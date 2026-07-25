import { describe, expect, it } from 'vitest';
import { Glytos } from '../src/index';

interface Capture {
  request?: Request;
}

// Same stub-transport pattern as client.test.ts: record the outgoing request so we can
// assert method + path + body/query for each new resource method.
function stubFetch(body: string, init: ResponseInit, capture?: Capture): typeof fetch {
  return (async (input: RequestInfo | URL, requestInit?: RequestInit) => {
    if (capture) capture.request = new Request(input, requestInit);
    return new Response(body, init);
  }) as typeof fetch;
}

function client(capture: Capture, body = '{}'): Glytos {
  return new Glytos({ apiKey: 'gly_test', fetch: stubFetch(body, { status: 200 }, capture) });
}

describe('workflows parity', () => {
  it('promote sends target_environment_id', async () => {
    const capture: Capture = {};
    await client(capture).workflows.promote('wf_1', 'env_2');

    expect(capture.request?.method).toBe('POST');
    expect(new URL(capture.request!.url).pathname).toMatch(/\/workflows\/wf_1\/promote$/);
    expect(await capture.request!.json()).toEqual({ target_environment_id: 'env_2' });
  });

  it('updateConfig is a PUT with body {config}', async () => {
    const capture: Capture = {};
    await client(capture).workflows.updateConfig('wf_1', { end_call_enabled: true });

    expect(capture.request?.method).toBe('PUT');
    expect(new URL(capture.request!.url).pathname).toMatch(/\/workflows\/wf_1\/config$/);
    expect(await capture.request!.json()).toEqual({ config: { end_call_enabled: true } });
  });

  it('list accepts an optional query', async () => {
    const capture: Capture = {};
    await client(capture, '[]').workflows.list({ archived: true, environment: 'all' });

    expect(capture.request?.method).toBe('GET');
    expect(new URL(capture.request!.url).search).toBe('?archived=true&environment=all');
  });

  it('startSession omits unprovided optional fields', async () => {
    const capture: Capture = {};
    await client(capture).workflows.startSession('wf_1', { name: 'Ada' });

    expect(await capture.request!.json()).toEqual({ variables: { name: 'Ada' } });
  });
});

describe('phoneNumbers parity', () => {
  it('instant sends query params and no body', async () => {
    const capture: Capture = {};
    await client(capture).phoneNumbers.instant('US', 'twilio');

    expect(capture.request?.method).toBe('POST');
    const url = new URL(capture.request!.url);
    expect(url.pathname).toMatch(/\/telephony\/numbers\/instant$/);
    expect(url.search).toBe('?country=US&provider=twilio');
    expect(await capture.request!.text()).toBe('');
    expect(capture.request?.headers.get('content-type')).toBeNull();
  });

  it('importNumber sends only the provided fields', async () => {
    const capture: Capture = {};
    await client(capture).phoneNumbers.importNumber('+15550001111', 'twilio');

    expect(new URL(capture.request!.url).pathname).toMatch(/\/telephony\/numbers\/import$/);
    expect(await capture.request!.json()).toEqual({ e164: '+15550001111', provider: 'twilio' });
  });
});

describe('campaigns parity', () => {
  it('create maps positional args to the snake_case body', async () => {
    const capture: Capture = {};
    await client(capture).campaigns.create('Launch', 'wf_1', '+15550002222');

    expect(capture.request?.method).toBe('POST');
    expect(new URL(capture.request!.url).pathname).toMatch(/\/telephony\/campaigns$/);
    expect(await capture.request!.json()).toEqual({
      name: 'Launch',
      workflow_uuid: 'wf_1',
      from_number: '+15550002222',
    });
  });

  it('syncContacts posts the source_url', async () => {
    const capture: Capture = {};
    await client(capture).campaigns.syncContacts('camp_1', 'https://example.com/c.csv');

    expect(new URL(capture.request!.url).pathname).toMatch(
      /\/telephony\/campaigns\/camp_1\/contacts\/sync$/,
    );
    expect(await capture.request!.json()).toEqual({ source_url: 'https://example.com/c.csv' });
  });
});

describe('tools parity', () => {
  it('update is a PATCH that omits unprovided fields', async () => {
    const capture: Capture = {};
    await client(capture).tools.update('tool_1', 'Renamed');

    expect(capture.request?.method).toBe('PATCH');
    expect(new URL(capture.request!.url).pathname).toMatch(/\/tools\/tool_1$/);
    // Only the provided `name` is sent; description/kind/config/parameters are absent.
    expect(await capture.request!.json()).toEqual({ name: 'Renamed' });
  });
});

describe('knowledgeBase parity', () => {
  it('search posts the query and optional knobs', async () => {
    const capture: Capture = {};
    await client(capture, '[]').knowledgeBase.search('refund policy', 5, [1, 2]);

    expect(capture.request?.method).toBe('POST');
    expect(new URL(capture.request!.url).pathname).toMatch(/\/knowledge-base\/search$/);
    expect(await capture.request!.json()).toEqual({
      query: 'refund policy',
      top_k: 5,
      document_ids: [1, 2],
    });
  });
});

describe('analytics parity', () => {
  it('overview sends days as a query param', async () => {
    const capture: Capture = {};
    await client(capture).analytics.overview(30);

    expect(capture.request?.method).toBe('GET');
    const url = new URL(capture.request!.url);
    expect(url.pathname).toMatch(/\/analytics\/overview$/);
    expect(url.search).toBe('?days=30');
  });
});

describe('webhooks parity', () => {
  it('update omits unprovided fields', async () => {
    const capture: Capture = {};
    await client(capture).webhooks.update(7, undefined, ['call.completed']);

    expect(capture.request?.method).toBe('PATCH');
    expect(new URL(capture.request!.url).pathname).toMatch(/\/webhooks\/endpoints\/7$/);
    expect(await capture.request!.json()).toEqual({ events: ['call.completed'] });
  });

  it('redeliver posts to the delivery id', async () => {
    const capture: Capture = {};
    await client(capture).webhooks.redeliver(42);

    expect(capture.request?.method).toBe('POST');
    expect(new URL(capture.request!.url).pathname).toMatch(/\/webhooks\/deliveries\/42\/redeliver$/);
  });
});
