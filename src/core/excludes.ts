// src/core/excludes.ts
//
// Project exclusion: paths matching CLAW_MEMORY_EXCLUDED_PROJECTS (comma or
// path-separator separated substrings) are never recorded or recalled.

function patterns(): string[] {
  const raw = process.env.CLAW_MEMORY_EXCLUDED_PROJECTS ?? "";
  return raw
    .split(/[,:]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isExcludedPath(cwd: string): boolean {
  if (!cwd) return false;
  return patterns().some((p) => cwd.includes(p));
}
