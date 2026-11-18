// http.ts — small shared helpers for the HTTP adapters: body reading, JSON
// answers with the headers the wire contract requires on every reply.

import type { IncomingMessage, ServerResponse } from 'node:http';

import { ForgeError } from './core.ts';

let requestCounter = 0;

/** The next deterministic request id (non-empty on every API reply). */
export function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

/** Read a whole request body (bodies in this contest are small). */
export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > 64 * 1024 * 1024) throw new ForgeError(413, 'Request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Read and parse a JSON body; a malformed body is the contract's 400. */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    throw new ForgeError(400, 'Problems parsing JSON');
  }
}

/** Send a JSON answer with the standard API headers. */
export function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = value === undefined ? '' : JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(body);
}

/** Send a plain answer (git endpoints, healthz) without JSON wrapping. */
export function sendRaw(res: ServerResponse, status: number, body: Buffer | string, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'x-github-request-id': nextRequestId() });
  res.end(body);
}

/** Whether a value is a plain record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A string field of a record, or the fallback when absent/not a string. */
export function strField(record: Record<string, unknown>, key: string, fallback = ''): string {
  const value = record[key];
  return typeof value === 'string' ? value : fallback;
}

/** Translate a thrown error into the JSON error shape the contract uses. */
export function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof ForgeError) {
    sendJson(res, error.status, { message: error.message });
    return;
  }
  sendJson(res, 500, { message: 'Internal Server Error' });
}
