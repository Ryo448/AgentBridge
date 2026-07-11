import {
  FIRST_RESPONSE_TIMEOUT_MS,
  HEDGE_SLOW_THRESHOLD_MS,
  HEDGE_PRIMARY_GRACE_MS,
  NVIDIA_CHAT_URL
} from '../config.ts';
import {
  acquireApiKey,
  getApiKeyCount,
  getRequestDelayMs,
  markApiRateLimited,
  reserveSendSlot,
  markApiModelSwitch,
  markHedgedModelSwitch,
  markApiRequestCancelled,
  markApiRequestError,
  markApiDelayWaiting,
  markApiResponseCompleted,
  markApiResponseStarted,
  markApiSuccess,
  markApiUpstreamError,
  type AcquireApiKeyOptions
} from './runtime.ts';

import { saveLastError } from './lastErrors.ts';
import { extractUserPrompt } from './lastPrompt.ts';

export type NvidiaFetch = typeof fetch;

async function captureUpstreamErrorForLog(
  response: Response,
  body: Record<string, unknown>,
  model?: string
) {
  try {
    const cloned = response.clone();
    let errorBody = '';
    try {
      errorBody = await cloned.text();
    } catch {
      errorBody = '';
    }
    void saveLastError({
      savedAt: '',
      model: model || (typeof body.model === 'string' ? body.model : ''),
      prompt: extractUserPrompt(body),
      errorMessage: response.statusText || `HTTP ${response.status}`,
      errorStatus: response.status,
      errorBody
    });
  } catch {
    // Ignora — nao pode derrubar a request
  }
}

type ForwardOptions = {
  firstResponseTimeoutMs?: number;
  resolveModel?: (exhausted: string[]) => string | null;
  enableHedge?: boolean;
  onResponseText?: (text: string, model?: string) => void;
  streamKeepAliveMs?: number;
  // Sinal do cliente: quando o cliente cancela a request, este signal
  // e abortado e o proxy cancela todas as requests ativas (primario + backup).
  abortSignal?: AbortSignal;
};

type ToolCallDraft = {
  id?: string;
  type: 'function';
  function: {
    name?: string;
    arguments: string;
  };
};

const DEFAULT_STREAM_KEEP_ALIVE_MS = 5_000;
const SSE_KEEP_ALIVE_CHUNK = new TextEncoder().encode(': keep-alive\n\n');
const SSE_DONE_CHUNK = new TextEncoder().encode('data: [DONE]\n\n');

type SseCompletionReason = false | 'done' | 'finish_reason';

function timeoutError(milliseconds: number) {
  return new Error(`A API NVIDIA nao respondeu em ${Math.round(milliseconds / 1000)}s.`);
}

async function withTimeout<T>(
  action: Promise<T>,
  milliseconds: number,
  onTimeout?: () => void
) {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      action,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(timeoutError(milliseconds));
        }, milliseconds);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function cloneHeaders(response: Response) {
  const headers = new Headers();
  const contentType = response.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  headers.set('cache-control', 'no-store');
  return headers;
}

function parseRetryAfterMs(response: Response) {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function responseFromUpstream(response: Response) {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: cloneHeaders(response)
  });
}

function extractUsage(data: string): { totalTokens?: number; promptTokens?: number; completionTokens?: number } | undefined {
  if (!data.includes('"usage"')) return undefined;
  try {
    const parsed = JSON.parse(data);
    const usage = parsed?.usage;
    if (!usage) return undefined;
    return {
      totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
      promptTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
      completionTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined
    };
  } catch {
    return undefined;
  }
}

function appendSseTextAndCompletionReason(state: { buffer: string; responseText: string; totalTokens?: number; promptTokens?: number; completionTokens?: number }, text: string): SseCompletionReason {
  let completionReason: SseCompletionReason = false;
  state.buffer += text;
  while (true) {
    const boundary = state.buffer.search(/\r?\n\r?\n/);
    if (boundary < 0) {
      state.buffer = state.buffer.slice(-256);
      return completionReason;
    }
    const raw = state.buffer.slice(0, boundary);
    const separatorLength = state.buffer[boundary] === '\r' ? 4 : 2;
    state.buffer = state.buffer.slice(boundary + separatorLength);
    const data = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data === '[DONE]') return 'done';
    if (data) {
      const usage = extractUsage(data);
      if (usage) {
        if (usage.totalTokens !== undefined) state.totalTokens = usage.totalTokens;
        if (usage.promptTokens !== undefined) state.promptTokens = usage.promptTokens;
        if (usage.completionTokens !== undefined) state.completionTokens = usage.completionTokens;
      }
      try {
        const parsed = JSON.parse(data);
        const choice = parsed?.choices?.[0];
        const content = choice?.delta?.content;
        if (typeof content === 'string') state.responseText += content;
        if (choice?.finish_reason) completionReason = 'finish_reason';
      } catch {
        // Ignora eventos SSE que nao sejam JSON de chat completion.
      }
    }
  }
}

function streamWithLogs(input: {
  firstChunk: Uint8Array;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  apiNumber: number;
  requestStartedAt: number;
  attempt?: number;
  maxAttempts?: number;
  model?: string;
  onResponseText?: (text: string, model?: string) => void;
  keepAliveMs?: number;
  abortSignal?: AbortSignal;
}) {
  let firstEnqueued = false;
  let completed = false;
  let responseTextReported = false;
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  const decoder = new TextDecoder();
  const sseState: { buffer: string; responseText: string; totalTokens?: number; promptTokens?: number; completionTokens?: number } = { buffer: '', responseText: '' };
  const keepAliveMs = Math.max(1, input.keepAliveMs ?? DEFAULT_STREAM_KEEP_ALIVE_MS);
  const getPendingRead = () => {
    pendingRead ??= input.reader.read();
    return pendingRead;
  };
  const reportResponseText = () => {
    if (responseTextReported) return;
    responseTextReported = true;
    input.onResponseText?.(sseState.responseText, input.model);
  };
  const markCompletedAndClose = async (controller: ReadableStreamDefaultController<Uint8Array>, appendDone = false) => {
    if (completed) return;
    completed = true;
    if (appendDone) controller.enqueue(SSE_DONE_CHUNK);
    reportResponseText();
    markApiResponseCompleted({
      apiNumber: input.apiNumber,
      requestStartedAt: input.requestStartedAt,
      attempt: input.attempt,
      maxAttempts: input.maxAttempts,
      totalTokens: sseState.totalTokens,
      promptTokens: sseState.promptTokens,
      completionTokens: sseState.completionTokens,
      model: input.model
    });
    await input.reader.cancel().catch(() => {});
    controller.close();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!firstEnqueued) {
          firstEnqueued = true;
          if (input.firstChunk.length) {
            controller.enqueue(input.firstChunk);
            const completionReason = appendSseTextAndCompletionReason(
              sseState,
              decoder.decode(input.firstChunk, { stream: true })
            );
            if (completionReason) await markCompletedAndClose(controller, completionReason === 'finish_reason');
          }
          return;
        }
        let keepAliveTimer: NodeJS.Timeout | undefined;
        let readResult: { type: 'read'; result: ReadableStreamReadResult<Uint8Array> } | { type: 'keep_alive' };
        try {
          readResult = await Promise.race([
            getPendingRead().then((result) => ({ type: 'read' as const, result })),
            new Promise<{ type: 'keep_alive' }>((resolve) => {
              keepAliveTimer = setTimeout(() => resolve({ type: 'keep_alive' }), keepAliveMs);
            })
          ]);
        } finally {
          if (keepAliveTimer) clearTimeout(keepAliveTimer);
        }
        if (readResult.type === 'keep_alive') {
          controller.enqueue(SSE_KEEP_ALIVE_CHUNK);
          return;
        }

        pendingRead = null;
        const { done, value } = readResult.result;
        if (done) {
          await markCompletedAndClose(controller);
          return;
        }
        if (value) {
          controller.enqueue(value);
          const completionReason = appendSseTextAndCompletionReason(
            sseState,
            decoder.decode(value, { stream: true })
          );
          if (completionReason) await markCompletedAndClose(controller, completionReason === 'finish_reason');
        }
      } catch (error) {
        if (completed) return;
        markApiRequestError({
          apiNumber: input.apiNumber,
          requestStartedAt: input.requestStartedAt,
          attempt: input.attempt,
          maxAttempts: input.maxAttempts,
          message: error instanceof Error ? error.message : String(error)
        });
        reportResponseText();
        controller.error(error);
      }
    },
    cancel() {
      if (completed) return;
      completed = true;
      reportResponseText();
      if (input.abortSignal?.aborted) {
        markApiRequestCancelled({
          apiNumber: input.apiNumber,
          requestStartedAt: input.requestStartedAt,
          attempt: input.attempt,
          maxAttempts: input.maxAttempts
        });
      }
      input.reader.cancel().catch(() => {});
    }
  });
}

function parseSseEvents(text: string) {
  return text
    .split(/\r?\n\r?\n/)
    .map((event) => event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n'))
    .filter((data) => data && data !== '[DONE]')
    .map((data) => {
      try {
        return JSON.parse(data);
      } catch {
        return undefined;
      }
    })
    .filter((event): event is Record<string, unknown> => event !== undefined);
}

function mergeToolCall(
  drafts: Map<number, ToolCallDraft>,
  toolCall: any
) {
  const index = toolCall.index || 0;
  let draft = drafts.get(index);
  if (!draft) {
    draft = {
      id: toolCall.id,
      type: 'function',
      function: {
        name: toolCall.function?.name,
        arguments: ''
      }
    };
    drafts.set(index, draft);
  }
  if (toolCall.id) draft.id = toolCall.id;
  if (toolCall.function?.name) draft.function.name = toolCall.function.name;
  if (toolCall.function?.arguments) draft.function.arguments += toolCall.function.arguments;
}

function aggregateChatCompletion(events: any[]) {
  let id = 'chatcmpl-agentbridge';
  let created = Math.floor(Date.now() / 1000);
  let model = '';
  let role = 'assistant';
  let content = '';
  let finishReason: string | null = null;
  let usage: any = null;
  const toolCalls = new Map<number, ToolCallDraft>();

  for (const event of events) {
    if (event.id) id = event.id;
    if (event.created) created = event.created;
    if (event.model) model = event.model;
    if (event.usage) usage = event.usage;
    if (finishReason) continue; // apos a primeira finish_reason, descarta chunks extra
    const choice = event.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (delta.role) role = delta.role;
    if (delta.content) content += delta.content;
    for (const toolCall of delta.tool_calls || []) mergeToolCall(toolCalls, toolCall);
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{
      index: 0,
      message: {
        role,
        content: toolCalls.size ? (content || null) : content,
        ...(toolCalls.size ? { tool_calls: [...toolCalls.values()] } : {})
      },
      finish_reason: finishReason || (toolCalls.size ? 'tool_calls' : 'stop')
    }],
    ...(usage ? { usage } : {})
  };
}

function completionHasOutput(completion: any) {
  const message = completion?.choices?.[0]?.message;
  const content = message?.content;
  const hasText = typeof content === 'string' && content.trim().length > 0;
  const hasToolCalls = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
  return hasText || hasToolCalls;
}

function emptyResponseMessage(model?: string) {
  return `A NVIDIA retornou uma resposta vazia${model ? ` para o modelo ${model}` : ''}.`;
}

function ensureSseDone(text: string) {
  if (/(^|\n)data:\s*\[DONE\]\s*$/m.test(text.trimEnd())) return text;
  const separator = text.endsWith('\n\n') || text.endsWith('\r\n\r\n') ? '' : '\n\n';
  return `${text}${separator}data: [DONE]\n\n`;
}

function sseTextHasOutput(text: string) {
  try {
    return completionHasOutput(aggregateChatCompletion(parseSseEvents(text)));
  } catch {
    return false;
  }
}

async function readRemainingText(
  firstChunk: Uint8Array,
  reader: ReadableStreamDefaultReader<Uint8Array>
) {
  const decoder = new TextDecoder();
  const sseState: { buffer: string; responseText: string; totalTokens?: number; promptTokens?: number; completionTokens?: number } = { buffer: '', responseText: '' };
  let text = firstChunk.length ? decoder.decode(firstChunk, { stream: true }) : '';
  if (firstChunk.length && appendSseTextAndCompletionReason(sseState, text)) {
    await reader.cancel().catch(() => {});
    text += decoder.decode();
    return text;
  }
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunkText = decoder.decode(value, { stream: true });
    text += chunkText;
    if (appendSseTextAndCompletionReason(sseState, chunkText)) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  text += decoder.decode();
  return text;
}

function buildUpstreamBody(body: Record<string, unknown>) {
  return {
    ...body,
    stream: true,
    stream_options: {
      ...(body.stream_options && typeof body.stream_options === 'object'
        ? body.stream_options as Record<string, unknown>
        : {}),
      include_usage: true
    }
  };
}

// ---------------------------------------------------------------------------
// ModelAttempt: estado de uma tentativa de fetch bem-sucedida (HTTP 200)
// ---------------------------------------------------------------------------
type ModelAttempt = {
  model: string;
  apiNumber: number;
  response: Response;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  firstChunk: Uint8Array;
  abortController: AbortController;
};

// ---------------------------------------------------------------------------
// makeSuccessResponse: monta a Response final (stream ou JSON)
// ---------------------------------------------------------------------------
async function makeSuccessResponse(
  attempt: ModelAttempt,
  requestStartedAt: number,
  maxAttempts: number,
  clientWantsStream: boolean,
  onResponseText?: (text: string, model?: string) => void,
  keepAliveMs?: number,
  abortSignal?: AbortSignal,
  emptyRetryState?: { count: number }
): Promise<Response | undefined> {
  const text = await readRemainingText(attempt.firstChunk, attempt.reader);
  const completion = aggregateChatCompletion(parseSseEvents(text));
  const usageInfo = (completion as { usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number } }).usage;

  if (!completionHasOutput(completion)) {
    markApiUpstreamError({
      apiNumber: attempt.apiNumber,
      status: 204,
      message: emptyResponseMessage(attempt.model),
      requestStartedAt,
      attempt: 1,
      maxAttempts,
      model: attempt.model
    });
    markApiResponseCompleted({
      apiNumber: attempt.apiNumber,
      requestStartedAt,
      attempt: 1,
      maxAttempts,
      totalTokens: usageInfo?.total_tokens,
      promptTokens: usageInfo?.prompt_tokens,
      completionTokens: usageInfo?.completion_tokens,
      model: attempt.model,
      timestamp: Date.now()
    });
    if (emptyRetryState) emptyRetryState.count++;
    return undefined;
  }

  onResponseText?.(String(completion.choices?.[0]?.message?.content || ''), attempt.model);
  markApiResponseCompleted({
    apiNumber: attempt.apiNumber,
    requestStartedAt,
    attempt: 1,
    maxAttempts,
    totalTokens: usageInfo?.total_tokens,
    promptTokens: usageInfo?.prompt_tokens,
    completionTokens: usageInfo?.completion_tokens,
    model: attempt.model,
    timestamp: Date.now()
  });

  if (clientWantsStream) {
    const headers = cloneHeaders(attempt.response);
    headers.set('content-type', 'text/event-stream');
    return new Response(ensureSseDone(text), {
      status: attempt.response.status,
      statusText: attempt.response.statusText,
      headers
    });
  }

  return Response.json(completion, {
    status: attempt.response.status,
    statusText: attempt.response.statusText,
    headers: { 'cache-control': 'no-store' }
  });
}
// ---------------------------------------------------------------------------
// Lê o primeiro chunk de um ReadableStream com timeout
// ---------------------------------------------------------------------------
async function readFirstChunk(
  fetchImpl: NvidiaFetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number
): Promise<{ response: Response; reader: ReadableStreamDefaultReader<Uint8Array>; value: Uint8Array }> {
  const controller = new AbortController();
  const startedAt = Date.now();
  const response = await withTimeout(fetchImpl(input, {
    ...init,
    signal: controller.signal
  }), timeoutMs, () => controller.abort());

  if (!response.ok || !response.body) {
    return {
      response,
      reader: new ReadableStream<Uint8Array>().getReader(),
      value: new Uint8Array()
    };
  }

  const reader = response.body.getReader();
  const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
  const firstRead = await withTimeout(reader.read(), remainingMs, () => controller.abort());
  if (firstRead.done || !firstRead.value) {
    return { response, reader, value: new Uint8Array() };
  }
  return { response, reader, value: firstRead.value };
}

// ---------------------------------------------------------------------------
// forwardToNvidia — ponto de entrada principal
// ---------------------------------------------------------------------------
export async function forwardToNvidia(
  body: Record<string, unknown>,
  fetchImpl: NvidiaFetch = fetch,
  delayMs = getRequestDelayMs(),
  rateLimitOptions: AcquireApiKeyOptions = {},
  options: ForwardOptions = {}
) {
  const clientWantsStream = Boolean(body.stream);
  const timeoutMs = options.firstResponseTimeoutMs ?? FIRST_RESPONSE_TIMEOUT_MS;
  const now = rateLimitOptions.now || Date.now;
  const onResponseText = options.onResponseText;
  const requestStartedAt = now();
  const maxAttempts = Math.max(1, getApiKeyCount());
  let activeModel = typeof body.model === 'string' ? body.model : undefined;
  const exhaustedModels: string[] = [];
  let apiNumber: number | undefined;
  const emptyRetryState = { count: 0 };

  markApiDelayWaiting({ delayMs, timestamp: now() });
  await reserveSendSlot({ delayMs, now, sleep: rateLimitOptions.sleep });

  let attempt = 0;
  while (true) {
    attempt++;
    let acquired;
    try {
      acquired = await acquireApiKey({ ...rateLimitOptions, model: activeModel });
    } catch (error: any) {
      const resting = error?.code === 'all_resting';
      if (resting && options.resolveModel) {
        const previousModel = activeModel;
        if (activeModel) exhaustedModels.push(activeModel);
        const nextModel = options.resolveModel(exhaustedModels.slice());
        if (nextModel && !exhaustedModels.includes(nextModel)) {
          markApiModelSwitch({ from: previousModel, to: nextModel, reason: 'todas as APIs em castigo 429', timestamp: now() });
          activeModel = nextModel;
          body = { ...body, model: nextModel };
          attempt = 0;
          emptyRetryState.count = 0;
          continue;
        }
      }
      markApiRequestError({ apiNumber, message: error?.message || String(error), requestStartedAt, attempt, maxAttempts, timestamp: now() });
      return Response.json({
        error: { type: resting ? 'rate_limited' : 'upstream_timeout', message: error?.message || 'Nenhuma API NVIDIA disponivel.' }
      }, { status: resting ? 429 : 504 });
    }
    apiNumber = acquired.apiNumber;

    const upstreamBody = buildUpstreamBody(body);

    // ======================================================================
    // Com hedge: usa race entre readFirstChunk e timer
    // ======================================================================
    if (options.enableHedge && options.resolveModel) {
      // Se o cliente ja cancelou, nem comeca
      if (options.abortSignal?.aborted) {
        markApiRequestCancelled({ apiNumber, requestStartedAt, message: 'Cliente cancelou a request.', attempt, maxAttempts, timestamp: now() });
        return new Response(null, { status: 499 });
      }
      const result = await hedgeForward(
        body, activeModel!, fetchImpl, timeoutMs, rateLimitOptions,
        attempt, maxAttempts, requestStartedAt, options.resolveModel,
        upstreamBody, acquired, clientWantsStream, now, options.abortSignal, onResponseText, emptyRetryState
      );
      if (result) return result;
      // undefined: erro 429 ou HTTP error que o loop externo pode tentar de novo
      continue;
    }

    // ======================================================================
    // Sem hedge: comportamento original
    // ======================================================================
    try {
      const { response, reader, value } = await readFirstChunk(fetchImpl, NVIDIA_CHAT_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${acquired.apiKey}`,
          'content-type': 'application/json',
          accept: 'text/event-stream'
        },
        body: JSON.stringify(upstreamBody)
      }, timeoutMs);

      markApiResponseStarted({ apiNumber, requestStartedAt, model: activeModel, attempt, maxAttempts, timestamp: now() });

      if (response.status === 429 && attempt < maxAttempts) {
        markApiUpstreamError({ apiNumber, status: 429, message: response.statusText || 'Too Many Requests', requestStartedAt, model: activeModel, attempt, maxAttempts, timestamp: now() });
        markApiRateLimited({ apiNumber, model: activeModel, retryAfterMs: parseRetryAfterMs(response), timestamp: now() });
        markApiResponseCompleted({ apiNumber, requestStartedAt, attempt, maxAttempts, timestamp: now() });
        await reader.cancel().catch(() => {});
        continue;
      }

      if (!response.ok) {
        markApiUpstreamError({ apiNumber, status: response.status, message: response.statusText || `NVIDIA HTTP ${response.status}`, requestStartedAt, model: activeModel, attempt, maxAttempts, timestamp: now() });
        if (response.status === 429) markApiRateLimited({ apiNumber, model: activeModel, retryAfterMs: parseRetryAfterMs(response), timestamp: now() });
        markApiResponseCompleted({ apiNumber, requestStartedAt, attempt, maxAttempts, timestamp: now() });
        await reader.cancel().catch(() => {});

        const isModelFailover = response.status === 429 || response.status === 400 || response.status === 404;
        if (isModelFailover && options.resolveModel) {
          const previousModel = activeModel;
          if (activeModel) exhaustedModels.push(activeModel);
          const nextModel = options.resolveModel(exhaustedModels.slice());
          if (nextModel && !exhaustedModels.includes(nextModel)) {
            if (response.status !== 429) {
              void captureUpstreamErrorForLog(response, body, activeModel);
            }
            markApiModelSwitch({ from: previousModel, to: nextModel, apiNumber, reason: response.status === 429 ? 'todas as APIs em castigo 429' : `modelo recusado (HTTP ${response.status})`, timestamp: now() });
            activeModel = nextModel;
            body = { ...body, model: nextModel };
            attempt = 0;
            emptyRetryState.count = 0;
            continue;
          }
        }
        return responseFromUpstream(response);
      }

      markApiSuccess({ apiNumber, model: activeModel, timestamp: now() });

      if (clientWantsStream && sseTextHasOutput(new TextDecoder().decode(value))) {
        const headers = cloneHeaders(response);
        headers.set('content-type', 'text/event-stream');
        return new Response(streamWithLogs({
          firstChunk: value, reader, apiNumber, requestStartedAt, attempt, maxAttempts, model: activeModel, onResponseText: onResponseText, keepAliveMs: options.streamKeepAliveMs, abortSignal: options.abortSignal
        }), { status: response.status, statusText: response.statusText, headers });
      }

      const text = await readRemainingText(value, reader);
      const completion = aggregateChatCompletion(parseSseEvents(text));
      const usageInfo = (completion as { usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number } }).usage;
      if (!completionHasOutput(completion)) {
        markApiUpstreamError({ apiNumber, status: 204, message: emptyResponseMessage(activeModel), requestStartedAt, model: activeModel, attempt, maxAttempts, timestamp: now() });
        markApiResponseCompleted({ apiNumber, requestStartedAt, attempt, maxAttempts, totalTokens: usageInfo?.total_tokens, promptTokens: usageInfo?.prompt_tokens, completionTokens: usageInfo?.completion_tokens, model: activeModel, timestamp: now() });

        emptyRetryState.count++;
        continue;
      }
      onResponseText?.(String(completion.choices?.[0]?.message?.content || ''), activeModel);
      markApiResponseCompleted({ apiNumber, requestStartedAt, attempt, maxAttempts, totalTokens: usageInfo?.total_tokens, promptTokens: usageInfo?.prompt_tokens, completionTokens: usageInfo?.completion_tokens, model: activeModel, timestamp: now() });
      if (clientWantsStream) {
        const headers = cloneHeaders(response);
        headers.set('content-type', 'text/event-stream');
        return new Response(ensureSseDone(text), { status: response.status, statusText: response.statusText, headers });
      }
      return Response.json(completion, { status: response.status, statusText: response.statusText, headers: { 'cache-control': 'no-store' } });

    } catch (error: any) {
      markApiRequestError({ apiNumber, message: error?.message || String(error), requestStartedAt, attempt, maxAttempts, timestamp: now() });
      return Response.json({
        error: { type: 'upstream_timeout', message: error?.message || 'A API NVIDIA nao iniciou resposta a tempo.' }
      }, { status: 504 });
    }
  }

  return Response.json({
    error: { type: 'rate_limited', message: 'Todas as APIs NVIDIA retornaram 429.' }
  }, { status: 429 });
}

// ===========================================================================
// hedgeForward: fluxo completo com hedge.
//
// 1. Dispara fetch HTTP do primario com timeout de 600s
// 2. Timer de 60s corre em paralelo esperando o HTTP 200
// 3. Se timer vencer → faz doFetch completo do backup
// 4. Quando o backup responder (HTTP 200 + primeiro chunk) → grace period de 10s
// 5. Se primario responder no grace → primario vence
// 6. Se nao → backup vence, primario cancelado, sticky ativado
// ===========================================================================
async function hedgeForward(
  body: Record<string, unknown>,
  activeModel: string,
  fetchImpl: NvidiaFetch,
  timeoutMs: number,
  rateLimitOptions: AcquireApiKeyOptions,
  attempt: number,
  maxAttempts: number,
  requestStartedAt: number,
  resolveModelFn: (exhausted: string[]) => string | null,
  upstreamBody: Record<string, unknown>,
  acquired: { apiKey: string; apiNumber: number },
  clientWantsStream: boolean,
  now: () => number,
  clientAbortSignal?: AbortSignal,
  onResponseText?: (text: string) => void,
  emptyRetryState?: { count: number }
): Promise<Response | undefined> {
  const primaryApiNumber = acquired.apiNumber;
  const primaryAbort = new AbortController();

  // Helper: trata abort do cliente — aborta primario e/ou backup
  let backupAbortForCleanup: AbortController | null = null;
  const onClientAbort = () => {
    primaryAbort.abort();
    if (backupAbortForCleanup) backupAbortForCleanup.abort();
  };
  const abortListener = clientAbortSignal
    ? () => { clientAbortSignal.addEventListener('abort', onClientAbort, { once: true }); }
    : () => {};
  abortListener();
  const cleanup = () => {
    if (clientAbortSignal) clientAbortSignal.removeEventListener('abort', onClientAbort);
  };

  // Se o cliente ja cancelou, aborta tudo
  if (clientAbortSignal?.aborted) {
    primaryAbort.abort();
    cleanup();
    return undefined;
  }
  // Retorna {response, reader} ou null em caso de abort/timeout/erro
  const primaryHttp = (async (): Promise<{ response: Response; reader: ReadableStreamDefaultReader<Uint8Array> } | null> => {
    try {
      const response = await withTimeout(fetchImpl(NVIDIA_CHAT_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${acquired.apiKey}`,
          'content-type': 'application/json',
          accept: 'text/event-stream'
        },
        signal: primaryAbort.signal,
        body: JSON.stringify(upstreamBody)
      }), timeoutMs);
      if (primaryAbort.signal.aborted) return null;
      if (!response.body) return { response, reader: new ReadableStream<Uint8Array>().getReader() };
      return { response, reader: response.body.getReader() };
    } catch (error: any) {
      if (error?.name === 'AbortError') return null;
      return null;
    }
  })();

  // Timer do hedge
  const hedgeTimer = new Promise<'timeout'>((resolve) => {
    setTimeout(() => resolve('timeout'), HEDGE_SLOW_THRESHOLD_MS);
  });

  // Race: HTTP do primario vs timer
  const first = await Promise.race([
    primaryHttp.then((r) => ({ type: 'primary' as const, result: r })),
    hedgeTimer.then(() => ({ type: 'hedge' as const }))
  ]);

  // ---- Caso A: Primario respondeu HTTP (qualquer status) antes do timer ----
  if (first.type === 'primary') {
    const httpResult = first.result;
    if (!httpResult) return undefined;

    const { response, reader } = httpResult;

    markApiResponseStarted({ apiNumber: primaryApiNumber, requestStartedAt, model: activeModel, attempt, maxAttempts, timestamp: now() });

    // 429: coloca em castigo e retorna undefined pro loop tentar de novo
    if (response.status === 429) {
      markApiUpstreamError({ apiNumber: primaryApiNumber, status: 429, message: response.statusText || 'Too Many Requests', requestStartedAt, model: activeModel, attempt, maxAttempts, timestamp: now() });
      markApiRateLimited({ apiNumber: primaryApiNumber, model: activeModel, retryAfterMs: parseRetryAfterMs(response), timestamp: now() });
      markApiResponseCompleted({ apiNumber: primaryApiNumber, requestStartedAt, attempt, maxAttempts, timestamp: now() });
      await reader.cancel().catch(() => {});
      cleanup();
      return undefined;
    }

    // Outro HTTP erro
    if (!response.ok) {
      markApiUpstreamError({ apiNumber: primaryApiNumber, status: response.status, message: response.statusText || `NVIDIA HTTP ${response.status}`, requestStartedAt, model: activeModel, attempt, maxAttempts, timestamp: now() });
      if (response.status === 429) markApiRateLimited({ apiNumber: primaryApiNumber, model: activeModel, retryAfterMs: parseRetryAfterMs(response), timestamp: now() });
      if (response.status !== 429) {
        void captureUpstreamErrorForLog(response, body, activeModel);
      }
      markApiResponseCompleted({ apiNumber: primaryApiNumber, requestStartedAt, attempt, maxAttempts, timestamp: now() });
      await reader.cancel().catch(() => {});
      cleanup();
      return undefined; // loop externo tenta failover 400/404
    }

    // HTTP 200! Le o primeiro chunk
    markApiSuccess({ apiNumber: primaryApiNumber, model: activeModel, timestamp: now() });

    let firstChunk: Uint8Array;
    try {
      const readResult = await withTimeout(reader.read(), Math.max(1, Math.min(60_000, timeoutMs - (Date.now() - requestStartedAt))));
      firstChunk = readResult.done ? new Uint8Array() : (readResult.value || new Uint8Array());
    } catch {
      firstChunk = new Uint8Array();
    }

    const ma: ModelAttempt = { model: activeModel, apiNumber: primaryApiNumber, response, reader, firstChunk, abortController: primaryAbort };
    cleanup();
    return makeSuccessResponse(ma, requestStartedAt, maxAttempts, clientWantsStream, onResponseText, undefined, clientAbortSignal, emptyRetryState);
  }

  // ---- Caso B: Hedge timeout! Primario nao respondeu HTTP em 60s ----
  console.log(`[HEDGE] Primario (${activeModel}) sem HTTP 200 em ${HEDGE_SLOW_THRESHOLD_MS}ms. Disparando backup.`);

  const backupModel = resolveModelFn([activeModel]);
  if (!backupModel) {
    console.log(`[HEDGE] Nenhum modelo backup. Aguardando primario.`);
    cleanup();
    const httpResult = await primaryHttp;
    if (!httpResult) { cleanup(); return undefined; }
    return processPrimaryHttp(httpResult, body, activeModel, fetchImpl, timeoutMs, rateLimitOptions, attempt, maxAttempts, requestStartedAt, resolveModelFn, upstreamBody, acquired, clientWantsStream, now, onResponseText, clientAbortSignal, emptyRetryState);
  }
  console.log(`[HEDGE] Backup modelo: ${backupModel}`);

  // Se o cliente cancelou, aborta tudo
  if (clientAbortSignal?.aborted) {
    primaryAbort.abort();
    if (clientAbortSignal) clientAbortSignal.removeEventListener('abort', onClientAbort);
    return undefined;
  }

  // Dispara backup (doFetch completo: acquireApiKey + fetch + primeiro chunk)
  const backupAbort = new AbortController();
  backupAbortForCleanup = backupAbort;

  const backupAttempt = await doFetchWithModel(
    { ...body, model: backupModel }, backupModel,
    fetchImpl, timeoutMs, rateLimitOptions, requestStartedAt, backupAbort
  );

  if (!backupAttempt) {
    console.log(`[HEDGE] Backup falhou. Aguardando primario.`);
    cleanup();
    const httpResult = await primaryHttp;
    if (!httpResult) { cleanup(); return undefined; }
    return processPrimaryHttp(httpResult, body, activeModel, fetchImpl, timeoutMs, rateLimitOptions, attempt, maxAttempts, requestStartedAt, resolveModelFn, upstreamBody, acquired, clientWantsStream, now, onResponseText, clientAbortSignal, emptyRetryState);
  }

  // ---- Backup respondeu (HTTP 200 + primeiro chunk). Grace period. ----
  console.log(`[HEDGE] Backup respondeu. Grace period de ${HEDGE_PRIMARY_GRACE_MS}ms...`);
  const primaryLate = await Promise.race([
    primaryHttp.then((r) => r),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), HEDGE_PRIMARY_GRACE_MS))
  ]);

  if (primaryLate) {
    // Primario respondeu HTTP no grace period!
    const { response, reader } = primaryLate;

    // Se o primario deu erro, continua com backup!
    if (!response.ok) {
      console.log(`[HEDGE] Primario respondeu com HTTP ${response.status} no grace. Backup mantido.`);
    } else {
      // Primario deu HTTP 200. Le o primeiro chunk e ve se tem dados
      console.log(`[HEDGE] Primario respondeu HTTP 200 no grace period.`);
      markApiResponseStarted({ apiNumber: primaryApiNumber, requestStartedAt, model: activeModel, attempt, maxAttempts, timestamp: now() });
      markApiSuccess({ apiNumber: primaryApiNumber, model: activeModel, timestamp: now() });

      let primaryChunk: Uint8Array;
      try {
        const rr = await withTimeout(reader.read(), Math.min(60_000, timeoutMs - (Date.now() - requestStartedAt)));
        primaryChunk = rr.done ? new Uint8Array() : (rr.value || new Uint8Array());
      } catch {
        primaryChunk = new Uint8Array();
      }

      // Primario tem dados: ele vence!
      if (primaryChunk.length) {
        console.log(`[HEDGE] Primario tem dados. Primario vence, backup cancelado.`);
        backupAbort.abort();
        await backupAttempt.reader.cancel().catch(() => {});
        const ma: ModelAttempt = { model: activeModel, apiNumber: primaryApiNumber, response, reader, firstChunk: primaryChunk, abortController: primaryAbort };
        cleanup();
        return makeSuccessResponse(ma, requestStartedAt, maxAttempts, clientWantsStream, onResponseText, undefined, clientAbortSignal, emptyRetryState);
      }

      // Primario respondeu HTTP 200 mas chunk vazio — continua com backup
      console.log(`[HEDGE] Primario HTTP 200 mas chunk vazio. Backup mantido.`);
      await reader.cancel().catch(() => {});
    }
  }

  // ---- Backup wins! ----
  console.log(`[HEDGE] Backup venceu! Modelo ${backupAttempt.model} assumiu. Cancelando primario.`);
  primaryAbort.abort();
  try { await primaryHttp; } catch {}
  cleanup();
  markHedgedModelSwitch({ from: activeModel, to: backupAttempt.model, apiNumber: primaryApiNumber, timestamp: Date.now() });
  if (emptyRetryState) emptyRetryState.count = 0;
  return makeSuccessResponse(backupAttempt, requestStartedAt, maxAttempts, clientWantsStream, onResponseText, undefined, clientAbortSignal, emptyRetryState);
}

// Processa o HTTP response do primario depois que ele respondeu
async function processPrimaryHttp(
  httpResult: { response: Response; reader: ReadableStreamDefaultReader<Uint8Array> },
  body: Record<string, unknown>,
  activeModel: string,
  fetchImpl: NvidiaFetch,
  timeoutMs: number,
  rateLimitOptions: AcquireApiKeyOptions,
  attempt: number,
  maxAttempts: number,
  requestStartedAt: number,
  resolveModelFn: (exhausted: string[]) => string | null,
  upstreamBody: Record<string, unknown>,
  acquired: { apiKey: string; apiNumber: number },
  clientWantsStream: boolean,
  now: () => number,
  onResponseText?: (text: string, model?: string) => void,
  clientAbortSignal?: AbortSignal,
  emptyRetryState?: { count: number }
): Promise<Response | undefined> {
  const primaryApiNumber = acquired.apiNumber;
  const { response, reader } = httpResult;

  markApiResponseStarted({ apiNumber: primaryApiNumber, requestStartedAt, model: activeModel, attempt, maxAttempts, timestamp: now() });

  if (response.status === 429 && attempt < maxAttempts) {
    markApiUpstreamError({ apiNumber: primaryApiNumber, status: 429, message: response.statusText || 'Too Many Requests', requestStartedAt, model: activeModel, attempt, maxAttempts, timestamp: now() });
    markApiRateLimited({ apiNumber: primaryApiNumber, model: activeModel, retryAfterMs: parseRetryAfterMs(response), timestamp: now() });
    markApiResponseCompleted({ apiNumber: primaryApiNumber, requestStartedAt, attempt, maxAttempts, timestamp: now() });
    await reader.cancel().catch(() => {});
    return undefined;
  }

  if (!response.ok) {
    markApiUpstreamError({ apiNumber: primaryApiNumber, status: response.status, message: response.statusText || `NVIDIA HTTP ${response.status}`, requestStartedAt, model: activeModel, attempt, maxAttempts, timestamp: now() });
    if (response.status === 429) markApiRateLimited({ apiNumber: primaryApiNumber, model: activeModel, retryAfterMs: parseRetryAfterMs(response), timestamp: now() });
    markApiResponseCompleted({ apiNumber: primaryApiNumber, requestStartedAt, attempt, maxAttempts, timestamp: now() });
    await reader.cancel().catch(() => {});
    return undefined;
  }

  markApiSuccess({ apiNumber: primaryApiNumber, model: activeModel, timestamp: now() });

  let firstChunk: Uint8Array;
  try {
    const rr = await withTimeout(reader.read(), Math.min(60_000, timeoutMs - (Date.now() - requestStartedAt)));
    firstChunk = rr.done ? new Uint8Array() : (rr.value || new Uint8Array());
  } catch {
    firstChunk = new Uint8Array();
  }

  const ma: ModelAttempt = { model: activeModel, apiNumber: primaryApiNumber, response, reader, firstChunk, abortController: new AbortController() };
  return makeSuccessResponse(ma, requestStartedAt, maxAttempts, clientWantsStream, onResponseText, undefined, clientAbortSignal, emptyRetryState);
}

// doFetchWithModel: acquireApiKey + fetch + primeiro chunk, retorna null em erro
async function doFetchWithModel(
  body: Record<string, unknown>,
  model: string,
  fetchImpl: NvidiaFetch,
  timeoutMs: number,
  rateLimitOptions: AcquireApiKeyOptions,
  requestStartedAt: number,
  abortController: AbortController
): Promise<ModelAttempt | null> {
  let acquired;
  try {
    acquired = await acquireApiKey({ ...rateLimitOptions, model });
  } catch {
    return null;
  }

  const apiNumber = acquired.apiNumber;
  const upstreamBody = buildUpstreamBody(body);

  try {
    const { response, reader, value } = await readFirstChunk(fetchImpl, NVIDIA_CHAT_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${acquired.apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream'
      },
      signal: abortController.signal,
      body: JSON.stringify(upstreamBody)
    }, timeoutMs);

    if (abortController.signal.aborted) {
      await reader.cancel().catch(() => {});
      return null;
    }

    markApiResponseStarted({ apiNumber, requestStartedAt, model, attempt: 1, maxAttempts: 1, timestamp: Date.now() });

    if (!response.ok) {
      markApiUpstreamError({ apiNumber, status: response.status, message: response.statusText || `NVIDIA HTTP ${response.status}`, requestStartedAt, model, attempt: 1, maxAttempts: 1, timestamp: Date.now() });
      if (response.status === 429) markApiRateLimited({ apiNumber, model, retryAfterMs: parseRetryAfterMs(response), timestamp: Date.now() });
      if (response.status !== 429) {
        void captureUpstreamErrorForLog(response, body, model);
      }
      markApiResponseCompleted({ apiNumber, requestStartedAt, attempt: 1, maxAttempts: 1, timestamp: Date.now() });
      await reader.cancel().catch(() => {});
      return null;
    }

    markApiSuccess({ apiNumber, model, timestamp: Date.now() });

    return { model, apiNumber, response, reader, firstChunk: value, abortController };
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      markApiRequestCancelled({ apiNumber, requestStartedAt, message: 'Request abortada (hedge)', attempt: 1, maxAttempts: 1, timestamp: Date.now() });
    } else {
      markApiRequestError({ apiNumber, message: error?.message || String(error), requestStartedAt, attempt: 1, maxAttempts: 1, timestamp: Date.now() });
    }
    return null;
  }
}