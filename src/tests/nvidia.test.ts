import test from 'node:test';
import assert from 'node:assert/strict';
import { forwardToNvidia } from '../services/nvidia.ts';
import {
  clearRuntimeConfig,
  onApiRequestLog,
  setRuntimeConfig
} from '../services/runtime.ts';

test('NVIDIA forwarding sticks to the same key (no 429) and preserves streaming responses', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-first', 'nvapi-second'] });
  const authorizations: string[] = [];
  const upstreamStreams: unknown[] = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    authorizations.push(new Headers(init?.headers).get('authorization') || '');
    upstreamStreams.push(JSON.parse(String(init?.body || '{}')).stream);
    return new Response('data: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' }
    });
  };

  const first = await forwardToNvidia({ model: 'test', stream: true }, fakeFetch, 0);
  const second = await forwardToNvidia({ model: 'test', stream: true }, fakeFetch, 0);

  assert.deepEqual(authorizations, ['Bearer nvapi-first', 'Bearer nvapi-first']);
  assert.deepEqual(upstreamStreams, [true, true]);
  assert.equal(first.headers.get('content-type'), 'text/event-stream');
  assert.equal(await second.text(), 'data: [DONE]\n\n');
});

test('NVIDIA forwarding waits before starting the upstream request', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-delay'] });
  const startedAt = Date.now();
  let fetchAt = 0;
  const fakeFetch: typeof fetch = async () => {
    fetchAt = Date.now();
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  };

  await forwardToNvidia({ model: 'test' }, fakeFetch, 25);
  assert.ok(fetchAt - startedAt >= 20);
});

test('NVIDIA forwarding sends first 35 without wait, then waits for RPM window reset', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-limited'] });
  let now = 240_000;
  const rateSleeps: number[] = [];
  const rateLimitOptions = {
    now: () => now,
    sleep: async (milliseconds: number) => {
      rateSleeps.push(milliseconds);
      now += milliseconds;
    }
  };
  const fakeFetch: typeof fetch = async () =>
    new Response('{}', { headers: { 'content-type': 'application/json' } });

  for (let index = 0; index < 35; index++) {
    await forwardToNvidia({ model: 'test' }, fakeFetch, 0, rateLimitOptions);
  }
  // As primeiras 35 devem sair sem delay (sem pacing).
  assert.equal(rateSleeps.length, 0);
  // A 36a dispara o teto de 35 RPM e espera a reabertura da janela.
  await forwardToNvidia({ model: 'test' }, fakeFetch, 0, rateLimitOptions);
  assert.ok(rateSleeps.length > 0);
});

test('NVIDIA forwarding aggregates upstream streaming for non-streaming clients and logs lifecycle', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-stream'] });
  const events: string[] = [];
  const unsubscribe = onApiRequestLog((event) => {
    events.push(event.type);
  });
  const encoder = new TextEncoder();
  const fakeFetch: typeof fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"id":"chatcmpl-1","created":1,"model":"test","choices":[{"delta":{"role":"assistant","content":"Oi"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n'));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    }
  }), { headers: { 'content-type': 'text/event-stream' } });

  const response = await forwardToNvidia({ model: 'test', stream: false }, fakeFetch, 0);
  const body = await response.json() as any;

  assert.equal(body.choices[0].message.content, 'Oi!');
  assert.deepEqual(events, ['delay', 'called', 'started', 'completed']);
  unsubscribe();
});

test('NVIDIA forwarding honors zero configured delay and logs it', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-zero'], requestDelayMs: 0 });
  const events: Array<{ type: string; delayMs?: number }> = [];
  const unsubscribe = onApiRequestLog((event) => {
    events.push({ type: event.type, delayMs: event.delayMs });
  });
  const fakeFetch: typeof fetch = async () =>
    new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n', {
      headers: { 'content-type': 'text/event-stream' }
    });

  const response = await forwardToNvidia({ model: 'test', stream: false }, fakeFetch);
  const body = await response.json() as any;

  assert.equal(body.choices[0].message.content, 'ok');
  assert.deepEqual(events.map((event) => event.type), ['delay', 'called', 'started', 'completed']);
  assert.equal(events.find((event) => event.type === 'delay')?.delayMs, 0);
  unsubscribe();
});

test('NVIDIA forwarding finishes non-streaming clients as soon as upstream sends DONE', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-done'], requestDelayMs: 0 });
  const encoder = new TextEncoder();
  const fakeFetch: typeof fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode([
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n'
      ].join('')));
    }
  }), { headers: { 'content-type': 'text/event-stream' } });

  const response = await forwardToNvidia({ model: 'test', stream: false }, fakeFetch);
  const body = await response.json() as any;

  assert.equal(body.choices[0].message.content, 'ok');
});

test('NVIDIA forwarding closes streaming clients as soon as upstream sends DONE', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-done-stream'], requestDelayMs: 0 });
  const encoder = new TextEncoder();
  const fakeFetch: typeof fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    }
  }), { headers: { 'content-type': 'text/event-stream' } });

  const response = await forwardToNvidia({ model: 'test', stream: true }, fakeFetch);

  assert.equal(await response.text(), 'data: [DONE]\n\n');
});
test('NVIDIA forwarding closes streaming clients when upstream sends finish_reason without DONE', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-finish-stream'], requestDelayMs: 0 });
  const encoder = new TextEncoder();
  let upstreamCancelled = false;
  const fakeFetch: typeof fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"final"},"finish_reason":"stop"}]}\n\n'));
    },
    cancel() {
      upstreamCancelled = true;
    }
  }), { headers: { 'content-type': 'text/event-stream' } });

  const response = await forwardToNvidia({ model: 'test', stream: true }, fakeFetch, 0);

  assert.equal(
    await response.text(),
    'data: {"choices":[{"delta":{"content":"final"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  );
  assert.equal(upstreamCancelled, true);
});

test('NVIDIA forwarding aggregates non-streaming clients when upstream sends finish_reason without DONE', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-finish-json'], requestDelayMs: 0 });
  const encoder = new TextEncoder();
  let upstreamCancelled = false;
  const fakeFetch: typeof fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"final"},"finish_reason":"stop"}]}\n\n'));
    },
    cancel() {
      upstreamCancelled = true;
    }
  }), { headers: { 'content-type': 'text/event-stream' } });

  const response = await forwardToNvidia({ model: 'test', stream: false }, fakeFetch, 0);
  const body = await response.json() as any;

  assert.equal(body.choices[0].message.content, 'final');
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.equal(upstreamCancelled, true);
});
test('NVIDIA forwarding emits SSE keep-alives while streaming upstream is idle', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-keepalive'], requestDelayMs: 0 });
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let upstreamCancelled = false;
  const fakeFetch: typeof fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Oi"}}]}\n\n'));
    },
    cancel() {
      upstreamCancelled = true;
    }
  }), { headers: { 'content-type': 'text/event-stream' } });

  const response = await forwardToNvidia(
    { model: 'test', stream: true },
    fakeFetch,
    0,
    {},
    { streamKeepAliveMs: 5 }
  );
  assert.ok(response.body);
  const reader = response.body.getReader();

  const first = await reader.read();
  assert.equal(decoder.decode(first.value), 'data: {"choices":[{"delta":{"content":"Oi"}}]}\n\n');
  const keepAlive = await reader.read();
  assert.equal(decoder.decode(keepAlive.value), ': keep-alive\n\n');
  assert.equal(upstreamCancelled, false);

  await reader.cancel();
});

test('NVIDIA forwarding does not log local stream disposal as client cancellation', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-local-dispose'], requestDelayMs: 0 });
  const events: string[] = [];
  const unsubscribe = onApiRequestLog((event) => {
    events.push(event.type);
  });
  const encoder = new TextEncoder();
  const fakeFetch: typeof fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Oi"}}]}\n\n'));
    }
  }), { headers: { 'content-type': 'text/event-stream' } });

  const response = await forwardToNvidia({ model: 'test', stream: true }, fakeFetch, 0);
  assert.ok(response.body);
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  await Promise.resolve();

  assert.equal(events.includes('cancelled'), false);
  unsubscribe();
});
test('NVIDIA forwarding captures streamed response text without cloning the response', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-capture-stream'], requestDelayMs: 0 });
  let captured = '';
  const fakeFetch: typeof fetch = async () => new Response([
    'data: {"choices":[{"delta":{"content":"Oi"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n'
  ].join(''), { headers: { 'content-type': 'text/event-stream' } });

  const response = await forwardToNvidia(
    { model: 'test', stream: true },
    fakeFetch,
    0,
    {},
    { onResponseText: (text) => { captured = text; } }
  );

  assert.equal(await response.text(), 'data: {"choices":[{"delta":{"content":"Oi"}}]}\n\ndata: {"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  assert.equal(captured, 'Oi!');
});

test('NVIDIA forwarding captures aggregated response text for non-streaming clients', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-capture-json'], requestDelayMs: 0 });
  let captured = '';
  const fakeFetch: typeof fetch = async () => new Response([
    'data: {"choices":[{"delta":{"content":"Tudo"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" certo"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n'
  ].join(''), { headers: { 'content-type': 'text/event-stream' } });

  const response = await forwardToNvidia(
    { model: 'test', stream: false },
    fakeFetch,
    0,
    {},
    { onResponseText: (text) => { captured = text; } }
  );
  const body = await response.json() as any;

  assert.equal(body.choices[0].message.content, 'Tudo certo');
  assert.equal(captured, 'Tudo certo');
});
test('NVIDIA forwarding logs upstream HTTP errors', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-error'] });
  const events: Array<{ type: string; status?: number; message?: string }> = [];
  const unsubscribe = onApiRequestLog((event) => {
    events.push({
      type: event.type,
      status: event.status,
      message: event.message
    });
  });
  const fakeFetch: typeof fetch = async () =>
    new Response('rate limited', {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'content-type': 'text/plain' }
    });

  const response = await forwardToNvidia({ model: 'test' }, fakeFetch, 0);

  assert.equal(response.status, 429);
  assert.deepEqual(events.map((event) => event.type), [
    'delay',
    'called',
    'started',
    'upstream_error',
    'completed'
  ]);
  assert.equal(events.find((event) => event.type === 'upstream_error')?.status, 429);
  assert.equal(
    events.find((event) => event.type === 'upstream_error')?.message,
    'Too Many Requests'
  );
  unsubscribe();
});

test('NVIDIA forwarding fails over to the next key on HTTP 429', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-limited', 'nvapi-spare'] });
  const authorizations: string[] = [];
  const events: string[] = [];
  const unsubscribe = onApiRequestLog((event) => {
    events.push(event.type);
  });
  const fakeFetch: typeof fetch = async (_input, init) => {
    const auth = new Headers(init?.headers).get('authorization') || '';
    authorizations.push(auth);
    if (auth === 'Bearer nvapi-limited') {
      return new Response('rate limited', {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'content-type': 'text/plain' }
      });
    }
    return new Response(
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } }
    );
  };

  const response = await forwardToNvidia({ model: 'test', stream: false }, fakeFetch, 0);
  const body = await response.json() as any;

  assert.equal(response.status, 200);
  assert.equal(body.choices[0].message.content, 'ok');
  assert.deepEqual(authorizations, ['Bearer nvapi-limited', 'Bearer nvapi-spare']);
  assert.ok(events.includes('upstream_error'));
  assert.equal(events.filter((type) => type === 'called').length, 2);
  unsubscribe();
});

test('NVIDIA forwarding returns 429 only after every key is rate limited', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-a', 'nvapi-b'] });
  const authorizations: string[] = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    authorizations.push(new Headers(init?.headers).get('authorization') || '');
    return new Response('rate limited', {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'content-type': 'text/plain' }
    });
  };

  const response = await forwardToNvidia({ model: 'test' }, fakeFetch, 0);

  assert.equal(response.status, 429);
  assert.deepEqual(authorizations, ['Bearer nvapi-a', 'Bearer nvapi-b']);
});

test('NVIDIA forwarding serializes the configured delay so sends are spaced apart', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-gate'] });
  let now = 1_000_000;
  const opts = {
    now: () => now,
    sleep: async (milliseconds: number) => {
      now += milliseconds;
    }
  };
  const sendTimes: number[] = [];
  const fakeFetch: typeof fetch = async () => {
    sendTimes.push(now);
    return new Response('data: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' }
    });
  };

  await forwardToNvidia({ model: 'test' }, fakeFetch, 3000, opts);
  await forwardToNvidia({ model: 'test' }, fakeFetch, 3000, opts);

  // Cada request espera ao menos o delay antes de enviar, e os envios ficam
  // espacados em delayMs entre si (em vez de dispararem juntos apos um atraso comum).
  assert.equal(sendTimes[0], 1_003_000);
  assert.equal(sendTimes[1], 1_006_000);
});

test('NVIDIA forwarding skips a penalized key on later requests (1h castigo)', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-one', 'nvapi-two'] });
  const authorizations: string[] = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    const auth = new Headers(init?.headers).get('authorization') || '';
    authorizations.push(auth);
    if (auth === 'Bearer nvapi-one') {
      return new Response('rate limited', {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'content-type': 'text/plain' }
      });
    }
    return new Response('data: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' }
    });
  };

  // Request 1: key1 leva 429 -> failover para key2; key1 entra de castigo por 1h.
  await forwardToNvidia({ model: 'test', stream: true }, fakeFetch, 0);
  // Request 2: vai DIRETO para key2, sem desperdicar uma chamada na key1 de castigo.
  authorizations.length = 0;
  await forwardToNvidia({ model: 'test', stream: true }, fakeFetch, 0);
  assert.deepEqual(authorizations, ['Bearer nvapi-two']);
  clearRuntimeConfig();
});

test('NVIDIA forwarding logs the model on started and upstream_error', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-model'] });
  const byType = new Map<string, string | undefined>();
  const unsubscribe = onApiRequestLog((event) => {
    if (event.type === 'started' || event.type === 'upstream_error') {
      byType.set(event.type, event.model);
    }
  });
  const fakeFetch: typeof fetch = async () =>
    new Response('not found', {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'text/plain' }
    });

  await forwardToNvidia({ model: 'moonshotai/kimi-k2-instruct' }, fakeFetch, 0);

  assert.equal(byType.get('started'), 'moonshotai/kimi-k2-instruct');
  assert.equal(byType.get('upstream_error'), 'moonshotai/kimi-k2-instruct');
  unsubscribe();
  clearRuntimeConfig();
});

test('NVIDIA forwarding does not delegate to another API when the first stream is silent', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['nvapi-silent', 'nvapi-fast'] });
  const authorizations: string[] = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    authorizations.push(new Headers(init?.headers).get('authorization') || '');
    return new Response(new ReadableStream({ start() {} }), {
      headers: { 'content-type': 'text/event-stream' }
    });
  };

  const response = await forwardToNvidia(
    { model: 'test', stream: false },
    fakeFetch,
    0,
    {},
    { firstResponseTimeoutMs: 5 }
  );

  assert.equal(response.status, 504);
  assert.deepEqual(authorizations, ['Bearer nvapi-silent']);
});
