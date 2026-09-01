import type { z } from 'zod';
import type { Artifact } from './artifact.js';

export type Phase = 'scout' | 'codegen' | 'selftest' | 'repair' | 'run' | 'heal';

export type CrawlEvent =
  | { type: 'progress'; phase: Phase; message: string; pct?: number }
  | { type: 'item'; schema: string; item: unknown }
  | { type: 'invalid-item'; schema: string; issues: z.core.$ZodIssue[]; raw: unknown }
  | { type: 'screenshot'; label: string; buffer?: Buffer; path?: string }
  /** Raw page after a successful navigation — opt-in via `pageEvents: true`. */
  | { type: 'page'; phase: Phase; url: string; html: string }
  | { type: 'log'; level: 'debug' | 'info' | 'warn'; message: string }
  | { type: 'llm-usage'; phase: Phase; inputTokens: number; outputTokens: number }
  /** A heal pass produced a repaired artifact — persist it to keep the fix. */
  | { type: 'artifact-updated'; artifact: Artifact }
  | { type: 'error'; error: Error };

export type CrawlEventType = CrawlEvent['type'];
export type CrawlEventOf<T extends CrawlEventType> = Extract<CrawlEvent, { type: T }>;
