// src/core/providers.ts
//
// Minimal LLM provider env for the Claude Agent SDK (used only by distill).
// Default: Claude with the CLI's stored credentials. Override model with
// AGENT_SDK_MODEL; for non-default endpoints set ANTHROPIC_BASE_URL /
// ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY in the environment.

export function getModel(): string {
  return process.env.AGENT_SDK_MODEL ?? "claude-sonnet-4-5";
}

/** Inherit process.env minus Claude Code's own injected vars (avoid recursion). */
export function buildFullSdkEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("CLAUDE_CODE_") && k !== "CLAUDECODE") {
      env[k] = v;
    }
  }
  return env;
}
