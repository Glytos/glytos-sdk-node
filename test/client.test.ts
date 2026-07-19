import { describe, expect, it } from 'vitest';
import { Glytos, GlytosError } from '../src/index';

interface Capture {
  request?: Request;
}

// A fetch stub that records the outgoing request and returns a fresh response each call.
function stubFetch(body: string, init: ResponseInit, capture?: Capture): typeof fetch {
  return (async (input: RequestInfo | URL, requestInit?: RequestInit) => {
    if (capture) capture.request = new Request(input, requestInit);
    return new Response(body, init);
  }) as typeof fetch;
}

describe('Glytos', () => {
  it('requires an api key', () => {
    expect(() => new Glytos('')).toThrow();
  });

  it('decodes json and sends auth headers', async () => {
    const capture: Capture = {};
    const glytos = new Glytos({
      apiKey: 'gly_test',
      environment: 'prod',
      fetch: stubFetch('[{"uuid":"wf_1"}]', { status: 200, headers: { 'x-request-id': 'req_1' } }, capture),
    });

    const agents = await glytos.workflows.list();

    expect(agents).toEqual([{ uuid: 'wf_1' }]);
    expect(capture.request?.headers.get('X-API-Key')).toBe('gly_test');
    expect(capture.request?.headers.get('X-Environment-Id')).toBe('prod');
    expect(capture.request?.method).toBe('GET');
    expect(capture.request?.url).toMatch(/\/workflows$/);
  });

  it('drops null query parameters', async () => {
    const capture: Capture = {};
    const glytos = new Glytos({
      apiKey: 'gly_test',
      fetch: stubFetch('[]', { status: 200 }, capture),
    });

    await glytos.calls.list({ status: 'completed', agent: null });

    expect(new URL(capture.request!.url).search).toBe('?status=completed');
  });

  it('throws GlytosError on a non-2xx response', async () => {
    const glytos = new Glytos({
      apiKey: 'gly_test',
      fetch: stubFetch(
        '{"error":{"code":"not_found","message":"Nope"}}',
        { status: 404, headers: { 'x-request-id': 'req_2' } },
      ),
    });

    const error = await glytos.workflows.retrieve('missing').catch((e) => e);

    expect(error).toBeInstanceOf(GlytosError);
    expect(error.status).toBe(404);
    expect(error.code).toBe('not_found');
    expect(error.message).toBe('Nope');
    expect(error.requestId).toBe('req_2');
  });
});
