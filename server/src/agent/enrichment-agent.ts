import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { Annotation, END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import { extractLinks, fetchRawHtml, htmlToText, rankCandidateLinks } from "../integrations/enrichment.js";
import { createModel, logTokenUsage } from "./llm.js";

// Bounds on the agentic loop — every LLM call here is one Anthropic call this
// pipeline didn't make before, so these exist as much for cost control as for
// correctness. Combined with a recursionLimit backstop and a wall-clock
// timeout in runEnrichmentAgent, per the "three layers" pattern LangGraph
// docs recommend for bounding an agent loop.
const MAX_STEPS = 4;
const PAGE_TEXT_CHARS = 4000;
const MAX_AGGREGATE_CHARS = 10_000;
const WALL_CLOCK_TIMEOUT_MS = 45_000;

const EnrichmentAgentState = Annotation.Root({
  ...MessagesAnnotation.spec,
  stepCount: Annotation<number>({ reducer: (_current, next) => next, default: () => 0 }),
});

const fetchPageTool = tool(
  async ({ url }: { url: string }) => {
    const html = await fetchRawHtml(url);
    if (!html) {
      return JSON.stringify({ url, error: "could not fetch this page" });
    }
    const text = htmlToText(html).slice(0, PAGE_TEXT_CHARS);
    const links = rankCandidateLinks(extractLinks(html, url), url);
    return JSON.stringify({ url, text, links });
  },
  {
    name: "fetch_page",
    description:
      "Fetch a page on the lead's company website and return its visible text plus a ranked list of other same-site pages worth following next (about, pricing, product, etc). Only call this with URLs on the company's own domain — either the homepage you were given, or one of the `links` returned by a previous call.",
    schema: z.object({
      url: z.string().describe("Absolute URL of the page to fetch"),
    }),
  },
);

/** Pure termination condition for the agent <-> tools cycle in the graph below. */
export function shouldContinueEnrichment(
  hasToolCalls: boolean,
  stepCount: number,
  maxSteps: number,
): boolean {
  return hasToolCalls && stepCount < maxSteps;
}

async function agentNode(
  state: typeof EnrichmentAgentState.State,
): Promise<Partial<typeof EnrichmentAgentState.State>> {
  const remaining = MAX_STEPS - state.stepCount;
  const systemPrompt = [
    `You are gathering context on a company for a B2B sales-qualification rubric.`,
    `Use the fetch_page tool to look at the company's homepage and, if it seems useful, a small number of other same-site pages (about, pricing, product, customers).`,
    `You have at most ${remaining} more fetch_page call(s) left in this budget. Once you have enough context — or you're out of budget — stop calling tools and just reply with a short confirmation instead.`,
  ].join(" ");

  const model = createModel(1024).bindTools([fetchPageTool]);
  const response = (await model.invoke([
    { role: "system", content: systemPrompt },
    ...state.messages,
  ])) as AIMessage;
  logTokenUsage("enrich_agent_step", response);

  const calledTool = Boolean(response.tool_calls && response.tool_calls.length > 0);
  return {
    messages: [response],
    stepCount: calledTool ? state.stepCount + 1 : state.stepCount,
  };
}

const toolNode = new ToolNode([fetchPageTool]);

const enrichmentAgentGraph = new StateGraph(EnrichmentAgentState)
  .addNode("agent", agentNode)
  .addNode("tools", toolNode)
  .addEdge(START, "agent")
  .addConditionalEdges(
    "agent",
    (state) => {
      const last = state.messages[state.messages.length - 1] as AIMessage | undefined;
      const hasToolCalls = Boolean(last?.tool_calls && last.tool_calls.length > 0);
      return shouldContinueEnrichment(hasToolCalls, state.stepCount, MAX_STEPS) ? "tools" : END;
    },
    ["tools", END],
  )
  .addEdge("tools", "agent")
  .compile();

function timeoutAfter(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(`enrichment agent timed out after ${ms}ms`)), ms);
  });
}

export interface EnrichmentAgentResult {
  text: string;
  pagesVisited: number;
}

/**
 * Runs the tool-calling enrichment loop against a company homepage. Throws
 * on timeout or graph failure — callers (enrichNode) are expected to catch
 * and fall back to the single-fetch fetchWebsiteText, the same "degrade,
 * don't hard-fail the pipeline" pattern every other integration follows.
 * Stateless per call: no checkpointer, unlike the two main pipeline graphs.
 */
export async function runEnrichmentAgent(homepageUrl: string): Promise<EnrichmentAgentResult | null> {
  const result = await Promise.race([
    enrichmentAgentGraph.invoke(
      {
        messages: [
          new HumanMessage(`Company homepage: ${homepageUrl}. Start by fetching this page.`),
        ],
      },
      // Backstop in case the step-budget conditional edge above has a bug —
      // LangGraph's own recommendation is to pair an explicit termination
      // condition with a recursionLimit safety net, not rely on just one.
      { recursionLimit: MAX_STEPS * 2 + 4 },
    ),
    timeoutAfter(WALL_CLOCK_TIMEOUT_MS),
  ]);

  const toolMessages = result.messages.filter(
    (message) => message.getType() === "tool",
  );

  const pageTexts: string[] = [];
  for (const message of toolMessages) {
    try {
      const parsed = JSON.parse(String(message.content)) as {
        url: string;
        text?: string;
        error?: string;
      };
      if (parsed.text) {
        pageTexts.push(`--- ${parsed.url} ---\n${parsed.text}`);
      }
    } catch {
      // Malformed tool output — skip it rather than fail the whole run.
    }
  }

  if (pageTexts.length === 0) return null;
  return {
    text: pageTexts.join("\n\n").slice(0, MAX_AGGREGATE_CHARS),
    pagesVisited: toolMessages.length,
  };
}
