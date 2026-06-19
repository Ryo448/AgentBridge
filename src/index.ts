import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PORT,
  FIXED_CLIENT_MODEL,
  INTERNAL_API_KEY,
  NVIDIA_RPM_LIMIT,
  RATE_LIMIT_WINDOW_MS
} from './config.ts';
import { responsesApi, anthropicMessagesApi } from './routes/compatibility.ts';
import { withLocalToolInstructions } from './routes/toolInstructions.ts';
import { forwardToNvidia } from './services/nvidia.ts';
import {
  getEffectiveModel,
  getRuntimeStatus,
  getSelectedModel,
  isAutoToggleEnabled,
  markClientRequestCompleted,
  markClientRequestFailed,
  markClientRequestReceived,
  markClientRequestRejected,
  onApiRequestLog,
  resolveAvailableModel,
  setRuntimeConfig,
  type ApiRequestLogEvent
} from './services/runtime.ts';

export const app = new Hono();

app.use('*', cors());
app.use('/v1/*', async (context, next) => {
  const requestStartedAt = Date.now();
  const method = context.req.method;
  const path = context.req.path;
  markClientRequestReceived({ method, path, timestamp: requestStartedAt });
  const bearer = context.req.header('authorization')?.replace(/^Bearer\s+/i, '');
  const apiKey = context.req.header('x-api-key');
  if (bearer !== INTERNAL_API_KEY && apiKey !== INTERNAL_API_KEY) {
    markClientRequestRejected({
      method,
      path,
      status: 401,
      message: 'Chave local invalida.',
      requestStartedAt
    });
    return context.json({
      error: {
        type: 'authentication_error',
        message: `Chave local invalida. Use ${INTERNAL_API_KEY}.`
      }
    }, 401);
  }
  try {
    await next();
    markClientRequestCompleted({
      method,
      path,
      status: context.res.status,
      requestStartedAt
    });
  } catch (error) {
    markClientRequestFailed({
      method,
      path,
      message: error instanceof Error ? error.message : String(error),
      requestStartedAt
    });
    throw error;
  }
});

async function invokeChat(body: Record<string, unknown>) {
  // Redirecionamento SEMPRE ativo: o proxy ignora o modelo que o cliente mandou
  // (seja "AgentBridge", "gpt-5", deepseek, vazio, o que for) e reescreve para o
  // modelo efetivo. No modo manual e o modelo fixo selecionado; no modo automatico
  // e o primeiro modelo disponivel da lista de prioridades (reavaliada a cada
  // request, entao o proxy volta sozinho para o de maior prioridade quando ele
  // libera). Assim o usuario nunca precisa mexer no modelo do Codex/Claude.
  const overridden = { ...body, model: getEffectiveModel() };
  // No modo automatico, passa o resolvedor de failover de modelo: se todas as
  // chaves do modelo atual estiverem de castigo (429), o proxy troca para o
  // proximo da lista em vez de devolver erro ao cliente.
  const resolveModel = isAutoToggleEnabled()
    ? (exhausted: string[]) => resolveAvailableModel(exhausted)
    : undefined;
  return forwardToNvidia(withLocalToolInstructions(overridden), fetch, undefined, {}, { resolveModel });
}

app.get('/health', (context) => {
  const runtime = getRuntimeStatus();
  return context.json({
    status: runtime.unlocked ? 'ok' : 'locked',
    provider: 'NVIDIA',
    model_source: 'request',
    api_keys: runtime.keyCount,
    delay_ms: runtime.requestDelayMs,
    rpm_limit_per_key: NVIDIA_RPM_LIMIT,
    rate_limit_window_ms: RATE_LIMIT_WINDOW_MS,
    requests_this_minute: runtime.requestsThisMinute,
    capacity_per_minute: runtime.capacityPerMinute,
    protocols: ['openai-responses', 'openai-chat-completions', 'anthropic-messages']
  });
});

app.get('/v1/models', (context) => {
  // Anuncia o modelo fixo "AgentBridge": o cliente pode selecionar ele sem
  // precisar saber o id real da NVIDIA. O proxy redireciona para o modelo
  // escolhido no app de qualquer jeito.
  const created = Math.floor(Date.now() / 1000);
  return context.json({
    object: 'list',
    data: [
      { id: FIXED_CLIENT_MODEL, object: 'model', created, owned_by: 'agentbridge' }
    ],
    model_source: 'proxy',
    selected_model: getSelectedModel(),
    message: `Use o modelo "${FIXED_CLIENT_MODEL}". O proxy redireciona para o modelo selecionado no app.`
  });
});

app.post('/v1/chat/completions', async (context) => {
  try {
    return await invokeChat(await context.req.json<Record<string, unknown>>());
  } catch (error: any) {
    return context.json({ error: { type: 'proxy_error', message: error.message } }, 503);
  }
});
app.post('/v1/responses', (context) => responsesApi(context, invokeChat));
app.post('/v1/messages', (context) => anthropicMessagesApi(context, invokeChat));

function formatStandaloneLog(event: ApiRequestLogEvent) {
  const time = new Date(event.timestamp).toLocaleTimeString('pt-BR');
  const elapsed = event.elapsedMs === undefined ? '' : ` em ${event.elapsedMs}ms`;
  const attempt = event.attempt && event.maxAttempts
    ? ` tentativa ${event.attempt}/${event.maxAttempts}`
    : '';

  if (event.type === 'received') {
    return `[${time}] Cliente chamou ${event.method} ${event.path}`;
  }
  if (event.type === 'rejected') {
    return `[${time}] Cliente rejeitado ${event.method} ${event.path} HTTP ${event.status}${elapsed}: ${event.message}`;
  }
  if (event.type === 'completed_client') {
    return `[${time}] Cliente recebeu HTTP ${event.status} ${event.method} ${event.path}${elapsed}`;
  }
  if (event.type === 'failed_client') {
    return `[${time}] Erro no proxy ${event.method} ${event.path}${elapsed}: ${event.message}`;
  }
  if (event.type === 'called') {
    return `[${time}] API ${event.apiNumber} selecionada (${event.requestsThisMinute}/${NVIDIA_RPM_LIMIT} nesta janela)`;
  }
  if (event.type === 'delay') {
    return `[${time}] Esperando delay de ${event.delayMs}ms antes da NVIDIA${attempt}`;
  }
  if (event.type === 'rate_limit_wait') {
    return `[${time}] Aguardando throttle de RPM por ${event.waitMs}ms`;
  }
  if (event.type === 'started') {
    return `[${time}] API ${event.apiNumber} iniciou resposta${elapsed}${attempt}${event.model ? ` (modelo ${event.model})` : ''}`;
  }
  if (event.type === 'completed') {
    return `[${time}] API ${event.apiNumber} completou resposta${elapsed}${attempt}`;
  }
  if (event.type === 'upstream_error') {
    return `[${time}] NVIDIA retornou erro na API ${event.apiNumber} HTTP ${event.status}${elapsed}${attempt}${event.model ? ` (modelo ${event.model})` : ''}: ${event.message}`;
  }
  if (event.type === 'cancelled') {
    return `[${time}] Stream cancelado na API ${event.apiNumber}${elapsed}${attempt}: ${event.message}`;
  }
  if (event.type === 'model_switch') {
    return `[${time}] Alternancia automatica de modelo${event.message ? ` ${event.message}` : ''} para ${event.model}`;
  }
  return `[${time}] Erro na API ${event.apiNumber || '?'}${elapsed}${attempt}: ${event.message}`;
}

export async function startStandaloneServer() {
  const apiKeys = (process.env.NVIDIA_API_KEYS || process.env.NVIDIA_API_KEY || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  setRuntimeConfig({
    apiKeys,
    port: Number(process.env.PORT) || DEFAULT_PORT
  });

  const port = getRuntimeStatus().port;
  onApiRequestLog((event) => {
    console.log(formatStandaloneLog(event));
  });
  serve({ fetch: app.fetch, port }, () => {
    console.log(`AgentBridge NVIDIA em http://localhost:${port}`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startStandaloneServer();
}
