import {
  DEFAULT_MODEL,
  DEFAULT_PORT,
  INTERNAL_API_KEY,
  NVIDIA_RPM_LIMIT,
  RATE_LIMIT_PENALTY_MS,
  RATE_LIMIT_WINDOW_MS,
  REQUEST_DELAY_MS
} from '../config.ts';

// Um castigo de 429 ATIVO para um modelo especifico. A mesma chave pode ter
// varios destes ao mesmo tempo (um por modelo que recebeu 429).
type ModelPenalty = {
  // Fim do castigo de 429 (epoch ms). Enquanto > agora, a chave fica fora do
  // rodizio PARA ESTE MODELO.
  penaltyUntil: number;
  // Quando o castigo comecou (epoch ms), so para exibir "entrou de castigo as ...".
  penaltyStartedAt: number;
  // Quantas respostas HTTP 200 esta (chave, modelo) acumulou ATE levar o 429.
  // Congelado no instante do 429 e exibido na tela de castigo.
  successesBefore429: number;
};

type ApiKeyState = {
  apiKey: string;
  requestTimestamps: number[];
  nextAllowedAt: number | null;
  // Castigo de 429 POR MODELO. A chave pode estar de castigo no Kimi mas ainda
  // livre no Deepseek: cada 429 marca apenas o modelo que veio na request, entao
  // trocar de modelo nao paga cooldown desnecessario. A chave do Map e o nome do
  // modelo ('' quando a request nao informou modelo).
  penalties: Map<string, ModelPenalty>;
  // Contagem de HTTP 200 POR MODELO desde o ultimo reset. Vai subindo a cada 200
  // enquanto o modelo esta livre; quando a chave leva 429 nesse modelo, o valor e
  // copiado para o penalty (successesBefore429) e zera SO quando o castigo expira
  // (o modelo sai do castigo). A chave do Map e o nome do modelo ('' sem modelo).
  successCounts: Map<string, number>;
};

// Normaliza o nome do modelo usado como chave do castigo. Sem modelo cai para ''.
function modelKey(model?: string) {
  return typeof model === 'string' && model.trim() ? model.trim() : '';
}

export type AcquireApiKeyOptions = {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  // Modelo da request: o castigo e checado/aplicado por modelo.
  model?: string;
};

export type ApiKeyUsageEvent = {
  apiNumber: number;
  requestsThisMinute: number;
  totalRequestsThisMinute: number;
  timestamp: number;
};

export type ApiKeyPenaltyEvent = {
  apiNumber: number;
  // Modelo que levou o 429 ('' quando a request nao informou modelo).
  model: string;
  penaltyStartedAt: number;
  penaltyUntil: number;
  // Quantas 200 essa (chave, modelo) tinha acumulado ate dar o 429.
  successesBefore429: number;
};

export type ApiRequestLogEvent = {
  type:
    | 'received'
    | 'rejected'
    | 'completed_client'
    | 'failed_client'
    | 'called'
    | 'delay'
    | 'rate_limit_wait'
    | 'started'
    | 'completed'
    | 'upstream_error'
    | 'error'
    | 'cancelled'
    | 'model_switch';
  apiNumber?: number;
  timestamp: number;
  requestsThisMinute?: number;
  totalRequestsThisMinute?: number;
  delayMs?: number;
  elapsedMs?: number;
  method?: string;
  path?: string;
  status?: number;
  model?: string;
  stream?: boolean;
  attempt?: number;
  maxAttempts?: number;
  waitMs?: number;
  message?: string;
  // Tokens consumidos na request (prompt + completion), quando a NVIDIA informa.
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
};

export const API_REQUEST_LOG_RETENTION_MS = 3 * 60_000;
export const RPM_PACING_INTERVAL_MS = Math.ceil(RATE_LIMIT_WINDOW_MS / NVIDIA_RPM_LIMIT);

let apiKeyStates: ApiKeyState[] = [];
let currentPort = DEFAULT_PORT;
let requestDelayMs = REQUEST_DELAY_MS;
// Chave local que os clientes (Codex/Claude/etc.) precisam enviar como Bearer ou
// x-api-key para falar com o proxy. Comeca na chave padrao do config e pode ser
// trocada pelo usuario (persistida criptografada junto da config). Nunca e
// exposta na mensagem de erro de autenticacao.
let localApiKey = INTERNAL_API_KEY;
// Modelo NVIDIA para onde TODA chamada e redirecionada. Sempre ativo: o proxy
// ignora o modelo que o cliente mandou e usa este. Trocar de modelo e a unica
// forma de "desligar" o anterior. No modo manual e o modelo fixo escolhido pelo
// usuario; no modo automatico e apenas o fallback quando a lista de prioridades
// nao resolve nada.
let selectedModel = DEFAULT_MODEL;
// Alternancia automatica de modelo. Quando ligada, o proxy escolhe sozinho o
// modelo de cada request varrendo `modelPriority` do topo e usando o primeiro que
// ainda tenha alguma chave fora de castigo (429). Assim, assim que um modelo de
// prioridade mais alta libera uma chave, o proxy volta a usa-lo automaticamente.
let autoToggle = false;
// Ordem de prioridade do failover automatico (ids "provider/modelo").
let modelPriority: string[] = [];
// Ultimo modelo realmente colocado em uso (modo automatico): serve para exibir na
// UI e para resetar o cursor "comecando da 1" quando o modelo efetivo muda.
let activeModel = DEFAULT_MODEL;
let cursor = 0;
let nextSendAt = 0;
const usageListeners = new Set<(event: ApiKeyUsageEvent) => void>();
const requestLogListeners = new Set<(event: ApiRequestLogEvent) => void>();
const penaltyListeners = new Set<(event: ApiKeyPenaltyEvent) => void>();

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export function pruneApiRequestLogs<T extends { timestamp: number }>(
  logs: T[],
  now = Date.now(),
  maxEntries = 100
) {
  const cutoff = now - API_REQUEST_LOG_RETENTION_MS;
  return logs
    .filter((entry) => entry.timestamp >= cutoff)
    .slice(-maxEntries);
}

export function setRuntimeConfig(config: {
  apiKeys: string[];
  port?: number;
  requestDelayMs?: number;
  selectedModel?: string;
  autoToggle?: boolean;
  modelPriority?: string[];
  localApiKey?: string;
}) {
  const previousStates = new Map(
    apiKeyStates.map((state) => [state.apiKey, state])
  );
  apiKeyStates = [...new Set(config.apiKeys.filter(Boolean))].map((apiKey) => {
    const previous = previousStates.get(apiKey);
    return previous || {
      apiKey,
      requestTimestamps: [],
      nextAllowedAt: null,
      penalties: new Map<string, ModelPenalty>(),
      successCounts: new Map<string, number>()
    };
  });
  currentPort = config.port || DEFAULT_PORT;
  requestDelayMs = normalizeRequestDelayMs(config.requestDelayMs);
  if (typeof config.selectedModel === 'string' && config.selectedModel.trim()) {
    selectedModel = config.selectedModel.trim();
  }
  if (typeof config.autoToggle === 'boolean') {
    autoToggle = config.autoToggle;
  }
  if (Array.isArray(config.modelPriority)) {
    modelPriority = config.modelPriority
      .map((model) => String(model || '').trim())
      .filter(Boolean);
  }
  if (typeof config.localApiKey === 'string' && config.localApiKey.trim()) {
    localApiKey = config.localApiKey.trim();
  }
  cursor = 0;
}

export function clearRuntimeConfig() {
  apiKeyStates = [];
  cursor = 0;
  nextSendAt = 0;
  requestDelayMs = REQUEST_DELAY_MS;
  selectedModel = DEFAULT_MODEL;
  autoToggle = false;
  modelPriority = [];
  activeModel = DEFAULT_MODEL;
  localApiKey = INTERNAL_API_KEY;
}

// Chave local exigida dos clientes. Sempre devolve algo nao vazio (cai para a
// chave padrao do config quando nada foi definido).
export function getLocalApiKey() {
  return localApiKey && localApiKey.trim() ? localApiKey.trim() : INTERNAL_API_KEY;
}

// Define a chave local que o proxy passa a exigir. Vazio volta para a padrao.
export function setLocalApiKey(key: unknown) {
  const normalized = String(key || '').trim();
  localApiKey = normalized || INTERNAL_API_KEY;
  return localApiKey;
}

// Liga/desliga a alternancia automatica de modelo.
export function setAutoToggle(value: unknown) {
  autoToggle = Boolean(value);
  return autoToggle;
}

export function isAutoToggleEnabled() {
  return autoToggle;
}

// Define a ordem de prioridade do failover automatico (ids "provider/modelo").
export function setModelPriority(list: unknown) {
  if (Array.isArray(list)) {
    modelPriority = list
      .map((model) => String(model || '').trim())
      .filter(Boolean);
  }
  return modelPriority.slice();
}

export function getModelPriority() {
  return modelPriority.slice();
}

// Modelo realmente em uso agora (no modo automatico pode diferir do manual).
export function getActiveModel() {
  return activeModel && activeModel.trim() ? activeModel.trim() : getSelectedModel();
}

// Varre a lista de prioridades (do topo) e devolve o primeiro modelo que ainda
// tenha PELO MENOS uma chave fora de castigo (429), ignorando os ids em `exhausted`.
// Devolve null quando nenhum modelo elegivel sobra -- ai nao ha para onde correr.
export function pickAvailableModel(exhausted: string[] = [], timestamp = Date.now()): string | null {
  if (!apiKeyStates.length) return null;
  const skip = new Set(exhausted.map((model) => modelKey(model)));
  for (const candidate of modelPriority) {
    const id = candidate.trim();
    if (!id || skip.has(modelKey(id))) continue;
    const hasFreeKey = apiKeyStates.some((state) => {
      resetExpiredWindow(state, timestamp);
      return !isResting(state, timestamp, id);
    });
    if (hasFreeKey) return id;
  }
  return null;
}

// Igual ao pickAvailableModel, mas e o ponto de entrada usado pelo failover de
// modelo dentro de uma request (nvidia.ts). Mantido separado para deixar a
// intencao explicita no call-site.
export function resolveAvailableModel(exhausted: string[] = [], timestamp = Date.now()): string | null {
  return pickAvailableModel(exhausted, timestamp);
}

// Este modelo especifico tem PELO MENOS uma chave fora de castigo (429) agora?
// Usado pelas rotas diretas (/v1/direct/*) e por GET /v1/models/available para
// dizer ao cliente quais modelos estao realmente prontos para receber request.
// Independe do modelo selecionado no app: o castigo e checado por (chave, modelo).
export function isModelAvailable(model: string, timestamp = Date.now()): boolean {
  if (!apiKeyStates.length) return false;
  const id = String(model || '').trim();
  if (!id) return false;
  return apiKeyStates.some((state) => {
    resetExpiredWindow(state, timestamp);
    return !isResting(state, timestamp, id);
  });
}

// Modelo efetivo de uma request. No modo manual, sempre o modelo fixo. No modo
// automatico, reavalia a lista de prioridades DO TOPO a cada chamada (por isso o
// proxy volta sozinho para o modelo de maior prioridade assim que ele libera uma
// chave). Ao trocar o modelo efetivo, reseta o cursor para "comecar da 1 de novo".
export function getEffectiveModel(timestamp = Date.now()): string {
  let chosen: string;
  if (autoToggle && modelPriority.length) {
    chosen = pickAvailableModel([], timestamp)
      || modelPriority[0]
      || getSelectedModel();
  } else {
    chosen = getSelectedModel();
  }
  chosen = chosen.trim() || DEFAULT_MODEL;
  if (chosen !== activeModel) {
    activeModel = chosen;
    cursor = 0; // novo modelo: recomeca o rodizio de chaves a partir da primeira
  }
  return chosen;
}

// Modelo de redirecionamento atual (sempre devolve algo nao vazio).
export function getSelectedModel() {
  return selectedModel && selectedModel.trim() ? selectedModel.trim() : DEFAULT_MODEL;
}

// Define o modelo de redirecionamento. Qualquer chamada futura passa a ir para
// ele, independente do que o cliente mandar.
export function setSelectedModel(model: unknown) {
  const normalized = String(model || '').trim();
  selectedModel = normalized || DEFAULT_MODEL;
  return selectedModel;
}

export function onApiKeyUsed(listener: (event: ApiKeyUsageEvent) => void) {
  usageListeners.add(listener);
  return () => usageListeners.delete(listener);
}

export function onApiKeyPenalized(listener: (event: ApiKeyPenaltyEvent) => void) {
  penaltyListeners.add(listener);
  return () => penaltyListeners.delete(listener);
}

// Restaura um castigo lido do disco (sem reemitir evento nem mexer no cursor).
// O castigo e por modelo: restaura apenas o par (chave, modelo) salvo.
export function setApiPenaltyUntil(
  apiNumber: number,
  penaltyUntil: number,
  penaltyStartedAt?: number,
  model?: string,
  successesBefore429?: number
) {
  const state = apiKeyStates[apiNumber - 1];
  if (!state) return;
  if (!Number.isFinite(penaltyUntil) || penaltyUntil <= Date.now()) return;
  const successes = Number.isFinite(successesBefore429) ? Number(successesBefore429) : 0;
  state.penalties.set(modelKey(model), {
    penaltyUntil,
    penaltyStartedAt: penaltyStartedAt ?? Date.now(),
    successesBefore429: successes
  });
  // Restaura a contagem congelada para a tela e o JSON seguirem batendo ate o
  // castigo expirar.
  state.successCounts.set(modelKey(model), successes);
}

export function onApiRequestLog(listener: (event: ApiRequestLogEvent) => void) {
  requestLogListeners.add(listener);
  return () => requestLogListeners.delete(listener);
}

export function getRequestDelayMs() {
  return requestDelayMs;
}

export function getApiKeyCount() {
  return apiKeyStates.length;
}

function normalizeRequestDelayMs(value: unknown) {
  if (value === undefined || value === null || value === '') return REQUEST_DELAY_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return REQUEST_DELAY_MS;
  return Math.round(parsed);
}

function resetExpiredWindow(state: ApiKeyState, timestamp: number) {
  const cutoff = timestamp - RATE_LIMIT_WINDOW_MS;
  state.requestTimestamps = state.requestTimestamps.filter((value) => value > cutoff);
  if (state.nextAllowedAt !== null && state.nextAllowedAt <= timestamp) {
    state.nextAllowedAt = null;
  }
  // Remove castigos por modelo ja expirados. Ao sair do castigo, a contagem de
  // 200 daquele modelo volta para 0 (comeca a contar de novo do zero).
  for (const [model, penalty] of state.penalties) {
    if (penalty.penaltyUntil <= timestamp) {
      state.penalties.delete(model);
      state.successCounts.delete(model);
    }
  }
}

// A chave esta de castigo PARA ESTE MODELO? Outros modelos seguem livres.
function isResting(state: ApiKeyState, timestamp: number, model?: string) {
  const penalty = state.penalties.get(modelKey(model));
  return penalty !== undefined && penalty.penaltyUntil > timestamp;
}

// Lista os castigos ativos da chave (um por modelo), do mais cedo ao mais tarde.
function activePenalties(state: ApiKeyState, timestamp: number) {
  return [...state.penalties.entries()]
    .filter(([, penalty]) => penalty.penaltyUntil > timestamp)
    .map(([model, penalty]) => ({
      model,
      penaltyStartedAt: penalty.penaltyStartedAt,
      penaltyUntil: penalty.penaltyUntil,
      successesBefore429: penalty.successesBefore429
    }))
    .sort((a, b) => a.penaltyUntil - b.penaltyUntil);
}

// Lista a contagem de 200 viva (uma entrada por modelo) da chave.
function successCountRows(state: ApiKeyState) {
  return [...state.successCounts.entries()]
    .map(([model, count]) => ({ model, count }))
    .sort((a, b) => b.count - a.count);
}

function activeRequests(state: ApiKeyState, timestamp: number) {
  resetExpiredWindow(state, timestamp);
  return state.requestTimestamps.length;
}

function nextResetAt(state: ApiKeyState, timestamp: number) {
  resetExpiredWindow(state, timestamp);
  return state.requestTimestamps.length ? state.requestTimestamps[0] + RATE_LIMIT_WINDOW_MS : null;
}

function totalRequests(timestamp: number) {
  return apiKeyStates.reduce((total, state) => total + activeRequests(state, timestamp), 0);
}

function emitRequestLog(event: ApiRequestLogEvent) {
  requestLogListeners.forEach((listener) => {
    try {
      listener(event);
    } catch {
      // Observadores de interface nao podem interromper o encaminhamento.
    }
  });
}

// Registra no log que o failover automatico trocou o modelo da request (ex.: todas
// as chaves do v4 pro de castigo, ou o modelo respondeu 400/404). `from` e o modelo
// que saiu, `to` o que entrou. So aparece no modo de alternancia automatica.
export function markApiModelSwitch(input: {
  from?: string;
  to: string;
  apiNumber?: number;
  reason?: string;
  timestamp?: number;
}) {
  emitRequestLog({
    type: 'model_switch',
    apiNumber: input.apiNumber,
    model: input.to,
    message: input.from
      ? `de ${input.from}${input.reason ? ` (${input.reason})` : ''}`
      : input.reason,
    timestamp: input.timestamp ?? Date.now()
  });
}

export function markApiResponseStarted(input: {
  apiNumber: number;
  requestStartedAt: number;
  model?: string;
  attempt?: number;
  maxAttempts?: number;
  timestamp?: number;
}) {
  const timestamp = input.timestamp ?? Date.now();
  const state = apiKeyStates[input.apiNumber - 1];
  emitRequestLog({
    type: 'started',
    apiNumber: input.apiNumber,
    timestamp,
    model: input.model,
    requestsThisMinute: state ? activeRequests(state, timestamp) : 0,
    totalRequestsThisMinute: totalRequests(timestamp),
    elapsedMs: timestamp - input.requestStartedAt,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts
  });
}

// A chave respondeu HTTP 200 NESTE MODELO: soma 1 na contagem viva de 200 desse
// par (chave, modelo). A contagem so zera quando um eventual castigo expira.
export function markApiSuccess(input: {
  apiNumber: number;
  model?: string;
  timestamp?: number;
}) {
  const state = apiKeyStates[input.apiNumber - 1];
  if (!state) return;
  const model = modelKey(input.model);
  state.successCounts.set(model, (state.successCounts.get(model) || 0) + 1);
}

export function markApiRateLimited(input: {
  apiNumber: number;
  model?: string;
  retryAfterMs?: number;
  timestamp?: number;
}) {
  const timestamp = input.timestamp ?? Date.now();
  const index = input.apiNumber - 1;
  const state = apiKeyStates[index];
  if (!state) return;
  // A chave recebeu HTTP 429 (limite real da NVIDIA) NESTE MODELO. Coloca a chave
  // de castigo por RATE_LIMIT_PENALTY_MS (1 hora) -- ou pelo Retry-After informado,
  // se for maior -- apenas PARA ESTE MODELO, para nao gastar requests inuteis nele
  // enquanto ainda estiver no limite. Outros modelos da mesma chave continuam
  // elegiveis. O castigo e por (chave, modelo) e roda em paralelo.
  const model = modelKey(input.model);
  const retryAfterMs = input.retryAfterMs && input.retryAfterMs > 0 ? input.retryAfterMs : 0;
  const penaltyUntil = timestamp + Math.max(RATE_LIMIT_PENALTY_MS, retryAfterMs);
  // Congela quantas 200 essa (chave, modelo) acumulou ate aqui. O contador NAO
  // zera agora: zera so quando o castigo expirar (resetExpiredWindow).
  const successesBefore429 = state.successCounts.get(model) || 0;
  state.penalties.set(model, { penaltyStartedAt: timestamp, penaltyUntil, successesBefore429 });
  // O fluxo passa a seguir a partir da PROXIMA chave: avanca o cursor sticky.
  if (apiKeyStates.length > 0) {
    cursor = (index + 1) % apiKeyStates.length;
  }
  const penaltyEvent: ApiKeyPenaltyEvent = {
    apiNumber: input.apiNumber,
    model,
    penaltyStartedAt: timestamp,
    penaltyUntil,
    successesBefore429
  };
  penaltyListeners.forEach((listener) => {
    try {
      listener(penaltyEvent);
    } catch {
      // Observadores de interface nao podem interromper o encaminhamento.
    }
  });
}

export function markApiDelayWaiting(input: {
  apiNumber?: number;
  delayMs: number;
  attempt?: number;
  maxAttempts?: number;
  timestamp?: number;
}) {
  const timestamp = input.timestamp ?? Date.now();
  const state = input.apiNumber ? apiKeyStates[input.apiNumber - 1] : undefined;
  emitRequestLog({
    type: 'delay',
    apiNumber: input.apiNumber,
    timestamp,
    requestsThisMinute: state ? activeRequests(state, timestamp) : undefined,
    totalRequestsThisMinute: totalRequests(timestamp),
    delayMs: input.delayMs,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts
  });
}

export function markApiResponseCompleted(input: {
  apiNumber: number;
  requestStartedAt: number;
  attempt?: number;
  maxAttempts?: number;
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  model?: string;
  timestamp?: number;
}) {
  const timestamp = input.timestamp ?? Date.now();
  const state = apiKeyStates[input.apiNumber - 1];
  emitRequestLog({
    type: 'completed',
    apiNumber: input.apiNumber,
    timestamp,
    requestsThisMinute: state ? activeRequests(state, timestamp) : 0,
    totalRequestsThisMinute: totalRequests(timestamp),
    elapsedMs: timestamp - input.requestStartedAt,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    totalTokens: input.totalTokens,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    model: input.model
  });
}

export function markClientRequestReceived(input: {
  method: string;
  path: string;
  timestamp?: number;
}) {
  emitRequestLog({
    type: 'received',
    method: input.method,
    path: input.path,
    timestamp: input.timestamp ?? Date.now()
  });
}

export function markClientRequestRejected(input: {
  method: string;
  path: string;
  status: number;
  message: string;
  requestStartedAt: number;
  timestamp?: number;
}) {
  const timestamp = input.timestamp ?? Date.now();
  emitRequestLog({
    type: 'rejected',
    method: input.method,
    path: input.path,
    status: input.status,
    message: input.message,
    timestamp,
    elapsedMs: timestamp - input.requestStartedAt
  });
}

export function markClientRequestCompleted(input: {
  method: string;
  path: string;
  status: number;
  requestStartedAt: number;
  timestamp?: number;
}) {
  const timestamp = input.timestamp ?? Date.now();
  emitRequestLog({
    type: 'completed_client',
    method: input.method,
    path: input.path,
    status: input.status,
    timestamp,
    elapsedMs: timestamp - input.requestStartedAt
  });
}

export function markClientRequestFailed(input: {
  method: string;
  path: string;
  message: string;
  requestStartedAt: number;
  timestamp?: number;
}) {
  const timestamp = input.timestamp ?? Date.now();
  emitRequestLog({
    type: 'failed_client',
    method: input.method,
    path: input.path,
    message: input.message,
    timestamp,
    elapsedMs: timestamp - input.requestStartedAt
  });
}

export function markRateLimitWaiting(input: {
  waitMs: number;
  timestamp?: number;
}) {
  const timestamp = input.timestamp ?? Date.now();
  emitRequestLog({
    type: 'rate_limit_wait',
    waitMs: input.waitMs,
    totalRequestsThisMinute: totalRequests(timestamp),
    timestamp
  });
}

export function markApiUpstreamError(input: {
  apiNumber: number;
  status?: number;
  message: string;
  requestStartedAt: number;
  model?: string;
  attempt?: number;
  maxAttempts?: number;
  timestamp?: number;
}) {
  const timestamp = input.timestamp ?? Date.now();
  const state = apiKeyStates[input.apiNumber - 1];
  emitRequestLog({
    type: 'upstream_error',
    apiNumber: input.apiNumber,
    status: input.status,
    message: input.message,
    model: input.model,
    requestsThisMinute: state ? activeRequests(state, timestamp) : 0,
    totalRequestsThisMinute: totalRequests(timestamp),
    elapsedMs: timestamp - input.requestStartedAt,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    timestamp
  });
}

export function markApiRequestError(input: {
  apiNumber?: number;
  message: string;
  requestStartedAt: number;
  attempt?: number;
  maxAttempts?: number;
  timestamp?: number;
}) {
  const timestamp = input.timestamp ?? Date.now();
  const state = input.apiNumber ? apiKeyStates[input.apiNumber - 1] : undefined;
  emitRequestLog({
    type: 'error',
    apiNumber: input.apiNumber,
    message: input.message,
    requestsThisMinute: state ? activeRequests(state, timestamp) : undefined,
    totalRequestsThisMinute: totalRequests(timestamp),
    elapsedMs: timestamp - input.requestStartedAt,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    timestamp
  });
}

export function markApiRequestCancelled(input: {
  apiNumber: number;
  requestStartedAt: number;
  message?: string;
  attempt?: number;
  maxAttempts?: number;
  timestamp?: number;
}) {
  const timestamp = input.timestamp ?? Date.now();
  const state = apiKeyStates[input.apiNumber - 1];
  emitRequestLog({
    type: 'cancelled',
    apiNumber: input.apiNumber,
    message: input.message || 'Cliente cancelou a leitura do stream.',
    requestsThisMinute: state ? activeRequests(state, timestamp) : 0,
    totalRequestsThisMinute: totalRequests(timestamp),
    elapsedMs: timestamp - input.requestStartedAt,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    timestamp
  });
}

export async function reserveSendSlot(options: {
  delayMs: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}) {
  const delayMs = options.delayMs;
  if (!Number.isFinite(delayMs) || delayMs <= 0) return 0;
  const now = options.now || Date.now;
  const sleep = options.sleep || defaultSleep;
  const current = now();
  // Porteira serializada de envio: cada request espera no minimo delayMs e os
  // envios ficam espacados em delayMs entre si, mesmo com varias requests
  // concorrentes chegando juntas. Assim o delay realmente controla a TAXA que
  // chega na NVIDIA (e o consumo de RPM), em vez de so atrasar um lote inteiro
  // em paralelo. O pacing por chave (RPM_PACING_INTERVAL_MS) continua valendo
  // como piso de protecao quando o delay configurado e menor que ele.
  const sendAt = Math.max(current, nextSendAt) + delayMs;
  nextSendAt = sendAt;
  const waitMs = sendAt - current;
  if (waitMs > 0) await sleep(waitMs);
  return waitMs;
}

export class AllKeysRestingError extends Error {
  readonly code = 'all_resting';
  readonly waitMs: number;
  constructor(waitMs: number) {
    super('Todas as APIs NVIDIA estao em castigo apos HTTP 429. Tente novamente mais tarde.');
    this.name = 'AllKeysRestingError';
    this.waitMs = waitMs;
  }
}

export async function acquireApiKey(options: AcquireApiKeyOptions = {}) {
  const now = options.now || Date.now;
  const sleep = options.sleep || defaultSleep;
  const model = options.model;

  while (true) {
    if (!apiKeyStates.length) {
      throw new Error('Nenhuma API NVIDIA foi desbloqueada.');
    }

    const timestamp = now();

    // Selecao "sticky": a partir do cursor, fica na PRIMEIRA chave que nao esteja
    // de castigo (429) PARA ESTE MODELO e gruda nela. Uma chave de castigo no Kimi
    // continua elegivel para o Deepseek. So mudamos de chave quando a atual leva um
    // 429 (markApiRateLimited avanca o cursor). As demais so esperam a vez delas.
    let chosenIndex = -1;
    let shortestPenaltyWaitMs = Number.POSITIVE_INFINITY;
    for (let offset = 0; offset < apiKeyStates.length; offset++) {
      const index = (cursor + offset) % apiKeyStates.length;
      const state = apiKeyStates[index];
      resetExpiredWindow(state, timestamp);
      if (isResting(state, timestamp, model)) {
        const penalty = state.penalties.get(modelKey(model));
        if (penalty) {
          shortestPenaltyWaitMs = Math.min(
            shortestPenaltyWaitMs,
            penalty.penaltyUntil - timestamp
          );
        }
        continue;
      }
      chosenIndex = index;
      break;
    }

    if (chosenIndex === -1) {
      // Todas as chaves estao de castigo. Em vez de segurar a request por ate 1 hora,
      // devolvemos um erro para o cliente reenviar mais tarde.
      throw new AllKeysRestingError(Math.max(1, Math.ceil(shortestPenaltyWaitMs)));
    }

    cursor = chosenIndex; // gruda na chave escolhida
    const state = apiKeyStates[chosenIndex];

    // Protecao de 35 RPM + pacing NA chave atual (para nao estourar os ~40 reais da NVIDIA).
    const rpmWaitMs = state.requestTimestamps.length >= NVIDIA_RPM_LIMIT
      ? (state.requestTimestamps[0] + RATE_LIMIT_WINDOW_MS) - timestamp
      : 0;
    const pacingWaitMs = state.nextAllowedAt === null
      ? 0
      : state.nextAllowedAt - timestamp;
    const waitMs = Math.max(0, rpmWaitMs, pacingWaitMs);
    if (waitMs > 0) {
      markRateLimitWaiting({ waitMs, timestamp });
      await sleep(waitMs);
      continue; // reavalia; cursor inalterado, entao continua na MESMA chave
    }

    state.requestTimestamps.push(timestamp);
    state.nextAllowedAt = timestamp + RPM_PACING_INTERVAL_MS;
    // NAO avanca o cursor: o fluxo segue na mesma chave ate ela levar 429.
    const totalRequestsThisMinute = totalRequests(timestamp);
    const usageEvent = {
      apiNumber: chosenIndex + 1,
      requestsThisMinute: state.requestTimestamps.length,
      totalRequestsThisMinute,
      timestamp
    };
    usageListeners.forEach((listener) => {
      try {
        listener(usageEvent);
      } catch {
        // Observadores de interface nao podem interromper o encaminhamento.
      }
    });
    emitRequestLog({
      type: 'called',
      apiNumber: usageEvent.apiNumber,
      requestsThisMinute: usageEvent.requestsThisMinute,
      totalRequestsThisMinute,
      timestamp
    });
    return {
      apiKey: state.apiKey,
      apiNumber: usageEvent.apiNumber,
      requestsThisMinute: state.requestTimestamps.length,
      remainingThisMinute: NVIDIA_RPM_LIMIT - state.requestTimestamps.length
    };
  }
}

export function getRuntimeStatus(timestamp = Date.now()) {
  const apiUsage = apiKeyStates.map((state, index) => {
    const requestsThisMinute = activeRequests(state, timestamp); // ja poda janela/castigos
    // Uma entrada por modelo de castigo ativo: a mesma API aparece varias vezes na
    // tela de castigo se estiver de castigo em mais de um modelo.
    const penalties = activePenalties(state, timestamp);
    const resting = penalties.length > 0;
    // Para o card resumido, usa o castigo que termina por ultimo.
    const latest = penalties[penalties.length - 1];
    // Contagem viva de 200 por modelo + total da chave (soma de todos os modelos).
    const successCounts = successCountRows(state);
    const successTotal = successCounts.reduce((sum, row) => sum + row.count, 0);
    return {
      apiNumber: index + 1,
      requestsThisMinute,
      limitPerMinute: NVIDIA_RPM_LIMIT,
      windowStartedAt: state.requestTimestamps[0] || null,
      resetsAt: nextResetAt(state, timestamp),
      resting,
      penalties,
      penaltyUntil: resting ? latest.penaltyUntil : null,
      penaltyStartedAt: resting ? latest.penaltyStartedAt : null,
      successCounts,
      successTotal
    };
  });
  const requestsThisMinute = totalRequests(timestamp);
  return {
    keyCount: apiKeyStates.length,
    port: currentPort,
    unlocked: apiKeyStates.length > 0,
    requestDelayMs,
    selectedModel: getSelectedModel(),
    autoToggle,
    modelPriority: modelPriority.slice(),
    activeModel: getActiveModel(),
    requestsThisMinute,
    capacityPerMinute: apiKeyStates.length * NVIDIA_RPM_LIMIT,
    limitPerKey: NVIDIA_RPM_LIMIT,
    apiUsage
  };
}
