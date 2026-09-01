import type { ArtifactManifest } from '../artifact.js';
import type { CookieFetchInit, CookieFetchResult } from '../runtime/cookie-fetch.js';

/**
 * IPC protocol between executeArtifact (parent) and the sandbox runner (child).
 * Everything crossing the boundary is JSON — screenshot buffers travel base64.
 *
 * Trust model: the child runs LLM-written artifact code with a clean env and
 * Node's permission model (no fs beyond code + node_modules, no child
 * processes, no workers). The parent keeps everything with authority: the
 * cookie jar and network, robots/budget/politeness gates, zod validation, and
 * the report. Child-side checks are for honest code's control flow only.
 */

export interface SandboxInit {
  type: 'init';
  code: string;
  /** Path the parent already wrote the artifact module to (child only reads it). */
  moduleFile: string;
  manifest: ArtifactManifest;
  inputs: Record<string, string>;
  limits: { maxPages: number; delayMs: number; maxItems?: number };
  pageEvents: boolean;
  screenshots: boolean;
  userAgent: string;
  headers?: Record<string, string>;
  ignoreTlsErrors?: boolean;
  retry: import('../runtime/net.js').ResolvedRetry;
  /** Playwright engine only: browser server to connect to. */
  wsEndpoint?: string;
}

/** Child → parent: request/response calls the parent must execute. */
export type RpcMethod = 'gate' | 'fetch';

export interface RpcRequest {
  type: 'rpc';
  id: number;
  method: RpcMethod;
  params: { url: string; init?: CookieFetchInit };
}

export interface RpcResponse {
  type: 'rpc-result';
  id: number;
  ok: boolean;
  /** For 'fetch' successes. */
  value?: CookieFetchResult;
  /** For failures: message rethrown child-side (robots/budget/network errors). */
  error?: string;
}

/** Child → parent: fire-and-forget notifications. */
export type SandboxNotify =
  | { type: 'notify'; kind: 'item'; schema: string; item: unknown }
  | { type: 'notify'; kind: 'visit'; url: string }
  | { type: 'notify'; kind: 'progress'; message: string; pct?: number }
  | { type: 'notify'; kind: 'log'; level: 'debug' | 'info' | 'warn'; message: string }
  | { type: 'notify'; kind: 'page'; url: string; html: string }
  | { type: 'notify'; kind: 'screenshot'; label: string; base64: string };

/** Child → parent: lifecycle. */
export type SandboxOutcome =
  | { type: 'ready' }
  | { type: 'done' }
  | {
      type: 'crash';
      error: { message: string; stack: string; failedSelector?: string };
      failurePage?: string;
    };

export type ChildMessage = RpcRequest | SandboxNotify | SandboxOutcome;
export type ParentMessage = SandboxInit | RpcResponse;
