# LeadFlow AI

An autonomous lead-generation and qualification agent for B2B sales teams. Inbound leads arrive through a webhook (n8n form, Zapier Zap, or any HTTP client), and a LangGraph-powered agent runs the entire top-of-funnel workflow with a single human checkpoint:

```
Lead arrives (form / webhook)
  → enrich   — an agentic tool-calling loop crawls the lead's company site (homepage +
               a handful of other pages it decides are worth following), bounded by a step
               budget, a recursion-limit backstop, and a wall-clock timeout
  → qualify  — the LLM rates the lead against a configurable ICP rubric; deterministic code
               turns ratings into a 0-100 score, a hot/warm/cold tier, and any criterion veto
  → CRM sync — upsert the contact + qualification note into HubSpot
  → draft    — the LLM writes a personalized outreach email, then a critique/revise cycle
               (pure lint + LLM semantic critique, up to 2 revisions) fixes issues before a human ever sees it
  → approve  — pipeline pauses (durably, in Postgres) until a human approves/edits/rejects in the dashboard or via Slack
  → send     — email goes out via Resend; hot leads ping Slack
  → replies  — a second agent classifies intent (9 classes, using the full reply thread —
               not just the latest message) and answers, escalates to a human, or unsubscribes accordingly
```

This is the business-automation counterpart to [NutriGuide AI](https://github.com/rjacaac211/nutriguide-ai) (a conversational RAG agent): together they cover conversational AI *and* autonomous business-process agents.

## Demo

![LeadFlow AI demo](docs/demo.gif)

*A lead comes in, gets scored/tiered against the ICP rubric, synced to HubSpot, drafted for outreach, approved by a human, sent, and replied to — end to end, one pass.*

<details>
<summary>How this demo was recorded (for re-recording later)</summary>

1. `docker compose up --build`, wait for `/health` to return OK, open http://localhost:5173.
2. Click "Simulate an inbound lead" to expand the form.
3. Click the **Hot example** preset chip, then **Submit lead**.
4. Wait for "Lead submitted — the agent is qualifying it now," then wait for the new row
   in the Pipeline table (5s poll; qualification + enrichment + CRM sync take ~10-30s).
5. Click the row. Narrate the score/tier badge and qualification rationale as they appear.
6. Wait for stage "Needs approval" — the Approval card appears with a drafted subject/body.
7. Edit a line of the draft to show it's editable, then click **Approve & send**.
8. Wait for stage "Outreach sent" — "Simulate a reply from this lead" appears (hidden before this).
9. Expand it, click the **Interested** preset chip, click **Send reply**.
10. Wait for `Classified as "interested".` and stage moving to "Escalated".
11. Stop recording.

</details>

## Highlights

| Area | What this project demonstrates |
|------|-------------------------------|
| **Autonomous AI agents** | LangGraph.js `StateGraph` pipelines that execute a multi-step business task end-to-end with minimal human intervention, including a tool-calling sub-agent (`bindTools`/`ToolNode`) that decides which pages to crawl and a bounded self-critique/revise cycle on generated content |
| **Human-in-the-loop** | LangGraph `interrupt()` + Postgres checkpointer — approval pauses survive restarts and redeploys; humans edit drafts before anything is sent, from the dashboard or Slack |
| **Lead gen & qualification** | Configurable ICP rubric (`icp.config.json`); LLM rates evidence per criterion, deterministic code computes the weighted score and applies criterion vetoes — auditable, not vibes |
| **Evals** | Offline harness over 15 hand-labeled leads scoring tier accuracy, disqualify recall, calibration error and cost, gated by committed thresholds and run weekly in CI. It caught three real defects unit tests could not, and turned model selection into a costed comparison rather than a guess (see [Evaluation](#evaluation)) |
| **CRM integration** | HubSpot contacts + notes via REST (free-tier compatible), idempotent upsert by email |
| **Messaging platforms** | Outbound email via Resend, hot-lead / handoff notifications via Slack incoming webhooks, interactive Approve/Reject via Slack Block Kit buttons routed through n8n |
| **Workflow automation tools** | Three committed n8n workflow exports (lead capture with retry/error branching, IMAP inbound replies, Slack interactive approval) + optional n8n service in docker-compose; the same webhook works as a Zapier action (documented below) |
| **Customer inquiry handling** | Reply-handling agent classifies intent against a 9-class taxonomy using the full prior thread (not just the latest message), answers product questions, escalates high-intent leads to a human, honors opt-outs |
| **LLM engineering** | Provider-agnostic by design — Claude (`@langchain/anthropic`) or OpenAI (`@langchain/openai`) behind one factory, switchable with an env var and [benchmarked against each other](#evaluation) rather than picked on vibes. Zod structured outputs everywhere; per-lead token/cost rolled into the audit trail and surfaced in the dashboard |
| **Agent reliability** | Graph-wide `RetryPolicy` for transient failures, a Saga-style compensating error handler on CRM sync (an outage doesn't lose the lead), and checkpoint-based recovery (`POST /:id/retry`) for a lead stuck after a post-approval node failure |
| **Production practices** | Structured JSON logging (pino), graceful mock mode for every integration, unit-tested pure logic, typecheck + test + build CI, Docker Compose |
| **Stack** | TypeScript, LangGraph.js, Express, Prisma/PostgreSQL, React + Vite |

## Architecture

```mermaid
flowchart LR
    subgraph Sources
        N8N["n8n: form / IMAP replies /<br/>Slack approval / Zapier zap"]
        FORM[Dashboard demo form]
    end

    subgraph Server["server/ (Express + LangGraph)"]
        WH[POST /api/webhooks/lead]
        RG[Reply agent graph]
        IG[Intake agent graph]
        API[Dashboard API]
    end

    subgraph Data
        PG[(PostgreSQL<br/>leads, events, messages,<br/>LangGraph checkpoints)]
    end

    subgraph Integrations
        CL["LLM (Claude or OpenAI)"]
        HS[HubSpot CRM]
        RS[Resend email]
        SL[Slack]
    end

    WEB[React dashboard] --> API
    N8N --> WH
    FORM --> WH
    WH --> IG
    IG --> CL & HS & RS & SL
    IG <--> PG
    RG --> CL & RS & SL
    API <--> PG
    API -->|approve / reject| IG
    SL -.->|button click| N8N
    N8N -.->|approve / reject| API
```

Two services:

- **`server/`** — TypeScript. Express API + two LangGraph graphs in one process. Prisma models (`Lead`, `LeadEvent` audit trail, `OutreachMessage`) share a PostgreSQL database with the LangGraph `PostgresSaver` checkpointer, so an in-flight approval pause is just data — restart the process and the pipeline resumes where it left off.
- **`web/`** — React + Vite dashboard: live pipeline table, per-lead timeline (every agent decision is recorded as an event), approval queue with an editable draft, and demo forms to simulate inbound leads and replies.

### Agent design notes

- **Deterministic scoring on top of LLM judgment.** The LLM only does what LLMs are good at — reading evidence and rating each rubric criterion 0-5 with a rationale (zod-enforced structured output). The weighted 0-100 score, tier thresholds, and disqualification cutoff are plain unit-tested TypeScript (`server/src/agent/scoring.ts`), so scoring is explainable and tunable without touching a prompt.
- **A weighted average can't veto, so criteria can.** Any rubric criterion can declare `disqualifyAtOrBelow` in `icp.config.json`: rate it that low and the lead is rejected outright, whatever it scored. This exists because [the eval](#evaluation) caught a competitor doing market research scoring 36/100 — above the disqualify cutoff — on the strength of its industry and headcount, despite the model correctly rating its buying intent 0. The vetoing criterion is recorded on the `disqualified` event, so a high score with a rejected lead is never a mystery.
- **The approval gate is a real interrupt, not a status flag.** `interrupt()` checkpoints the graph mid-run into Postgres. `POST /api/leads/:id/approve` resumes it with a `Command({ resume })` carrying the (possibly edited) subject/body. Server restarts between draft and approval are harmless. Approving from Slack's Approve/Reject buttons hits the exact same route (via the n8n workflow below) — there's no separate code path to keep in sync.
- **Every integration degrades to mock mode.** Missing `HUBSPOT_ACCESS_TOKEN` / `RESEND_API_KEY` / `SLACK_WEBHOOK_URL` turns that step into a logged no-op, so the full pipeline demos with a single chat-provider key. The audit trail records `mock: true` so you always know what really happened.
- **Failures don't lose leads.** CRM outages are caught, recorded as `crm_sync_failed` events, and the pipeline continues; enrichment is best-effort; webhook capture responds `202` and runs the agent in the background. Every node also gets a `RetryPolicy` for transient errors (429/5xx/network), and a lead stuck after a post-approval failure (e.g. a Resend outage mid-send) can be recovered with `POST /:id/retry`, which replays from the last checkpoint rather than needing the approval redone.
- **A drafted email is critiqued before a human ever sees it.** `draftOutreach → critiqueOutreach → (reviseOutreach → critiqueOutreach again, or on to approve)` is a real graph-level cycle, not an in-node loop — the critique combines a deterministic lint (word count, placeholder text, markdown, leaked internal metadata) with one LLM semantic-quality check, bounded to 2 revisions.
- **Enrichment is agentic, not a single fetch.** A bounded tool-calling loop (step budget + recursion-limit backstop + wall-clock timeout) lets the LLM decide which pages on a lead's site are worth reading — homepage, then pricing/about/product if it judges them useful — falling back to a single-page fetch if the agent fails or times out.

## Quick Start

Prerequisites: Docker + one chat-provider API key — Anthropic or OpenAI. (Or Node 22+ and PostgreSQL 16 for local dev.)

```bash
git clone https://github.com/rjacaac211/leadflow-ai.git
cd leadflow-ai
cp .env.example .env          # set ANTHROPIC_API_KEY or OPENAI_API_KEY (everything else optional)
docker compose up --build
```

- Dashboard: http://localhost:5173
- API: http://localhost:4000 (`GET /health`)

Submit a lead from the dashboard ("Simulate an inbound lead"), or hit the webhook directly:

```bash
curl -X POST http://localhost:4000/api/webhooks/lead \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $WEBHOOK_API_KEY" \
  -d '{
    "name": "Jordan Rivera",
    "email": "jordan@acme-saas.example",
    "company": "Acme SaaS",
    "website": "https://example.com",
    "message": "Our 12-rep sales team forecasts in spreadsheets and it is falling apart. Looking to fix this quarter."
  }'
```

Within a few seconds the lead appears in the dashboard scored and tiered, with a drafted outreach email waiting for your approval. Approve it (edit freely first), then use "Simulate a reply" to watch the reply agent classify and respond.

### Local development (without Docker)

```bash
# server
cd server
npm install
npx prisma generate         # regenerates the Prisma client — required after npm install
npx prisma migrate deploy   # needs DATABASE_URL pointing at a running Postgres
npm run dev                 # tsx watch, port 4000

# web (second terminal)
cd web
npm install
npm run dev                 # Vite on 5173, proxies /api to :4000
```

## Configuration

All configuration is environment variables (see [`.env.example`](.env.example)) plus one JSON file:

- **`icp.config.json`** — the ideal-customer-profile rubric: product pitch, target customer, weighted criteria, tier thresholds, and the disqualification cutoff. Edit it to point the agent at a different product/market; no code changes needed. A criterion may also set `disqualifyAtOrBelow: N` to act as a veto — rate it at or below `N` and the lead is rejected regardless of its weighted score.
- **`LLM_PROVIDER`** — `anthropic` (default) or `openai`. The agent is provider-agnostic: every call goes through one `createModel()` factory, so switching is an env var, not a code change. If unset, it's inferred from whichever key is present, preferring Anthropic — set it explicitly when you have both keys.
- **`ANTHROPIC_MODEL` / `OPENAI_MODEL`** — default to `claude-opus-4-8` and `gpt-5.4`, which are the cheapest model on each provider that clears the [eval](#evaluation) thresholds. If you switch models, add a pricing entry in `server/src/agent/llm.ts` so cost logging stays accurate.

| Variable | Required | Purpose |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` *or* `OPENAI_API_KEY` | ✅ | The chat model — qualification, drafting, reply handling. Either one alone is enough |
| `LLM_PROVIDER` | if both keys set | `anthropic` (default) or `openai` |
| `DATABASE_URL` | ✅ | PostgreSQL (app tables + LangGraph checkpoints) |
| `WEBHOOK_API_KEY` | recommended | Shared secret for `/api/webhooks/*` (open with a warning if unset — dev only) |
| `HUBSPOT_ACCESS_TOKEN` | optional | HubSpot account-scoped token; unset = mock mode |
| `RESEND_API_KEY`, `OUTREACH_FROM_EMAIL` | optional | Outbound email; unset = mock mode |
| `SLACK_WEBHOOK_URL` | optional | Hot-lead / handoff notifications; unset = mock mode |
| `SLACK_BOT_TOKEN`, `SLACK_APPROVAL_CHANNEL` | optional | Interactive approval-request message (Block Kit buttons) instead of a plain notification; unset = falls back to `SLACK_WEBHOOK_URL`/mock |
| `SLACK_SIGNING_SECRET` | optional | Verifies Slack button clicks in the n8n approval workflow are really from Slack; only read by n8n, not the server |

Notes on the optional integrations, from setting each of these up live:

- **HubSpot** — HubSpot's UI has moved private-app creation from "Private Apps" to **Settings → Integrations → Development → Keys → Service Keys** (public beta as of Feb 2026); it issues the same `pat-na1-...`-style bearer token, so no code changes are needed either way. Only the `crm.objects.contacts.read` and `crm.objects.contacts.write` scopes are required — there's no separate notes scope exposed in the scope picker; the Notes API is governed by the contacts scopes.
- **Resend** — on an unverified (sandbox) account, Resend only allows sending **to the exact email address you signed up with** (not even a `+alias` variant of it) — a platform restriction, not a bug. Verify a domain to send to arbitrary recipients.

## Automation Platforms

### n8n (demonstrated)

[`automation/n8n-lead-capture-workflow.json`](automation/n8n-lead-capture-workflow.json) is a committed n8n export: a hosted lead-capture form that posts submissions to the LeadFlow webhook with the `X-API-Key` header.

```bash
docker compose --profile automation up   # starts n8n on http://localhost:5678
```

Import the JSON via n8n → Workflows → Import from File, activate it, and share the form URL (`http://localhost:5678/form/leadflow-capture`, or your host's equivalent). The workflow reads the webhook key from the `LEADFLOW_WEBHOOK_KEY` env var — already wired in `docker-compose.yml`, along with `N8N_BLOCK_ENV_ACCESS_IN_NODE: "false"`, which recent n8n versions require for a node expression to read `$env` at all (without it the HTTP Request node fails with "access to env vars denied" and the form silently drops every submission). Verified live end-to-end: form submission → `POST /api/webhooks/lead` → full qualify/CRM-sync/draft pipeline, landing with `source: "n8n-form"`.

The `Send to LeadFlow` node retries transient failures automatically (up to 3 attempts) and, if the webhook call still fails, routes to an `Alert on Failure` branch instead of silently dropping the submission — a plain POST to `SLACK_WEBHOOK_URL` (mirrored into the n8n container the same way `LEADFLOW_WEBHOOK_KEY` is) naming the lead's email and the error. A duplicate submission (the server's own `200 {"status":"duplicate"}` response) is not treated as a failure, since the server already owns that logic.

### n8n — inbound email replies (demonstrated)

[`automation/n8n-email-reply-workflow.json`](automation/n8n-email-reply-workflow.json) closes the loop on the reply side: an **Email Trigger (IMAP)** node polls a mailbox and forwards each new message to `POST /api/webhooks/email-reply`, so replies can be tested against a real inbox instead of only via the dashboard's simulate-reply control or a manual curl.

Import it the same way as the lead-capture workflow, then attach real IMAP credentials (Settings → Credentials → IMAP) to the trigger node — a disposable test mailbox with app-password IMAP access works fine for a demo. The node's default **Simple** format returns `textPlain`/`textHtml` and a raw `from` header string (e.g. `"Jane Doe <jane@example.com>"`); the HTTP Request node extracts the address out of that string with a regex before posting `{ email, message }`, matching what `/api/webhooks/email-reply` expects. This workflow is optional and additive — the endpoint it calls already works standalone with zero IMAP setup, so there's nothing to configure if you don't need this piece.

### n8n — Slack interactive approval (needs a Slack App)

[`automation/n8n-slack-approval-workflow.json`](automation/n8n-slack-approval-workflow.json) lets a human approve or reject a drafted outreach email with one click from Slack instead of opening the dashboard. `approvalGateNode` posts a Block Kit message (via `notifySlackWithApproval` in `server/src/integrations/slack.ts`) with **Approve**/**Reject** buttons carrying the lead ID; clicking one sends Slack's interaction payload to this workflow, which verifies it really came from Slack, then calls the same unmodified `/api/leads/:id/approve|reject` routes the dashboard uses — there's exactly one code path that resumes the graph, Slack is just another caller of it.

Setup requires a real Slack App (Slack signs every interaction payload with a per-app secret, so there's no way to demo the *interactive* part without one — a curl-simulated payload can't stand in for it the way it does for the other two workflows):

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps), add the `chat:write` bot scope, install it to your workspace, and grab the **Bot User OAuth Token** (`xoxb-...`).
2. Under **Interactivity & Shortcuts**, turn it on and set the Request URL to `http://<your-n8n-host>:5678/webhook/leadflow-slack-approval` (needs a public URL — `ngrok http 5678` or similar for local testing).
3. Copy the **Signing Secret** from the app's Basic Information page.
4. Set `SLACK_BOT_TOKEN`, `SLACK_APPROVAL_CHANNEL` (for the server) and `SLACK_SIGNING_SECRET` (for n8n) in `.env`, then import and activate the workflow the same way as the others.

The workflow's signature check (`Verify & Parse Slack Interaction`, a Code node — `NODE_FUNCTION_ALLOW_BUILTIN: crypto` is already wired into the n8n service for it) recomputes Slack's `v0=` HMAC over the raw request body and does a constant-time compare, rejecting anything with a bad or stale (>5 min old) signature with `401` before it can reach `/approve`. **Verified against a synthetic-but-correctly-signed payload** (same HMAC algorithm, a throwaway local secret) rather than a live Slack workspace: crafted requests with valid signatures were routed through to `/approve` and `/reject` and correctly resumed a paused lead's graph end-to-end (rejecting flipped the stage back to `QUALIFIED` and recorded `outreach_rejected`; approving reached the `send` node and only failed on Resend's sandbox recipient restriction, the same known limitation noted above — not a workflow bug), and a bad signature was correctly rejected with `401`. The one piece this can't stand in for is Slack's own request signing and the actual button-click UX, which needs the real app from the steps above.

### Zapier (compatible)

The intake endpoint is a plain authenticated webhook, so any Zapier trigger (Facebook Lead Ads, Typeform, Google Forms…) can feed it with a **Webhooks by Zapier → Custom Request** action:

- **Method/URL:** `POST https://your-host/api/webhooks/lead`
- **Headers:** `Content-Type: application/json`, `X-API-Key: <your WEBHOOK_API_KEY>`
- **Data:** `{"name": "...", "email": "...", "company": "...", "website": "...", "message": "...", "source": "zapier"}`

Field names are forgiving — the payload normalizer accepts common variants (`full_name`, `first_name`+`last_name`, `email_address`, `company_name`, `url`, `notes`, …).

## API

| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST /api/webhooks/lead` | `X-API-Key` | Capture a lead; responds `202`, pipeline runs in background |
| `POST /api/webhooks/email-reply` | `X-API-Key` | `{email, message}` — run the reply agent for an inbound response |
| `GET /api/leads` | — | Pipeline list (dashboard) |
| `GET /api/leads/:id` | — | Lead + full event timeline + messages |
| `POST /api/leads/:id/approve` | — | Resume a paused pipeline; optional `{subject, body}` overrides |
| `POST /api/leads/:id/reject` | — | Resume with rejection; optional `{reason}` |
| `POST /api/leads/:id/retry` | — | Recover a lead stuck after a post-approval node failure (e.g. `send`); replays from the last checkpoint |
| `GET /health` | — | Liveness + DB check |

The dashboard API is unauthenticated by design for the local demo — put it behind your reverse proxy's auth (or a VPN) before exposing it.

## Testing & CI

```bash
cd server && npm run typecheck && npm test   # vitest — 100 unit tests on pure logic
cd web && npm run build
```

Unit tests cover the deterministic core (weighted scoring/tiering, criterion vetoes, webhook payload normalization, HTML-to-text extraction, link ranking, outreach draft linting, retriable-error classification, reply-thread transcript building, and the eval harness's own metrics) and need no database, network, or API keys. GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs typecheck + tests + web build on every PR and push to `main`.

## Evaluation

Unit tests prove the scoring *arithmetic* is right. They say nothing about whether the agent's **judgment** is any good — so changing a prompt, a rubric criterion, or `ANTHROPIC_MODEL` would otherwise ship blind. `server/evals/` closes that gap.

```bash
cd server
# uses whichever provider LLM_PROVIDER / your keys select — no database needed
ANTHROPIC_API_KEY=sk-ant-... npm run eval -- --repeat 3

# benchmark a different model without touching config
LLM_PROVIDER=openai OPENAI_MODEL=gpt-5.4-mini npm run eval -- --repeat 3 --out evals/mini.json
```

15 hand-labeled leads ([`evals/dataset/qualification.json`](server/evals/dataset/qualification.json)) run through the *same* prompt (`qualify-prompt.ts`) and the *same* deterministic verdict function (`scoring.ts`'s `qualifyFromRatings`) the live pipeline uses — not a reimplementation, so the eval can't quietly drift from production. Each case ships **canned website text** rather than crawling live, so the harness measures qualification judgment instead of whether a third party redesigned their homepage overnight. It imports no Prisma and needs no database.

The dataset is built around the cases that actually catch regressions, not just easy wins: a lead with no enrichment at all (must score low, not hallucinate fit), a competitor doing recon, an agency pitching *us*, a student, a B2C business with no sales pipeline, an enterprise buyer above the ICP, a sales engineer with no budget authority, and a lead whose confident message is contradicted by their website.

**Baseline** — `gpt-5.4`, 15 cases × 3 repeats, on the final rubric:

| Metric | Result | Gate |
|---|---|---|
| Tier accuracy (hot/warm/cold exact match) | 97.8% | ≥ 85% |
| Qualified/disqualified accuracy | 100% | ≥ 90% |
| **Disqualify recall** (share of junk correctly rejected) | **100%** | ≥ 90% |
| Score MAE vs. labeled band | 0.04 | ≤ 3 |
| Cost | $0.0066 / lead | — |

**Model selection** — the same 15 cases, same prompt and rubric, run across four models. Measured on the pre-rebalance rubric, so the absolute numbers differ from the table above; the comparison between rows is what matters:

| Model | Tier | Qualified | Disqualify recall | $/lead | Latency | |
|---|---|---|---|---|---|---|
| `claude-opus-4-8` | 76.2% | 100% | 100% | $0.0219 | 8.3s | ✅ |
| `gpt-5.4` | 76.2% | 100% | 100% | $0.0066 | 4.8s | ✅ |
| `gpt-5.4-mini` | 73.8% | 88.1% | 86.7% | $0.0018 | 3.3s | ❌ |
| `gpt-5.4-nano` | **88.1%** | 81.0% | 93.3% | $0.0005 | 2.9s | ❌ |

Gates live in [`evals/thresholds.json`](server/evals/thresholds.json) so raising the bar is a reviewable diff. `--repeat N` re-runs each case to expose nondeterminism; a case whose repeats disagree on tier is reported `FLAKY` rather than silently averaged. [`.github/workflows/eval.yml`](.github/workflows/eval.yml) runs it weekly and on demand, uploads the JSON report as an artifact, and skips cleanly when no API key is configured — the main CI stays secret-free.

**Why the table earns its keep.** "Use a cheaper model" is normally a vibes decision. Here it's costed: `gpt-5.4` matches Opus on every gate at a third of the price, so it's the OpenAI default. The two smaller models fail in *opposite* and business-meaningful ways, which no aggregate score would have shown — `gpt-5.4-mini` is too lenient (it rates a competitor's buying intent 1 instead of 0, slipping past the veto, so a competitor can receive an outreach email), while `gpt-5.4-nano` is too strict (it vetoed a financial-services firm and a technology consultancy as "not B2B", silently dropping real leads). Note that nano has the *best* tier accuracy and calibration of any model tested and is still the wrong choice — picking on headline accuracy alone would have been a mistake.

**Three real defects it caught**, none of which the unit tests could have:

1. **A weighted mean cannot express a veto.** The first run failed at 60% disqualify recall. The model's reasoning was right every time — it rated the competitor's buying intent 0 and flagged the candle shop as "not a B2B company" — but averaging diluted those decisive negatives, and the competitor still scored 36/100, above the cutoff, on industry and headcount alone. Fixed with the `disqualifyAtOrBelow` criterion gate, in `icp.config.json` rather than by re-prompting.
2. **A veto on a criterion that also means "unknown" rejects good leads.** A live run then dropped a COO with 22 reps, explicit pain and a demo request — `industry_fit` was rated 1 purely because no website was supplied, and the veto fired. The prompt tells the model to score low when evidence is absent, so a low rating meant both "wrong industry" and "no idea". Fixed by making `industry_fit: 0` require *positive* evidence of a non-fit, with absence scoring 2. `hot-strong-buyer-no-website` now guards it.
3. **The rubric under-weighted whether a deal can actually happen.** `buyer_role` + `urgency` were only 5/14 of the weight, so a lead failing *both* — no budget authority, no timeline — still scored 79 and was ranked "hot". Two independent model families agreed on this. Rebalanced to 8/17, and the hot threshold moved 70 → 80 so that "hot" requires authority and a timeline rather than just company fit.

**What it still says is imperfect.** One case (`warm-b2c-ecommerce-vetoed`) straddles the cold/warm boundary at 38-42 and is reported `FLAKY`. It doesn't affect the decision that matters — the veto rejects it either way — but the harness reports the wobble rather than hiding it behind an average. The `warm-strong-claim-weak-website` case also shows the model still partly believing an unverifiable claim about headcount; it lands warm, but on the strength of the claim rather than skepticism about it.

## Project Structure

```
├── icp.config.json              # the qualification rubric — edit to retarget the agent
├── docker-compose.yml           # postgres + server + web (+ optional n8n)
├── automation/
│   ├── n8n-lead-capture-workflow.json
│   ├── n8n-email-reply-workflow.json
│   └── n8n-slack-approval-workflow.json
├── server/
│   ├── prisma/schema.prisma     # Lead, LeadEvent (audit trail), OutreachMessage
│   └── src/
│       ├── agent/
│       │   ├── graph.ts             # StateGraphs, RetryPolicy/errorHandler wiring, Postgres checkpointer, run/resume/retry API
│       │   ├── nodes.ts             # enrich → qualify → crmSync → draft → critique/revise → approve → send; reply pipeline
│       │   ├── enrichment-agent.ts  # bounded tool-calling agent that crawls a lead's site (fetch_page tool)
│       │   ├── outreach-critique.ts # pure draft lint + revision termination condition (unit tested)
│       │   ├── reply-context.ts     # builds prior-thread transcript for reply classification/drafting (unit tested)
│       │   ├── errors.ts            # retriable-error classification for RetryPolicy (unit tested)
│       │   ├── scoring.ts           # pure weighted scoring, tiering + criterion vetoes (unit tested)
│       │   ├── qualify-prompt.ts    # pure qualification prompt/schema — shared with the eval harness
│       │   ├── llm.ts               # Claude factory + token/cost logging
│       │   ├── usage.ts             # per-lead token/cost rollup → `llm_usage` audit event
│       │   └── state.ts             # graph state annotations
│       ├── integrations/        # hubspot, resend, slack, enrichment — all with mock mode
│       ├── routes/              # webhooks, leads (approve/reject/retry resume)
│       └── services/leads.ts    # webhook payload normalization (unit tested)
│   └── evals/                   # offline qualification eval — labeled dataset, metrics, CLI runner
└── web/                         # React dashboard: pipeline, timeline, approval queue, per-lead cost
```

## Roadmap

- Extend the eval to outreach quality (LLM-as-judge on drafts) and reply-intent classification
- Grow the qualification dataset past 15 cases — the current rubric weights and tier thresholds were validated against four models but only this many leads
- Scheduled follow-up sequences (no-reply after N days → follow-up draft)
- Multi-channel outreach (LinkedIn task creation) and richer enrichment providers
- Deployment guide (ECS/EC2) mirroring NutriGuide's AWS pipeline
