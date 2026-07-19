/**
 * @glytos/node - the official Glytos server SDK for Node.js and TypeScript.
 *
 * Use it from your backend with an API key. Never ship an API key to the browser;
 * for in-browser voice use `@glytos/web` with a short-lived, workflow-scoped token
 * you mint here via `calls.webToken(...)`.
 *
 * ```ts
 * import { Glytos } from '@glytos/node';
 *
 * const glytos = new Glytos(process.env.GLYTOS_API_KEY!);
 *
 * const agents = await glytos.workflows.list();
 * const { token, ws_url } = await glytos.calls.webToken({ workflow_uuid: agents[0].uuid });
 * ```
 *
 * Every resource method is a thin, typed wrapper over the REST API. For endpoints
 * without a dedicated helper, call `glytos.request(method, path, { body, query })`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_BASE_URL = 'https://api.glytos.com/api/v1';

export interface GlytosOptions {
  /** Your organization API key (starts with `gly_`). */
  apiKey: string;
  /** Override the API base URL (e.g. a regional stack). Defaults to the public API. */
  baseUrl?: string;
  /**
   * The environment to act in: `"dev"`, `"staging"`, `"prod"`, or an environment
   * uuid. Defaults to the organization's default environment (Development). Agents
   * are still created in Development regardless of this; it scopes reads and calls.
   */
  environment?: string;
  /** Custom fetch implementation. Defaults to the global `fetch` (Node 18+). */
  fetch?: typeof fetch;
}

/** Thrown on any non-2xx API response. Carries the API error `code` and status. */
export class GlytosError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;

  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message);
    this.name = 'GlytosError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

type Primitive = string | number | boolean;
export type Query = Record<string, Primitive | undefined | null>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
}

// Entity shapes carry the fields you rely on plus an index signature, so they stay
// forward-compatible as the API grows (new fields never break your build).
export interface Workflow {
  uuid: string;
  name: string;
  mode: string;
  status?: string;
  archived?: boolean;
  [key: string]: unknown;
}

export interface Call {
  uuid: string;
  status: string;
  [key: string]: unknown;
}

export interface WebCallToken {
  token: string;
  ws_url: string;
  [key: string]: unknown;
}

export interface PhoneNumber {
  uuid: string;
  e164: string;
  [key: string]: unknown;
}

export interface Session {
  session_uuid: string;
  workflow_uuid?: string;
  mode?: string;
  status: string;
  created_at?: string;
  [key: string]: unknown;
}

export interface WebhookEndpoint {
  id: number;
  url: string;
  events: string[];
  [key: string]: unknown;
}

const enc = encodeURIComponent;

class Workflows {
  constructor(private readonly client: Glytos) {}

  /** List your agents (prompt agents and visual workflows). */
  list(): Promise<Workflow[]> {
    return this.client.request('GET', '/workflows');
  }

  /** Retrieve a single agent by uuid. */
  retrieve(workflowUuid: string): Promise<Workflow> {
    return this.client.request('GET', `/workflows/${enc(workflowUuid)}`);
  }

  /** Create an agent. `mode` is `"prompt"` (default) or `"workflow"`. */
  create(body: {
    name: string;
    mode?: 'prompt' | 'workflow';
    config?: Record<string, unknown>;
  }): Promise<Workflow> {
    return this.client.request('POST', '/workflows', { body });
  }

  /** Publish the current draft so the agent goes live. */
  publish(workflowUuid: string): Promise<Workflow> {
    return this.client.request('POST', `/workflows/${enc(workflowUuid)}/publish`);
  }

  /** Delete an agent. */
  delete(workflowUuid: string): Promise<void> {
    return this.client.request('DELETE', `/workflows/${enc(workflowUuid)}`);
  }

  /** Ready-made starter workflow graphs. */
  templates(): Promise<Workflow[]> {
    return this.client.request('GET', '/workflows/templates');
  }

  /** Full detail for one session of an agent (transcript, cost, latency, ...). */
  session(workflowUuid: string, sessionUuid: string): Promise<Session> {
    return this.client.request(
      'GET',
      `/workflows/${enc(workflowUuid)}/sessions/${enc(sessionUuid)}`,
    );
  }

  /** The run-event log for a session (routing decisions, tool calls, ...). */
  sessionEvents(workflowUuid: string, sessionUuid: string): Promise<unknown[]> {
    return this.client.request(
      'GET',
      `/workflows/${enc(workflowUuid)}/sessions/${enc(sessionUuid)}/events`,
    );
  }
}

class Calls {
  constructor(private readonly client: Glytos) {}

  /** Start an outbound phone call, or run a transient agent. */
  create(body: Record<string, unknown>): Promise<Call> {
    return this.client.request('POST', '/calls', { body });
  }

  /** List calls. */
  list(query?: Query): Promise<Call[]> {
    return this.client.request('GET', '/calls', { query });
  }

  /** Retrieve a call by uuid. */
  retrieve(callUuid: string): Promise<Call> {
    return this.client.request('GET', `/calls/${enc(callUuid)}`);
  }

  /**
   * Mint a short-lived, workflow-scoped token for an in-browser web call. Hand the
   * returned `{ token, ws_url }` to the browser and connect with `@glytos/web`.
   */
  webToken(body: {
    workflow_uuid?: string;
    agent?: Record<string, unknown>;
  }): Promise<WebCallToken> {
    return this.client.request('POST', '/calls/web-token', { body });
  }

  /** Control an in-progress call (e.g. transfer, hang up). */
  control(callUuid: string, body: Record<string, unknown>): Promise<unknown> {
    return this.client.request('POST', `/calls/${enc(callUuid)}/control`, { body });
  }
}

class PhoneNumbers {
  constructor(private readonly client: Glytos) {}

  /** Search carrier inventory for available numbers. */
  search(query: Query): Promise<unknown[]> {
    return this.client.request('GET', '/telephony/numbers/search', { query });
  }

  /** List the numbers on your account. */
  list(): Promise<PhoneNumber[]> {
    return this.client.request('GET', '/telephony/numbers');
  }

  /** Provision (buy) a number by its e164 value. */
  provision(body: { e164: string; [key: string]: unknown }): Promise<PhoneNumber> {
    return this.client.request('POST', '/telephony/numbers', { body });
  }

  /** Assign a number to an agent. */
  assign(numberUuid: string, body: Record<string, unknown>): Promise<PhoneNumber> {
    return this.client.request('POST', `/telephony/numbers/${enc(numberUuid)}/assign`, { body });
  }

  /** Release (delete) a number. */
  release(numberUuid: string): Promise<void> {
    return this.client.request('DELETE', `/telephony/numbers/${enc(numberUuid)}`);
  }
}

class Sessions {
  constructor(private readonly client: Glytos) {}

  /** List sessions across your agents. */
  list(query?: Query): Promise<Session[]> {
    return this.client.request('GET', '/sessions', { query });
  }
}

class Webhooks {
  constructor(private readonly client: Glytos) {}

  /** List your webhook endpoints. */
  list(): Promise<WebhookEndpoint[]> {
    return this.client.request('GET', '/webhooks/endpoints');
  }

  /** Create a webhook endpoint subscribed to the given events. */
  create(body: { url: string; events: string[]; [key: string]: unknown }): Promise<WebhookEndpoint> {
    return this.client.request('POST', '/webhooks/endpoints', { body });
  }

  /** Delete a webhook endpoint. */
  delete(endpointId: number | string): Promise<void> {
    return this.client.request('DELETE', `/webhooks/endpoints/${enc(String(endpointId))}`);
  }

  /** The catalog of webhook event types you can subscribe to. */
  events(): Promise<unknown[]> {
    return this.client.request('GET', '/webhooks/events');
  }

  /**
   * Verify a webhook delivery signature. Pass the RAW request body (string or
   * Buffer), the `X-Glytos-Signature` header value, and the endpoint secret.
   * Returns true only if the signature is valid and within the tolerance window.
   */
  verify(
    payload: string | Buffer,
    signatureHeader: string,
    secret: string,
    toleranceSeconds = 300,
  ): boolean {
    return verifyWebhook(payload, signatureHeader, secret, toleranceSeconds);
  }
}

export class Glytos {
  readonly workflows: Workflows;
  readonly calls: Calls;
  readonly phoneNumbers: PhoneNumbers;
  readonly sessions: Sessions;
  readonly webhooks: Webhooks;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly environment?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GlytosOptions | string) {
    const opts: GlytosOptions = typeof options === 'string' ? { apiKey: options } : options;
    if (!opts.apiKey) throw new Error('Glytos: an apiKey is required');
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.environment = opts.environment;
    const fetchImpl = opts.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new Error('Glytos: no global fetch found; upgrade to Node 18+ or pass options.fetch');
    }
    this.fetchImpl = fetchImpl;

    this.workflows = new Workflows(this);
    this.calls = new Calls(this);
    this.phoneNumbers = new PhoneNumbers(this);
    this.sessions = new Sessions(this);
    this.webhooks = new Webhooks(this);
  }

  /**
   * Low-level request against any API endpoint. Path is relative to the API base
   * (e.g. `"/workflows"`). Throws `GlytosError` on a non-2xx response.
   */
  async request<T = unknown>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      'X-API-Key': this.apiKey,
      Accept: 'application/json',
    };
    if (this.environment) headers['X-Environment-Id'] = this.environment;
    const init: RequestInit = { method, headers };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    const response = await this.fetchImpl(url.toString(), init);
    const requestId = response.headers.get('x-request-id') ?? undefined;
    const text = await response.text();
    const data = text ? safeParse(text) : undefined;

    if (!response.ok) {
      const error = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
      throw new GlytosError(
        response.status,
        error?.code ?? 'error',
        error?.message ?? (response.statusText || 'Request failed'),
        requestId,
      );
    }
    return data as T;
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Standalone webhook signature verifier (also available as `glytos.webhooks.verify`).
 * Matches the server scheme: HMAC-SHA256 over `"{timestamp}.{body}"`, sent as
 * `X-Glytos-Signature: t=<ts>,v1=<hex>`.
 */
export function verifyWebhook(
  payload: string | Buffer,
  signatureHeader: string,
  secret: string,
  toleranceSeconds = 300,
): boolean {
  const parts: Record<string, string> = {};
  for (const piece of signatureHeader.split(',')) {
    const idx = piece.indexOf('=');
    if (idx > 0) parts[piece.slice(0, idx).trim()] = piece.slice(idx + 1).trim();
  }
  const timestamp = parts['t'];
  const provided = parts['v1'];
  if (!timestamp || !provided) return false;

  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const signed = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body]);
  const expected = createHmac('sha256', secret).update(signed).digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  if (expectedBuf.length !== providedBuf.length) return false;
  if (!timingSafeEqual(expectedBuf, providedBuf)) return false;

  if (toleranceSeconds > 0) {
    const ts = Number.parseInt(timestamp, 10);
    if (!Number.isFinite(ts)) return false;
    if (Math.abs(Date.now() / 1000 - ts) > toleranceSeconds) return false;
  }
  return true;
}

export default Glytos;
