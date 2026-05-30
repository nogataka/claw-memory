// src/core/private.ts
//
// Remove <private>…</private> spans from text before it is persisted or sent to
// an LLM. Case-insensitive, multiline, non-greedy.

const PRIVATE_RE = /<private>[\s\S]*?<\/private>/gi;

export function stripPrivate(text: string): string {
  return text.replace(PRIVATE_RE, "").trim();
}
