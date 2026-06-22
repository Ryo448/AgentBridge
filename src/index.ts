import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { homedir } from 'node:os';
import {
  DEFAULT_MODEL_CATALOG,
  DEFAULT_PORT,
  FIXED_CLIENT_MODEL,
  NVIDIA_RPM_LIMIT,
  RATE_LIMIT_WINDOW_MS
} from './config.ts';
import { recordTokenUsage, readTokenUsage, flushTokenUsage } from './services/token-tracking.ts';
import { responsesApi, anthropicMessagesApi } from './routes/compatibility.ts';
import { withLocalToolInstructions } from './routes/toolInstructions.ts';
import { forwardToNvidia } from './services/nvidia.ts';
import { getLocale, initLocale, t } from './i18n/index.ts';
import {
  getEffectiveModel,
  getLocalApiKey,
  getModelPriority,
  getRuntimeStatus,
  getSelectedModel,
  isAutoToggleEnabled,
  isModelAvailable,
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

function tokenUsagePath() {
  const home = homedir();
  const documents = process.platform === 'win32'
    ? path.join(process.env.USERPROFILE || home, 'Documents')
    : path.join(home, 'Documents');
  return path.join(documents, 'AgentBridge', 'used_tokens.json');
}

// Listener global: registra tokens consumidos em cada chamada completada.
onApiRequestLog((event) => {
  if (event.type === 'completed' && event.model) {
    let promptTokens = event.promptTokens || 0;
    let completionTokens = event.completionTokens || 0;
    const total = event.totalTokens || 0;
    // Fallback: se a NVIDIA nao discriminar prompt/completion mas tivermos
    // total_tokens, divide 50/50 como estimativa razoavel.
    if (total > 0 && promptTokens === 0 && completionTokens === 0) {
      promptTokens = Math.floor(total * 0.3);
      completionTokens = total - promptTokens;
    }
    if (promptTokens > 0 || completionTokens > 0) {
      recordTokenUsage(tokenUsagePath(), event.model, promptTokens, completionTokens);
    }
  }
});

// Rotas publicas (sem autenticacao de chave local).
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

app.get('/v1/tokens/usage', (context) => {
  flushTokenUsage(tokenUsagePath());
  return context.json(readTokenUsage(tokenUsagePath()));
});

app.use('/v1/*', async (context, next) => {
  const requestStartedAt = Date.now();
  const method = context.req.method;
  const path = context.req.path;
  markClientRequestReceived({ method, path, timestamp: requestStartedAt });
  const bearer = context.req.header('authorization')?.replace(/^Bearer\s+/i, '');
  const apiKey = context.req.header('x-api-key');
  // Compara contra a chave local viva (definida pelo usuario, ou a padrao do
  // config). A mensagem de erro NUNCA revela a chave esperada: so informa que a
  // autenticacao falhou, para nao expor o segredo a quem chamar sem credencial.
  const expectedKey = getLocalApiKey();
  if (bearer !== expectedKey && apiKey !== expectedKey) {
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
        message: t('api.authFailed')
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

async function invokeChat(body: Record<string, unknown>, abortSignal?: AbortSignal) {
  // Roteamento de modelo (vale para /v1/chat/completions, /v1/responses e
  // /v1/messages):
  //   - model "AgentBridge" ou vazio -> REDIRECIONA para o modelo efetivo (modo
  //     manual: o selecionado no app; modo automatico: o primeiro disponivel da
  //     prioridade). E o comportamento de sempre, entao Codex e Claude (que mandam
  //     "AgentBridge") nao mudam em nada.
  //   - model com id real (ex.: o Odysseus escolheu "moonshotai/kimi-k2.6") ->
  //     HONRA o pedido quando ha pelo menos uma chave livre para ele. Se nao
  //     houver, cai para o modelo efetivo em vez de devolver erro.
  const requested = String(body.model ?? '').trim();
  const isPassthrough = requested !== '' && requested !== FIXED_CLIENT_MODEL;
  const target = isPassthrough && isModelAvailable(requested)
    ? requested
    : getEffectiveModel();
  const overridden = { ...body, model: target };
  // Failover de modelo: se TODAS as chaves do alvo entrarem em castigo (429) no
  // meio da request, o proxy troca para o proximo modelo disponivel da lista em
  // vez de erro. Sempre ativo quando o client pediu um modelo real; no modo
  // "AgentBridge" segue a regra antiga (so com alternancia automatica ligada).
  const isAuto = isAutoToggleEnabled();
  const resolveModel = isPassthrough || isAuto
    ? (exhausted: string[]) => resolveAvailableModel(exhausted)
    : undefined;
  // Hedged failover: so no modo automatico ("AgentBridge"). Quando o modelo
  // primario demora > 60s para dar o primeiro sinal, dispara um backup no
  // proximo modelo disponivel. Nunca ativo em modo manual ou passthrough.
  const enableHedge = !isPassthrough && isAuto;
  return forwardToNvidia(withLocalToolInstructions(overridden), fetch, undefined, {}, { resolveModel, enableHedge, abortSignal });
}

// Catalogo "real" de modelos que o gateway conhece: a uniao da lista de
// prioridades viva (editada pelo usuario no app) com o catalogo padrao do config.
// Mantem a ordem (prioridade primeiro) e remove duplicatas.
function listKnownModels(): string[] {
  const ids = [
    ...getModelPriority(),
    ...DEFAULT_MODEL_CATALOG.map((entry) => entry.model)
  ]
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  return [...new Set(ids)];
}

// Mapa label/icone do catalogo padrao, so para enriquecer a listagem.
const CATALOG_META = new Map(
  DEFAULT_MODEL_CATALOG.map((entry) => [entry.model, entry])
);

// Diferente de invokeChat: NAO reescreve o modelo. Honra exatamente o `model`
// que o cliente mandou (passthrough direto), sem failover automatico e sem
// depender do modelo selecionado no app. O castigo de 429 continua sendo
// rastreado por modelo dentro do forwardToNvidia (deriva de body.model).
async function invokeChatDirect(body: Record<string, unknown>) {
  const requested = String(body.model || '').trim();
  if (!requested || requested === FIXED_CLIENT_MODEL) {
    const err: any = new Error(
      t('api.modelRequired', { example: DEFAULT_MODEL_CATALOG[0]?.model, fixed: FIXED_CLIENT_MODEL })
    );
    err.status = 400;
    throw err;
  }
  const overridden = { ...body, model: requested };
  return forwardToNvidia(withLocalToolInstructions(overridden), fetch, undefined, {}, {});
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
  // Lista o catalogo REAL de modelos (ids "provider/modelo"), com flag available
  // por modelo, MAIS o pseudo-modelo "AgentBridge" (que mantem o redirecionamento
  // automatico para o modelo selecionado no app). Assim clients OpenAI-compativeis
  // (Odysseus, etc.) populam o seletor com os modelos de verdade e ainda podem
  // escolher "AgentBridge" para usar o modo automatico.
  const created = Math.floor(Date.now() / 1000);
  const real = listKnownModels().map((id) => {
    const meta = CATALOG_META.get(id);
    return {
      id,
      object: 'model' as const,
      created,
      owned_by: 'nvidia',
      available: isModelAvailable(id),
      ...(meta ? { label: meta.label, icon: meta.icon } : {})
    };
  });
  return context.json({
    object: 'list',
    data: [
      ...real,
      {
        id: FIXED_CLIENT_MODEL,
        object: 'model',
        created,
        owned_by: 'agentbridge',
        available: true,
        label: t('api.autoLabel'),
        icon: ''
      }
    ],
    model_source: 'proxy',
    selected_model: getSelectedModel(),
    message: t('api.catalogMessage', { fixed: FIXED_CLIENT_MODEL })
  });
});

app.post('/v1/chat/completions', async (context) => {
  try {
    return await invokeChat(await context.req.json<Record<string, unknown>>(), context.req.raw.signal);
  } catch (error: any) {
    return context.json({ error: { type: 'proxy_error', message: error.message } }, 503);
  }
});
app.post('/v1/responses', (context) => responsesApi(context, (body) => invokeChat(body, context.req.raw.signal)));
app.post('/v1/messages', (context) => anthropicMessagesApi(context, (body) => invokeChat(body, context.req.raw.signal)));

// ---------------------------------------------------------------------------
// Rotas DIRETAS (isoladas). Nao alteram o comportamento das rotas acima: aqui o
// cliente escolhe o modelo por request, sem precisar selecionar nada no app.
// ---------------------------------------------------------------------------

// Lista os modelos REAIS que o gateway conhece, cada um com `available`: true
// quando ha pelo menos uma chave fora de castigo (429) para ele agora. Formato
// compativel com OpenAI (data[].id = id real "provider/modelo"), entao um client
// OpenAI consegue popular o seletor de modelos direto daqui. Use ?only_available=1
// para receber so os que estao prontos agora.
app.get('/v1/models/available', (context) => {
  const created = Math.floor(Date.now() / 1000);
  const onlyAvailable = ['1', 'true', 'yes'].includes(
    (context.req.query('only_available') || '').toLowerCase()
  );
  const data = listKnownModels()
    .map((id) => {
      const meta = CATALOG_META.get(id);
      return {
        id,
        object: 'model' as const,
        created,
        owned_by: 'nvidia',
        available: isModelAvailable(id),
        ...(meta ? { label: meta.label, icon: meta.icon } : {})
      };
    })
    .filter((entry) => (onlyAvailable ? entry.available : true));
  return context.json({
    object: 'list',
    data,
    model_source: 'catalog',
    selected_model: getSelectedModel(),
    message: t('api.availableMessage')
  });
});

// Chat Completions DIRETO: usa o `model` do corpo como esta, sem redirecionar.
app.post('/v1/direct/chat/completions', async (context) => {
  try {
    return await invokeChatDirect(await context.req.json<Record<string, unknown>>());
  } catch (error: any) {
    return context.json(
      { error: { type: 'proxy_error', message: error.message } },
      error?.status === 400 ? 400 : 503
    );
  }
});
// Responses e Anthropic Messages DIRETOS: mesma traducao de protocolo das rotas
// originais, mas passando o invocador que honra o modelo do corpo.
app.post('/v1/direct/responses', (context) => responsesApi(context, invokeChatDirect));
app.post('/v1/direct/messages', (context) => anthropicMessagesApi(context, invokeChatDirect));

function formatStandaloneLog(event: ApiRequestLogEvent) {
  const time = new Date(event.timestamp).toLocaleTimeString(getLocale());
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
  // Permite sobrescrever a chave local exigida dos clientes pelo ambiente, sem
  // precisar do cofre criptografado. Vazio mantem a padrao do config.
  const localApiKey = (process.env.AGENTBRIDGE_LOCAL_KEY || '').trim();
  setRuntimeConfig({
    apiKeys,
    port: Number(process.env.PORT) || DEFAULT_PORT,
    ...(localApiKey ? { localApiKey } : {})
  });

  // Inicializa o i18n via deteccao automatica do SO (modo headless).
  initLocale(null);

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
