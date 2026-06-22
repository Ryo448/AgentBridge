import {
  FIRST_RESPONSE_TIMEOUT_MS,
  NVIDIA_CHAT_URL
} from '../config.ts';
import {
  acquireApiKey,
  getApiKeyCount,
  getRequestDelayMs,
  markApiRateLimited,
  reserveSendSlot,
  markApiModelSwitch,
  markApiRequestCancelled,
  markApiRequestError,
  markApiDelayWaiting,
  markApiResponseCompleted,
  markApiResponseStarted,
  markApiSuccess,
  markApiUpstreamError,
  type AcquireApiKeyOptions
} from './runtime.ts';

export type NvidiaFetch = typeof fetch;

type ForwardOptions = {
  firstResponseTimeoutMs?: number;
  // Failover automatico de modelo. Quando TODAS as chaves estao de castigo (429)
  // para o modelo atual ("nao tem para onde correr"), o proxy chama esta funcao
  // com a lista de modelos ja esgotados e troca para o proximo modelo disponivel
  // da lista de prioridades, sem devolver o 429 ao cliente. Retorna null quando
  // nao sobra nenhum modelo elegivel. So e passado no modo de alternancia automatica.
  resolveModel?: (exhausted: string[]) => string | null;
};

type FirstChunk = {
  response: Response;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  value: Uint8Array;
};

type ToolCallDraft = {
  id?: string;
  type: 'function';
  function: {
    name?: string;
    arguments: string;
  };
};

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

function appendSseTextAndHasDone(state: { buffer: string; totalTokens?: number; promptTokens?: number; completionTokens?: number }, text: string) {
  state.buffer += text;
  while (true) {
    const boundary = state.buffer.search(/\r?\n\r?\n/);
    if (boundary < 0) {
      state.buffer = state.buffer.slice(-256);
      return false;
    }
    const raw = state.buffer.slice(0, boundary);
    const separatorLength = state.buffer[boundary] === '\r' ? 4 : 2;
    state.buffer = state.buffer.slice(boundary + separatorLength);
    const data = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data === '[DONE]') return true;
    if (data) {
      const usage = extractUsage(data);
      if (usage) {
        if (usage.totalTokens !== undefined) state.totalTokens = usage.totalTokens;
        if (usage.promptTokens !== undefined) state.promptTokens = usage.promptTokens;
        if (usage.completionTokens !== undefined) state.completionTokens = usage.completionTokens;
      }
    }
  }
}

async function readFirstChunk(
  fetchImpl: NvidiaFetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number
): Promise<FirstChunk> {
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

function streamWithLogs(input: {
  firstChunk: Uint8Array;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  apiNumber: number;
  requestStartedAt: number;
  attempt?: number;
  maxAttempts?: number;
  model?: string;
}) {
  let firstEnqueued = false;
  let completed = false;
  const decoder = new TextDecoder();
  const sseState: { buffer: string; totalTokens?: number; promptTokens?: number; completionTokens?: number } = { buffer: '' };
  const markCompletedAndClose = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (completed) return;
    completed = true;
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
            const done = appendSseTextAndHasDone(
              sseState,
              decoder.decode(input.firstChunk, { stream: true })
            );
            if (done) await markCompletedAndClose(controller);
          }
          return;
        }
        const { done, value } = await input.reader.read();
        if (done) {
          await markCompletedAndClose(controller);
          return;
        }
        if (value) {
          controller.enqueue(value);
          const streamDone = appendSseTextAndHasDone(
            sseState,
            decoder.decode(value, { stream: true })
          );
          if (streamDone) await markCompletedAndClose(controller);
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
        controller.error(error);
      }
    },
    cancel() {
      if (completed) return;
      completed = true;
      markApiRequestCancelled({
        apiNumber: input.apiNumber,
        requestStartedAt: input.requestStartedAt,
        attempt: input.attempt,
        maxAttempts: input.maxAttempts
      });
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
    .map((data) => JSON.parse(data));
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
    const choice = event.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (delta.role) role = delta.role;
    if (delta.content) content += delta.content;
    for (const toolCall of delta.tool_calls || []) mergeToolCall(toolCalls, toolCall);
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

async function readRemainingText(
  firstChunk: Uint8Array,
  reader: ReadableStreamDefaultReader<Uint8Array>
) {
  const decoder = new TextDecoder();
  const sseState: { buffer: string; totalTokens?: number; promptTokens?: number; completionTokens?: number } = { buffer: '' };
  let text = firstChunk.length ? decoder.decode(firstChunk, { stream: true }) : '';
  if (firstChunk.length && appendSseTextAndHasDone(sseState, text)) {
    await reader.cancel().catch(() => {});
    text += decoder.decode();
    return text;
  }
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunkText = decoder.decode(value, { stream: true });
    text += chunkText;
    if (appendSseTextAndHasDone(sseState, chunkText)) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  text += decoder.decode();
  return text;
}

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
  const requestStartedAt = now();
  const maxAttempts = Math.max(1, getApiKeyCount());
  // Modelo atual da request. Pode mudar no meio do caminho quando o failover
  // automatico de modelo troca para o proximo da lista de prioridades.
  let activeModel = typeof body.model === 'string' ? body.model : undefined;
  // Modelos ja esgotados (todas as chaves de castigo) nesta request, para o
  // resolveModel nao devolver o mesmo de novo e o failover ser monotonico.
  const exhaustedModels: string[] = [];
  let apiNumber: number | undefined;

  // Porteira de envio: prepara, espera o delay configurado e SO entao envia ao
  // modelo. A espera e serializada (uma request por vez, espacadas em delayMs),
  // de modo que o delay realmente reduz a taxa que chega na NVIDIA e o consumo de
  // RPM -- em vez de apenas atrasar, em paralelo, um lote inteiro de requests.
  markApiDelayWaiting({ delayMs, timestamp: now() });
  await reserveSendSlot({ delayMs, now, sleep: rateLimitOptions.sleep });

  // Failover SOMENTE em HTTP 429 (limite da chave). A mesma request e reenviada
  // automaticamente para a proxima chave da lista, sem devolver o erro ao cliente.
  // NAO ha failover em timeout ou erro de rede: reenviar o mesmo contexto gigante
  // so pagaria o prefill de novo e empilharia minutos de espera ate um eventual 504,
  // entao nesses casos devolvemos o erro e deixamos o cliente reenviar o turno.
  let attempt = 0;
  while (true) {
    attempt++;
    let acquired;
    try {
      // O castigo de 429 e por modelo: passa o modelo da request para que uma chave
      // de castigo em outro modelo continue elegivel para este.
      acquired = await acquireApiKey({ ...rateLimitOptions, model: activeModel });
    } catch (error: any) {
      // Todas as chaves estao de castigo (429) para o modelo atual: nao ha para onde
      // encaminhar NESTE modelo. No modo automatico, troca para o proximo modelo
      // disponivel da lista de prioridades e segue, sem devolver o erro ao cliente.
      const resting = error?.code === 'all_resting';
      if (resting && options.resolveModel) {
        const previousModel = activeModel;
        if (activeModel) exhaustedModels.push(activeModel);
        const nextModel = options.resolveModel(exhaustedModels.slice());
        if (nextModel && !exhaustedModels.includes(nextModel)) {
          markApiModelSwitch({
            from: previousModel,
            to: nextModel,
            reason: 'todas as APIs em castigo 429',
            timestamp: now()
          });
          activeModel = nextModel;
          body = { ...body, model: nextModel };
          attempt = 0; // modelo novo: o orcamento de tentativas por chave reinicia
          continue;
        }
      }
      markApiRequestError({
        apiNumber,
        message: error?.message || String(error),
        requestStartedAt,
        attempt,
        maxAttempts,
        timestamp: now()
      });
      return Response.json({
        error: {
          type: resting ? 'rate_limited' : 'upstream_timeout',
          message: error?.message || 'Nenhuma API NVIDIA disponivel.'
        }
      }, { status: resting ? 429 : 504 });
    }
    apiNumber = acquired.apiNumber;

    try {
      // Pede usage no stream (include_usage) para conseguirmos contar os tokens
      // consumidos em cada request -- exibidos no log e no botao de teste.
      const upstreamBody = {
        ...body,
        stream: true,
        stream_options: {
          ...(body.stream_options && typeof body.stream_options === 'object'
            ? body.stream_options as Record<string, unknown>
            : {}),
          include_usage: true
        }
      };
      const { response, reader, value } = await readFirstChunk(fetchImpl, NVIDIA_CHAT_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${acquired.apiKey}`,
          'content-type': 'application/json',
          accept: 'text/event-stream'
        },
        body: JSON.stringify(upstreamBody)
      }, timeoutMs);

      markApiResponseStarted({
        apiNumber,
        requestStartedAt,
        model: activeModel,
        attempt,
        maxAttempts,
        timestamp: now()
      });

      // 429 e ainda ha chave seguinte: banca esta chave e tenta a proxima com a
      // MESMA request, mantendo o fluxo do agente vivo.
      if (response.status === 429 && attempt < maxAttempts) {
        markApiUpstreamError({
          apiNumber,
          status: 429,
          message: response.statusText || 'Too Many Requests',
          requestStartedAt,
          model: activeModel,
          attempt,
          maxAttempts,
          timestamp: now()
        });
        markApiRateLimited({
          apiNumber,
          model: activeModel,
          retryAfterMs: parseRetryAfterMs(response),
          timestamp: now()
        });
        markApiResponseCompleted({
          apiNumber,
          requestStartedAt,
          attempt,
          maxAttempts,
          timestamp: now()
        });
        await reader.cancel().catch(() => {});
        continue;
      }

      if (!response.ok) {
        markApiUpstreamError({
          apiNumber,
          status: response.status,
          message: response.statusText || `NVIDIA HTTP ${response.status}`,
          requestStartedAt,
          model: activeModel,
          attempt,
          maxAttempts,
          timestamp: now()
        });
        // 429 na ultima chave disponivel: ainda assim coloca ela de castigo de 1h,
        // para a proxima request ja nao tentar essa chave saturada.
        if (response.status === 429) {
          markApiRateLimited({
            apiNumber,
            model: activeModel,
            retryAfterMs: parseRetryAfterMs(response),
            timestamp: now()
          });
        }
        markApiResponseCompleted({
          apiNumber,
          requestStartedAt,
          attempt,
          maxAttempts,
          timestamp: now()
        });
        await reader.cancel().catch(() => {});
        // Failover de modelo no modo automatico:
        //  - 429: esta chave acabou de entrar em castigo, entao todas ficaram saturadas
        //    neste modelo -> troca para o proximo da lista em vez de devolver 429.
        //  - 400/404: a NVIDIA nao reconhece este modelo (id errado, modelo removido).
        //    Como o erro e imediato (nao pagou prefill), tambem pula para o proximo
        //    modelo em vez de quebrar a request do cliente.
        const isModelFailover =
          response.status === 429 ||
          response.status === 400 ||
          response.status === 404;
        if (isModelFailover && options.resolveModel) {
          const previousModel = activeModel;
          if (activeModel) exhaustedModels.push(activeModel);
          const nextModel = options.resolveModel(exhaustedModels.slice());
          if (nextModel && !exhaustedModels.includes(nextModel)) {
            markApiModelSwitch({
              from: previousModel,
              to: nextModel,
              apiNumber,
              reason: response.status === 429
                ? 'todas as APIs em castigo 429'
                : `modelo recusado (HTTP ${response.status})`,
              timestamp: now()
            });
            activeModel = nextModel;
            body = { ...body, model: nextModel };
            attempt = 0;
            continue;
          }
        }
        return responseFromUpstream(response);
      }

      // Resposta HTTP 200 da NVIDIA nesta (chave, modelo): conta +1 na contagem
      // de 200 do par, que vira "200 ate dar 429" se essa chave levar 429 depois.
      markApiSuccess({ apiNumber, model: activeModel, timestamp: now() });

      if (clientWantsStream) {
        const headers = cloneHeaders(response);
        headers.set('content-type', 'text/event-stream');
        return new Response(streamWithLogs({
          firstChunk: value,
          reader,
          apiNumber,
          requestStartedAt,
          attempt,
          maxAttempts,
          model: activeModel
        }), {
          status: response.status,
          statusText: response.statusText,
          headers
        });
      }

      const text = await readRemainingText(value, reader);
      const completion = aggregateChatCompletion(parseSseEvents(text));
      const usageInfo = (completion as { usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number } }).usage;
      markApiResponseCompleted({
        apiNumber,
        requestStartedAt,
        attempt,
        maxAttempts,
        totalTokens: usageInfo?.total_tokens,
        promptTokens: usageInfo?.prompt_tokens,
        completionTokens: usageInfo?.completion_tokens,
        model: activeModel,
        timestamp: now()
      });
      return Response.json(completion, {
        status: response.status,
        statusText: response.statusText,
        headers: { 'cache-control': 'no-store' }
      });
    } catch (error: any) {
      markApiRequestError({
        apiNumber,
        message: error?.message || String(error),
        requestStartedAt,
        attempt,
        maxAttempts,
        timestamp: now()
      });
      return Response.json({
        error: {
          type: 'upstream_timeout',
          message: error?.message || 'A API NVIDIA nao iniciou resposta a tempo.'
        }
      }, { status: 504 });
    }
  }

  // Inalcancavel na pratica (a ultima tentativa sempre retorna acima), mas mantido
  // como rede de seguranca de tipo: todas as chaves responderam 429.
  return Response.json({
    error: {
      type: 'rate_limited',
      message: 'Todas as APIs NVIDIA retornaram 429.'
    }
  }, { status: 429 });
}
