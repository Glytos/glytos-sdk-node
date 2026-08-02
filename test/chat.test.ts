import { describe, expect, it } from 'vitest';
import { Glytos } from '../src/index';

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

/** An SSE body, exactly as the server frames it. */
function sseBody(...blocks: Array<[string, unknown]>): string {
  return blocks.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

function sseClient(body: string): Glytos {
  return new Glytos({
    apiKey: 'gly_test',
    fetch: stubFetch(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  });
}

describe('threads', () => {
  it('create opens a session against the agent and carries its id back', async () => {
    const capture: Capture = {};
    const glytos = new Glytos({
      apiKey: 'gly_test',
      fetch: stubFetch(
        JSON.stringify({ session_uuid: 'ses_1', status: 'in_progress', messages: [{ role: 'assistant', content: 'Hi' }] }),
        { status: 200 },
        capture,
      ),
    });
    const thread = await glytos.threads.create({ agent: 'wf_1', variables: { name: 'Ada' } });

    expect(capture.request?.method).toBe('POST');
    expect(new URL(capture.request!.url).pathname).toMatch(/\/workflows\/wf_1\/sessions$/);
    expect(await capture.request!.json()).toEqual({ variables: { name: 'Ada' } });
    // The agent id rides on the thread so no later call has to repeat it.
    expect(thread).toMatchObject({ id: 'ses_1', agent: 'wf_1', status: 'in_progress' });
    expect(thread.messages).toHaveLength(1);
  });

  it('messages.create posts the turn and passes per-turn instructions through', async () => {
    const capture: Capture = {};
    await client(capture).threads.messages.create(
      { id: 'ses_1', agent: 'wf_1' },
      { content: 'hello', instructions: 'answer in French' },
    );

    expect(new URL(capture.request!.url).pathname).toMatch(/\/workflows\/wf_1\/sessions\/ses_1\/messages$/);
    expect(await capture.request!.json()).toEqual({
      content: 'hello',
      additional_instructions: 'answer in French',
    });
  });

  it('accepts a bare string as the turn', async () => {
    const capture: Capture = {};
    await client(capture).threads.runs.create({ id: 'ses_1', agent: 'wf_1' }, 'hi');
    expect(await capture.request!.json()).toEqual({ content: 'hi' });
  });

  it('runs with no message still sends an empty content', async () => {
    const capture: Capture = {};
    await client(capture).threads.runs.create({ id: 'ses_1', agent: 'wf_1' }, {
      instructions: 'summarise so far',
    });
    expect(await capture.request!.json()).toEqual({
      content: '',
      additional_instructions: 'summarise so far',
    });
  });

  it('messages.list returns the whole transcript', async () => {
    const glytos = new Glytos({
      apiKey: 'gly_test',
      fetch: stubFetch(
        JSON.stringify({ session_uuid: 'ses_1', status: 'completed', transcript: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }),
        { status: 200 },
      ),
    });
    const messages = await glytos.threads.messages.list({ id: 'ses_1', agent: 'wf_1' });
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('retrieve normalises the session detail into a thread', async () => {
    const glytos = new Glytos({
      apiKey: 'gly_test',
      fetch: stubFetch(
        JSON.stringify({ session_uuid: 'ses_9', status: 'completed', transcript: [], variables: { x: 1 } }),
        { status: 200 },
      ),
    });
    const detail = await glytos.threads.retrieve({ id: 'ses_9', agent: 'wf_1' });
    expect(detail).toMatchObject({ id: 'ses_9', agent: 'wf_1', status: 'completed' });
    expect(detail.variables).toEqual({ x: 1 });
  });

  it('refuses a thread reference missing an id', async () => {
    const glytos = client({});
    await expect(
      glytos.threads.messages.create({ id: '', agent: 'wf_1' }, 'hi'),
    ).rejects.toThrow(/needs both/);
  });
});

describe('streaming', () => {
  it('yields each token then the terminal run', async () => {
    const glytos = sseClient(
      sseBody(
        ['token', { delta: 'He' }],
        ['token', { delta: 'llo' }],
        ['done', { session_uuid: 'ses_1', status: 'completed', messages: [{ role: 'assistant', content: 'Hello' }] }],
      ),
    );

    const seen: string[] = [];
    let final: unknown;
    for await (const event of glytos.threads.runs.stream({ id: 'ses_1', agent: 'wf_1' }, 'hi')) {
      if (event.type === 'token') seen.push(event.delta);
      if (event.type === 'done') final = event.run;
    }
    expect(seen.join('')).toBe('Hello');
    expect(final).toMatchObject({ status: 'completed' });
  });

  it('surfaces a stream error event', async () => {
    const glytos = sseClient(sseBody(['error', { message: 'model refused' }]));
    const events = [];
    for await (const event of glytos.chat.stream({ token: 't', content: 'hi' })) events.push(event);
    expect(events).toEqual([{ type: 'error', message: 'model refused' }]);
  });

  it('handles an event split across chunks and a missing trailing blank line', async () => {
    // No trailing "\n\n" on the last block: the parser must still emit it.
    const glytos = sseClient('event: token\ndata: {"delta":"x"}\n\nevent: done\ndata: {"status":"completed"}');
    const events = [];
    for await (const event of glytos.threads.runs.stream({ id: 's', agent: 'w' })) events.push(event);
    expect(events).toEqual([
      { type: 'token', delta: 'x' },
      { type: 'done', run: { status: 'completed' } },
    ]);
  });

  it('throws a GlytosError when the stream endpoint rejects', async () => {
    const glytos = new Glytos({
      apiKey: 'gly_test',
      fetch: stubFetch(JSON.stringify({ error: { code: 'insufficient_credit', message: 'no credit' } }), { status: 402 }),
    });
    await expect(async () => {
      for await (const _ of glytos.threads.runs.stream({ id: 's', agent: 'w' })) void _;
    }).rejects.toMatchObject({ status: 402, code: 'insufficient_credit' });
  });
});

describe('folders, imports and uploads', () => {
  it('creates a folder', async () => {
    const capture: Capture = {};
    await client(capture).folders.create('Sales');
    expect(capture.request?.method).toBe('POST');
    expect(new URL(capture.request!.url).pathname).toMatch(/\/agent-folders$/);
    expect(await capture.request!.json()).toEqual({ name: 'Sales' });
  });

  it('deletes a folder', async () => {
    const capture: Capture = {};
    await client(capture).folders.delete('fld_1');
    expect(capture.request?.method).toBe('DELETE');
    expect(new URL(capture.request!.url).pathname).toMatch(/\/agent-folders\/fld_1$/);
  });

  it('imports an assistant definition', async () => {
    const capture: Capture = {};
    await client(capture).imports.assistant({ name: 'Support', instructions: 'help' });
    expect(await capture.request!.json()).toEqual({
      assistant: { name: 'Support', instructions: 'help' },
    });
  });

  it('uploads a chat file as multipart, not JSON', async () => {
    const capture: Capture = {};
    await client(capture).chat.uploadFile({
      token: 'tok',
      sessionUuid: 'ses_1',
      file: 'hello world',
      filename: 'notes.txt',
    });
    const contentType = capture.request!.headers.get('content-type') ?? '';
    expect(contentType).toMatch(/multipart\/form-data/);
    // The boundary must come from fetch; setting it by hand yields an unparseable body.
    expect(contentType).toMatch(/boundary=/);
    const form = await capture.request!.formData();
    expect(form.get('token')).toBe('tok');
    expect(form.get('session_uuid')).toBe('ses_1');
  });

  it('uploads a knowledge-base document', async () => {
    const capture: Capture = {};
    await client(capture).knowledgeBase.uploadDocument('body text', 'guide.md');
    expect(new URL(capture.request!.url).pathname).toMatch(/\/knowledge-base\/documents\/upload$/);
    expect(capture.request!.headers.get('content-type')).toMatch(/multipart\/form-data/);
  });
});

describe('agents alias', () => {
  it('is the same resource as workflows', () => {
    const glytos = client({});
    expect(glytos.agents).toBe(glytos.workflows);
  });

  it('sendMessage carries instructions', async () => {
    const capture: Capture = {};
    await client(capture).agents.sendMessage('wf_1', 'ses_1', { content: 'hi', instructions: 'be brief' });
    expect(await capture.request!.json()).toEqual({
      content: 'hi',
      additional_instructions: 'be brief',
    });
  });

  it('keeps the old positional images argument working', async () => {
    const capture: Capture = {};
    await client(capture).agents.sendMessage('wf_1', 'ses_1', 'look', ['data:image/png;base64,AAA']);
    expect(await capture.request!.json()).toEqual({
      content: 'look',
      images: ['data:image/png;base64,AAA'],
    });
  });
});
