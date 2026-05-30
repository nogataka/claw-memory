// src/core/projects.ts
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sqlite } from "./db.js";

export interface ProjectRow {
  id: string;
  name: string;
  path: string;
  created_at: string;
  last_accessed_at: string;
}

export function getProjectByPath(p: string): ProjectRow | undefined {
  return sqlite
    .prepare("SELECT * FROM projects WHERE path = ?")
    .get(p) as ProjectRow | undefined;
}

export function getProject(id: string): ProjectRow | undefined {
  return sqlite
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(id) as ProjectRow | undefined;
}

export function listProjects(): ProjectRow[] {
  return sqlite
    .prepare("SELECT * FROM projects ORDER BY last_accessed_at DESC")
    .all() as ProjectRow[];
}

/**
 * Resolve a working directory to a stable project record, creating it on first
 * sight. Paths are normalized with path.resolve so symlink/trailing-slash
 * variants don't fork into separate projects.
 */
export function getOrCreateProjectByPath(cwd: string): ProjectRow {
  const normalized = path.resolve(cwd);
  const existing = getProjectByPath(normalized);
  const now = new Date().toISOString();
  if (existing) {
    sqlite
      .prepare("UPDATE projects SET last_accessed_at = ? WHERE id = ?")
      .run(now, existing.id);
    return existing;
  }
  const row: ProjectRow = {
    id: randomUUID(),
    name: path.basename(normalized) || normalized,
    path: normalized,
    created_at: now,
    last_accessed_at: now,
  };
  sqlite
    .prepare(
      "INSERT INTO projects(id, name, path, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(row.id, row.name, row.path, row.created_at, row.last_accessed_at);
  return row;
}
