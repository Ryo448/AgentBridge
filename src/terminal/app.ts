import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { app as honoApp } from '../index.ts';
import { TEST_PROMPT } from '../desktop/testPrompt.ts';
import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_AUTO_TOGGLE,
  DEFAULT_MODEL,
  DEFAULT_MODEL_CATALOG,
  DEFAULT_MODEL_PRIORITY,
  DEFAULT_PORT,
  INTERNAL_API_KEY,
  NVIDIA_RPM_LIMIT,
  REQUEST_DELAY_MS,
  type ModelCatalogEntry
} from '../config.ts';
import {
  configExists,
  saveConfig,
  unlockConfig,
  type UnlockedConfig
} from '../services/vault.ts';
import {
  clearRuntimeConfig,
  getRuntimeStatus,
  onApiKeyPenalized,
  onApiRequestLog,
  pruneApiRequestLogs,
  setRuntimeConfig,
  type ApiRequestLogEvent
} from '../services/runtime.ts';
import { forwardToNvidia } from '../services/nvidia.ts';
import {
  appDir,
  configPath,
  loadPenalties,
  penaltiesPath,
  savePenalties
} from './paths.ts';
import {
  bar,
  box,
  boxDivider,
  c,
  centerVisible,
  logo,
  padEndVisible,
  screen,
  statusBadge,
  visibleLength
} from './theme.ts';
import {
  confirm,
  drawFrame,
  field,
  getSize,
  pause,
  promptText,
  readKey,
  selectMenu,
  setKeyHandler,
  startInput,
  stopInput
} from './input.ts';
import {
  claudeSnippet,
  codexConfigToml,
  codexEnv,
  formatCountdown,
  formatElapsed,
  usageMessage
} from './format.ts';
import { copyToClipboard } from './clipboard.ts';

// ----------------------------------------------------------------------------
// Estado da sessao (espelha o que o main.ts do Electron mantem em memoria).
// ----------------------------------------------------------------------------
type ProxyState = 'locked' | 'starting' | 'running' | 'stopped' | 'error';

let sessionPassword = '';
let unlockedConfig: UnlockedConfig = freshConfig();
let proxyServer: ServerType | null = null;
let proxyState: ProxyState = 'locked';
let proxyError = '';
let usageLog: ApiRequestLogEvent[] = [];

function freshConfig(): UnlockedConfig {
  return {
    apiKeys: [],
    port: DEFAULT_PORT,
    requestDelayMs: REQUEST_DELAY_MS,
    selectedModel: DEFAULT_MODEL,
    autoToggle: DEFAULT_AUTO_TOGGLE,
    modelPriority: [...DEFAULT_MODEL_PRIORITY],
    modelCatalog: DEFAULT_MODEL_CATALOG.map((item) => ({ ...item }))
  };
}

function refreshRuntime(): void {
  setRuntimeConfig(unlockedConfig);
}

function baseUrl(): string {
  return `http://localhost:${unlockedConfig.port}`;
}

// ----------------------------------------------------------------------------
// Catalogo / prioridade: saneamento identico ao desktop.
// ----------------------------------------------------------------------------
function sanitizeCatalog(value: ModelCatalogEntry[]): ModelCatalogEntry[] {
  const seen = new Set<string>();
  const catalog: ModelCatalogEntry[] = [];
  for (const raw of value) {
    const model = String(raw.model || '').trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    catalog.push({
      model,
      label: String(raw.label || '').trim() || model,
      icon: String(raw.icon || '').trim()
    });
  }
  return catalog.length ? catalog : unlockedConfig.modelCatalog;
}

function sanitizePriority(value: string[], catalog: ModelCatalogEntry[]): string[] {
  const known = new Set(catalog.map((item) => item.model));
  const priority: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const model = String(raw || '').trim();
    if (model && known.has(model) && !seen.has(model)) {
      seen.add(model);
      priority.push(model);
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

// Entradas do catalogo na ordem da lista de prioridades.
function orderedEntries(): ModelCatalogEntry[] {
  const byId = new Map(unlockedConfig.modelCatalog.map((entry) => [entry.model, entry]));
  const ordered: ModelCatalogEntry[] = [];
  for (const id of unlockedConfig.modelPriority) {
    const entry = byId.get(id);
    if (entry) {
      ordered.push(entry);
      byId.delete(id);
    }
  }
  byId.forEach((entry) => ordered.push(entry));
  return ordered;
}

// Modelo exibido no cabecalho de redirecionamento.
function headlineModel(): string {
  if (unlockedConfig.autoToggle) {
    const ordered = orderedEntries();
    if (ordered.length && ordered[0].model) return ordered[0].model.trim();
  }
  return unlockedConfig.selectedModel.trim() || DEFAULT_MODEL;
}

function labelFor(model: string): string {
  const entry = unlockedConfig.modelCatalog.find((item) => item.model === model);
  return entry ? entry.label : model;
}

// ----------------------------------------------------------------------------
// Persistencia.
// ----------------------------------------------------------------------------
function persistToDisk(): void {
  if (!sessionPassword) return;
  if (unlockedConfig.apiKeys.length) {
    saveConfig(configPath(), sessionPassword, unlockedConfig);
  }
}

// ----------------------------------------------------------------------------
// Servidor (gateway).
// ----------------------------------------------------------------------------
async function startProxy(): Promise<void> {
  if (!sessionPassword) throw new Error('Desbloqueie as APIs primeiro.');
  if (!unlockedConfig.apiKeys.length) throw new Error('Cadastre ao menos uma API NVIDIA.');
  if (proxyServer) return;
  proxyState = 'starting';
  proxyError = '';
  await new Promise<void>((resolve) => {
    let settled = false;
    const server = serve({ fetch: honoApp.fetch, port: unlockedConfig.port }, () => {
      settled = true;
      proxyServer = server;
      proxyState = 'running';
      resolve();
    });
    server.once('error', (error: NodeJS.ErrnoException) => {
      proxyServer = null;
      proxyState = 'error';
      proxyError = error.code === 'EADDRINUSE'
        ? `A porta ${unlockedConfig.port} ja esta em uso.`
        : error.message;
      if (!settled) resolve();
    });
  });
}

async function stopProxy(): Promise<void> {
  if (!proxyServer) {
    proxyState = sessionPassword ? 'stopped' : 'locked';
    return;
  }
  const server = proxyServer;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (proxyServer === server) proxyServer = null;
  proxyState = sessionPassword ? 'stopped' : 'locked';
  proxyError = '';
}

// ----------------------------------------------------------------------------
// Layout helpers.
// ----------------------------------------------------------------------------
function innerWidth(): number {
  return Math.min(getSize().cols - 2, 96);
}

// Concatena dois blocos de caixa lado a lado (mesmo numero de linhas).
function twoColumns(left: string[], right: string[], gap = 2): string[] {
  const leftWidth = Math.max(...left.map((line) => visibleLength(line)));
  const rows = Math.max(left.length, right.length);
  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    const l = left[i] ?? '';
    const r = right[i] ?? '';
    out.push(padEndVisible(l, leftWidth) + ' '.repeat(gap) + r);
  }
  return out;
}

// Cabecalho de marca usado em todas as telas.
function brandHeader(): string[] {
  const w = innerWidth();
  const state = statusBadge(proxyState);
  const left = c.accent('▲ ') + c.bold(c.text(APP_NAME)) + ' ' + c.faint(`v${APP_VERSION}`);
  const right = state + c.faint(`  porta ${unlockedConfig.port}`);
  const space = Math.max(1, w - visibleLength(left) - visibleLength(right));
  return [
    '',
    ' ' + left + ' '.repeat(space) + right,
    ' ' + c.faint('NVIDIA inference gateway · uma API local para seus agentes de codigo'),
    ''
  ];
}

// Cabecalho compacto para sub-telas (titulo da secao).
function sectionHeader(title: string, subtitle?: string): string[] {
  const lines = brandHeader();
  lines.push(' ' + c.accent('▌ ') + c.bold(c.text(title.toUpperCase())));
  if (subtitle) lines.push(' ' + c.faint('  ' + subtitle));
  lines.push('');
  return lines;
}

// ----------------------------------------------------------------------------
// Dashboard ao vivo.
// ----------------------------------------------------------------------------
function dashboardLines(): string[] {
  const status = getRuntimeStatus();
  const w = innerWidth();
  const colInner = Math.floor((w - 2) / 2);

  // Coluna esquerda: estado do proxy.
  const proxyRows = [
    field('Cofre', sessionPassword ? c.green('desbloqueado') : c.faint('bloqueado'), 12),
    field('Gateway', statusBadge(proxyState), 12),
    field('Porta', c.text(String(unlockedConfig.port)), 12),
    field('Chaves', c.text(`${status.keyCount} API${status.keyCount === 1 ? '' : 's'}`), 12),
    field('Delay', c.text(`${unlockedConfig.requestDelayMs} ms`), 12),
    field('RPM', `${c.text(`${status.requestsThisMinute}/${status.capacityPerMinute}`)}  ${bar(status.requestsThisMinute, status.capacityPerMinute || 1, Math.max(6, colInner - 22))}`, 12)
  ];

  // Coluna direita: modelo / redirecionamento.
  const headline = headlineModel();
  const modelRows = [
    field('Modo', unlockedConfig.autoToggle ? c.accentStrong('automatico') : c.text('manual'), 12),
    field('Alvo', c.accentStrong(headline), 12),
    field('Rotulo', c.text(labelFor(headline)), 12),
    field('Catalogo', c.text(`${unlockedConfig.modelCatalog.length} modelos`), 12),
    field('Em uso', c.text(status.activeModel || headline), 12),
    field('Cliente', c.faint('use o modelo ') + c.accent('AgentBridge'), 12)
  ];

  const leftBox = box({ title: 'PROXY', lines: proxyRows, innerWidth: colInner, color: c.faint, titleColor: c.accent });
  const rightBox = box({ title: 'MODELO', lines: modelRows, innerWidth: w - 2 - colInner - 2, color: c.faint, titleColor: c.accent });

  const lines = brandHeader();
  lines.push(...twoColumns(leftBox, rightBox).map((line) => ' ' + line));
  lines.push('');

  // Log ao vivo.
  const size = getSize();
  const reserved = lines.length + 6; // bordas do log + rodape
  const logHeight = Math.max(4, Math.min(14, size.rows - reserved));
  const logs = pruneApiRequestLogs(usageLog);
  const tail = logs.slice(-logHeight);
  const logRows = tail.length
    ? tail.map((entry) => {
        const time = c.faint(new Date(entry.timestamp).toLocaleTimeString('pt-BR'));
        return `${time} ${usageMessage(entry)}`;
      })
    : [c.faint('Aguardando a primeira requisicao...')];
  // Preenche ate a altura fixa para a caixa nao "pular".
  while (logRows.length < logHeight) logRows.push('');
  const rpm = c.accentStrong(`${status.requestsThisMinute}/${status.capacityPerMinute} RPM`);
  lines.push(...box({
    title: `LOG AO VIVO   ${rpm}`,
    lines: logRows,
    innerWidth: w,
    color: c.faint,
    titleColor: c.accent
  }).map((line) => ' ' + line));

  // Mensagem de contexto + atalhos.
  lines.push('');
  const penaltyCount = countPenalties(status);
  const hint = proxyState === 'error'
    ? c.red('  ' + proxyError)
    : !status.keyCount
      ? c.amber('  Cadastre suas APIs NVIDIA (tecla A) para iniciar o gateway.')
      : proxyState === 'running'
        ? c.green('  Gateway pronto para Codex CLI, Claude Code e clientes OpenAI/Anthropic.')
        : c.muted('  Pressione S para iniciar o gateway.');
  lines.push(hint);
  lines.push(hotkeyBar(penaltyCount));
  return lines;
}

function hotkeyBar(penaltyCount: number): string {
  const key = (label: string, desc: string) => c.accent(label) + c.faint(' ' + desc);
  const castigo = penaltyCount > 0
    ? c.accent('C') + c.amber(` castigos(${penaltyCount})`)
    : key('C', 'castigos');
  return '  ' + [
    proxyServer ? c.accent('S') + c.faint(' parar') : key('S', 'iniciar'),
    key('A', 'APIs'),
    key('M', 'modelos'),
    castigo,
    key('P', 'porta'),
    key('D', 'delay'),
    key('I', 'integracao'),
    key('L', 'limpar'),
    key('Q', 'sair')
  ].join(c.faint(' · '));
}

function countPenalties(status: ReturnType<typeof getRuntimeStatus>): number {
  let count = 0;
  for (const item of status.apiUsage as Array<{ penalties?: unknown[] }>) {
    count += (item.penalties || []).length;
  }
  return count;
}

// Loop do dashboard: re-renderiza a cada segundo e reage aos atalhos.
async function dashboardLoop(): Promise<void> {
  while (true) {
    const action = await new Promise<string>((resolve) => {
      const render = () => drawFrame(dashboardLines());
      render();
      const timer = setInterval(render, 1000);
      setKeyHandler((keyEvent) => {
        const key = (keyEvent.str || '').toLowerCase();
        const map: Record<string, string> = {
          s: 'toggle', a: 'apis', m: 'models', c: 'penalties',
          p: 'port', d: 'delay', i: 'integration', l: 'clear', q: 'quit'
        };
        const resolved = map[key];
        if (!resolved) return;
        clearInterval(timer);
        setKeyHandler(null);
        resolve(resolved);
      });
    });

    if (action === 'quit') {
      const ok = await confirm({
        header: sectionHeader('Sair', 'O gateway sera encerrado e as chaves saem da memoria.'),
        question: 'Encerrar o AgentBridge?',
        defaultYes: true
      });
      if (ok) return;
      continue;
    }
    await handleAction(action);
  }
}

async function handleAction(action: string): Promise<void> {
  try {
    switch (action) {
      case 'toggle':
        if (proxyServer) await stopProxy();
        else await startProxy();
        break;
      case 'apis': await apisScreen(); break;
      case 'models': await modelsScreen(); break;
      case 'penalties': await penaltiesScreen(); break;
      case 'port': await portScreen(); break;
      case 'delay': await delayScreen(); break;
      case 'integration': await integrationScreen(); break;
      case 'clear': usageLog = []; break;
    }
  } catch (error) {
    await pause({
      lines: sectionHeader('Erro', '').concat('  ' + c.red(error instanceof Error ? error.message : String(error)))
    });
  }
}

// ----------------------------------------------------------------------------
// Tela: APIs (cadastro/edicao das chaves criptografadas).
// ----------------------------------------------------------------------------
function maskKey(key: string): string {
  if (key.length <= 10) return key.slice(0, 2) + '…';
  return key.slice(0, 8) + '…' + key.slice(-4);
}

async function apisScreen(): Promise<void> {
  while (true) {
    const header = sectionHeader(
      'APIs NVIDIA',
      `As chaves sao criptografadas (AES-256-GCM) em ${configPath()}`
    );
    const items = unlockedConfig.apiKeys.map((key, i) => ({
      label: `API ${i + 1}  ${c.faint(maskKey(key))}`,
      value: `edit:${i}`,
      hint: ''
    }));
    items.push({ label: c.accent('+ Adicionar API'), value: 'add', hint: '' });
    if (unlockedConfig.apiKeys.length) {
      items.push({ label: 'Salvar e criptografar', value: 'save', hint: c.faint(`${unlockedConfig.apiKeys.length} chave(s)`) });
    }
    items.push({ label: c.muted('Voltar'), value: 'back', hint: '' });

    const choice = await selectMenu({
      header: header.concat(
        '  ' + c.faint('Enter numa API para editar/remover.')
      ),
      items
    });
    if (!choice || choice === 'back') return;

    if (choice === 'add') {
      const value = await promptText({
        header: sectionHeader('Adicionar API', 'Cole a chave nvapi-... gerada em build.nvidia.com'),
        label: 'Chave da API NVIDIA',
        mask: true,
        placeholder: 'nvapi-...',
        validate: (v) => (v.trim().startsWith('nvapi-') ? null : 'A chave deve comecar com nvapi-')
      });
      if (value && value.trim()) {
        unlockedConfig.apiKeys.push(value.trim());
        refreshRuntime();
      }
      continue;
    }

    if (choice === 'save') {
      persistToDisk();
      refreshRuntime();
      savePenalties(unlockedConfig.apiKeys);
      await pause({
        lines: sectionHeader('APIs salvas', '').concat(
          '  ' + c.green(`${unlockedConfig.apiKeys.length} chave(s) criptografada(s) com sucesso.`),
          '  ' + c.faint(configPath())
        )
      });
      continue;
    }

    if (choice.startsWith('edit:')) {
      const idx = Number(choice.slice(5));
      const action = await selectMenu({
        header: sectionHeader(`API ${idx + 1}`, maskKey(unlockedConfig.apiKeys[idx] || '')),
        items: [
          { label: 'Substituir chave', value: 'replace' },
          { label: c.red('Remover'), value: 'remove' },
          { label: c.muted('Voltar'), value: 'back' }
        ]
      });
      if (action === 'replace') {
        const value = await promptText({
          header: sectionHeader('Substituir API', ''),
          label: 'Nova chave NVIDIA',
          mask: true,
          placeholder: 'nvapi-...',
          validate: (v) => (v.trim().startsWith('nvapi-') ? null : 'A chave deve comecar com nvapi-')
        });
        if (value && value.trim()) {
          unlockedConfig.apiKeys[idx] = value.trim();
          refreshRuntime();
        }
      } else if (action === 'remove') {
        unlockedConfig.apiKeys.splice(idx, 1);
        refreshRuntime();
      }
      continue;
    }
  }
}

// ----------------------------------------------------------------------------
// Tela: Modelos (selecao, automatico, prioridade, testar, editar).
// ----------------------------------------------------------------------------
async function modelsScreen(): Promise<void> {
  while (true) {
    const ordered = orderedEntries();
    const active = unlockedConfig.autoToggle
      ? (getRuntimeStatus().activeModel || headlineModel())
      : unlockedConfig.selectedModel;

    const header = sectionHeader(
      'Modelos NVIDIA',
      unlockedConfig.autoToggle
        ? 'Automatico ligado: o proxy segue a ordem de prioridade e troca em 429.'
        : 'Manual: toda chamada vai para o modelo selecionado.'
    );

    const items: Array<{ label: string; value: string; hint?: string }> = [];
    items.push({
      label: (unlockedConfig.autoToggle ? c.accent('◉') : c.faint('◯')) +
        ' Alternancia automatica de modelo ' +
        (unlockedConfig.autoToggle ? c.accentStrong('[ON]') : c.faint('[OFF]')),
      value: 'auto'
    });
    ordered.forEach((entry, i) => {
      const isActive = entry.model === active;
      const rank = unlockedConfig.autoToggle ? c.accent(`${i + 1}. `) : '';
      const marker = isActive ? c.green('● ') : c.faint('○ ');
      const name = isActive ? c.bold(c.text(entry.label)) : c.text(entry.label);
      items.push({
        label: `${marker}${rank}${name}`,
        value: `model:${entry.model}`,
        hint: c.faint(entry.model)
      });
    });
    items.push({ label: c.accent('+ Adicionar modelo'), value: 'add' });
    items.push({ label: c.muted('Voltar'), value: 'back' });

    const choice = await selectMenu({ header, items });
    if (!choice || choice === 'back') return;

    if (choice === 'auto') {
      unlockedConfig.autoToggle = !unlockedConfig.autoToggle;
      refreshRuntime();
      persistToDisk();
      continue;
    }
    if (choice === 'add') {
      await addModelScreen();
      continue;
    }
    if (choice.startsWith('model:')) {
      await modelActionScreen(choice.slice(6));
      continue;
    }
  }
}

async function modelActionScreen(model: string): Promise<void> {
  const entry = unlockedConfig.modelCatalog.find((item) => item.model === model);
  if (!entry) return;
  const idx = unlockedConfig.modelPriority.indexOf(model);

  const choice = await selectMenu({
    header: sectionHeader(entry.label, model),
    items: [
      { label: 'Usar este modelo (manual)', value: 'use' },
      { label: 'Testar modelo', value: 'test', hint: c.faint('gera uma calculadora e mede o tempo') },
      { label: 'Subir prioridade', value: 'up', disabled: idx <= 0 },
      { label: 'Descer prioridade', value: 'down', disabled: idx < 0 || idx >= unlockedConfig.modelPriority.length - 1 },
      { label: 'Editar nome / id', value: 'edit' },
      { label: c.red('Remover do catalogo'), value: 'remove', disabled: unlockedConfig.modelCatalog.length <= 1 },
      { label: c.muted('Voltar'), value: 'back' }
    ]
  });

  switch (choice) {
    case 'use':
      unlockedConfig.autoToggle = false;
      unlockedConfig.selectedModel = model;
      refreshRuntime();
      persistToDisk();
      break;
    case 'test':
      await testModelScreen(model);
      break;
    case 'up':
    case 'down': {
      const swap = choice === 'up' ? idx - 1 : idx + 1;
      const next = [...unlockedConfig.modelPriority];
      [next[idx], next[swap]] = [next[swap], next[idx]];
      unlockedConfig.modelPriority = sanitizePriority(next, unlockedConfig.modelCatalog);
      refreshRuntime();
      persistToDisk();
      break;
    }
    case 'edit':
      await editModelScreen(model);
      break;
    case 'remove': {
      unlockedConfig.modelCatalog = unlockedConfig.modelCatalog.filter((item) => item.model !== model);
      unlockedConfig.modelPriority = sanitizePriority(
        unlockedConfig.modelPriority.filter((id) => id !== model),
        unlockedConfig.modelCatalog
      );
      if (unlockedConfig.selectedModel === model) {
        unlockedConfig.selectedModel = unlockedConfig.modelCatalog[0]?.model || DEFAULT_MODEL;
      }
      refreshRuntime();
      persistToDisk();
      break;
    }
  }
}

async function addModelScreen(): Promise<void> {
  const label = await promptText({
    header: sectionHeader('Adicionar modelo', ''),
    label: 'Nome amigavel (ex.: Llama 4 Maverick)',
    placeholder: 'Nome do modelo'
  });
  if (label === null) return;
  const model = await promptText({
    header: sectionHeader('Adicionar modelo', label.trim()),
    label: 'provider/modelo (ex.: meta/llama-4-maverick)',
    placeholder: 'provider/modelo',
    validate: (v) => {
      const id = v.trim();
      if (!id) return 'Informe o provider/modelo.';
      if (unlockedConfig.modelCatalog.some((item) => item.model === id)) return 'Ja existe esse provider/modelo.';
      return null;
    }
  });
  if (model === null) return;
  const catalog = sanitizeCatalog([
    ...unlockedConfig.modelCatalog,
    { label: label.trim() || model.trim(), model: model.trim(), icon: '' }
  ]);
  unlockedConfig.modelCatalog = catalog;
  unlockedConfig.modelPriority = sanitizePriority(unlockedConfig.modelPriority, catalog);
  refreshRuntime();
  persistToDisk();
}

async function editModelScreen(model: string): Promise<void> {
  const entry = unlockedConfig.modelCatalog.find((item) => item.model === model);
  if (!entry) return;
  const label = await promptText({
    header: sectionHeader('Editar modelo', model),
    label: 'Nome do modelo',
    initial: entry.label
  });
  if (label === null) return;
  const newId = await promptText({
    header: sectionHeader('Editar modelo', label.trim()),
    label: 'provider/modelo',
    initial: entry.model,
    validate: (v) => {
      const id = v.trim();
      if (!id) return 'Informe o provider/modelo.';
      if (id !== model && unlockedConfig.modelCatalog.some((item) => item.model === id)) return 'Ja existe esse provider/modelo.';
      return null;
    }
  });
  if (newId === null) return;
  const id = newId.trim();
  unlockedConfig.modelCatalog = unlockedConfig.modelCatalog.map((item) =>
    item.model === model ? { label: label.trim() || id, model: id, icon: item.icon } : item
  );
  unlockedConfig.modelPriority = unlockedConfig.modelPriority.map((p) => (p === model ? id : p));
  if (unlockedConfig.selectedModel === model) unlockedConfig.selectedModel = id;
  unlockedConfig.modelCatalog = sanitizeCatalog(unlockedConfig.modelCatalog);
  unlockedConfig.modelPriority = sanitizePriority(unlockedConfig.modelPriority, unlockedConfig.modelCatalog);
  refreshRuntime();
  persistToDisk();
}

// Testa um modelo enviando o TEST_PROMPT por toda a rotacao e medindo o tempo.
async function testModelScreen(model: string): Promise<void> {
  if (!unlockedConfig.apiKeys.length) {
    await pause({ lines: sectionHeader('Testar modelo', '').concat('  ' + c.amber('Cadastre ao menos uma API primeiro.')) });
    return;
  }
  const startedAt = Date.now();
  let done = false;
  const render = () => {
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    drawFrame(sectionHeader('Testar modelo', model).concat(
      '  ' + c.amber(`Gerando calculadora... ${seconds}s`),
      '',
      c.faint('  Enviando o prompt por toda a rotacao de chaves...')
    ));
  };
  render();
  const timer = setInterval(() => { if (!done) render(); }, 100);

  let resultLines: string[];
  try {
    const response = await forwardToNvidia(
      { model, messages: [{ role: 'user', content: TEST_PROMPT }], stream: false },
      fetch
    );
    const elapsed = Date.now() - startedAt;
    const payload: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      resultLines = ['  ' + c.red(`Falhou (HTTP ${response.status}) em ${formatElapsed(elapsed)}: ${payload?.error?.message || 'sem detalhe'}`)];
    } else {
      const reply = String(payload?.choices?.[0]?.message?.content || '').trim();
      const tokens = Number(payload?.usage?.total_tokens) || 0;
      resultLines = [
        '  ' + c.green(`Respondeu em ${formatElapsed(elapsed)}${tokens ? `, ${tokens} tokens` : ''}`),
        ''
      ];
      const snippet = reply.split('\n').slice(0, 18);
      for (const line of snippet) resultLines.push('  ' + c.faint('│ ') + c.text(line));
      if (reply.split('\n').length > 18) resultLines.push('  ' + c.faint('│ ...'));
    }
  } catch (error) {
    resultLines = ['  ' + c.red(`Falhou: ${error instanceof Error ? error.message : String(error)}`)];
  } finally {
    done = true;
    clearInterval(timer);
  }
  await pause({ lines: sectionHeader('Resultado do teste', model).concat(resultLines) });
}

// ----------------------------------------------------------------------------
// Tela: Castigos (429) ao vivo.
// ----------------------------------------------------------------------------
async function penaltiesScreen(): Promise<void> {
  await new Promise<void>((resolve) => {
    const render = () => {
      const status = getRuntimeStatus();
      const now = Date.now();
      const rows: string[] = [];
      (status.apiUsage as Array<{ apiNumber: number; penalties?: Array<{ model: string; penaltyStartedAt: number; penaltyUntil: number; successesBefore429?: number }> }>)
        .forEach((item) => {
          (item.penalties || []).forEach((penalty) => {
            rows.push(JSON.stringify({ ...penalty, apiNumber: item.apiNumber }));
          });
        });
      const parsed = rows
        .map((r) => JSON.parse(r) as { apiNumber: number; model: string; penaltyStartedAt: number; penaltyUntil: number; successesBefore429?: number })
        .sort((a, b) => a.penaltyUntil - b.penaltyUntil);

      const header = sectionHeader('APIs em castigo (HTTP 429)', `Cooldown de 1h por (chave, modelo). Arquivo: ${penaltiesPath()}`);
      const w = innerWidth();
      let bodyLines: string[];
      if (!parsed.length) {
        bodyLines = [c.green('Nenhuma API em castigo agora.'), '', c.faint('Tudo no rodizio normal.')];
      } else {
        bodyLines = parsed.map((item) => {
          const title = item.model ? `API ${item.apiNumber} · ${item.model}` : `API ${item.apiNumber}`;
          const countdown = c.amber(formatCountdown(item.penaltyUntil - now));
          const success = c.green(`${item.successesBefore429 || 0} x 200 ate 429`);
          const entered = c.faint(`entrou ${new Date(item.penaltyStartedAt).toLocaleTimeString('pt-BR')}`);
          const left = padEndVisible(c.text(title), Math.max(20, w - 34));
          return `${left} ${success}  ${entered}  ${countdown}`;
        });
      }
      drawFrame(header.concat(
        box({ title: 'CASTIGOS', lines: bodyLines, innerWidth: w, color: c.faint, titleColor: c.amber }).map((l) => ' ' + l),
        '',
        c.faint('  Atualiza a cada segundo · Esc voltar')
      ));
    };
    render();
    const timer = setInterval(render, 1000);
    setKeyHandler((key) => {
      if (key.name === 'escape' || (key.str || '').toLowerCase() === 'q') {
        clearInterval(timer);
        setKeyHandler(null);
        resolve();
      }
    });
  });
}

// ----------------------------------------------------------------------------
// Tela: Porta.
// ----------------------------------------------------------------------------
async function portScreen(): Promise<void> {
  const value = await promptText({
    header: sectionHeader('Porta local', 'Onde o gateway escuta (1-65535). Reinicia se estiver rodando.'),
    label: 'Porta',
    initial: String(unlockedConfig.port),
    validate: (v) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 && n <= 65535 ? null : 'Digite uma porta entre 1 e 65535.';
    }
  });
  if (value === null) return;
  const wasRunning = Boolean(proxyServer);
  if (wasRunning) await stopProxy();
  unlockedConfig.port = Number(value);
  persistToDisk();
  refreshRuntime();
  if (wasRunning) await startProxy();
}

// ----------------------------------------------------------------------------
// Tela: Delay extra.
// ----------------------------------------------------------------------------
async function delayScreen(): Promise<void> {
  const value = await promptText({
    header: sectionHeader('Delay extra (ms)', 'Espacamento adicional antes de cada chamada NVIDIA (0-600000).'),
    label: 'Delay em ms',
    initial: String(unlockedConfig.requestDelayMs),
    validate: (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 && n <= 600_000 ? null : 'Digite um valor entre 0 e 600000 ms.';
    }
  });
  if (value === null) return;
  unlockedConfig.requestDelayMs = Math.round(Number(value));
  persistToDisk();
  refreshRuntime();
}

// ----------------------------------------------------------------------------
// Tela: Integracao (snippets Codex / Claude / API direta).
// ----------------------------------------------------------------------------
async function integrationScreen(): Promise<void> {
  while (true) {
    const choice = await selectMenu({
      header: sectionHeader('Integracao dos clientes', `Endereco do gateway: ${baseUrl()}`),
      items: [
        { label: 'Codex CLI', value: 'codex', hint: c.faint('config.toml + variavel') },
        { label: 'Claude Code', value: 'claude', hint: c.faint('variaveis de ambiente') },
        { label: 'API direta', value: 'api', hint: c.faint('endpoints + chave') },
        { label: 'Exportar tudo para um arquivo .txt', value: 'export' },
        { label: c.muted('Voltar'), value: 'back' }
      ]
    });
    if (!choice || choice === 'back') return;
    if (choice === 'codex') await codexScreen();
    else if (choice === 'claude') await claudeScreen();
    else if (choice === 'api') await apiDirectScreen();
    else if (choice === 'export') await exportIntegrationFile();
  }
}

// Copia o texto para a area de transferencia e mostra uma confirmacao + o texto
// limpo (sem bordas, para selecao manual com o mouse tambem sair limpa).
async function copyAndShow(title: string, subtitle: string, text: string): Promise<void> {
  const result = await copyToClipboard(text);
  const note =
    result === 'native'
      ? c.green('✓ Copiado para a area de transferencia.')
      : result === 'osc52'
        ? c.green('✓ Copiado via terminal (OSC52).') + c.faint('  Se nao colar, selecione abaixo.')
        : c.amber('Nao consegui copiar sozinho. Selecione o texto abaixo.');
  const block = text.split('\n').map((line) => '   ' + c.text(line));
  await pause({ lines: sectionHeader(title, subtitle).concat('  ' + note, '', ...block) });
}

async function codexScreen(): Promise<void> {
  while (true) {
    const choice = await selectMenu({
      header: sectionHeader('Codex CLI', 'O config.toml vai no ~/.codex/config.toml; a variavel, no shell.'),
      items: [
        { label: 'Copiar config.toml', value: 'toml', hint: c.faint('bloco [model_providers]') },
        { label: 'Copiar variavel — bash / zsh', value: 'bash', hint: c.faint('export AGENTBRIDGE_API_KEY=...') },
        { label: 'Copiar variavel — PowerShell', value: 'pwsh', hint: c.faint('$env:AGENTBRIDGE_API_KEY=...') },
        { label: c.muted('Voltar'), value: 'back' }
      ]
    });
    if (!choice || choice === 'back') return;
    if (choice === 'toml') {
      await copyAndShow('Codex · config.toml', 'Cole no ~/.codex/config.toml', codexConfigToml(baseUrl()));
    } else if (choice === 'bash') {
      await copyAndShow('Codex · variavel (bash / zsh)', 'Cole no terminal antes de rodar o Codex', codexEnv(INTERNAL_API_KEY, 'bash'));
    } else if (choice === 'pwsh') {
      await copyAndShow('Codex · variavel (PowerShell)', 'Cole no PowerShell antes de rodar o Codex', codexEnv(INTERNAL_API_KEY, 'powershell'));
    }
  }
}

async function claudeScreen(): Promise<void> {
  while (true) {
    const choice = await selectMenu({
      header: sectionHeader('Claude Code', 'Escolha o shell. Cole o bloco e o Claude Code ja inicia.'),
      items: [
        { label: 'Copiar — bash / zsh', value: 'bash', hint: c.faint('export ...') },
        { label: 'Copiar — PowerShell', value: 'pwsh', hint: c.faint('$env:...') },
        { label: c.muted('Voltar'), value: 'back' }
      ]
    });
    if (!choice || choice === 'back') return;
    if (choice === 'bash') {
      await copyAndShow('Claude Code · bash / zsh', 'Cole no terminal', claudeSnippet(baseUrl(), INTERNAL_API_KEY, 'bash'));
    } else if (choice === 'pwsh') {
      await copyAndShow('Claude Code · PowerShell', 'Cole no PowerShell', claudeSnippet(baseUrl(), INTERNAL_API_KEY, 'powershell'));
    }
  }
}

async function apiDirectScreen(): Promise<void> {
  while (true) {
    const entries = [
      { label: 'Chave local', value: 'key', text: INTERNAL_API_KEY },
      { label: 'Chat Completions', value: 'chat', text: `${baseUrl()}/v1/chat/completions` },
      { label: 'Responses', value: 'responses', text: `${baseUrl()}/v1/responses` },
      { label: 'Anthropic Messages', value: 'messages', text: `${baseUrl()}/v1/messages` },
      { label: 'Health', value: 'health', text: `${baseUrl()}/health` },
      { label: 'Modelos', value: 'models', text: `${baseUrl()}/v1/models` }
    ];
    const choice = await selectMenu({
      header: sectionHeader('API direta', 'Enter copia o valor. Auth via Bearer ou x-api-key.'),
      items: [
        ...entries.map((entry) => ({ label: entry.label, value: entry.value, hint: c.faint(entry.text) })),
        { label: c.muted('Voltar'), value: 'back' }
      ]
    });
    if (!choice || choice === 'back') return;
    const picked = entries.find((entry) => entry.value === choice);
    if (picked) await copyAndShow(`API · ${picked.label}`, 'Copiado', picked.text);
  }
}

async function exportIntegrationFile(): Promise<void> {
  const file = path.join(appDir(), 'integracao.txt');
  const content = [
    `AgentBridge NVIDIA - integracao (${baseUrl()})`,
    `Chave local: ${INTERNAL_API_KEY}`,
    '',
    '=== Codex CLI (~/.codex/config.toml) ===',
    codexConfigToml(baseUrl()),
    '',
    '# bash / zsh',
    codexEnv(INTERNAL_API_KEY, 'bash'),
    '# PowerShell',
    codexEnv(INTERNAL_API_KEY, 'powershell'),
    '',
    '=== Claude Code (bash / zsh) ===',
    claudeSnippet(baseUrl(), INTERNAL_API_KEY, 'bash'),
    '',
    '=== Claude Code (PowerShell) ===',
    claudeSnippet(baseUrl(), INTERNAL_API_KEY, 'powershell'),
    '',
    '=== Endpoints ===',
    `${baseUrl()}/v1/chat/completions`,
    `${baseUrl()}/v1/responses`,
    `${baseUrl()}/v1/messages`,
    `${baseUrl()}/health`
  ].join('\n');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  await pause({ lines: sectionHeader('Exportado', '').concat('  ' + c.green('Arquivo salvo em:'), '  ' + c.faint(file)) });
}

// ----------------------------------------------------------------------------
// Fluxo de desbloqueio / primeira execucao.
// ----------------------------------------------------------------------------
async function unlockFlow(): Promise<boolean> {
  const splash = () => {
    const w = innerWidth();
    const lines = ['', '', ...logo().map((l) => ' ' + centerVisible(l, w))];
    lines.push('', ' ' + centerVisible(c.faint(`NVIDIA inference gateway · v${APP_VERSION}`), w), '');
    return lines;
  };

  if (configExists(configPath())) {
    let error = '';
    while (true) {
      const password = await promptText({
        header: splash().concat(
          ' ' + centerVisible(c.muted('Cofre local encontrado. Digite sua senha para descriptografar.'), innerWidth()),
          ''
        ),
        label: 'Senha de criptografia',
        mask: true,
        footer: error ? '  ' + c.red(error) : c.faint('  Enter desbloquear · Esc sair'),
        validate: () => null
      });
      if (password === null) return false;
      try {
        unlockedConfig = unlockConfig(configPath(), password);
        sessionPassword = password;
        usageLog = [];
        refreshRuntime();
        loadPenalties(unlockedConfig.apiKeys);
        proxyState = 'stopped';
        // Sobe o gateway automaticamente, igual ao desktop.
        if (unlockedConfig.apiKeys.length) await startProxy();
        return true;
      } catch (e) {
        error = e instanceof Error ? e.message : 'Senha incorreta.';
      }
    }
  }

  // Primeira execucao: cria senha e segue para o cadastro de APIs.
  await pause({
    lines: splash().concat(
      ' ' + centerVisible(c.amber('Nenhum cofre encontrado. Vamos criar um agora.'), innerWidth()),
      ' ' + centerVisible(c.faint('A senha NUNCA e salva: ela so descriptografa as chaves nesta sessao.'), innerWidth())
    ),
    footer: c.faint('  Pressione qualquer tecla para comecar...')
  });

  while (true) {
    const password = await promptText({
      header: sectionHeader('Criar cofre', 'Escolha uma senha forte para criptografar suas chaves.'),
      label: 'Nova senha',
      mask: true,
      validate: (v) => (v.trim().length >= 4 ? null : 'Use ao menos 4 caracteres.')
    });
    if (password === null) return false;
    const confirmPwd = await promptText({
      header: sectionHeader('Criar cofre', 'Confirme a senha digitada.'),
      label: 'Confirmar senha',
      mask: true
    });
    if (confirmPwd === null) return false;
    if (password !== confirmPwd) {
      await pause({ lines: sectionHeader('Senhas diferentes', '').concat('  ' + c.red('As senhas nao conferem. Tente de novo.')) });
      continue;
    }
    sessionPassword = password;
    unlockedConfig = freshConfig();
    clearRuntimeConfig();
    proxyState = 'stopped';
    // Cadastro inicial das APIs.
    await apisScreen();
    if (unlockedConfig.apiKeys.length) {
      persistToDisk();
      refreshRuntime();
      await startProxy();
    }
    return true;
  }
}

// ----------------------------------------------------------------------------
// Wiring de eventos do runtime -> log da TUI.
// ----------------------------------------------------------------------------
function wireRuntimeEvents(): void {
  onApiRequestLog((event) => {
    usageLog = pruneApiRequestLogs([...usageLog, event]);
  });
  onApiKeyPenalized(() => {
    savePenalties(unlockedConfig.apiKeys);
  });
}

// ----------------------------------------------------------------------------
// Entrada principal da TUI.
// ----------------------------------------------------------------------------
export async function runTui(): Promise<void> {
  process.stdout.write(screen.altOn);
  let exiting = false;
  const cleanup = () => {
    if (exiting) return;
    exiting = true;
    proxyServer?.close();
    clearRuntimeConfig();
    stopInput();
    process.stdout.write(screen.showCursor + screen.altOff);
    process.exit(0);
  };
  startInput(cleanup);
  wireRuntimeEvents();

  try {
    const unlocked = await unlockFlow();
    if (!unlocked) {
      cleanup();
      return;
    }
    await dashboardLoop();
  } finally {
    cleanup();
  }
}
