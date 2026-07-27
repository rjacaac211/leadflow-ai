# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

LeadFlow AI is an autonomous B2B lead-qualification and outreach agent. A lead arrives via webhook (n8n/Zapier/curl) and a LangGraph.js `StateGraph` runs it through enrich (agentic, multi-page) → qualify → CRM sync → draft outreach → self-critique/revise → **human approval gate** (dashboard or Slack) → send, with a second graph handling inbound email replies (classify intent against a 9-class taxonomy, using full thread history → answer/escalate/unsubscribe). The approval pause is a real `interrupt()` checkpointed into Postgres, not a status flag — server restarts between draft and approval are harmless.

Two services: `server/` (TypeScript/Express/LangGraph/Prisma) and `web/` (React + Vite dashboard). See `README.md` for the full architecture diagram, API table, and automation-platform setup (n8n/Zapier) — it's kept up to date and worth reading before making cross-cutting changes.

## Commands

All commands run from the relevant subdirectory (`server/` or `web/`), not the repo root — there is no root `package.json`.

```bash
# server
cd server
npm install
npx prisma generate          # required after npm install, and again after any schema.prisma change
npx prisma migrate deploy    # apply migrations (needs DATABASE_URL)
npm run dev                  # tsx watch, port 4000
npm run typecheck            # tsc --noEmit
npm test                     # vitest run — all tests, no DB/network/keys needed
npx vitest run tests/scoring.test.ts   # single test file
npm run build                # tsc -> dist/

# web
cd web
npm install
npm run dev                  # vite, port 5173, proxies /api -> :4000 (or $API_URL)
npm run build
```

Full stack via Docker: `cp .env.example .env` (set `ANTHROPIC_API_KEY`), then `docker compose up --build`. Add `--profile automation` to also start n8n on :5678.

CI (`.github/workflows/ci.yml`) runs, per PR/push to `main`: server `prisma generate` + `typecheck` + `test`, and `web` `build`. It needs no secrets — server tests only exercise pure logic.

## Architecture

### Two LangGraph graphs, one process (`server/src/agent/`)

- **`state.ts`** — `IntakeState` (stateful, one LangGraph thread per lead, `thread_id = lead-${leadId}`) and `ReplyState` (stateless, one run per inbound reply). Graph nodes return `Partial<...State>`.
- **`graph.ts`** — builds both graphs and owns the `PostgresSaver` checkpointer. Notable: `buildCheckpointerPool` strips `sslmode` out of `DATABASE_URL` and passes `ssl` explicitly, because `pg` re-parses `connectionString` *after* explicit config and would otherwise silently re-enable strict cert verification against managed Postgres. `initGraphs()` must run once at boot before `runIntakePipeline`/`resumeWithDecision`/`runReplyPipeline` are called (they throw otherwise).
- **`nodes.ts`** — the actual node implementations for both graphs (`enrichNode`, `qualifyNode`, `crmSyncNode`, `draftOutreachNode`, `critiqueOutreachNode`, `reviseOutreachNode`, `approvalGateNode`, `sendNode` for intake; `classifyReplyNode`, `handleReplyNode` for replies). All Claude calls go through `createModel(...).withStructuredOutput(zodSchema, { includeRaw: true })` and every call site logs usage via `logTokenUsage`. `draftOutreach` → `critiqueOutreach` → (`reviseOutreach` → `critiqueOutreach` again, or on to `approvalGate`) is a real graph-level cycle, not an in-node loop — `critiqueOutreachNode` combines a pure lint (`outreach-critique.ts`'s `lintOutreachDraft`) with one LLM semantic-critique call, and `shouldRevise` (same file) is the pure termination condition (`MAX_OUTREACH_REVISIONS = 2`, exported from `nodes.ts`) the conditional edge in `graph.ts` evaluates. `lead.stage` only flips to `AWAITING_APPROVAL` inside `approvalGateNode` itself (not `draftOutreachNode`), since a draft can go through several silent revisions before a human ever sees it. `enrichNode` tries `runEnrichmentAgent()` (the tool-calling agent in `enrichment-agent.ts`) first and falls back to the old single-fetch `fetchWebsiteText()` on any failure or empty result — same "degrade, don't drop the lead" pattern as the integrations below, just without a missing-credential trigger. `classifyReplyNode`/`handleReplyNode` classify against a 9-class `ReplyIntent` taxonomy (`state.ts`) using the full prior thread transcript (`reply-context.ts`'s `buildThreadTranscript()`), not just the latest message in isolation — `AUTO_REPLY_INTENTS`/`ESCALATE_INTENTS` (both in `nodes.ts`) decide which intents get an automated reply vs. an immediate Slack escalation to a human.
- **`enrichment-agent.ts`** — a bounded ReAct-style tool-calling subgraph (`fetch_page` tool, `bindTools`/`ToolNode`) that lets the LLM decide which pages on a lead's company site to crawl, instead of one hardcoded homepage fetch. Bounded by three independent layers, per LangGraph's own recommendation for agent loops: a step-budget conditional edge (`shouldContinueEnrichment`, `MAX_STEPS = 4`), a `recursionLimit` backstop on the compiled graph in case that conditional has a bug, and a wall-clock `Promise.race` timeout (`WALL_CLOCK_TIMEOUT_MS`) in `runEnrichmentAgent()`. Stateless per call (no checkpointer) — only the two main pipeline graphs use the Postgres checkpointer.
- **`scoring.ts`** — pure, unit-tested weighted scoring: LLM rates each ICP criterion 0-5, this turns ratings into a deterministic 0-100 score and hot/warm/cold tier. Keep this free of I/O; it's the one piece of "judgment" that's supposed to be auditable math rather than a prompt. Tune scoring behavior here or in `icp.config.json`, not by re-prompting.
- **`llm.ts`** — `ChatAnthropic` factory. `PRICING_PER_1M_TOKENS_USD` must get a new entry whenever `ANTHROPIC_MODEL` changes, or cost logging silently stops (a warning is logged, not an error). Also force-nulls `temperature`/`top_k`/`top_p` in `invocationKwargs` because Opus 4.7+/Sonnet 5 reject those params outright and the langchain version in use doesn't know to omit them for newer models.

### Approval gate mechanics

`approvalGateNode` calls `interrupt(...)`, which pauses and checkpoints the graph. `POST /api/leads/:id/approve` (or `/reject`) → `resumeWithDecision()` in `graph.ts` → `graph.invoke(new Command({ resume: decision }), threadConfig)`. `routes/leads.ts` guards this by checking `lead.stage === "AWAITING_APPROVAL"` before resuming (409 otherwise) — the interrupt state itself is the source of truth, but the stage check gives a friendlier error and avoids racing double-approval. Slack's Approve/Reject buttons (`automation/n8n-slack-approval-workflow.json`) call these exact same routes — there's no separate Slack-specific resume path.

Everything in `approvalGateNode` *before* the `interrupt()` call re-runs on every resume too (interrupt() only skips re-pausing, not the surrounding code), so the `notifySlackWithApproval` call there is guarded by checking for an existing `slack_approval_requested` `LeadEvent` first — without that guard, resuming would re-post the Slack message every time.

**Recovering from a post-approval failure:** if a node *after* `approvalGate` throws — e.g. `sendNode` hitting a Resend/HubSpot error — the interrupt has already been consumed by that resume call, so a second `approve`/`reject` fails with "lead is not awaiting approval" (no pending interrupt left to resume); `Lead.stage` also stays stuck at `AWAITING_APPROVAL` since only a successful send advances it. `POST /api/leads/:id/retry` (`retryFailedStep()` in `graph.ts`) recovers this: it reads the checkpoint directly via `getState()` (the actual source of truth, unlike the stale `Lead.stage` column) and, if nothing is paused and the graph hasn't reached `END`, calls `graph.invoke(null, threadConfig)` to replay from the last checkpoint — deliberately not gated on `lead.stage` the way approve/reject are. Every node in the intake graph also gets a `RetryPolicy` (`errors.ts`'s `isRetriableError`, retrying 429/5xx/transient network errors) via `setNodeDefaults`, so most transient failures never reach this point; `crmSync` additionally gets an `errorHandler` that compensates after retries are exhausted (records `crm_sync_failed` and continues the pipeline) rather than blocking outreach, per the "a CRM outage must not lose the lead" rule.

### Config, not code, for retargeting the product

- **`icp.config.json`** (repo root, loaded by `server/src/config.ts` via `ICP_CONFIG_PATH` or a path relative to the compiled/`src` location) — product pitch, target customer, weighted rubric criteria, tier thresholds, disqualify cutoff. Changing what the agent qualifies for should mean editing this file, not the prompts in `nodes.ts`.
- All other config is env vars, read once into the `config` object in `config.ts`. There's no runtime env re-read — changes require a restart.
- **Use `||`, not `??`, for any optional env var with a non-empty default.** `docker-compose.yml` always injects vars like `OUTREACH_FROM_EMAIL` into the container, even when unset in `.env` — Compose passes an empty string, not `undefined`. `??` only falls back on `null`/`undefined`, so it silently keeps `""` instead of the intended default. This bit `outreachFromEmail` for real (fixed in commit `a1af391`) — Resend rejected sends with `from: ""` as "the domain is invalid" until the fallback operator was changed to `||`. Any new config field with this shape needs the same treatment.

### Data model (`server/prisma/schema.prisma`)

`Lead` (stage machine: `NEW → QUALIFIED/DISQUALIFIED → AWAITING_APPROVAL → OUTREACH_SENT → REPLIED/ESCALATED/OPTED_OUT`), `LeadEvent` (append-only audit trail — every agent decision/branch records one via `recordEvent()` in `db.ts`; this is what the dashboard timeline renders), `OutreachMessage` (both outbound drafts and inbound replies, `direction` + `status`). When adding a new agent decision point, add a corresponding `recordEvent()` call — the dashboard and any future debugging depends on the event trail being complete, not just the final DB state.

### Integrations all degrade to mock mode (`server/src/integrations/`)

`hubspot.ts`, `resend.ts`, `slack.ts`, `enrichment.ts` each check for their own API key/URL and no-op with a logged `mock: true` result if it's missing, rather than throwing. This is intentional so the full pipeline demos on just an `ANTHROPIC_API_KEY`. Preserve this pattern for any new integration — never make an integration hard-fail the pipeline for a missing credential; failures should degrade or be caught and recorded as a `*_failed` event (see `crmSyncNode` in `nodes.ts` for the pattern: catch, log, `recordEvent`, continue — a CRM outage must not lose the lead or block outreach).

### Webhook intake normalization (`server/src/services/leads.ts`)

`normalizeLeadPayload()` is pure (no I/O) and deliberately forgiving about field names (`full_name`/`first_name`+`last_name`, `email_address`, `company_name`, `url`/`domain`, etc.) since n8n/Zapier/form builders all disagree on shape. Auth for webhook routes is a constant-time `X-API-Key` check in `middleware/auth.ts` (`requireWebhookKey`) — open with a one-time warning if `WEBHOOK_API_KEY` is unset (dev convenience only, not for anything internet-reachable). `POST /api/webhooks/lead` responds `202` immediately and runs the intake pipeline in the background (fire-and-forget with its own error→event handling); it does not await the pipeline.

### Dashboard API is unauthenticated by design

`routes/leads.ts` (list/detail/approve/reject) has no auth — it's meant to sit behind a reverse proxy or VPN, not be exposed directly. Don't add pipeline-affecting logic here beyond what `graph.ts` already exposes; routes should stay thin wrappers.

### Testing

Unit tests (`server/tests/*.test.ts`, vitest, 58 tests total) only cover pure logic with no I/O: `scoring.ts` (weighted score/tier math), `services/leads.ts` (payload normalization), `enrichment.ts` (HTML-to-text extraction, link ranking), `enrichment-agent.ts`'s `shouldContinueEnrichment` termination condition, `outreach-critique.ts` (draft lint + revision termination), `reply-context.ts` (thread transcript building), and `errors.ts` (retriable-error classification). There is no integration/e2e test setup against a real Postgres or the LangGraph checkpointer — keep new tests in this pure-logic style unless you're also standing up test infrastructure.
