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

export interface WebhookDelivery {
  id: number;
  event_type?: string;
  status?: string;
  [key: string]: unknown;
}

export interface WorkflowVersion {
  version?: number;
  [key: string]: unknown;
}

export interface Campaign {
  uuid: string;
  name: string;
  status?: string;
  [key: string]: unknown;
}

export interface Tool {
  uuid: string;
  name: string;
  kind: string;
  [key: string]: unknown;
}

// Named KnowledgeDocument (not `Document`) to avoid shadowing the DOM `Document`
// global that the "DOM" lib pulls in.
export interface KnowledgeDocument {
  id: number;
  name: string;
  [key: string]: unknown;
}

export interface VectorStore {
  uuid: string;
  name: string;
  [key: string]: unknown;
}

export interface ChatToken {
  token: string;
  workflow_uuid: string;
  expires_in: number;
  [key: string]: unknown;
}

const enc = encodeURIComponent;

class Workflows {
  constructor(private readonly client: Glytos) {}

  /** List your agents (prompt agents and visual workflows). */
  list(query?: { archived?: boolean; environment?: string }): Promise<Workflow[]> {
    return this.client.request('GET', '/workflows', { query });
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

  /** Rename an agent (name only; use updateConfig/updateDefinition for the rest). */
  rename(workflowUuid: string, name: string): Promise<Workflow> {
    return this.client.request('PATCH', `/workflows/${enc(workflowUuid)}`, { body: { name } });
  }

  /** Duplicate an agent, returning the new copy. */
  duplicate(workflowUuid: string): Promise<Workflow> {
    return this.client.request('POST', `/workflows/${enc(workflowUuid)}/duplicate`);
  }

  /** Archive an agent (hides it from the default list). */
  archive(workflowUuid: string): Promise<Workflow> {
    return this.client.request('POST', `/workflows/${enc(workflowUuid)}/archive`);
  }

  /** Restore an archived agent. */
  unarchive(workflowUuid: string): Promise<Workflow> {
    return this.client.request('POST', `/workflows/${enc(workflowUuid)}/unarchive`);
  }

  /** Promote an agent into another environment (a move, not a copy). */
  promote(workflowUuid: string, targetEnvironmentId: string): Promise<Workflow> {
    return this.client.request('POST', `/workflows/${enc(workflowUuid)}/promote`, {
      body: { target_environment_id: targetEnvironmentId },
    });
  }

  /** List the saved versions of an agent. */
  versions(workflowUuid: string): Promise<WorkflowVersion[]> {
    return this.client.request('GET', `/workflows/${enc(workflowUuid)}/versions`);
  }

  /** Replace an agent's graph definition. */
  updateDefinition(workflowUuid: string, graph: Record<string, unknown>): Promise<Workflow> {
    return this.client.request('PUT', `/workflows/${enc(workflowUuid)}/definition`, {
      body: { graph },
    });
  }

  /** Replace an agent's config. */
  updateConfig(workflowUuid: string, config: Record<string, unknown>): Promise<Workflow> {
    return this.client.request('PUT', `/workflows/${enc(workflowUuid)}/config`, {
      body: { config },
    });
  }

  /** Start a text/chat session against an agent. */
  startSession(
    workflowUuid: string,
    variables?: Record<string, unknown>,
    version?: number | string,
  ): Promise<Session> {
    const body: Record<string, unknown> = {};
    if (variables !== undefined) body.variables = variables;
    if (version !== undefined) body.version = version;
    return this.client.request('POST', `/workflows/${enc(workflowUuid)}/sessions`, { body });
  }

  /** Send one user message to an existing session and get that turn's reply. */
  sendMessage(
    workflowUuid: string,
    sessionUuid: string,
    content: string,
    images?: string[],
  ): Promise<unknown> {
    const body: Record<string, unknown> = { content };
    if (images !== undefined) body.images = images;
    return this.client.request(
      'POST',
      `/workflows/${enc(workflowUuid)}/sessions/${enc(sessionUuid)}/messages`,
      { body },
    );
  }

  /** Run a one-shot text conversation (list of {role, content}) against an agent. */
  runText(
    workflowUuid: string,
    messages: Array<{ role: string; content: string; [key: string]: unknown }>,
  ): Promise<unknown> {
    return this.client.request('POST', `/workflows/${enc(workflowUuid)}/runs/text`, {
      body: { messages },
    });
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

  /** List the telephony providers available to your account. */
  providers(): Promise<unknown[]> {
    return this.client.request('GET', '/telephony/providers');
  }

  /** Import (connect) a number you already own at a carrier. */
  importNumber(
    e164: string,
    provider?: string,
    providerSid?: string,
    credentials?: Record<string, unknown>,
    workflowUuid?: string,
  ): Promise<PhoneNumber> {
    const body: Record<string, unknown> = { e164 };
    if (provider !== undefined) body.provider = provider;
    if (providerSid !== undefined) body.provider_sid = providerSid;
    if (credentials !== undefined) body.credentials = credentials;
    if (workflowUuid !== undefined) body.workflow_uuid = workflowUuid;
    return this.client.request('POST', '/telephony/numbers/import', { body });
  }

  /** Provision a platform "instant" number (query params, no body). */
  instant(country?: string, provider?: string): Promise<PhoneNumber> {
    const query: Query = {};
    if (country !== undefined) query.country = country;
    if (provider !== undefined) query.provider = provider;
    return this.client.request('POST', '/telephony/numbers/instant', { query });
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

  /** Update a webhook endpoint (only the fields you pass are changed). */
  update(
    endpointId: number | string,
    url?: string,
    events?: string[],
    isActive?: boolean,
    timeoutSeconds?: number,
    headers?: Record<string, string>,
    authHeader?: string,
  ): Promise<WebhookEndpoint> {
    const body: Record<string, unknown> = {};
    if (url !== undefined) body.url = url;
    if (events !== undefined) body.events = events;
    if (isActive !== undefined) body.is_active = isActive;
    if (timeoutSeconds !== undefined) body.timeout_seconds = timeoutSeconds;
    if (headers !== undefined) body.headers = headers;
    if (authHeader !== undefined) body.auth_header = authHeader;
    return this.client.request('PATCH', `/webhooks/endpoints/${enc(String(endpointId))}`, { body });
  }

  /** List recent webhook deliveries (optionally filtered). */
  deliveries(
    eventType?: string,
    status?: string,
    limit?: number,
    offset?: number,
  ): Promise<WebhookDelivery[]> {
    const query: Query = {};
    if (eventType !== undefined) query.event_type = eventType;
    if (status !== undefined) query.status = status;
    if (limit !== undefined) query.limit = limit;
    if (offset !== undefined) query.offset = offset;
    return this.client.request('GET', '/webhooks/deliveries', { query });
  }

  /** Re-send a past webhook delivery. */
  redeliver(deliveryId: number | string): Promise<unknown> {
    return this.client.request('POST', `/webhooks/deliveries/${enc(String(deliveryId))}/redeliver`);
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

class Campaigns {
  constructor(private readonly client: Glytos) {}

  /** List your outbound calling campaigns. */
  list(): Promise<Campaign[]> {
    return this.client.request('GET', '/telephony/campaigns');
  }

  /** Create an outbound calling campaign. */
  create(
    name: string,
    workflowUuid: string,
    fromNumber: string,
    contacts?: Array<Record<string, unknown>>,
  ): Promise<Campaign> {
    const body: Record<string, unknown> = {
      name,
      workflow_uuid: workflowUuid,
      from_number: fromNumber,
    };
    if (contacts !== undefined) body.contacts = contacts;
    return this.client.request('POST', '/telephony/campaigns', { body });
  }

  /** Retrieve a campaign by uuid. */
  retrieve(campaignUuid: string): Promise<Campaign> {
    return this.client.request('GET', `/telephony/campaigns/${enc(campaignUuid)}`);
  }

  /** Start a campaign (begins dialing its contacts). */
  start(campaignUuid: string): Promise<Campaign> {
    return this.client.request('POST', `/telephony/campaigns/${enc(campaignUuid)}/start`);
  }

  /** Load a campaign's contacts from a remote source URL. */
  syncContacts(campaignUuid: string, sourceUrl: string): Promise<unknown> {
    return this.client.request('POST', `/telephony/campaigns/${enc(campaignUuid)}/contacts/sync`, {
      body: { source_url: sourceUrl },
    });
  }
}

class Chat {
  constructor(private readonly client: Glytos) {}

  /** Mint a short-lived chat token scoped to a workflow. */
  token(workflowUuid: string): Promise<ChatToken> {
    return this.client.request('POST', '/chat/token', { body: { workflow_uuid: workflowUuid } });
  }

  /** Send a chat message (authed by the body token, not the API key). */
  messages(
    token: string,
    content: string,
    sessionUuid?: string,
    images?: string[],
  ): Promise<unknown> {
    const body: Record<string, unknown> = { token, content };
    if (sessionUuid !== undefined) body.session_uuid = sessionUuid;
    if (images !== undefined) body.images = images;
    return this.client.request('POST', '/chat/messages', { body });
  }
}

class Tools {
  constructor(private readonly client: Glytos) {}

  /** List your saved tools. */
  list(): Promise<Tool[]> {
    return this.client.request('GET', '/tools');
  }

  /** Create a tool. `kind` is `"http"`, `"static"`, or `"mcp"`. */
  create(
    name: string,
    kind: 'http' | 'static' | 'mcp',
    description?: string,
    config?: Record<string, unknown>,
    parameters?: Record<string, unknown>,
  ): Promise<Tool> {
    const body: Record<string, unknown> = { name, kind };
    if (description !== undefined) body.description = description;
    if (config !== undefined) body.config = config;
    if (parameters !== undefined) body.parameters = parameters;
    return this.client.request('POST', '/tools', { body });
  }

  /** Update a tool (only the fields you pass are changed). */
  update(
    toolUuid: string,
    name?: string,
    description?: string,
    kind?: 'http' | 'static' | 'mcp',
    config?: Record<string, unknown>,
    parameters?: Record<string, unknown>,
  ): Promise<Tool> {
    const body: Record<string, unknown> = {};
    if (name !== undefined) body.name = name;
    if (description !== undefined) body.description = description;
    if (kind !== undefined) body.kind = kind;
    if (config !== undefined) body.config = config;
    if (parameters !== undefined) body.parameters = parameters;
    return this.client.request('PATCH', `/tools/${enc(toolUuid)}`, { body });
  }

  /** Delete a tool. */
  delete(toolUuid: string): Promise<void> {
    return this.client.request('DELETE', `/tools/${enc(toolUuid)}`);
  }
}

class KnowledgeBase {
  constructor(private readonly client: Glytos) {}

  /** List your knowledge-base documents. */
  listDocuments(): Promise<KnowledgeDocument[]> {
    return this.client.request('GET', '/knowledge-base/documents');
  }

  /** Add a document (it is chunked and embedded for retrieval). */
  createDocument(
    name: string,
    content: string,
    chunkSize?: number,
    chunkOverlap?: number,
  ): Promise<KnowledgeDocument> {
    const body: Record<string, unknown> = { name, content };
    if (chunkSize !== undefined) body.chunk_size = chunkSize;
    if (chunkOverlap !== undefined) body.chunk_overlap = chunkOverlap;
    return this.client.request('POST', '/knowledge-base/documents', { body });
  }

  /** Hybrid (vector + full-text) search over your documents. */
  search(
    query: string,
    topK?: number,
    documentIds?: number[],
    minScore?: number,
  ): Promise<unknown[]> {
    const body: Record<string, unknown> = { query };
    if (topK !== undefined) body.top_k = topK;
    if (documentIds !== undefined) body.document_ids = documentIds;
    if (minScore !== undefined) body.min_score = minScore;
    return this.client.request('POST', '/knowledge-base/search', { body });
  }
}

class VectorStores {
  constructor(private readonly client: Glytos) {}

  /** List your vector stores. */
  list(): Promise<VectorStore[]> {
    return this.client.request('GET', '/vector-stores');
  }

  /** Create a vector store. */
  create(name: string): Promise<VectorStore> {
    return this.client.request('POST', '/vector-stores', { body: { name } });
  }

  /** Retrieve a vector store by uuid. */
  retrieve(vectorStoreUuid: string): Promise<VectorStore> {
    return this.client.request('GET', `/vector-stores/${enc(vectorStoreUuid)}`);
  }

  /** Delete a vector store. */
  delete(vectorStoreUuid: string): Promise<void> {
    return this.client.request('DELETE', `/vector-stores/${enc(vectorStoreUuid)}`);
  }
}

class Analytics {
  constructor(private readonly client: Glytos) {}

  /** High-level usage/cost overview for the last `days` days (1-90, default 14). */
  overview(days?: number): Promise<unknown> {
    const query: Query = {};
    if (days !== undefined) query.days = days;
    return this.client.request('GET', '/analytics/overview', { query });
  }
}

export class Glytos {
  readonly workflows: Workflows;
  readonly calls: Calls;
  readonly phoneNumbers: PhoneNumbers;
  readonly sessions: Sessions;
  readonly webhooks: Webhooks;
  readonly campaigns: Campaigns;
  readonly chat: Chat;
  readonly tools: Tools;
  readonly knowledgeBase: KnowledgeBase;
  readonly vectorStores: VectorStores;
  readonly analytics: Analytics;

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
    this.campaigns = new Campaigns(this);
    this.chat = new Chat(this);
    this.tools = new Tools(this);
    this.knowledgeBase = new KnowledgeBase(this);
    this.vectorStores = new VectorStores(this);
    this.analytics = new Analytics(this);
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
