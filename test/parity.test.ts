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
    await client(capture).workflows.startSession('wf_1', { variables: { name: 'Ada' } });

    expect(await capture.request!.json()).toEqual({ variables: { name: 'Ada' } });
  });
});

describe('phoneNumbers parity', () => {
  it('instant sends query params and no body', async () => {
    const capture: Capture = {};
    await client(capture).phoneNumbers.instant({ country: 'US', provider: 'twilio' });

    expect(capture.request?.method).toBe('POST');
    const url = new URL(capture.request!.url);
    expect(url.pathname).toMatch(/\/telephony\/numbers\/instant$/);
    expect(url.search).toBe('?country=US&provider=twilio');
    expect(await capture.request!.text()).toBe('');
    expect(capture.request?.headers.get('content-type')).toBeNull();
  });

  it('importNumber sends only the provided fields', async () => {
    const capture: Capture = {};
    await client(capture).phoneNumbers.importNumber({ e164: '+15550001111', provider: 'twilio' });

    expect(new URL(capture.request!.url).pathname).toMatch(/\/telephony\/numbers\/import$/);
    expect(await capture.request!.json()).toEqual({ e164: '+15550001111', provider: 'twilio' });
  });
});

describe('campaigns parity', () => {
  it('create posts the snake_case body', async () => {
    const capture: Capture = {};
    await client(capture).campaigns.create({
      name: 'Launch',
      workflow_uuid: 'wf_1',
      from_number: '+15550002222',
    });

    expect(capture.request?.method).toBe('POST');
    expect(new URL(capture.request!.url).pathname).toMatch(/\/telephony\/campaigns$/);
    expect(await capture.request!.json()).toEqual({
      name: 'Launch',
      workflow_uuid: 'wf_1',
      from_number: '+15550002222',
    });
  });

  it('create sends contacts as plain numbers, not objects', async () => {
    // The API takes a list of strings; sending objects is rejected with a 422.
    const capture: Capture = {};
    await client(capture).campaigns.create({
      name: 'Launch',
      workflow_uuid: 'wf_1',
      from_number: '+15550002222',
      contacts: ['+15550003333', '0532 123 45 67'],
    });

    expect(await capture.request!.json()).toMatchObject({
      contacts: ['+15550003333', '0532 123 45 67'],
    });
  });

  it('create carries the schedule and the calling window', async () => {
    const capture: Capture = {};
    await client(capture).campaigns.create({
      name: 'Launch',
      workflow_uuid: 'wf_1',
      from_number: '+15550002222',
      contacts_csv: 'phone,name\n+15550003333,Ada\n',
      scheduled_at: '2026-03-01T09:00:00Z',
      call_window_start: '09:00',
      call_window_end: '20:00',
      timezone: 'Europe/Istanbul',
      suppression_policy: 'ignore',
      override_caller_requests: true,
    });

    expect(await capture.request!.json()).toMatchObject({
      scheduled_at: '2026-03-01T09:00:00Z',
      call_window_start: '09:00',
      call_window_end: '20:00',
      timezone: 'Europe/Istanbul',
      suppression_policy: 'ignore',
      override_caller_requests: true,
    });
  });

  it('stop and delete address the campaign', async () => {
    const capture: Capture = {};
    await client(capture).campaigns.stop('camp_1');
    expect(capture.request?.method).toBe('POST');
    expect(new URL(capture.request!.url).pathname).toMatch(/\/telephony\/campaigns\/camp_1\/stop$/);

    await client(capture).campaigns.delete('camp_1');
    expect(capture.request?.method).toBe('DELETE');
    expect(new URL(capture.request!.url).pathname).toMatch(/\/telephony\/campaigns\/camp_1$/);
  });

  it('addContacts posts CSV text and no source url', async () => {
    const capture: Capture = {};
    await client(capture).campaigns.addContacts('camp_1', 'telefon;isim\n+905321234567;Ada\n');

    expect(new URL(capture.request!.url).pathname).toMatch(
      /\/telephony\/campaigns\/camp_1\/contacts\/sync$/,
    );
    expect(await capture.request!.json()).toEqual({
      contacts_csv: 'telefon;isim\n+905321234567;Ada\n',
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

  it('previewSuppression reports how many each policy reaches', async () => {
    const capture: Capture = {};
    const preview = await client(
      capture,
      JSON.stringify({
        contacts: 100,
        suppressed_total: 12,
        caller_requested: 4,
        reached_if_strict: 88,
        reached_if_transactional: 92,
        reached_if_ignore: 96,
        reached_if_override: 100,
      }),
    ).campaigns.previewSuppression({ contacts: ['+15550003333'] });

    expect(new URL(capture.request!.url).pathname).toMatch(
      /\/telephony\/campaigns\/suppression-preview$/,
    );
    expect(preview.caller_requested).toBe(4);
    expect(preview.reached_if_strict).toBe(88);
  });
});

describe('dnc parity', () => {
  it('list passes search and paging', async () => {
    const capture: Capture = {};
    await client(capture, '{"items":[],"total":0}').dnc.list({
      search: '0555',
      limit: 50,
      offset: 100,
    });

    expect(capture.request?.method).toBe('GET');
    const url = new URL(capture.request!.url);
    expect(url.pathname).toMatch(/\/dnc$/);
    expect(url.search).toBe('?search=0555&limit=50&offset=100');
  });

  it('list omits unset filters', async () => {
    const capture: Capture = {};
    await client(capture, '{"items":[],"total":0}').dnc.list();

    expect(new URL(capture.request!.url).search).toBe('');
  });

  it('add posts the number and the reason', async () => {
    const capture: Capture = {};
    await client(capture).dnc.add('+15550003333', 'asked on a call');

    expect(capture.request?.method).toBe('POST');
    expect(await capture.request!.json()).toEqual({
      phone: '+15550003333',
      reason: 'asked on a call',
    });
  });

  it('omits an unstated reason rather than sending null', async () => {
    // The reason is a plain string server-side, not a nullable one, so a null
    // is a 422 rather than "no reason given".
    const capture: Capture = {};
    await client(capture).dnc.add('+15550003333');
    expect(await capture.request!.json()).toEqual({ phone: '+15550003333' });

    await client(capture, '{"added":1}').dnc.import(['+15550003333']);
    expect(await capture.request!.json()).toEqual({ phones: ['+15550003333'] });
  });

  it('setScope and remove carry the phone number in the path', async () => {
    const capture: Capture = {};
    await client(capture).dnc.setScope('+15550003333', 'marketing');

    expect(capture.request?.method).toBe('PATCH');
    // "+" has to reach the server as itself, not as a space.
    expect(new URL(capture.request!.url).pathname).toMatch(/\/dnc\/%2B15550003333$/);
    expect(await capture.request!.json()).toEqual({ scope: 'marketing' });

    await client(capture).dnc.remove('+15550003333');
    expect(capture.request?.method).toBe('DELETE');
    expect(new URL(capture.request!.url).pathname).toMatch(/\/dnc\/%2B15550003333$/);
  });

  it('import reports what it did', async () => {
    const capture: Capture = {};
    const result = await client(
      capture,
      '{"added":8,"duplicates":1,"rejected":2}',
    ).dnc.import(['+15550003333', 'not a number'], 'CRM export');

    expect(new URL(capture.request!.url).pathname).toMatch(/\/dnc\/import$/);
    expect(result.added).toBe(8);
    expect(result.rejected).toBe(2);
  });
});

describe('tools parity', () => {
  it('update is a PATCH that omits unprovided fields', async () => {
    const capture: Capture = {};
    await client(capture).tools.update('tool_1', { name: 'Renamed' });

    expect(capture.request?.method).toBe('PATCH');
    expect(new URL(capture.request!.url).pathname).toMatch(/\/tools\/tool_1$/);
    // Only the provided `name` is sent; description/kind/config/parameters are absent.
    expect(await capture.request!.json()).toEqual({ name: 'Renamed' });
  });
});

describe('knowledgeBase parity', () => {
  it('search posts the query and optional knobs', async () => {
    const capture: Capture = {};
    await client(capture, '[]').knowledgeBase.search({ query: 'refund policy', top_k: 5, document_ids: [1, 2] });

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
    await client(capture).webhooks.update(7, { events: ['call.completed'] });

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
