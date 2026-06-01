// src/core/llm.ts
//
// Pluggable single-turn LLM completion. distill() only ever needs a tool-less
// one-shot completion (maxTurns:1, allowedTools:[]), so the Claude Agent SDK is
// not required — it is just one of several interchangeable backends here.
//
//   CLAW_MEMORY_LLM_BACKEND = agent-sdk (default) | codex-sdk | anthropic | openai-compatible
//
// - agent-sdk:        zero-config; reuses Claude Code CLI's stored credentials
//                     (Claude Pro/Max/Team/Enterprise via the Agent SDK).
// - codex-sdk:        reuses the Codex CLI's stored login (ChatGPT/Codex plan)
//                     via @openai/codex-sdk — no API key. Requires Codex CLI.
// - anthropic:        plain Messages API over fetch (needs ANTHROPIC_API_KEY).
// - openai-compatible: OpenAI/Gemini/OpenRouter/LM Studio chat-completions.
//
// Tier routing lets cheap models handle simple work:
//   CLAW_MEMORY_TIER_SMART / _SUMMARY / _SIMPLE  (model id per tier)
// The two SDK backends reuse a subscription login; the HTTP backends need fetch
// (built into Node >=20).

import os from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildFullSdkEnv } from "./providers.js";

export type Tier = "smart" | "summary" | "simple";

export interface CompleteOptions {
  prompt: string;
  /** Routing hint; defaults to "summary". */
  tier?: Tier;
  maxTokens?: number;
}

export function getBackend(): string {
  return process.env.CLAW_MEMORY_LLM_BACKEND ?? "agent-sdk";
}

/**
 * Resolve the env-configured model id for a tier, or undefined when unset.
 * Each backend applies its own default when this is undefined.
 */
export function modelForTier(tier: Tier): string | undefined {
  const def = process.env.AGENT_SDK_MODEL ?? process.env.CLAW_MEMORY_MODEL;
  switch (tier) {
    case "simple":
      return process.env.CLAW_MEMORY_TIER_SIMPLE ?? def;
    case "summary":
      return process.env.CLAW_MEMORY_TIER_SUMMARY ?? def;
    case "smart":
      return process.env.CLAW_MEMORY_TIER_SMART ?? def;
  }
}

export async function complete(opts: CompleteOptions): Promise<string> {
  const tier = opts.tier ?? "summary";
  const model = modelForTier(tier);
  const backend = getBackend();
  switch (backend) {
    case "agent-sdk":
      return completeAgentSdk(opts.prompt, model ?? "claude-sonnet-4-5");
    case "codex-sdk":
      return completeCodexSdk(opts.prompt, model);
    case "anthropic":
      return completeAnthropic(opts.prompt, model ?? "claude-sonnet-4-5", opts.maxTokens);
    case "openai-compatible":
      return completeOpenAi(opts.prompt, model, opts.maxTokens);
    default:
      throw new Error(
        `unknown CLAW_MEMORY_LLM_BACKEND: ${backend} (expected agent-sdk|codex-sdk|anthropic|openai-compatible)`
      );
  }
}

async function completeAgentSdk(prompt: string, model: string): Promise<string> {
  const sdkStream = query({
    prompt,
    options: {
      model,
      maxTurns: 1,
      allowedTools: [],
      permissionMode: "bypassPermissions",
      // SDK isolation: do NOT load ~/.claude or project settings into the
      // distillation sub-session. Otherwise the user's own hooks (e.g. a Stop
      // hook that plays a sound) and claw-memory's own hooks fire on every
      // spawned sub-session — a beep storm and needless recursion.
      settingSources: [],
      env: buildFullSdkEnv(),
    },
  });

  let text = "";
  for await (const event of sdkStream) {
    const ev = event as {
      type: string;
      message?: { role: string; content: unknown };
    };
    if (ev.type === "assistant" && ev.message?.role === "assistant") {
      const content = ev.message.content;
      if (typeof content === "string") text += content;
      else if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as { type: string; text?: string };
          if (b.type === "text" && b.text) text += b.text;
        }
      }
    }
  }
  return text;
}

async function completeCodexSdk(
  prompt: string,
  model?: string
): Promise<string> {
  // Dynamically imported so the Codex CLI is only spawned when this backend is
  // actually selected. Uses the Codex CLI's stored login (no API key) unless
  // CLAW_MEMORY_CODEX_API_KEY is set. Locked down for a pure text turn:
  // read-only sandbox, no approvals, no network, no web search.
  const { Codex } = await import("@openai/codex-sdk");
  const apiKey = process.env.CLAW_MEMORY_CODEX_API_KEY;
  const codex = new Codex(apiKey ? { apiKey } : {});
  const thread = codex.startThread({
    model: process.env.CLAW_MEMORY_CODEX_MODEL ?? model,
    sandboxMode: "read-only",
    skipGitRepoCheck: true,
    approvalPolicy: "never",
    networkAccessEnabled: false,
    webSearchEnabled: false,
    workingDirectory: os.tmpdir(),
  });
  const result = await thread.run(prompt);
  return result.finalResponse ?? "";
}

async function completeAnthropic(
  prompt: string,
  model: string,
  maxTokens = 1024
): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      "CLAW_MEMORY_LLM_BACKEND=anthropic requires ANTHROPIC_API_KEY"
    );
  }
  const base = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
  const res = await fetch(`${base.replace(/\/$/, "")}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(`anthropic API ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  return (json.content ?? [])
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("");
}

async function completeOpenAi(
  prompt: string,
  model: string | undefined,
  maxTokens = 1024
): Promise<string> {
  const key =
    process.env.CLAW_MEMORY_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      "CLAW_MEMORY_LLM_BACKEND=openai-compatible requires CLAW_MEMORY_OPENAI_API_KEY (or OPENAI_API_KEY)"
    );
  }
  if (!model) {
    throw new Error(
      "CLAW_MEMORY_LLM_BACKEND=openai-compatible requires a model (set CLAW_MEMORY_MODEL)"
    );
  }
  const base =
    process.env.CLAW_MEMORY_OPENAI_BASE_URL ??
    process.env.OPENAI_BASE_URL ??
    "https://api.openai.com/v1";
  const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(`openai-compatible API ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return json.choices?.[0]?.message?.content ?? "";
}
