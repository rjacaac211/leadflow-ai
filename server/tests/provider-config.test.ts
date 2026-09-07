import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * config.ts snapshots process.env at module-eval time, so each case has to
 * reset the module registry and re-import it under a different environment.
 */
async function loadConfig(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return (await import("../src/config.js")).config;
}

const LLM_KEYS = [
  "LLM_PROVIDER",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_MODEL",
  "OPENAI_MODEL",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(LLM_KEYS.map((k) => [k, process.env[k]]));
  for (const key of LLM_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of LLM_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.resetModules();
});

describe("provider resolution", () => {
  it("infers anthropic from an Anthropic key alone", async () => {
    const config = await loadConfig({ ANTHROPIC_API_KEY: "sk-ant-x" });
    expect(config.llmProvider).toBe("anthropic");
    expect(config.llmModel).toBe("claude-opus-4-8");
  });

  it("infers openai from an OpenAI key alone", async () => {
    const config = await loadConfig({ OPENAI_API_KEY: "sk-proj-x" });
    expect(config.llmProvider).toBe("openai");
    expect(config.llmModel).toBe("gpt-5.4");
  });

  // The case that motivated an explicit switch: a dead Anthropic key alongside
  // a live OpenAI one must not silently win just because inference prefers it.
  it("lets LLM_PROVIDER override inference when both keys are present", async () => {
    const config = await loadConfig({
      ANTHROPIC_API_KEY: "sk-ant-x",
      OPENAI_API_KEY: "sk-proj-x",
      LLM_PROVIDER: "openai",
    });
    expect(config.llmProvider).toBe("openai");
  });

  it("prefers anthropic when both keys are set and no provider is chosen", async () => {
    const config = await loadConfig({
      ANTHROPIC_API_KEY: "sk-ant-x",
      OPENAI_API_KEY: "sk-proj-x",
    });
    expect(config.llmProvider).toBe("anthropic");
  });

  it("tolerates whitespace and casing in LLM_PROVIDER", async () => {
    const config = await loadConfig({ LLM_PROVIDER: "  OpenAI  ", OPENAI_API_KEY: "x" });
    expect(config.llmProvider).toBe("openai");
  });

  // Compose injects "" for unset vars; that must mean "infer", not "invalid".
  it("treats an empty LLM_PROVIDER as unset rather than throwing", async () => {
    const config = await loadConfig({ LLM_PROVIDER: "", OPENAI_API_KEY: "sk-proj-x" });
    expect(config.llmProvider).toBe("openai");
  });

  it("throws on an unrecognised provider instead of silently defaulting", async () => {
    await expect(loadConfig({ LLM_PROVIDER: "gemini" })).rejects.toThrow(/LLM_PROVIDER/);
  });

  it("uses the model override for the active provider only", async () => {
    const config = await loadConfig({
      LLM_PROVIDER: "openai",
      OPENAI_API_KEY: "x",
      OPENAI_MODEL: "gpt-5.4-nano",
      ANTHROPIC_MODEL: "claude-haiku-4-5",
    });
    expect(config.llmModel).toBe("gpt-5.4-nano");
  });

  it("falls back to the default when the model override is empty (Compose injects '')", async () => {
    const config = await loadConfig({
      LLM_PROVIDER: "openai",
      OPENAI_API_KEY: "x",
      OPENAI_MODEL: "",
    });
    expect(config.llmModel).toBe("gpt-5.4");
  });
});
