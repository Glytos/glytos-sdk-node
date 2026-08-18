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

export type CampaignStatus =
  | 'draft'
  | 'scheduled'
  | 'running'
  | 'waiting'
  | 'stopped'
  | 'completed'
  | 'halted'
  | 'out_of_credit'
  | 'failed';

/**
 * How much of the do-not-call list a campaign honours: `strict` all of it,
 * `transactional` still calls people who only refused marketing, `ignore` skips
 * entries the organization added for itself (requests people made on a call
 * still apply).
 */
export type SuppressionPolicy = 'strict' | 'transactional' | 'ignore';

/**
 * How far a campaign has got. Sent with every campaign so a row can draw its
 * progress without fetching the contact list to count it.
 */
export interface CampaignCounts {
  total: number;
  pending: number;
  dialing: number;
  answered: number;
  voicemail: number;
  no_answer: number;
  failed: number;
  /** On the do-not-call list, so never dialed. */
  suppressed: number;
  /** Handed to the carrier, including calls still in flight. Excludes suppressed. */
  dialed: number;
  /**
   * What this campaign can ever dial: `total` minus `suppressed`. Measure
   * progress against this, not against `total`, or a finished campaign stops
   * short of complete by however many numbers were suppressed.
   */
  dialable: number;
  [key: string]: unknown;
}

export interface Campaign {
  uuid: string;
  name: string;
  workflow_uuid?: string;
  /** The agent that does the dialing, named so a row need not resolve the uuid. */
  workflow_name?: string | null;
  counts?: CampaignCounts;
  /** Only on create: what reading the supplied contact list did. */
  imported?: ContactSyncResult;
  from_number?: string;
  status?: CampaignStatus;
  /** Why a campaign stopped short of the end of its list. */
  status_detail?: string;
  scheduled_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  /** Dialing hours, read in `timezone`. */
  call_window_start?: string | null;
  call_window_end?: string | null;
  timezone?: string | null;
  suppression_policy?: SuppressionPolicy;
  override_caller_requests?: boolean;
  [key: string]: unknown;
}

export type ContactStatus =
  | 'pending'
  | 'dialing'
  | 'answered'
  | 'voicemail'
  | 'no_answer'
  | 'failed'
  | 'suppressed';

export interface CampaignContact {
  phone: string;
  /**
   * Busy is not reported separately from `no_answer`: it needs per-carrier
   * callbacks the platform does not collect.
   */
  status: ContactStatus;
  /** The carrier's own id for the call. */
  call_sid?: string | null;
  /** The carrier's own words when it refused the number. */
  error?: string | null;
  /** The conversation this contact produced, if it answered. */
  session_uuid?: string | null;
  /**
   * The contact's other CSV columns, which reach the agent's prompt, so
   * `{{name}}` means this person.
   */
  variables?: Record<string, string>;
  [key: string]: unknown;
}

export interface CampaignDetail extends Campaign {
  contacts: CampaignContact[];
}

/** How many of a contact list each suppression policy would reach. */
export interface SuppressionPreview {
  contacts: number;
  suppressed_total: number;
  /** How many of them asked, on a call, not to be contacted again. */
  caller_requested: number;
  reached_if_strict: number;
  reached_if_transactional: number;
  reached_if_ignore: number;
  reached_if_override: number;
  [key: string]: unknown;
}

/** What adding contacts to a campaign did. */
export interface ContactSyncResult {
  added: number;
  /** Already on the list. */
  skipped: number;
  /** The same number more than once inside the file. */
  duplicates: number;
  /** Held no usable phone number. */
  rejected: number;
  /**
   * Of what was added, how many are on the do-not-call list and so will never
   * be dialed. Counted here purely to report it; suppression happens at dial
   * time.
   */
  on_do_not_call: number;
  /**
   * The column read as the phone number, so a file read from the wrong one is
   * distinguishable from one that could not be read at all.
   */
  phone_column: string;
  [key: string]: unknown;
}

/** How far a suppression reaches. */
export type DncScope = 'all' | 'marketing';

/** How a number reached the do-not-call list. */
export type DncSource = 'agent' | 'manual' | 'import' | 'api';

export interface DncEntry {
  uuid: string;
  phone: string;
  source: DncSource;
  scope: DncScope;
  reason?: string | null;
  last_matched_at?: string | null;
  created_at?: string;
  [key: string]: unknown;
}

export interface DncList {
  items: DncEntry[];
  total: number;
}

export interface DncImportResult {
  added: number;
  /** Already on the list. */
  duplicates: number;
  /** Not phone numbers. */
  rejected: number;
  [key: string]: unknown;
}

/**
 * What a tool actually does.
 *
 * `code` runs only in an operator-configured sandbox, and `client` is resolved by
 * the browser during a web call, so both are inert unless that side is set up.
 */
export type ToolKind = 'static' | 'http' | 'mcp' | 'code' | 'integration' | 'client';

export interface Tool {
  uuid: string;
  name: string;
  kind: ToolKind;
  [key: string]: unknown;
}

/** One tool an MCP server publishes, as discovered from the server itself. */
export interface McpTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SipTrunk {
  uuid: string;
  name: string;
  preset: string;
  sip_server: string;
  sip_port: number;
  transport: string;
  username: string;
  /** `registered`, `pending` or `failed`. Only a registered trunk takes calls. */
  status?: string;
  status_detail?: string | null;
  last_registered_at?: string | null;
  number_count?: number;
  [key: string]: unknown;
}

/** A carrier the platform already knows the connection details for. */
export interface SipPreset {
  key: string;
  name: string;
  sip_server: string;
  sip_port: number;
  transport: string;
  country: string;
  /** Whether these settings have been confirmed against the live carrier. */
  verified: boolean;
  note: string;
  [key: string]: unknown;
}

export interface SipTrunkTest {
  ok: boolean;
  detail: string;
  /**
   * Whether the carrier answered at all. A carrier that refused the credentials
   * is a different problem from one that never replied, and only the first is
   * worth changing the password over.
   */
  reachable?: boolean;
}

export interface TestSuite {
  uuid: string;
  workflow_uuid: string;
  name: string;
  cases: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface TestSuiteRun {
  suite_uuid: string;
  passed: boolean;
  total: number;
  passed_count: number;
  results: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/** A third-party destination the platform can act on. */
export interface Integration {
  key: string;
  name: string;
  required_credentials: string[];
  /** Which of those are safe to show back, so a form can be pre-filled. */
  public_credentials?: string[];
  /** Whether an automation may fire this integration. */
  supports_automation?: boolean;
  actions: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/**
 * One configured destination. An organization can hold several per integration -
 * two Slack workspaces, three calendars - so an agent or automation names the
 * connection rather than the integration.
 */
export interface IntegrationConnection {
  uuid: string;
  integration_key: string;
  name: string;
  is_active: boolean;
  /** Credentials come back masked; secrets are never returned. */
  data: Record<string, unknown>;
  automation_count?: number;
  [key: string]: unknown;
}

export interface Automation {
  uuid: string;
  name: string;
  is_active: boolean;
  /** A webhook event type, e.g. `session.completed`. */
  trigger_event: string;
  connection_uuid: string;
  integration_key: string;
  action: string;
  payload_template: Record<string, unknown>;
  conditions: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AutomationRun {
  event_type: string;
  status: string;
  error?: string | null;
  duration_ms: number;
  created_at: string;
  [key: string]: unknown;
}

export interface CreditBalance {
  balance: number;
  currency: string;
}

export interface CreditTransaction {
  amount: number;
  kind: string;
  description: string;
  balance_after: number;
  created_at: string;
  [key: string]: unknown;
}

export interface UsageSummary {
  total_units: number;
  total_cost: number;
  record_count: number;
  currency: string;
}

export interface Environment {
  uuid: string;
  /** The stable id to pass as `environment`: `dev`, `staging` or `prod`. */
  kind: string;
  name: string;
  is_default: boolean;
  [key: string]: unknown;
}

export interface Provider {
  key: string;
  name: string;
  /** `llm`, `stt`, `tts` or `realtime`. */
  service_type: string;
  default_model: string;
  models: Array<Record<string, unknown>>;
  voices: Array<Record<string, unknown>>;
  languages: Array<Record<string, unknown>>;
  /** A provider that is not available renders as "Soon" and cannot be selected. */
  available: boolean;
  [key: string]: unknown;
}

export interface ApiKey {
  id: number;
  name: string;
  key_prefix: string;
  is_active: boolean;
  last_used_at?: string | null;
  created_at?: string;
  expires_at?: string | null;
  scopes?: string[] | null;
  [key: string]: unknown;
}

/** A created key, the one and only time the secret is returned. */
export interface CreatedApiKey extends ApiKey {
  key: string;
}

export interface Organization {
  id: number;
  name: string;
  slug: string;
  /** Immutable: where this organization's data lives. */
  region: string;
  [key: string]: unknown;
}

export interface Region {
  code: string;
  label: string;
  /** Empty for the stack you are already talking to. */
  api_base_url: string;
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

  /**
   * Create an agent. `mode` is `"prompt"` (default) or `"workflow"`, and
   * `primary_channel` is `"voice"` (default) or `"chat"`.
   *
   * A new agent always lands in Development, whatever environment the client is
   * scoped to, so nothing is ever built straight into production.
   */
  create(body: {
    name: string;
    mode?: 'prompt' | 'workflow';
    primary_channel?: 'voice' | 'chat';
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

  /**
   * Export an agent as portable, secret-free JSON. It imports back through
   * `imports.create('glytos', ...)`, on this account or another.
   */
  export(workflowUuid: string): Promise<Record<string, unknown>> {
    return this.client.request('GET', `/workflows/${enc(workflowUuid)}/export`);
  }

  /** File an agent into a folder. Both must be in the same environment. */
  moveToFolder(workflowUuid: string, folderUuid: string): Promise<Workflow> {
    return this.client.request('PATCH', `/workflows/${enc(workflowUuid)}`, {
      body: { folder_uuid: folderUuid },
    });
  }

  /** Take an agent out of its folder, leaving it ungrouped. */
  removeFromFolder(workflowUuid: string): Promise<Workflow> {
    // Sent as null is what unfiles it; not sent at all would leave it where it is.
    return this.client.request('PATCH', `/workflows/${enc(workflowUuid)}`, {
      body: { folder_uuid: null },
    });
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

  /**
   * Act on a call that is happening right now: make the agent say a line, hand
   * the call to a person, or end it.
   *
   * `say` needs `text`, `transfer` needs `to_number`, `end` needs neither.
   */
  control(
    callUuid: string,
    body:
      | { action: 'say'; text: string }
      | { action: 'transfer'; to_number: string }
      | { action: 'end' },
  ): Promise<unknown> {
    return this.client.request('POST', `/calls/${enc(callUuid)}/control`, { body });
  }
}

/**
 * BYO SIP trunks: connect a carrier directly, with no third party in between.
 *
 * A trunk registers with the carrier using credentials it issued you. Numbers are
 * attached to a registered trunk through `phoneNumbers.importNumber`.
 */
class SipTrunks {
  constructor(private readonly client: Glytos) {}

  /** Carriers whose connection settings are already known, so you supply only the login. */
  presets(): Promise<SipPreset[]> {
    return this.client.request('GET', '/telephony/sip-trunks/presets');
  }

  /** List your trunks and their registration state. */
  list(): Promise<SipTrunk[]> {
    return this.client.request('GET', '/telephony/sip-trunks');
  }

  /**
   * Register a trunk. Give a `preset` and the platform fills in the server, port
   * and transport; otherwise set them yourself. The password is stored encrypted
   * and is never returned.
   */
  create(body: {
    username: string;
    password: string;
    name?: string;
    preset?: string;
    sip_server?: string;
    sip_port?: number;
    transport?: string;
    from_domain?: string | null;
    outbound_proxy?: string | null;
    caller_id?: string | null;
    carrier_networks?: string[];
    use_registration?: boolean;
    expires_seconds?: number;
  }): Promise<SipTrunk> {
    return this.client.request('POST', '/telephony/sip-trunks', { body });
  }

  /** Update a trunk (only the fields you pass are changed). */
  update(trunkUuid: string, body: Record<string, unknown>): Promise<SipTrunk> {
    return this.client.request('PATCH', `/telephony/sip-trunks/${enc(trunkUuid)}`, { body });
  }

  /** Remove a trunk. Numbers attached to it stop receiving calls. */
  delete(trunkUuid: string): Promise<void> {
    return this.client.request('DELETE', `/telephony/sip-trunks/${enc(trunkUuid)}`);
  }

  /** Re-check the trunk against its carrier now, rather than waiting for the next reconcile. */
  test(trunkUuid: string): Promise<SipTrunkTest> {
    return this.client.request('POST', `/telephony/sip-trunks/${enc(trunkUuid)}/test`);
  }
}

/** Saved conversations replayed against an agent, to catch prompt regressions. */
class TestSuites {
  constructor(private readonly client: Glytos) {}

  /** List your test suites. */
  list(): Promise<TestSuite[]> {
    return this.client.request('GET', '/test-suites');
  }

  /** Create a suite of cases against one agent. */
  create(body: {
    workflow_uuid: string;
    name: string;
    cases?: Array<Record<string, unknown>>;
  }): Promise<TestSuite> {
    return this.client.request('POST', '/test-suites', { body });
  }

  /** Rename a suite, repoint it at another agent, or rewrite its cases. */
  update(
    suiteUuid: string,
    body: { name?: string; workflow_uuid?: string; cases?: Array<Record<string, unknown>> },
  ): Promise<TestSuite> {
    return this.client.request('PUT', `/test-suites/${enc(suiteUuid)}`, { body });
  }

  /** Delete a suite. */
  delete(suiteUuid: string): Promise<void> {
    return this.client.request('DELETE', `/test-suites/${enc(suiteUuid)}`);
  }

  /** Run every case and report which passed. Runs the agent, so it costs credit. */
  run(suiteUuid: string): Promise<TestSuiteRun> {
    return this.client.request('POST', `/test-suites/${enc(suiteUuid)}/run`);
  }
}

/**
 * Third-party destinations - Slack, Discord, Telegram, a generic webhook, Cal.com -
 * and the connections that hold their credentials.
 *
 * A connection is reachable three ways: run it directly from here, give an agent an
 * `integration` tool that names it, or fire it from an `automations` rule.
 */
class Integrations {
  readonly connections: IntegrationConnections;

  constructor(private readonly client: Glytos) {
    this.connections = new IntegrationConnections(client);
  }

  /** The catalog: what can be connected, and which actions each one offers. */
  list(): Promise<Integration[]> {
    return this.client.request('GET', '/integrations');
  }

  /**
   * Run an action using the organization's stored credentials for an integration,
   * without naming a connection. Prefer `connections.run` - this resolves whichever
   * credentials the organization saved for that integration key, which is ambiguous
   * once there is more than one destination.
   */
  run(
    integrationKey: string,
    body: { action: string; params?: Record<string, unknown> },
  ): Promise<{ result: Record<string, unknown> }> {
    return this.client.request('POST', `/integrations/${enc(integrationKey)}/run`, { body });
  }
}

class IntegrationConnections {
  constructor(private readonly client: Glytos) {}

  /** List configured connections, optionally for one integration. */
  list(query?: { integration_key?: string }): Promise<IntegrationConnection[]> {
    return this.client.request('GET', '/integrations/connections', { query: query ?? {} });
  }

  /**
   * Configure a destination. `data` carries the integration's required credentials
   * (see `integrations.list`); they are encrypted at rest and masked on read.
   */
  create(body: {
    integration_key: string;
    name: string;
    data: Record<string, unknown>;
  }): Promise<IntegrationConnection> {
    return this.client.request('POST', '/integrations/connections', { body });
  }

  /** Update a connection (only the fields you pass are changed). */
  update(
    connectionUuid: string,
    body: { name?: string; data?: Record<string, unknown>; is_active?: boolean },
  ): Promise<IntegrationConnection> {
    return this.client.request('PATCH', `/integrations/connections/${enc(connectionUuid)}`, {
      body,
    });
  }

  /** Delete a connection. Automations pointing at it stop firing. */
  delete(connectionUuid: string): Promise<void> {
    return this.client.request('DELETE', `/integrations/connections/${enc(connectionUuid)}`);
  }

  /** Run one of the integration's actions through this connection. */
  run(
    connectionUuid: string,
    body: { action: string; params?: Record<string, unknown> },
  ): Promise<{ result: Record<string, unknown> }> {
    return this.client.request('POST', `/integrations/connections/${enc(connectionUuid)}/run`, {
      body,
    });
  }
}

/**
 * "When this happens, do that": a webhook event fires an integration action, with
 * no server of your own.
 *
 * Automations run in the background after the event, never during a call, and a
 * failed automation is recorded rather than allowed to affect the call.
 */
class Automations {
  constructor(private readonly client: Glytos) {}

  /** List your automations. */
  list(): Promise<Automation[]> {
    return this.client.request('GET', '/automations');
  }

  /**
   * Create a rule. `trigger_event` is a webhook event type (see `webhooks.events`),
   * and `payload_template` values may reference the event with `{{placeholders}}`.
   */
  create(body: {
    name: string;
    trigger_event: string;
    connection_uuid: string;
    action: string;
    payload_template?: Record<string, unknown>;
    conditions?: Record<string, unknown>;
  }): Promise<Automation> {
    return this.client.request('POST', '/automations', { body });
  }

  /** Update an automation, including pausing it with `is_active: false`. */
  update(
    automationUuid: string,
    body: {
      name?: string;
      trigger_event?: string;
      connection_uuid?: string;
      action?: string;
      payload_template?: Record<string, unknown>;
      conditions?: Record<string, unknown>;
      is_active?: boolean;
    },
  ): Promise<Automation> {
    return this.client.request('PATCH', `/automations/${enc(automationUuid)}`, { body });
  }

  /** Delete an automation. */
  delete(automationUuid: string): Promise<void> {
    return this.client.request('DELETE', `/automations/${enc(automationUuid)}`);
  }

  /** Recent firings, newest first: what ran, and what came back. */
  runs(automationUuid: string, query?: { limit?: number }): Promise<AutomationRun[]> {
    return this.client.request('GET', `/automations/${enc(automationUuid)}/runs`, {
      query: query ?? {},
    });
  }

  /**
   * Fire it once against a payload you supply, to see the rendered parameters and
   * the destination's reply before trusting it to a real event.
   */
  test(
    automationUuid: string,
    payload?: Record<string, unknown>,
  ): Promise<{ params: Record<string, unknown>; result: Record<string, unknown> }> {
    return this.client.request('POST', `/automations/${enc(automationUuid)}/test`, {
      body: { payload: payload ?? {} },
    });
  }
}

/** Credit balance, ledger and usage. */
class Billing {
  constructor(private readonly client: Glytos) {}

  /** The current prepaid balance. Check it before a large outbound run. */
  credits(): Promise<CreditBalance> {
    return this.client.request('GET', '/billing/credits');
  }

  /** The credit ledger: top-ups and debits, newest first. */
  transactions(query?: { kind?: string; limit?: number }): Promise<CreditTransaction[]> {
    return this.client.request('GET', '/billing/credits/transactions', { query: query ?? {} });
  }

  /** Aggregate usage and cost for the organization. */
  usage(): Promise<UsageSummary> {
    return this.client.request('GET', '/billing/usage');
  }
}

/**
 * Development, Staging and Production.
 *
 * Pass a `kind` or a uuid as the client's `environment` option to scope reads and
 * calls; agents are always created in Development whatever it is set to.
 */
class Environments {
  constructor(private readonly client: Glytos) {}

  /** The organization's three environments. */
  list(): Promise<Environment[]> {
    return this.client.request('GET', '/environments');
  }
}

/** The model, transcriber and voice catalog, and what each provider offers. */
class Providers {
  constructor(private readonly client: Glytos) {}

  /** Every provider, its models and voices, and whether it is available to you. */
  list(): Promise<Provider[]> {
    return this.client.request('GET', '/providers');
  }

  /**
   * A single provider's live models and voices, fetched from the provider itself
   * where it publishes them. `language` narrows a long voice list.
   */
  resources(
    serviceType: string,
    key: string,
    query?: { language?: string },
  ): Promise<Record<string, unknown>> {
    return this.client.request('GET', `/providers/${enc(serviceType)}/${enc(key)}/resources`, {
      query: query ?? {},
    });
  }
}

/** Keys for calling this API. */
class ApiKeys {
  constructor(private readonly client: Glytos) {}

  /** List the keys on the organization. Secrets are never returned. */
  list(): Promise<ApiKey[]> {
    return this.client.request('GET', '/api-keys');
  }

  /**
   * Create a key. The secret is in the response and nowhere else, so store it now.
   *
   * `scopes` bounds what the key may do and cannot exceed what you hold. Omit it
   * and the key inherits your permissions, which means it stops working if you
   * leave the organization. `expires_in_days` retires the key on its own.
   */
  create(body: {
    name: string;
    expires_in_days?: number;
    scopes?: string[];
  }): Promise<CreatedApiKey> {
    return this.client.request('POST', '/api-keys', { body });
  }

  /** Revoke a key immediately. */
  delete(keyId: number | string): Promise<void> {
    return this.client.request('DELETE', `/api-keys/${enc(String(keyId))}`);
  }
}

/** The organization this key belongs to, and the regions data can live in. */
class Organizations {
  constructor(private readonly client: Glytos) {}

  /** The organization behind this API key. */
  retrieve(): Promise<Organization> {
    return this.client.request('GET', '/organization');
  }

  /** Rename the organization. Its region is fixed at creation and cannot change. */
  update(body: { name?: string }): Promise<Organization> {
    return this.client.request('PATCH', '/organization', { body });
  }

  /**
   * The regions this deployment offers. Each is a separate stack with its own base
   * URL, so reaching an organization in another region means pointing `baseUrl`
   * there with a key issued there.
   */
  regions(): Promise<Region[]> {
    return this.client.request('GET', '/regions');
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

  /**
   * Import (connect) a number you already own at a carrier.
   *
   * Importing verifies you own the number, so the organization's own carrier
   * credentials are required. Pass `sip_trunk_uuid` instead when the number
   * arrives over a SIP trunk you registered - there is no carrier account to
   * look it up in, and the trunk's registration is the ownership proof.
   */
  importNumber(body: {
    e164: string;
    provider?: string;
    provider_sid?: string;
    credentials?: Record<string, unknown>;
    workflow_uuid?: string;
    sip_trunk_uuid?: string;
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
    /**
     * The caller id to dial from. It must be a number your organization has
     * connected, or the campaign is refused.
     */
    from_number: string;
    /**
     * An initial contact list. Any spelling works: numbers are converted to
     * international form and duplicates are dropped.
     */
    contacts?: string[];
    /**
     * The contents of a CSV file. The phone column is found by its header or by
     * which column holds phone numbers, and every other column travels with
     * that contact's call as a variable.
     */
    contacts_csv?: string;
    /**
     * Start the campaign at a moment in the future (ISO 8601). Left unset, the
     * campaign is a draft until you call `start`.
     */
    scheduled_at?: string;
    /** Dialing hours ("09:00", "20:00"), read in `timezone`. Set both or neither. */
    call_window_start?: string;
    call_window_end?: string;
    /** An IANA name, e.g. "Europe/Istanbul". Defaults to UTC. */
    timezone?: string;
    suppression_policy?: SuppressionPolicy;
    /**
     * Also call people who asked, on a call, not to be contacted again. Only
     * valid with a `suppression_policy` of `ignore`.
     */
    override_caller_requests?: boolean;
  }): Promise<Campaign> {
    return this.client.request('POST', '/telephony/campaigns', { body });
  }

  /** Retrieve a campaign by uuid, with its contacts and their outcomes. */
  retrieve(campaignUuid: string): Promise<CampaignDetail> {
    return this.client.request('GET', `/telephony/campaigns/${enc(campaignUuid)}`);
  }

  /**
   * Begin dialing, from the contacts that have not been called yet. A campaign
   * that is already running is refused.
   */
  start(campaignUuid: string): Promise<Campaign> {
    return this.client.request('POST', `/telephony/campaigns/${enc(campaignUuid)}/start`);
  }

  /**
   * End dialing at the next contact. Calls already handed to the carrier run to
   * their end; undialed contacts stay ready, so `start` resumes.
   */
  stop(campaignUuid: string): Promise<Campaign> {
    return this.client.request('POST', `/telephony/campaigns/${enc(campaignUuid)}/stop`);
  }

  /**
   * Rename a campaign, or change when and within what hours it dials.
   *
   * A rename is accepted at any point. The schedule and the calling window can
   * only be changed before the campaign starts: moving the start of one already
   * dialing would say nothing about the calls it has placed.
   */
  update(
    campaignUuid: string,
    body: {
      name?: string;
      /** ISO 8601. To remove a schedule entirely, use `unschedule`. */
      scheduled_at?: string;
      /** Dialing hours ("09:00", "20:00"), read in `timezone`. Set both or neither. */
      call_window_start?: string;
      call_window_end?: string;
      timezone?: string;
    },
  ): Promise<Campaign> {
    return this.client.request('PATCH', `/telephony/campaigns/${enc(campaignUuid)}`, { body });
  }

  /**
   * Clear a campaign's schedule, returning it to a draft that waits for `start`.
   * Separate from `update` because leaving a field out and setting it to nothing
   * are different instructions, and only one of them can be expressed by absence.
   */
  unschedule(campaignUuid: string): Promise<Campaign> {
    return this.client.request('PATCH', `/telephony/campaigns/${enc(campaignUuid)}`, {
      body: { scheduled_at: null },
    });
  }

  /**
   * Copy a campaign and its contact list into a fresh draft. Nothing dials and
   * no outcome is copied, so this is how you run the same list again or reuse a
   * setup against a new one.
   */
  duplicate(campaignUuid: string, name?: string): Promise<Campaign> {
    return this.client.request('POST', `/telephony/campaigns/${enc(campaignUuid)}/duplicate`, {
      body: { name },
    });
  }

  /**
   * The contacts and what came of each, as CSV: phone, outcome, dialed_at,
   * error, session_uuid. The session uuid joins a result back to the
   * conversation that produced it.
   */
  export(campaignUuid: string): Promise<string> {
    return this.client.request('GET', `/telephony/campaigns/${enc(campaignUuid)}/export`);
  }

  /** Remove a campaign and its contact list. A running campaign is stopped first. */
  delete(campaignUuid: string): Promise<void> {
    return this.client.request('DELETE', `/telephony/campaigns/${enc(campaignUuid)}`);
  }

  /** Append contacts from the contents of a CSV file. */
  addContacts(campaignUuid: string, contactsCsv: string): Promise<ContactSyncResult> {
    return this.client.request('POST', `/telephony/campaigns/${enc(campaignUuid)}/contacts/sync`, {
      body: { contacts_csv: contactsCsv },
    });
  }

  /** Append contacts from a CSV your own system serves over HTTP. */
  syncContacts(campaignUuid: string, sourceUrl: string): Promise<ContactSyncResult> {
    return this.client.request('POST', `/telephony/campaigns/${enc(campaignUuid)}/contacts/sync`, {
      body: { source_url: sourceUrl },
    });
  }

  /**
   * Report how many of a contact list each suppression policy would reach,
   * including how many of those people asked on a call not to be contacted.
   * Measure before choosing anything other than the default.
   */
  previewSuppression(body: {
    contacts?: string[];
    contacts_csv?: string;
  }): Promise<SuppressionPreview> {
    return this.client.request('POST', '/telephony/campaigns/suppression-preview', { body });
  }
}

/**
 * The numbers your organization must not call.
 *
 * Every outbound call is checked against this list, whether it comes from a
 * campaign or from `calls.create`. Agents add to it themselves when a caller
 * asks not to be contacted again.
 */
class Dnc {
  constructor(private readonly client: Glytos) {}

  /** List suppressed numbers, newest first. */
  list(query?: {
    /**
     * Normalized before matching, so a number typed the way it appears on a
     * contact list finds the entry stored in international form.
     */
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<DncList> {
    return this.client.request('GET', '/dnc', { query: query ?? {} });
  }

  /**
   * Suppress a number. Any spelling is accepted and stored in international
   * form. Adding one already on the list returns the existing entry rather than
   * failing.
   */
  add(phone: string, reason?: string): Promise<DncEntry> {
    return this.client.request('POST', '/dnc', { body: { phone, reason } });
  }

  /** Suppress many numbers at once, e.g. a list exported from your CRM. */
  import(phones: string[], reason?: string): Promise<DncImportResult> {
    return this.client.request('POST', '/dnc/import', { body: { phones, reason } });
  }

  /**
   * Change how far a suppression reaches: `all` for every call, or `marketing`
   * to allow a transactional call about the person's own order.
   */
  setScope(phone: string, scope: DncScope): Promise<DncEntry> {
    return this.client.request('PATCH', `/dnc/${enc(phone)}`, { body: { scope } });
  }

  /** Take a number off the list, so it can be called again. */
  remove(phone: string): Promise<void> {
    return this.client.request('DELETE', `/dnc/${enc(phone)}`);
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

  /**
   * List what is on the other platform, using its API key. The key is used for
   * this request and is never stored.
   */
  connect(source: string, apiKey: string): Promise<{ agents: Array<Record<string, unknown>> }> {
    return this.client.request('POST', `/imports/${enc(source)}/connect`, {
      body: { api_key: apiKey },
    });
  }

  /** Bring over the agents you picked from `connect`. */
  pull(
    source: string,
    apiKey: string,
    agentIds: string[],
  ): Promise<{ imports: Array<Record<string, unknown>> }> {
    return this.client.request('POST', `/imports/${enc(source)}/pull`, {
      body: { api_key: apiKey, agent_ids: agentIds },
    });
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

  /**
   * Create a tool. `kind` is one of `http`, `static`, `mcp`, `code`,
   * `integration` or `client`.
   *
   * An `integration` tool names the connection in its own `config`, so the model
   * fills in arguments but never chooses the destination.
   */
  create(body: {
    name: string;
    kind: ToolKind;
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
      kind?: ToolKind;
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

  /**
   * Ask an MCP server what it publishes, so a tool can be built from the server's
   * own schema instead of one transcribed by hand.
   */
  async discoverMcp(body: {
    server_url: string;
    headers?: Record<string, string>;
  }): Promise<McpTool[]> {
    const resp = await this.client.request<{ tools?: McpTool[] }>('POST', '/tools/mcp/discover', {
      body,
    });
    return resp?.tools ?? [];
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

  /** Retrieve one document, including its extracted text. */
  retrieveDocument(documentId: number | string): Promise<KnowledgeDocument> {
    return this.client.request('GET', `/knowledge-base/documents/${enc(String(documentId))}`);
  }

  /** Delete a document, with its chunks and embeddings. */
  deleteDocument(documentId: number | string): Promise<void> {
    return this.client.request('DELETE', `/knowledge-base/documents/${enc(String(documentId))}`);
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

  /** Take a document out of a store. The document itself is not deleted. */
  removeDocument(vectorStoreUuid: string, documentId: number): Promise<void> {
    return this.client.request(
      'DELETE',
      `/vector-stores/${enc(vectorStoreUuid)}/documents/${documentId}`,
    );
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
  /** BYO SIP trunks, for connecting a carrier directly. */
  readonly sipTrunks: SipTrunks;
  readonly sessions: Sessions;
  readonly webhooks: Webhooks;
  readonly campaigns: Campaigns;
  /** The numbers your organization must not call. */
  readonly dnc: Dnc;
  readonly chat: Chat;
  readonly tools: Tools;
  readonly knowledgeBase: KnowledgeBase;
  readonly vectorStores: VectorStores;
  readonly analytics: Analytics;
  /** Saved conversations replayed against an agent, to catch regressions. */
  readonly testSuites: TestSuites;
  /** Third-party destinations and the connections holding their credentials. */
  readonly integrations: Integrations;
  /** Fire an integration action when an event happens. */
  readonly automations: Automations;
  /** Credit balance, ledger and usage. */
  readonly billing: Billing;
  /** Development, Staging and Production. */
  readonly environments: Environments;
  /** The model, transcriber and voice catalog. */
  readonly providers: Providers;
  /** Keys for calling this API. */
  readonly apiKeys: ApiKeys;
  /** The organization behind this key, and the available regions. */
  readonly organizations: Organizations;

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
    this.sipTrunks = new SipTrunks(this);
    this.sessions = new Sessions(this);
    this.webhooks = new Webhooks(this);
    this.campaigns = new Campaigns(this);
    this.dnc = new Dnc(this);
    this.chat = new Chat(this);
    this.tools = new Tools(this);
    this.knowledgeBase = new KnowledgeBase(this);
    this.vectorStores = new VectorStores(this);
    this.analytics = new Analytics(this);
    this.testSuites = new TestSuites(this);
    this.integrations = new Integrations(this);
    this.automations = new Automations(this);
    this.billing = new Billing(this);
    this.environments = new Environments(this);
    this.providers = new Providers(this);
    this.apiKeys = new ApiKeys(this);
    this.organizations = new Organizations(this);
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
