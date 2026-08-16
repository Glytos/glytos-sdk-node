import { describe, expect, it } from 'vitest';
import { Glytos } from '../src/index';

// Same stub-transport pattern as parity.test.ts, covering the resources added
// after the first release: SIP trunks, integrations, automations, test suites,
// billing, API keys, and the endpoints the older resources were missing.

interface Capture {
  request?: Request;
}

function stubFetch(body: string, init: ResponseInit, capture?: Capture): typeof fetch {
  return (async (input: RequestInfo | URL, requestInit?: RequestInit) => {
    if (capture) capture.request = new Request(input, requestInit);
    return new Response(body, init);
  }) as typeof fetch;
}

function client(capture: Capture, body = '{}'): Glytos {
  return new Glytos({ apiKey: 'gly_test', fetch: stubFetch(body, { status: 200 }, capture) });
}

const pathOf = (capture: Capture) => new URL(capture.request!.url).pathname;
const searchOf = (capture: Capture) => new URL(capture.request!.url).search;

describe('sipTrunks', () => {
  it('create posts the login and any preset', async () => {
    const capture: Capture = {};
    await client(capture).sipTrunks.create({
      username: 'line-1',
      password: 'secret',
      preset: 'netgsm',
      name: 'Main line',
    });

    expect(capture.request?.method).toBe('POST');
    expect(pathOf(capture)).toMatch(/\/telephony\/sip-trunks$/);
    expect(await capture.request!.json()).toEqual({
      username: 'line-1',
      password: 'secret',
      preset: 'netgsm',
      name: 'Main line',
    });
  });

  it('test reports reachable separately from ok', async () => {
    // A carrier that refused the credentials is a different problem from one that
    // never answered, and only the first is worth changing the password over.
    const capture: Capture = {};
    const result = await client(
      capture,
      '{"ok":false,"detail":"no reply","reachable":false}',
    ).sipTrunks.test('trunk_1');

    expect(capture.request?.method).toBe('POST');
    expect(pathOf(capture)).toMatch(/\/telephony\/sip-trunks\/trunk_1\/test$/);
    expect(result.reachable).toBe(false);
  });

  it('presets and list are plain reads', async () => {
    const capture: Capture = {};
    await client(capture, '[]').sipTrunks.presets();
    expect(pathOf(capture)).toMatch(/\/telephony\/sip-trunks\/presets$/);

    await client(capture, '[]').sipTrunks.list();
    expect(pathOf(capture)).toMatch(/\/telephony\/sip-trunks$/);
  });
});

describe('phoneNumbers', () => {
  it('importNumber can name a SIP trunk instead of a carrier', async () => {
    const capture: Capture = {};
    await client(capture).phoneNumbers.importNumber({
      e164: '+905321234567',
      sip_trunk_uuid: 'trunk_1',
    });

    expect(await capture.request!.json()).toEqual({
      e164: '+905321234567',
      sip_trunk_uuid: 'trunk_1',
    });
  });
});

describe('integrations', () => {
  it('connections.create posts the credential payload', async () => {
    const capture: Capture = {};
    await client(capture).integrations.connections.create({
      integration_key: 'slack',
      name: 'Sales channel',
      data: { webhook_url: 'https://hooks.example.com/x' },
    });

    expect(capture.request?.method).toBe('POST');
    expect(pathOf(capture)).toMatch(/\/integrations\/connections$/);
    expect(await capture.request!.json()).toEqual({
      integration_key: 'slack',
      name: 'Sales channel',
      data: { webhook_url: 'https://hooks.example.com/x' },
    });
  });

  it('connections.list filters by integration key', async () => {
    const capture: Capture = {};
    await client(capture, '[]').integrations.connections.list({ integration_key: 'calcom' });

    expect(searchOf(capture)).toBe('?integration_key=calcom');
  });

  it('connections.run addresses the connection, not the integration', async () => {
    const capture: Capture = {};
    await client(capture, '{"result":{}}').integrations.connections.run('conn_1', {
      action: 'post_message',
      params: { text: 'A lead came in' },
    });

    expect(pathOf(capture)).toMatch(/\/integrations\/connections\/conn_1\/run$/);
    expect(await capture.request!.json()).toEqual({
      action: 'post_message',
      params: { text: 'A lead came in' },
    });
  });
});

describe('automations', () => {
  it('create carries the trigger and the templated payload', async () => {
    const capture: Capture = {};
    await client(capture).automations.create({
      name: 'Tell sales',
      trigger_event: 'session.completed',
      connection_uuid: 'conn_1',
      action: 'post_message',
      payload_template: { text: 'Call from {{from_number}}' },
    });

    expect(pathOf(capture)).toMatch(/\/automations$/);
    expect(await capture.request!.json()).toMatchObject({
      trigger_event: 'session.completed',
      payload_template: { text: 'Call from {{from_number}}' },
    });
  });

  it('test sends an empty payload when none is given', async () => {
    const capture: Capture = {};
    await client(capture, '{"params":{},"result":{}}').automations.test('auto_1');

    expect(pathOf(capture)).toMatch(/\/automations\/auto_1\/test$/);
    expect(await capture.request!.json()).toEqual({ payload: {} });
  });

  it('update can pause one without touching anything else', async () => {
    const capture: Capture = {};
    await client(capture).automations.update('auto_1', { is_active: false });

    expect(capture.request?.method).toBe('PATCH');
    expect(await capture.request!.json()).toEqual({ is_active: false });
  });
});

describe('testSuites', () => {
  it('run posts to the suite and reports the tally', async () => {
    const capture: Capture = {};
    const result = await client(
      capture,
      '{"suite_uuid":"s1","passed":false,"total":3,"passed_count":2,"results":[]}',
    ).testSuites.run('s1');

    expect(capture.request?.method).toBe('POST');
    expect(pathOf(capture)).toMatch(/\/test-suites\/s1\/run$/);
    expect(result.passed_count).toBe(2);
  });
});

describe('billing', () => {
  it('credits reads the balance', async () => {
    const capture: Capture = {};
    const balance = await client(capture, '{"balance":12.5,"currency":"USD"}').billing.credits();

    expect(pathOf(capture)).toMatch(/\/billing\/credits$/);
    expect(balance.balance).toBe(12.5);
  });

  it('transactions passes its filters', async () => {
    const capture: Capture = {};
    await client(capture, '[]').billing.transactions({ kind: 'debit', limit: 10 });

    expect(searchOf(capture)).toBe('?kind=debit&limit=10');
  });
});

describe('apiKeys', () => {
  it('create carries the expiry and scopes when given', async () => {
    const capture: Capture = {};
    await client(capture).apiKeys.create({
      name: 'CI',
      expires_in_days: 90,
      scopes: ['workflow:read'],
    });

    expect(await capture.request!.json()).toEqual({
      name: 'CI',
      expires_in_days: 90,
      scopes: ['workflow:read'],
    });
  });

  it('omits both when unstated, which is the behaviour keys have always had', async () => {
    const capture: Capture = {};
    await client(capture).apiKeys.create({ name: 'CI' });

    expect(await capture.request!.json()).toEqual({ name: 'CI' });
  });
});

describe('tools', () => {
  it('discoverMcp returns the tool list rather than the envelope', async () => {
    const capture: Capture = {};
    const tools = await client(
      capture,
      '{"tools":[{"name":"search"},{"name":"fetch"}]}',
    ).tools.discoverMcp({ server_url: 'https://mcp.example.com' });

    expect(pathOf(capture)).toMatch(/\/tools\/mcp\/discover$/);
    expect(tools.map(tool => tool.name)).toEqual(['search', 'fetch']);
  });

  it('accepts every kind the API accepts', async () => {
    const capture: Capture = {};
    await client(capture).tools.create({ name: 'Book', kind: 'integration' });
    expect(await capture.request!.json()).toEqual({ name: 'Book', kind: 'integration' });

    await client(capture).tools.create({ name: 'Run', kind: 'code' });
    expect(await capture.request!.json()).toEqual({ name: 'Run', kind: 'code' });
  });
});

describe('imports', () => {
  it('connect and pull carry the other platform key without storing it', async () => {
    const capture: Capture = {};
    await client(capture, '{"agents":[]}').imports.connect('vapi', 'vapi_key');
    expect(pathOf(capture)).toMatch(/\/imports\/vapi\/connect$/);
    expect(await capture.request!.json()).toEqual({ api_key: 'vapi_key' });

    await client(capture, '{"imports":[]}').imports.pull('vapi', 'vapi_key', ['a1']);
    expect(pathOf(capture)).toMatch(/\/imports\/vapi\/pull$/);
    expect(await capture.request!.json()).toEqual({ api_key: 'vapi_key', agent_ids: ['a1'] });
  });
});

describe('knowledgeBase', () => {
  it('retrieve and delete address one document', async () => {
    const capture: Capture = {};
    await client(capture).knowledgeBase.retrieveDocument(7);
    expect(capture.request?.method).toBe('GET');
    expect(pathOf(capture)).toMatch(/\/knowledge-base\/documents\/7$/);

    await client(capture).knowledgeBase.deleteDocument(7);
    expect(capture.request?.method).toBe('DELETE');
    expect(pathOf(capture)).toMatch(/\/knowledge-base\/documents\/7$/);
  });
});

describe('calls', () => {
  it('control says a line, or ends the call with nothing else', async () => {
    const capture: Capture = {};
    await client(capture).calls.control('call_1', { action: 'say', text: 'One moment' });
    expect(pathOf(capture)).toMatch(/\/calls\/call_1\/control$/);
    expect(await capture.request!.json()).toEqual({ action: 'say', text: 'One moment' });

    await client(capture).calls.control('call_1', { action: 'end' });
    expect(await capture.request!.json()).toEqual({ action: 'end' });
  });
});

describe('environments and providers', () => {
  it('read the catalogue and the environment list', async () => {
    const capture: Capture = {};
    await client(capture, '[]').environments.list();
    expect(pathOf(capture)).toMatch(/\/environments$/);

    await client(capture, '[]').providers.list();
    expect(pathOf(capture)).toMatch(/\/providers$/);

    await client(capture, '{}').providers.resources('tts', 'cartesia', { language: 'tr' });
    expect(pathOf(capture)).toMatch(/\/providers\/tts\/cartesia\/resources$/);
    expect(searchOf(capture)).toBe('?language=tr');
  });
});
