import type { FastifyInstance } from 'fastify';
import { TransientError } from '../core/errors.js';
import { LOST_RESPONSE_HEADER } from '../core/vendor.js';

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * The connectors only depend on this interface, so the same client code runs against:
 *  - real HTTP (fetch) in the demo and in production, and
 *  - in-process Fastify `inject()` in tests and simulations (no sockets, fully deterministic).
 */
export interface Transport {
  request(req: HttpRequest): Promise<HttpResponse>;
}

function url(path: string, query?: Record<string, string>): string {
  const qs = query ? new URLSearchParams(query).toString() : '';
  return qs ? `${path}?${qs}` : path;
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Chaos shim: a mock can mark a response as "lost" — the server committed the write but we
 * behave exactly as if the TCP connection died before the response arrived.
 */
function checkLost(headers: Record<string, string>, system: string): void {
  if (headers[LOST_RESPONSE_HEADER]) throw new TransientError(`${system}: connection reset after request was sent`, system, true);
}

export function fetchTransport(baseUrl: string, system: string, timeoutMs = 5000): Transport {
  baseUrl = baseUrl.replace(/\/+$/, ''); // tolerate a pasted trailing slash
  return {
    async request(req) {
      let res: Response;
      try {
        res = await fetch(baseUrl + url(req.path, req.query), {
          method: req.method,
          headers: { accept: 'application/json', ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}), ...req.headers },
          body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        // Timeouts/resets on a write are ambiguous: the server may have applied it.
        throw new TransientError(`${system}: ${(e as Error).name}: ${(e as Error).message}`, system, req.method !== 'GET');
      }
      const headers = Object.fromEntries(res.headers.entries());
      checkLost(headers, system);
      return { status: res.status, headers, body: parseBody(await res.text()) };
    },
  };
}

export function injectTransport(app: FastifyInstance, system: string): Transport {
  return {
    async request(req) {
      const res = await app.inject({
        method: req.method,
        url: url(req.path, req.query),
        headers: { ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}), ...req.headers },
        payload: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      });
      const headers = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, String(v)]));
      checkLost(headers, system);
      return { status: res.statusCode, headers, body: parseBody(res.body) };
    },
  };
}
