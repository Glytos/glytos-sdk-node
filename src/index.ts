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

export interface AgentFolder {
  uuid: string;
  name: string;
  [key: string]: unknown;
}

export interface ChatFile {
  file_uuid: string;
  filename: string;
  characters: number;
  [key: string]: unknown;
}

/** One entry of a conversation. */
export interface Message {
  role: string;
  content: string;
  ts?: string | null;
  node_id?: string | null;
  images?: string[] | null;
  [key: string]: unknown;
}

/**
 * A conversation with an agent. Created against one agent and carrying its id, so
 * every later call knows which agent to run without a second lookup.
 */
export interface Thread {
  /** The conversation id. */
  id: string;
  /** The agent this conversation belongs to. */
  agent: string;
  status: string;
  /** Anything the agent opened with (a greeting), empty for a silent opening. */
  messages: Message[];
  [key: string]: unknown;
}

/** A thread plus everything recorded about it: full transcript, variables, cost. */
export interface ThreadDetail {
  id: string;
  agent: string;
  status: string;
  messages: Message[];
  variables: Record<string, unknown>;
  cost?: unknown;
  created_at?: string;
  [key: string]: unknown;
}

/** The result of one turn: what the agent said back, and where the flow now sits. */
export interface Run {
  status: string;
  /** Only THIS turn's reply - the thread holds the whole conversation. */
  messages: Message[];
  current_node_id?: string | null;
  [key: string]: unknown;
}

/** A single Server-Sent Event from a streamed turn. */
export type StreamEvent =
  /** One piece of the reply as it is written. */
  | { type: 'token'; delta: string }
  /** The turn finished; carries the same payload a non-streamed turn returns. */
  | { type: 'done'; run: Run }
  /** The turn failed. */
  | { type: 'error'; message: string };

/** Accepts the object `threads.create` returned, or the two ids spelled out. */
export type ThreadRef = Thread | ThreadDetail | { id: string; agent: string };

export interface TurnInput {
  content?: string;
  /** Image references (data: URIs or URLs) for this turn only. */
  images?: string[];
  /**
   * Extra context for THIS turn only, applied below the agent's own instructions
   * and never saved to the agent.
   */
  instructions?: string;
}

const enc = encodeURIComponent;

/**
 * Normalize a list response to a plain array. Most list endpoints return a bare
 * array, but the paginated ones wrap results in a `{ items, total, limit, offset }`
 * envelope; this returns the array either way so the declared return type holds.
 */
function toList<T>(resp: unknown): T[] {
  if (Array.isArray(resp)) return resp as T[];
  const wrapped = (resp as { items?: unknown } | null | undefined)?.items;
  return Array.isArray(wrapped) ? (wrapped as T[]) : [];
}

/** The ids behind a thread reference, whichever form the caller passed. */
function threadIds(thread: ThreadRef): { agent: string; id: string } {
  const agent = String(thread.agent ?? '');
  const id = String(thread.id ?? '');
  if (!agent || !id) {
    throw new Error('Glytos: a thread reference needs both `id` and `agent`');
  }
  return { agent, id };
}

/** Whatever the caller handed us as a file, as something FormData accepts. */
function toBlob(file: Blob | ArrayBuffer | Uint8Array | string): Blob {
  if (typeof file === 'string') return new Blob([file]);
  if (file instanceof Blob) return file;
  return new Blob([file as BlobPart]);
}

/** The turn body shared by the plain and the streamed endpoint. */
function turnBody(input: TurnInput | string): Record<string, unknown> {
  const turn: TurnInput = typeof input === 'string' ? { content: input } : input;
  const body: Record<string, unknown> = { content: turn.content ?? '' };
  if (turn.images !== undefined) body.images = turn.images;
  if (turn.instructions !== undefined) body.additional_instructions = turn.instructions;
  return body;
}

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
    body?: { variables?: Record<string, unknown>; version?: number | string },
  ): Promise<Session> {
    return this.client.request('POST', `/workflows/${enc(workflowUuid)}/sessions`, {
      body: body ?? {},
    });
  }

  /** Send one user message to an existing session and get that turn's reply. */
  sendMessage(
    workflowUuid: string,
    sessionUuid: string,
    input: TurnInput | string,
    images?: string[],
  ): Promise<Run> {
    const turn: TurnInput = typeof input === 'string' ? { content: input } : input;
    if (images !== undefined && turn.images === undefined) turn.images = images;
    return this.client.request(
      'POST',
      `/workflows/${enc(workflowUuid)}/sessions/${enc(sessionUuid)}/messages`,
      { body: turnBody(turn) },
    );
  }

  /** The same turn, delivered as it is written. */
  streamMessage(
    workflowUuid: string,
    sessionUuid: string,
    input: TurnInput | string,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    return this.client.stream(
      'POST',
      `/workflows/${enc(workflowUuid)}/sessions/${enc(sessionUuid)}/messages/stream`,
      { body: turnBody(input) },
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

  /** List calls (paginated endpoint; the items are returned). */
  list(query?: Query): Promise<Call[]> {
    return this.client.request('GET', '/calls', { query }).then((r) => toList<Call>(r));
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
  importNumber(body: {
    e164: string;
    provider?: string;
    provider_sid?: string;
    credentials?: Record<string, unknown>;
    workflow_uuid?: string;
  }): Promise<PhoneNumber> {
    return this.client.request('POST', '/telephony/numbers/import', { body });
  }

  /** Provision a platform "instant" number (query params, no body). */
  instant(query?: { country?: string; provider?: string }): Promise<PhoneNumber> {
    return this.client.request('POST', '/telephony/numbers/instant', { query: query ?? {} });
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
    body: {
      url?: string;
      events?: string[];
      is_active?: boolean;
      timeout_seconds?: number;
      headers?: Record<string, string>;
      auth_header?: string;
    },
  ): Promise<WebhookEndpoint> {
    return this.client.request('PATCH', `/webhooks/endpoints/${enc(String(endpointId))}`, { body });
  }

  /** List recent webhook deliveries (optionally filtered). */
  deliveries(query?: {
    event_type?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<WebhookDelivery[]> {
    return this.client
      .request('GET', '/webhooks/deliveries', { query: query ?? {} })
      .then((r) => toList<WebhookDelivery>(r));
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
  create(body: {
    name: string;
    workflow_uuid: string;
    from_number: string;
    contacts?: Array<Record<string, unknown>>;
  }): Promise<Campaign> {
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
  messages(body: {
    token: string;
    content: string;
    session_uuid?: string;
    images?: string[];
  }): Promise<unknown> {
    return this.client.request('POST', '/chat/messages', { body });
  }

  /** The same turn, delivered as it is written. */
  stream(body: {
    token: string;
    content: string;
    session_uuid?: string;
    images?: string[];
  }): AsyncGenerator<StreamEvent, void, undefined> {
    return this.client.stream('POST', '/chat/stream', { body });
  }

  /**
   * Attach a file to one conversation. Its text is put in front of the agent for
   * that conversation only - it does not join the knowledge base.
   */
  uploadFile(body: {
    token: string;
    sessionUuid: string;
    file: Blob | ArrayBuffer | Uint8Array | string;
    filename?: string;
  }): Promise<ChatFile> {
    const form = new FormData();
    form.set('token', body.token);
    form.set('session_uuid', body.sessionUuid);
    form.set('file', toBlob(body.file), body.filename ?? 'file');
    return this.client.requestForm('POST', '/chat/files', form);
  }
}

/**
 * Conversations with a text agent, in the vocabulary the rest of the industry uses:
 * a thread holds the conversation, a run is one turn on it.
 *
 * This is the same session API `glytos.agents` exposes, shaped so code written
 * against a thread/run model reads the same here. A thread is created against one
 * agent and carries its id, so no later call has to repeat it.
 */
class Threads {
  readonly messages: ThreadMessages;
  readonly runs: ThreadRuns;

  constructor(private readonly client: Glytos) {
    this.messages = new ThreadMessages(client);
    this.runs = new ThreadRuns(client);
  }

  /** Open a conversation with an agent. */
  async create(body: {
    agent: string;
    variables?: Record<string, unknown>;
    /** Run a specific agent version instead of the current one. */
    version?: number | string;
  }): Promise<Thread> {
    const { agent, ...rest } = body;
    const started = await this.client.request<{
      session_uuid: string;
      status: string;
      messages?: Message[];
    }>('POST', `/workflows/${enc(agent)}/sessions`, { body: rest });
    return {
      id: started.session_uuid,
      agent,
      status: started.status,
      messages: started.messages ?? [],
    };
  }

  /** The conversation so far, with its variables and cost. */
  async retrieve(thread: ThreadRef): Promise<ThreadDetail> {
    const { agent, id } = threadIds(thread);
    const detail = await this.client.request<{
      session_uuid: string;
      status: string;
      transcript?: Message[];
      variables?: Record<string, unknown>;
      [key: string]: unknown;
    }>('GET', `/workflows/${enc(agent)}/sessions/${enc(id)}`);
    const { session_uuid, transcript, variables, ...rest } = detail;
    return {
      ...rest,
      id: session_uuid,
      agent,
      status: detail.status,
      messages: transcript ?? [],
      variables: variables ?? {},
    };
  }
}

class ThreadMessages {
  constructor(private readonly client: Glytos) {}

  /**
   * Add a user message and run the agent on it. Returns that turn's reply.
   *
   * Async so a malformed thread reference rejects like every other failure here,
   * rather than throwing synchronously past a caller's `.catch()`.
   */
  async create(thread: ThreadRef, input: TurnInput | string): Promise<Run> {
    const { agent, id } = threadIds(thread);
    return this.client.request('POST', `/workflows/${enc(agent)}/sessions/${enc(id)}/messages`, {
      body: turnBody(input),
    });
  }

  /** Every message in the conversation, oldest first. */
  async list(thread: ThreadRef): Promise<Message[]> {
    const { agent, id } = threadIds(thread);
    const detail = await this.client.request<{ transcript?: Message[] }>(
      'GET',
      `/workflows/${enc(agent)}/sessions/${enc(id)}`,
    );
    return detail.transcript ?? [];
  }
}

class ThreadRuns {
  constructor(private readonly client: Glytos) {}

  /**
   * Run one turn and wait for it. A turn completes before it returns, so there is
   * no run to poll: the reply is already in the result.
   */
  async create(thread: ThreadRef, input: TurnInput | string = {}): Promise<Run> {
    const { agent, id } = threadIds(thread);
    return this.client.request('POST', `/workflows/${enc(agent)}/sessions/${enc(id)}/messages`, {
      body: turnBody(input),
    });
  }

  /**
   * The same turn, delivered as it is written. A bad thread reference surfaces on
   * the first iteration rather than at call time, which is how a generator is
   * expected to report a problem.
   */
  async *stream(
    thread: ThreadRef,
    input: TurnInput | string = {},
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const { agent, id } = threadIds(thread);
    yield* this.client.stream(
      'POST',
      `/workflows/${enc(agent)}/sessions/${enc(id)}/messages/stream`,
      { body: turnBody(input) },
    );
  }
}

class Folders {
  constructor(private readonly client: Glytos) {}

  /** Folders in the active environment. */
  list(): Promise<AgentFolder[]> {
    return this.client.request('GET', '/agent-folders');
  }

  /** Create a folder in the active environment. */
  create(name: string): Promise<AgentFolder> {
    return this.client.request('POST', '/agent-folders', { body: { name } });
  }

  /** Rename a folder. */
  rename(folderUuid: string, name: string): Promise<AgentFolder> {
    return this.client.request('PATCH', `/agent-folders/${enc(folderUuid)}`, { body: { name } });
  }

  /** Delete a folder. The agents filed in it are deleted with it. */
  delete(folderUuid: string): Promise<void> {
    return this.client.request('DELETE', `/agent-folders/${enc(folderUuid)}`);
  }
}

class Imports {
  constructor(private readonly client: Glytos) {}

  /** The platforms an agent can be brought over from. */
  sources(): Promise<unknown[]> {
    return this.client.request('GET', '/imports/sources');
  }

  /** Bring an agent over from another platform's export. */
  create(source: string, payload: Record<string, unknown>): Promise<unknown> {
    return this.client.request('POST', `/imports/${enc(source)}`, { body: { payload } });
  }

  /** Bring over an assistant definition, tools and all. */
  assistant(assistant: Record<string, unknown>): Promise<unknown> {
    return this.client.request('POST', '/imports/openai-assistant', { body: { assistant } });
  }
}

class Tools {
  constructor(private readonly client: Glytos) {}

  /** List your saved tools. */
  list(): Promise<Tool[]> {
    return this.client.request('GET', '/tools');
  }

  /** Create a tool. `kind` is `"http"`, `"static"`, or `"mcp"`. */
  create(body: {
    name: string;
    kind: 'http' | 'static' | 'mcp';
    description?: string;
    config?: Record<string, unknown>;
    parameters?: Record<string, unknown>;
  }): Promise<Tool> {
    return this.client.request('POST', '/tools', { body });
  }

  /** Update a tool (only the fields you pass are changed). */
  update(
    toolUuid: string,
    body: {
      name?: string;
      description?: string;
      kind?: 'http' | 'static' | 'mcp';
      config?: Record<string, unknown>;
      parameters?: Record<string, unknown>;
    },
  ): Promise<Tool> {
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
  createDocument(body: {
    name: string;
    content: string;
    chunk_size?: number;
    chunk_overlap?: number;
  }): Promise<KnowledgeDocument> {
    return this.client.request('POST', '/knowledge-base/documents', { body });
  }

  /** Upload a document file (txt, md, pdf) instead of pasting its text. */
  uploadDocument(
    file: Blob | ArrayBuffer | Uint8Array | string,
    filename = 'document',
  ): Promise<KnowledgeDocument> {
    const form = new FormData();
    form.set('file', toBlob(file), filename);
    return this.client.requestForm('POST', '/knowledge-base/documents/upload', form);
  }

  /** Hybrid (vector + full-text) search over your documents. */
  search(body: {
    query: string;
    top_k?: number;
    document_ids?: number[];
    min_score?: number;
  }): Promise<unknown[]> {
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
  create(body: { name: string }): Promise<VectorStore> {
    return this.client.request('POST', '/vector-stores', { body });
  }

  /** Retrieve a vector store by uuid. */
  retrieve(vectorStoreUuid: string): Promise<VectorStore> {
    return this.client.request('GET', `/vector-stores/${enc(vectorStoreUuid)}`);
  }

  /** Delete a vector store. */
  delete(vectorStoreUuid: string): Promise<void> {
    return this.client.request('DELETE', `/vector-stores/${enc(vectorStoreUuid)}`);
  }

  /** Add a document file to a vector store, so an agent can search it. */
  uploadDocument(
    vectorStoreUuid: string,
    file: Blob | ArrayBuffer | Uint8Array | string,
    filename = 'document',
  ): Promise<KnowledgeDocument> {
    const form = new FormData();
    form.set('file', toBlob(file), filename);
    return this.client.requestForm(
      'POST',
      `/vector-stores/${enc(vectorStoreUuid)}/documents/upload`,
      form,
    );
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
  /**
   * The same resource as `workflows`, under the word the product and the docs use.
   * Both names stay so existing code keeps working.
   */
  readonly agents: Workflows;
  /** Conversations with a text agent, in thread/run vocabulary. */
  readonly threads: Threads;
  /** Folders that group agents inside an environment. */
  readonly folders: Folders;
  /** Bring an agent over from another platform. */
  readonly imports: Imports;
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
    this.agents = this.workflows;
    this.threads = new Threads(this);
    this.folders = new Folders(this);
    this.imports = new Imports(this);
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

  /**
   * Upload a file. Separate from `request` because the body is multipart, so the
   * Content-Type has to carry the boundary fetch generates - setting it by hand
   * produces a body the server cannot parse.
   */
  async requestForm<T = unknown>(method: string, path: string, form: FormData): Promise<T> {
    const headers: Record<string, string> = {
      'X-API-Key': this.apiKey,
      Accept: 'application/json',
    };
    if (this.environment) headers['X-Environment-Id'] = this.environment;

    const response = await this.fetchImpl(this.baseUrl + path, { method, headers, body: form });
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

  /**
   * Stream a Server-Sent Events endpoint, yielding one parsed event at a time.
   *
   * The reply arrives as it is written rather than after the last token, which is
   * the whole difference on a long answer. The terminal `done` event carries the
   * same payload the non-streamed call returns, so a caller can render the deltas
   * and still end up with the authoritative result.
   */
  async *stream(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const url = new URL(this.baseUrl + path);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }
    const headers: Record<string, string> = {
      'X-API-Key': this.apiKey,
      Accept: 'text/event-stream',
    };
    if (this.environment) headers['X-Environment-Id'] = this.environment;
    const init: RequestInit = { method, headers };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    const response = await this.fetchImpl(url.toString(), init);
    if (!response.ok) {
      const text = await response.text();
      const error = (safeParse(text) as { error?: { code?: string; message?: string } } | undefined)
        ?.error;
      throw new GlytosError(
        response.status,
        error?.code ?? 'error',
        error?.message ?? (response.statusText || 'Request failed'),
        response.headers.get('x-request-id') ?? undefined,
      );
    }
    if (!response.body) return;

    const decoder = new TextDecoder();
    let buffer = '';
    // @ts-expect-error - Node's ReadableStream is async-iterable at runtime; the DOM
    // lib's type for it is not, and iterating is the portable way to read it.
    for await (const chunk of response.body) {
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      // Events are separated by a blank line; keep the trailing partial in the buffer.
      let split = buffer.indexOf('\n\n');
      while (split !== -1) {
        const event = parseSse(buffer.slice(0, split));
        if (event) yield event;
        buffer = buffer.slice(split + 2);
        split = buffer.indexOf('\n\n');
      }
    }
    const last = parseSse(buffer);
    if (last) yield last;
  }
}

/** Turn one raw SSE block ("event: x\ndata: {...}") into a typed event. */
function parseSse(block: string): StreamEvent | null {
  let name = '';
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!name || dataLines.length === 0) return null;
  const data = safeParse(dataLines.join('\n')) as Record<string, unknown>;
  if (name === 'token') return { type: 'token', delta: String(data?.delta ?? '') };
  if (name === 'error') return { type: 'error', message: String(data?.message ?? 'stream failed') };
  if (name === 'done') return { type: 'done', run: data as unknown as Run };
  return null;
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
