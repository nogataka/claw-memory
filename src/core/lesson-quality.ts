// src/core/lesson-quality.ts
//
// Lesson hygiene over time (design doc section 19 + section 7's quality phase):
//  - confidence decay: lessons not surfaced in a while lose confidence, so
//    stale advice naturally sinks in ranking. Long-lived general knowledge
//    (global / user_preference) decays toward a higher floor.
//  - expiry: lessons past their valid_until are auto-archived.
//  - stale detection: report lessons unused for N days (no mutation).
//
// Intended to run periodically (CLI `claw-memory lessons decay`), not on the
// hot path.

import { sqlite } from "./db.js";
import { listLessons, setStatus, recordEvent, type LessonRow } from "./lessons.js";

const DECAY_FACTOR = Number(process.env.LESSON_DECAY_FACTOR ?? 0.9);
const STALE_DAYS = Number(process.env.LESSON_STALE_DAYS ?? 30);
const FLOOR_DEFAULT = Number(process.env.LESSON_CONFIDENCE_FLOOR ?? 0.2);
// General, broadly-true knowledge shouldn't decay into irrelevance.
const FLOOR_GENERAL = Number(process.env.LESSON_CONFIDENCE_FLOOR_GENERAL ?? 0.5);

function ageDays(ref: string, now: number): number {
  const t = new Date(ref).getTime();
  if (!Number.isFinite(t)) return 0;
  return (now - t) / 86_400_000;
}

function floorFor(scope: string): number {
  return scope === "global" || scope === "user_preference"
    ? FLOOR_GENERAL
    : FLOOR_DEFAULT;
}

export interface DecayResult {
  scanned: number;
  decayed: number;
  archivedExpired: number;
}

export interface DecayOptions {
  factor?: number;
  staleDays?: number;
  dryRun?: boolean;
}

/**
 * Decay confidence of stale candidate/approved lessons and auto-archive expired
 * ones. Returns counts. Idempotent enough to run on a schedule.
 */
export function decayConfidence(opts: DecayOptions = {}): DecayResult {
  const factor = opts.factor ?? DECAY_FACTOR;
  const staleDays = opts.staleDays ?? STALE_DAYS;
  const now = Date.now();
  const result: DecayResult = { scanned: 0, decayed: 0, archivedExpired: 0 };

  const updateConfidence = sqlite.prepare(
    "UPDATE lessons SET confidence = ?, updated_at = ? WHERE id = ?"
  );

  for (const status of ["candidate", "approved"]) {
    for (const l of listLessons({ status }, 100_000)) {
      result.scanned++;

      // Expiry: valid_until in the past → archive.
      if (l.validUntil && new Date(l.validUntil).getTime() < now) {
        if (!opts.dryRun) setStatus(l.id, "archived", "valid_until passed");
        result.archivedExpired++;
        continue;
      }

      const age = ageDays(l.lastUsedAt ?? l.createdAt, now);
      if (age < staleDays) continue;

      const floor = floorFor(l.scope);
      const next = Math.max(floor, Math.round(l.confidence * factor * 10000) / 10000);
      if (next < l.confidence - 1e-9) {
        if (!opts.dryRun) {
          updateConfidence.run(next, new Date().toISOString(), l.id);
          recordEvent(l.id, "decay", {
            note: `confidence ${l.confidence.toFixed(4)}→${next.toFixed(4)} (age ${Math.round(age)}d)`,
          });
        }
        result.decayed++;
      }
    }
  }
  return result;
}

/** Lessons unused for >= `days` (no mutation) — candidates for review/removal. */
export function listStale(days = STALE_DAYS): LessonRow[] {
  const now = Date.now();
  const out: LessonRow[] = [];
  for (const status of ["candidate", "approved"]) {
    for (const l of listLessons({ status }, 100_000)) {
      if (ageDays(l.lastUsedAt ?? l.createdAt, now) >= days) out.push(l);
    }
  }
  return out;
}
