import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { app as electronApp, BrowserWindow, clipboard, ipcMain } from 'electron';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { app as honoApp } from '../index.ts';
import { TEST_PROMPT } from './testPrompt.ts';
import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_AUTO_TOGGLE,
  DEFAULT_MODEL,
  DEFAULT_MODEL_CATALOG,
  DEFAULT_MODEL_PRIORITY,
  DEFAULT_PORT,
  INTERNAL_API_KEY,
  REQUEST_DELAY_MS,
  type ModelCatalogEntry
} from '../config.ts';
import {
  configExists,
  localKeyStored,
  saveConfig,
  unlockConfig,
  type UnlockedConfig
} from '../services/vault.ts';
import {
  clearRuntimeConfig,
  type ApiRequestLogEvent,
  getActiveModel,
  getLocalApiKey,
  getRuntimeStatus,
  getSelectedModel,
  isAutoToggleEnabled,
  onApiRequestLog,
  onApiKeyPenalized,
  pruneApiRequestLogs,
  setApiPenaltyUntil,
  setAutoToggle,
  setLocalApiKey,
  setModelPriority,
  setRuntimeConfig,
  setSelectedModel
} from '../services/runtime.ts';
import { forwardToNvidia } from '../services/nvidia.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let proxyServer: ServerType | null = null;
let statusRefreshTimer: NodeJS.Timeout | null = null;
let proxyState: 'locked' | 'starting' | 'running' | 'stopped' | 'error' = 'locked';
let proxyError = '';
let sessionPassword = '';
let usageLog: ApiRequestLogEvent[] = [];
// false => ainda precisamos pedir ao usuario que defina a chave local (config
// sem chave salva ou cofre recem-criado). true enquanto bloqueado para nao
// piscar o modal antes do desbloqueio.
let localKeyResolved = true;
let unlockedConfig: UnlockedConfig = {
  apiKeys: [],
  port: DEFAULT_PORT,
  requestDelayMs: REQUEST_DELAY_MS,
  selectedModel: DEFAULT_MODEL,
  autoToggle: DEFAULT_AUTO_TOGGLE,
  modelPriority: [...DEFAULT_MODEL_PRIORITY],
  modelCatalog: DEFAULT_MODEL_CATALOG.map((item) => ({ ...item })),
  localApiKey: INTERNAL_API_KEY
};

function configPath() {
  return path.join(electronApp.getPath('documents'), 'AgentBridge', 'config.json');
}

function penaltiesPath() {
  return path.join(electronApp.getPath('documents'), 'AgentBridge', 'penalties.json');
}

// Impressao digital curta da chave (NAO o segredo) para casar o castigo salvo com
// a chave certa mesmo que a ordem das APIs mude entre reinicios.
function keyFingerprint(apiKey: string) {
  return apiKey ? apiKey.slice(-6) : '';
}

type PersistedPenalty = {
  apiNumber: number;
  keyFingerprint: string;
  // Modelo que levou o 429 ('' quando a request nao informou modelo). A mesma
  // chave pode ter varias entradas, uma por modelo de castigo.
  model: string;
  // Quantas respostas HTTP 200 essa (chave, modelo) acumulou ate levar o 429.
  successesBefore429: number;
  enteredAt: string;
  penaltyUntil: string;
};

function savePenalties() {
  try {
    const usage = getRuntimeStatus().apiUsage as Array<{
      apiNumber: number;
      resting?: boolean;
      penalties?: Array<{ model: string; penaltyStartedAt: number; penaltyUntil: number; successesBefore429?: number }>;
    }>;
    const penalties: PersistedPenalty[] = [];
    for (const item of usage) {
      for (const penalty of item.penalties || []) {
        penalties.push({
          apiNumber: item.apiNumber,
          keyFingerprint: keyFingerprint(unlockedConfig.apiKeys[item.apiNumber - 1] || ''),
          model: penalty.model,
          successesBefore429: Number(penalty.successesBefore429) || 0,
          enteredAt: new Date(penalty.penaltyStartedAt || Date.now()).toISOString(),
          penaltyUntil: new Date(penalty.penaltyUntil).toISOString()
        });
      }
    }
    const filePath = penaltiesPath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({ updatedAt: new Date().toISOString(), penalties }, null, 2),
      { encoding: 'utf8', mode: 0o600 }
    );
  } catch {
    // Persistir o castigo nao pode derrubar o proxy.
  }
}

// Le penalties.json no arranque: restaura quem ainda esta dentro da 1 hora e
// descarta quem ja passou (hora atual > penaltyUntil).
function loadPenalties() {
  try {
    const filePath = penaltiesPath();
    if (!existsSync(filePath)) return;
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as { penalties?: PersistedPenalty[] };
    const now = Date.now();
    for (const entry of raw.penalties || []) {
      const penaltyUntil = Date.parse(entry.penaltyUntil);
      if (!Number.isFinite(penaltyUntil) || penaltyUntil <= now) continue;
      const enteredAt = Date.parse(entry.enteredAt);
      let apiNumber = unlockedConfig.apiKeys.findIndex(
        (apiKey) => keyFingerprint(apiKey) === entry.keyFingerprint
      ) + 1;
      // Sem impressao digital correspondente, cai para o numero salvo se existir.
      if (apiNumber === 0 && entry.apiNumber >= 1 && entry.apiNumber <= unlockedConfig.apiKeys.length) {
        apiNumber = entry.apiNumber;
      }
      if (apiNumber >= 1) {
        setApiPenaltyUntil(
          apiNumber,
          penaltyUntil,
          Number.isFinite(enteredAt) ? enteredAt : undefined,
          typeof entry.model === 'string' ? entry.model : '',
          Number(entry.successesBefore429) || 0
        );
      }
    }
    // Normaliza o arquivo (remove expirados, atualiza numeros das APIs).
    savePenalties();
  } catch {
    // Arquivo corrompido nao pode travar o desbloqueio.
  }
}

function normalizePort(value: unknown) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error('Digite uma porta entre 1 e 65535.');
  }
  return parsed;
}

function normalizeDelayMs(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 600_000) {
    throw new Error('Digite um delay entre 0 e 600000 ms.');
  }
  return Math.round(parsed);
}

function endpointBase(port = unlockedConfig.port) {
  return `http://localhost:${port}`;
}

function getStatus() {
  usageLog = pruneApiRequestLogs(usageLog);
  const runtime = getRuntimeStatus();
  const baseUrl = endpointBase();
  return {
    proxyState,
    proxyError,
    unlocked: Boolean(sessionPassword),
    hasConfig: configExists(configPath()),
    keyCount: runtime.keyCount,
    requestsThisMinute: runtime.requestsThisMinute,
    capacityPerMinute: runtime.capacityPerMinute,
    limitPerKey: runtime.limitPerKey,
    apiUsage: runtime.apiUsage,
    requestDelayMs: runtime.requestDelayMs,
    usageLog,
    configPath: configPath(),
    penaltyPath: penaltiesPath(),
    port: unlockedConfig.port,
    selectedModel: getSelectedModel(),
    autoToggle: isAutoToggleEnabled(),
    activeModel: getActiveModel(),
    modelPriority: unlockedConfig.modelPriority,
    modelCatalog: unlockedConfig.modelCatalog,
    provider: 'NVIDIA',
    appVersion: APP_VERSION,
    apiKey: getLocalApiKey(),
    // true quando a sessao esta desbloqueada mas ainda nao ha chave local salva
    // no config: a UI pede para o usuario definir uma.
    needLocalKey: Boolean(sessionPassword) && !localKeyResolved,
    codexBaseUrl: `${baseUrl}/v1`,
    claudeBaseUrl: baseUrl,
    responsesEndpoint: `${baseUrl}/v1/responses`,
    messagesEndpoint: `${baseUrl}/v1/messages`,
    chatEndpoint: `${baseUrl}/v1/chat/completions`
  };
}

function broadcastStatus() {
  mainWindow?.webContents.send('status:changed', getStatus());
}

function startStatusRefresh() {
  if (statusRefreshTimer) clearInterval(statusRefreshTimer);
  statusRefreshTimer = setInterval(() => {
    broadcastStatus();
  }, 1000);
}

onApiKeyPenalized(() => {
  savePenalties();
  broadcastStatus();
});

onApiRequestLog((event) => {
  usageLog = pruneApiRequestLogs([...usageLog, {
    type: event.type,
    apiNumber: event.apiNumber,
    requestsThisMinute: event.requestsThisMinute,
    totalRequestsThisMinute: event.totalRequestsThisMinute,
    delayMs: event.delayMs,
    elapsedMs: event.elapsedMs,
    method: event.method,
    path: event.path,
    status: event.status,
    model: event.model,
    stream: event.stream,
    attempt: event.attempt,
    maxAttempts: event.maxAttempts,
    waitMs: event.waitMs,
    message: event.message,
    totalTokens: event.totalTokens,
    timestamp: event.timestamp
  }]);
  broadcastStatus();
});

async function stopProxy() {
  if (!proxyServer) {
    proxyState = sessionPassword ? 'stopped' : 'locked';
    broadcastStatus();
    return;
  }
  const server = proxyServer;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (proxyServer === server) proxyServer = null;
  proxyState = sessionPassword ? 'stopped' : 'locked';
  proxyError = '';
  broadcastStatus();
}

async function startProxy() {
  if (!sessionPassword) throw new Error('Desbloqueie as APIs primeiro.');
  if (!unlockedConfig.apiKeys.length) throw new Error('Cadastre ao menos uma API NVIDIA.');
  if (proxyServer) return;

  proxyState = 'starting';
  proxyError = '';
  broadcastStatus();

  await new Promise<void>((resolve) => {
    let settled = false;
    const server = serve({
      fetch: honoApp.fetch,
      port: unlockedConfig.port
    }, () => {
      settled = true;
      proxyServer = server;
      proxyState = 'running';
      broadcastStatus();
      resolve();
    });

    server.once('error', (error: NodeJS.ErrnoException) => {
      proxyServer = null;
      proxyState = 'error';
      proxyError = error.code === 'EADDRINUSE'
        ? `A porta ${unlockedConfig.port} ja esta em uso.`
        : error.message;
      broadcastStatus();
      if (!settled) resolve();
    });
  });
}

async function unlock(password: unknown) {
  const normalized = String(password || '');
  if (!normalized) throw new Error('Digite a senha de criptografia.');

  if (configExists(configPath())) {
    unlockedConfig = unlockConfig(configPath(), normalized);
    sessionPassword = normalized;
    usageLog = [];
    setRuntimeConfig(unlockedConfig);
    // So pede a chave local se o config ainda nao guarda uma (config antigo).
    localKeyResolved = localKeyStored(configPath());
    loadPenalties();
    proxyState = 'stopped';
    await startProxy();
  } else {
    sessionPassword = normalized;
    unlockedConfig = {
      apiKeys: [],
      port: DEFAULT_PORT,
      requestDelayMs: REQUEST_DELAY_MS,
      selectedModel: DEFAULT_MODEL,
      autoToggle: DEFAULT_AUTO_TOGGLE,
      modelPriority: [...DEFAULT_MODEL_PRIORITY],
      modelCatalog: DEFAULT_MODEL_CATALOG.map((item) => ({ ...item })),
      localApiKey: INTERNAL_API_KEY
    };
    usageLog = [];
    clearRuntimeConfig();
    // Cofre novo: ainda nao ha chave local definida, entao a UI vai pedir.
    localKeyResolved = false;
    proxyState = 'stopped';
  }
  broadcastStatus();
  return getStatus();
}

async function persistConfig(input: any) {
  if (!sessionPassword) throw new Error('A sessao ainda esta bloqueada.');
  const submitted = Array.isArray(input?.apiKeys) ? input.apiKeys : [];
  const apiKeys = submitted
    .map((entry: unknown) => {
      const item = entry && typeof entry === 'object'
        ? entry as { value?: unknown; existingIndex?: unknown }
        : { value: entry, existingIndex: undefined };
      const normalized = String(item.value || '').trim();
      const hasExistingIndex = item.existingIndex !== null && item.existingIndex !== undefined;
      const existingIndex = Number(item.existingIndex);
      return normalized || (
        hasExistingIndex && Number.isInteger(existingIndex) && existingIndex >= 0
          ? unlockedConfig.apiKeys[existingIndex]
          : ''
      );
    })
    .filter(Boolean);
  if (!apiKeys.length) throw new Error('Cadastre ao menos uma API NVIDIA.');

  const nextConfig: UnlockedConfig = {
    apiKeys,
    port: normalizePort(input?.port ?? unlockedConfig.port),
    requestDelayMs: normalizeDelayMs(input?.requestDelayMs ?? unlockedConfig.requestDelayMs),
    selectedModel: typeof input?.selectedModel === 'string' && input.selectedModel.trim()
      ? input.selectedModel.trim()
      : unlockedConfig.selectedModel,
    autoToggle: unlockedConfig.autoToggle,
    modelPriority: unlockedConfig.modelPriority,
    modelCatalog: unlockedConfig.modelCatalog,
    localApiKey: unlockedConfig.localApiKey
  };
  const shouldRestart = Boolean(proxyServer) && nextConfig.port !== unlockedConfig.port;
  if (shouldRestart) await stopProxy();

  unlockedConfig = nextConfig;
  saveConfig(configPath(), sessionPassword, unlockedConfig);
  setRuntimeConfig(unlockedConfig);
  savePenalties();
  if (!proxyServer) await startProxy();
  broadcastStatus();
  return getStatus();
}

// Define qual modelo NVIDIA o proxy usa para TODAS as chamadas. Trocar o modelo
// e a unica forma de "desligar" o anterior: o redirecionamento esta sempre ativo.
// Persistido em texto puro junto com a config.
async function selectModel(model: unknown) {
  if (!sessionPassword) throw new Error('A sessao ainda esta bloqueada.');
  const normalized = String(model || '').trim();
  if (!normalized) throw new Error('Modelo invalido.');
  unlockedConfig.selectedModel = normalized;
  setSelectedModel(normalized);
  setRuntimeConfig(unlockedConfig);
  if (unlockedConfig.apiKeys.length) {
    saveConfig(configPath(), sessionPassword, unlockedConfig);
  }
  broadcastStatus();
  return getStatus();
}

// Liga/desliga a alternancia automatica de modelo. Quando ligada, o proxy escolhe
// sozinho o modelo de cada chamada pela lista de prioridades. Persistido junto da
// config (texto puro).
async function setAutoMode(value: unknown) {
  if (!sessionPassword) throw new Error('A sessao ainda esta bloqueada.');
  unlockedConfig.autoToggle = Boolean(value);
  setAutoToggle(unlockedConfig.autoToggle);
  if (unlockedConfig.apiKeys.length) {
    saveConfig(configPath(), sessionPassword, unlockedConfig);
  }
  broadcastStatus();
  return getStatus();
}

// Saneia o catalogo recebido da UI: descarta entradas sem id "provider/modelo",
// normaliza textos e remove ids duplicados (mantendo a primeira ocorrencia).
function sanitizeCatalog(value: unknown): ModelCatalogEntry[] {
  if (!Array.isArray(value)) return unlockedConfig.modelCatalog;
  const seen = new Set<string>();
  const catalog: ModelCatalogEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Partial<ModelCatalogEntry>;
    const model = String(entry.model || '').trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    catalog.push({
      model,
      label: String(entry.label || '').trim() || model,
      icon: String(entry.icon || '').trim()
    });
  }
  return catalog.length ? catalog : unlockedConfig.modelCatalog;
}

// Saneia a prioridade: mantem apenas ids do catalogo, sem duplicar, e acrescenta no
// fim os modelos do catalogo que ficaram de fora (modelos novos entram no fim da fila).
function sanitizePriority(value: unknown, catalog: ModelCatalogEntry[]): string[] {
  const known = new Set(catalog.map((item) => item.model));
  const priority: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(value)) {
    for (const raw of value) {
      const model = String(raw || '').trim();
      if (model && known.has(model) && !seen.has(model)) {
        seen.add(model);
        priority.push(model);
      }
    }
  }
  for (const item of catalog) {
    if (!seen.has(item.model)) {
      seen.add(item.model);
      priority.push(item.model);
    }
  }
  return priority;
}

// Atualiza o catalogo de modelos (editar id/nome, adicionar novos) e a ordem da
// lista de prioridades de uma vez so. Persistido junto da config.
async function updateModels(payload: any) {
  if (!sessionPassword) throw new Error('A sessao ainda esta bloqueada.');
  const catalog = sanitizeCatalog(payload?.catalog);
  const priority = sanitizePriority(payload?.priority, catalog);
  unlockedConfig.modelCatalog = catalog;
  unlockedConfig.modelPriority = priority;
  setModelPriority(priority);
  if (unlockedConfig.apiKeys.length) {
    saveConfig(configPath(), sessionPassword, unlockedConfig);
  }
  broadcastStatus();
  return getStatus();
}

// Envia um prompt complexo (gerar uma calculadora em Python com interface) ao
// modelo informado, passando por toda a rotacao de APIs, e mede quanto tempo a
// NVIDIA levou para responder. Usado pelo botao "Testar Modelo" no modal. NAO usa
// o redirecionamento: testa exatamente o modelo do card.
async function testModel(model: unknown) {
  const normalizedModel = String(model || '').trim();
  if (!normalizedModel) throw new Error('Modelo invalido.');
  if (!sessionPassword) throw new Error('Desbloqueie as APIs primeiro.');
  if (!unlockedConfig.apiKeys.length) throw new Error('Cadastre ao menos uma API NVIDIA.');

  const startedAt = Date.now();
  try {
    const response = await forwardToNvidia(
      {
        model: normalizedModel,
        messages: [{ role: 'user', content: TEST_PROMPT }],
        stream: false
      },
      fetch
    );
    const elapsedMs = Date.now() - startedAt;
    const payload: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        model: normalizedModel,
        elapsedMs,
        status: response.status,
        error: payload?.error?.message || `HTTP ${response.status}`
      };
    }
    const reply = payload?.choices?.[0]?.message?.content || '';
    const usage = payload?.usage || {};
    return {
      ok: true,
      model: normalizedModel,
      elapsedMs,
      status: response.status,
      reply: String(reply).trim(),
      totalTokens: Number(usage.total_tokens) || 0,
      promptTokens: Number(usage.prompt_tokens) || 0,
      completionTokens: Number(usage.completion_tokens) || 0
    };
  } catch (error: any) {
    return {
      ok: false,
      model: normalizedModel,
      elapsedMs: Date.now() - startedAt,
      error: error?.message || String(error)
    };
  }
}

async function saveDelay(value: unknown) {
  if (!sessionPassword) throw new Error('A sessao ainda esta bloqueada.');
  unlockedConfig.requestDelayMs = normalizeDelayMs(value);
  setRuntimeConfig(unlockedConfig);
  if (unlockedConfig.apiKeys.length) {
    saveConfig(configPath(), sessionPassword, unlockedConfig);
  }
  broadcastStatus();
  return getStatus();
}

async function savePort(value: unknown) {
  if (!sessionPassword) throw new Error('A sessao ainda esta bloqueada.');
  const port = normalizePort(value);
  const wasRunning = Boolean(proxyServer);
  if (wasRunning) await stopProxy();
  unlockedConfig.port = port;
  if (unlockedConfig.apiKeys.length) {
    saveConfig(configPath(), sessionPassword, unlockedConfig);
    setRuntimeConfig(unlockedConfig);
  }
  if (wasRunning) await startProxy();
  broadcastStatus();
  return getStatus();
}

// Troca a chave local exigida dos clientes. Persistida criptografada junto da
// config. Pode ser chamada a qualquer momento pelo botao da UI, ou no primeiro
// desbloqueio quando o config ainda nao tem chave.
async function saveLocalKey(value: unknown) {
  if (!sessionPassword) throw new Error('A sessao ainda esta bloqueada.');
  const normalized = String(value || '').trim();
  if (normalized.length < 4) throw new Error('A chave local deve ter ao menos 4 caracteres.');
  if (/\s/.test(normalized)) throw new Error('A chave local nao pode conter espacos.');
  unlockedConfig.localApiKey = normalized;
  setLocalApiKey(normalized);
  setRuntimeConfig(unlockedConfig);
  localKeyResolved = true;
  if (unlockedConfig.apiKeys.length) {
    saveConfig(configPath(), sessionPassword, unlockedConfig);
  }
  broadcastStatus();
  return getStatus();
}

function registerIpc() {
  ipcMain.handle('status:get', () => getStatus());
  ipcMain.handle('vault:unlock', (_event, password) => unlock(password));
  ipcMain.handle('config:save', (_event, config) => persistConfig(config));
  ipcMain.handle('localKey:save', (_event, value) => saveLocalKey(value));
  ipcMain.handle('proxy:start', async () => {
    await startProxy();
    return getStatus();
  });
  ipcMain.handle('proxy:stop', async () => {
    await stopProxy();
    return getStatus();
  });
  ipcMain.handle('port:save', (_event, value) => savePort(value));
  ipcMain.handle('delay:save', (_event, value) => saveDelay(value));
  ipcMain.handle('model:select', (_event, model) => selectModel(model));
  ipcMain.handle('model:test', (_event, model) => testModel(model));
  ipcMain.handle('model:setAuto', (_event, value) => setAutoMode(value));
  ipcMain.handle('models:update', (_event, payload) => updateModels(payload));
  ipcMain.handle('clipboard:copy', (_event, value: string) => {
    clipboard.writeText(value);
    return true;
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1020,
    height: 800,
    minWidth: 820,
    minHeight: 680,
    title: APP_NAME,
    backgroundColor: '#090b10',
    icon: path.join(__dirname, 'assets', 'app-icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    broadcastStatus();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

electronApp.setName(APP_NAME);
electronApp.on('before-quit', () => {
  sessionPassword = '';
  usageLog = [];
  if (statusRefreshTimer) clearInterval(statusRefreshTimer);
  clearRuntimeConfig();
  proxyServer?.close();
});

electronApp.whenReady().then(() => {
  registerIpc();
  startStatusRefresh();
  createMainWindow();
});

electronApp.on('window-all-closed', () => {
  if (process.platform !== 'darwin') electronApp.quit();
});

electronApp.on('activate', () => {
  if (!mainWindow) createMainWindow();
});
