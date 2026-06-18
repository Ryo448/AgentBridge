const previewStatus = {
  proxyState: 'locked',
  unlocked: false,
  hasConfig: false,
  keyCount: 0,
  requestsThisMinute: 0,
  capacityPerMinute: 0,
  limitPerKey: 35,
  requestDelayMs: 0,
  apiUsage: [],
  usageLog: [],
  port: 3000,
  selectedModel: 'deepseek-ai/deepseek-v4-pro',
  autoToggle: false,
  activeModel: 'deepseek-ai/deepseek-v4-pro',
  modelCatalog: Array.isArray(window.agentBridgeModels)
    ? window.agentBridgeModels.map((item) => ({ label: item.label, model: item.model, icon: item.key }))
    : [],
  modelPriority: Array.isArray(window.agentBridgeModels)
    ? window.agentBridgeModels.map((item) => item.model)
    : [],
  provider: 'NVIDIA',
  appVersion: '3.0.0',
  apiKey: 'EuAmoORyo',
  codexBaseUrl: 'http://localhost:3000/v1',
  claudeBaseUrl: 'http://localhost:3000',
  responsesEndpoint: 'http://localhost:3000/v1/responses',
  messagesEndpoint: 'http://localhost:3000/v1/messages',
  chatEndpoint: 'http://localhost:3000/v1/chat/completions',
  configPath: 'Documentos\\AgentBridge\\config.json',
  penaltyPath: 'Documentos\\AgentBridge\\penalties.json'
};
const bridge = window.agentBridge || {
  getStatus: async () => previewStatus,
  unlock: async () => ({ ...previewStatus, unlocked: true, proxyState: 'stopped' }),
  saveConfig: async () => ({ ...previewStatus, unlocked: true, keyCount: 3, proxyState: 'running' }),
  startProxy: async () => ({ ...previewStatus, unlocked: true, proxyState: 'running' }),
  stopProxy: async () => ({ ...previewStatus, unlocked: true, proxyState: 'stopped' }),
  savePort: async () => previewStatus,
  saveDelay: async () => previewStatus,
  selectModel: async (model) => ({ ...previewStatus, selectedModel: model }),
  testModel: async () => ({ ok: false, error: 'Indisponivel no modo de previa.' }),
  setAutoToggle: async (value) => ({ ...previewStatus, autoToggle: Boolean(value) }),
  updateModels: async (payload) => ({
    ...previewStatus,
    modelCatalog: (payload && payload.catalog) || previewStatus.modelCatalog,
    modelPriority: (payload && payload.priority) || previewStatus.modelPriority
  }),
  copy: async () => true,
  onStatus: () => () => {}
};
const byId = (id) => document.getElementById(id);
const modelIcons = window.agentBridgeModelIcons;
let lastStatus = previewStatus;

const elements = Object.fromEntries([
  'appVersion', 'proxyStatus', 'vaultStatus', 'vaultDetail',
  'serverStatus', 'rateLimitDetail', 'portInput', 'savePortButton', 'delayInput', 'saveDelayButton', 'configButton', 'startButton',
  'stopButton', 'codexConfig', 'claudeConfig', 'chatValue', 'responsesValue',
  'messagesValue', 'apiKeyValue', 'messageLine', 'unlockModal', 'unlockForm',
  'passwordInput', 'unlockHint', 'unlockError', 'configModal', 'configForm',
  'closeConfigButton', 'apiFields', 'addApiButton',
  'configPathValue', 'configError', 'rpmCounter', 'usageTerminalOutput',
  'penaltyButton', 'penaltyBadge', 'penaltyModal', 'closePenaltyButton', 'penaltyList', 'penaltyPathValue',
  'copyLogButton',
  'selectedModelLabel', 'selectModelButton', 'selectModal', 'closeSelectButton', 'modelGrid',
  'autoToggleSwitch', 'autoToggleHint', 'selectModeHint', 'addModelButton', 'addModelForm',
  'addModelName', 'addModelId', 'addModelError', 'cancelAddModelButton'
].map((id) => [id, byId(id)]));

function stateLabel(state) {
  return ({ locked: 'Bloqueado', starting: 'Iniciando', running: 'Online', stopped: 'Offline', error: 'Erro' })[state] || 'Offline';
}

function codexSnippet(status) {
  return [
    'model = "AgentBridge"',
    'model_provider = "agentbridge"',
    '',
    '[model_providers.agentbridge]',
    'name = "NVIDIA via AgentBridge"',
    `base_url = "${status.codexBaseUrl}"`,
    'wire_api = "responses"',
    'env_key = "AGENTBRIDGE_API_KEY"',
    '',
    '# PowerShell',
    `$env:AGENTBRIDGE_API_KEY="${status.apiKey}"`
  ].join('\n');
}

function claudeSnippet(status) {
  return [
    '# PowerShell',
    `$env:ANTHROPIC_BASE_URL="${status.claudeBaseUrl}"`,
    `$env:ANTHROPIC_AUTH_TOKEN="${status.apiKey}"`,
    '$env:ANTHROPIC_MODEL="AgentBridge"',
    '$env:ANTHROPIC_DEFAULT_HAIKU_MODEL=$env:ANTHROPIC_MODEL',
    '$env:ANTHROPIC_DEFAULT_SONNET_MODEL=$env:ANTHROPIC_MODEL',
    '$env:ANTHROPIC_DEFAULT_OPUS_MODEL=$env:ANTHROPIC_MODEL',
    'claude'
  ].join('\n');
}

function formatElapsed(milliseconds) {
  if (!Number.isFinite(Number(milliseconds))) return '';
  const value = Number(milliseconds);
  if (value < 1000) return `${Math.max(0, Math.round(value))} ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
}

function usageMessage(entry) {
  const target = entry.path ? `${entry.method || ''} ${entry.path}`.trim() : '';
  if (entry.type === 'received') return `Cliente chamou ${target}`;
  if (entry.type === 'rejected') return `Cliente rejeitado ${target} HTTP ${entry.status}: ${entry.message || 'chave invalida'}`;
  if (entry.type === 'completed_client') return `Cliente recebeu HTTP ${entry.status} ${target} em ${formatElapsed(entry.elapsedMs)}`;
  if (entry.type === 'failed_client') return `Erro no proxy ${target}: ${entry.message || 'falha desconhecida'}`;
  if (entry.type === 'rate_limit_wait') return `Aguardando throttle de RPM por ${formatElapsed(entry.waitMs)}`;
  if (entry.type === 'delay') return `Esperando delay de ${formatElapsed(entry.delayMs)}`;
  if (entry.type === 'started') return `API ${entry.apiNumber} comecou a responder em ${formatElapsed(entry.elapsedMs)}${entry.model ? ` · modelo ${entry.model}` : ''}`;
  if (entry.type === 'completed') return `API ${entry.apiNumber} Respondeu em ${formatElapsed(entry.elapsedMs)}${Number(entry.totalTokens) > 0 ? `, consumindo ${entry.totalTokens} tokens` : ''}`;
  if (entry.type === 'upstream_error') return `NVIDIA erro HTTP ${entry.status} na API ${entry.apiNumber}${entry.model ? ` (modelo ${entry.model})` : ''}: ${entry.message || 'sem detalhe'}`;
  if (entry.type === 'cancelled') return `Stream cancelado na API ${entry.apiNumber}: ${entry.message || 'cliente desconectou'}`;
  if (entry.type === 'model_switch') return `Modelo trocado automaticamente${entry.message ? ` ${entry.message}` : ''} para ${entry.model || '?'}`;
  if (entry.type === 'error') return `Erro na API ${entry.apiNumber || '?'}: ${entry.message || 'sem detalhe'}`;
  return `API ${entry.apiNumber} Chamada`;
}

function renderUsageTerminal(status) {
  elements.rpmCounter.textContent =
    `${status.requestsThisMinute}/${status.capacityPerMinute} RPM`;
  const usageLog = Array.isArray(status.usageLog) ? status.usageLog : [];
  if (!usageLog.length) {
    elements.usageTerminalOutput.innerHTML =
      '<div class="terminal-empty">Aguardando a primeira requisicao...</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  usageLog.forEach((entry) => {
    const line = document.createElement('div');
    line.className = 'terminal-line';
    const time = document.createElement('span');
    time.className = 'terminal-time';
    time.textContent = new Date(entry.timestamp).toLocaleTimeString('pt-BR');
    const message = document.createElement('span');
    message.textContent = usageMessage(entry);
    const count = document.createElement('span');
    count.className = 'terminal-count';
    count.textContent = Number.isFinite(Number(entry.requestsThisMinute))
      ? `${entry.requestsThisMinute}/${status.limitPerKey}`
      : '';
    line.append(time, message, count);
    fragment.append(line);
  });
  elements.usageTerminalOutput.replaceChildren(fragment);
  elements.usageTerminalOutput.scrollTop = elements.usageTerminalOutput.scrollHeight;
}

function formatCountdown(milliseconds) {
  const total = Math.max(0, Math.floor(Number(milliseconds) / 1000));
  const pad = (value) => String(value).padStart(2, '0');
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

// Achata o apiUsage em uma linha por (API, modelo): a mesma API aparece varias
// vezes se estiver de castigo em mais de um modelo (ex.: 429 no Kimi e no Deepseek).
function penaltyRows(status) {
  const rows = [];
  (Array.isArray(status.apiUsage) ? status.apiUsage : []).forEach((item) => {
    const penalties = Array.isArray(item.penalties) && item.penalties.length
      ? item.penalties
      // Fallback para status antigo sem o array de penalties por modelo.
      : (item.resting && item.penaltyUntil
          ? [{ model: '', penaltyStartedAt: item.penaltyStartedAt, penaltyUntil: item.penaltyUntil }]
          : []);
    penalties.forEach((penalty) => {
      if (!penalty.penaltyUntil) return;
      rows.push({
        apiNumber: item.apiNumber,
        model: penalty.model || '',
        penaltyStartedAt: penalty.penaltyStartedAt,
        penaltyUntil: penalty.penaltyUntil,
        successesBefore429: Number(penalty.successesBefore429) || 0
      });
    });
  });
  return rows;
}

function renderPenalties(status) {
  const rows = penaltyRows(status);
  if (elements.penaltyBadge) {
    elements.penaltyBadge.textContent = String(rows.length);
    elements.penaltyBadge.classList.toggle('hidden', rows.length === 0);
  }
  if (elements.penaltyPathValue) {
    elements.penaltyPathValue.textContent = status.penaltyPath || '';
  }
  if (!elements.penaltyList) return;
  if (!rows.length) {
    elements.penaltyList.innerHTML =
      '<div class="terminal-empty">Nenhuma API de castigo agora.</div>';
    return;
  }
  const now = Date.now();
  const fragment = document.createDocumentFragment();
  rows
    .slice()
    .sort((a, b) => (a.penaltyUntil || 0) - (b.penaltyUntil || 0))
    .forEach((item) => {
      const row = document.createElement('div');
      row.className = 'penalty-row';
      const info = document.createElement('div');
      info.className = 'penalty-info';
      const title = document.createElement('strong');
      title.textContent = item.model ? `API ${item.apiNumber} · ${item.model}` : `API ${item.apiNumber}`;
      const sub = document.createElement('span');
      sub.className = 'penalty-sub';
      sub.textContent = item.penaltyStartedAt
        ? `entrou de castigo as ${new Date(item.penaltyStartedAt).toLocaleTimeString('pt-BR')}`
        : 'em castigo apos HTTP 429';
      const successes = document.createElement('span');
      successes.className = 'penalty-successes';
      successes.textContent = `${item.successesBefore429} resposta${item.successesBefore429 === 1 ? '' : 's'} HTTP 200 ate dar 429`;
      info.append(title, sub, successes);
      const countdown = document.createElement('span');
      countdown.className = 'penalty-countdown';
      countdown.textContent = formatCountdown(item.penaltyUntil - now);
      row.append(info, countdown);
      fragment.append(row);
    });
  elements.penaltyList.replaceChildren(fragment);
}

function openPenalty() {
  if (!elements.penaltyModal) return;
  renderPenalties(lastStatus);
  elements.penaltyModal.classList.remove('hidden');
}

function buildLogText(status) {
  const logs = Array.isArray(status.usageLog) ? status.usageLog : [];
  if (!logs.length) return '';
  return logs.map((entry) => {
    const time = new Date(entry.timestamp).toLocaleTimeString('pt-BR');
    const count = Number.isFinite(Number(entry.requestsThisMinute))
      ? ` [${entry.requestsThisMinute}/${status.limitPerKey}]`
      : '';
    return `[${time}] ${usageMessage(entry)}${count}`;
  }).join('\n');
}

function renderStatus(status) {
  lastStatus = status;
  const state = status.proxyState || 'stopped';
  elements.appVersion.textContent = `v${status.appVersion}`;
  elements.proxyStatus.className = `status-badge ${state}`;
  elements.proxyStatus.querySelector('.status-text').textContent = stateLabel(state);
  elements.vaultStatus.textContent = status.unlocked ? 'Desbloqueado' : 'Bloqueado';
  elements.vaultDetail.textContent = status.unlocked
    ? `${status.keyCount} API${status.keyCount === 1 ? '' : 's'} na memoria`
    : 'A senha nunca e salva';
  elements.serverStatus.textContent = state === 'error'
    ? 'Falha no gateway'
    : `${stateLabel(state)} na porta ${status.port}`;
  elements.rateLimitDetail.textContent = status.keyCount
    ? `${status.requestsThisMinute}/${status.capacityPerMinute} em janela movel; ${status.limitPerKey} por API; delay extra ${status.requestDelayMs} ms`
    : `35 RPM por API + delay extra de ${status.requestDelayMs ?? 0} ms`;
  if (document.activeElement !== elements.portInput) {
    elements.portInput.value = String(status.port);
  }
  if (document.activeElement !== elements.delayInput) {
    elements.delayInput.value = String(status.requestDelayMs ?? 0);
  }
  elements.startButton.disabled = !status.unlocked || !status.keyCount || state === 'running' || state === 'starting';
  elements.stopButton.disabled = state !== 'running';
  elements.configButton.disabled = !status.unlocked;
  elements.codexConfig.textContent = codexSnippet(status);
  elements.claudeConfig.textContent = claudeSnippet(status);
  elements.chatValue.textContent = status.chatEndpoint;
  elements.responsesValue.textContent = status.responsesEndpoint;
  elements.messagesValue.textContent = status.messagesEndpoint;
  elements.apiKeyValue.textContent = status.apiKey;
  elements.configPathValue.textContent = status.configPath;
  if (elements.selectedModelLabel) {
    const active = activeModelOf(status);
    elements.selectedModelLabel.textContent = status.autoToggle
      ? `${active} · auto`
      : (active || 'deepseek-ai/deepseek-v4-pro');
  }
  if (elements.selectModelButton) elements.selectModelButton.disabled = !status.unlocked;
  renderModelModal(status);
  renderUsageTerminal(status);
  renderPenalties(status);

  const message = state === 'error'
    ? status.proxyError
    : !status.unlocked
      ? 'Digite a senha para carregar as APIs criptografadas.'
      : !status.keyCount
        ? 'Cadastre suas APIs NVIDIA para iniciar o gateway.'
        : state === 'running'
          ? 'Gateway pronto para Codex CLI, Claude Code e clientes proprios.'
          : 'As APIs estao desbloqueadas apenas nesta sessao.';
  elements.messageLine.querySelector('span:last-child').textContent = message;
}

function addApiField(value = '', existingIndex = null) {
  const row = document.createElement('div');
  row.className = 'api-field-row';
  const input = document.createElement('input');
  input.type = 'password';
  input.placeholder = existingIndex === null
    ? 'nvapi-...'
    : `API salva ${existingIndex + 1} - deixe vazio para manter`;
  input.autocomplete = 'off';
  input.value = value;
  if (existingIndex !== null) input.dataset.existingIndex = String(existingIndex);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove-api';
  remove.textContent = 'Remover';
  remove.addEventListener('click', () => row.remove());
  row.append(input, remove);
  elements.apiFields.append(row);
}

/* ----- Modal de selecao de modelo ----- */
let selectingModel = false;
let busyModels = false; // evita cliques concorrentes em editar/reordenar/adicionar
let modelGridSignature = ''; // so reconstroi o grid quando catalogo/prioridade/modo muda

// Modelo realmente em uso: no modo automatico e o activeModel; no manual, o fixo.
function activeModelOf(status) {
  const value = status.autoToggle ? status.activeModel : status.selectedModel;
  return (value || '').trim();
}

function catalogOf(status) {
  return Array.isArray(status.modelCatalog) ? status.modelCatalog : [];
}

function priorityOf(status) {
  return Array.isArray(status.modelPriority) ? status.modelPriority : [];
}

// Devolve as entradas do catalogo na ORDEM da lista de prioridades (modelos fora da
// prioridade vao para o fim). E nesta ordem que o grid e desenhado.
function orderedEntries(status) {
  const byId = new Map(catalogOf(status).map((entry) => [entry.model, entry]));
  const ordered = [];
  priorityOf(status).forEach((id) => {
    if (byId.has(id)) {
      ordered.push(byId.get(id));
      byId.delete(id);
    }
  });
  byId.forEach((entry) => ordered.push(entry));
  return ordered;
}

// Persiste catalogo + prioridade no backend e re-renderiza com o status retornado.
async function persistModels(catalog, priority) {
  if (busyModels) return;
  busyModels = true;
  try {
    const status = await bridge.updateModels({ catalog, priority });
    renderStatus(status);
  } catch (error) {
    elements.messageLine.querySelector('span:last-child').textContent =
      error?.message || 'Nao foi possivel salvar os modelos.';
  } finally {
    busyModels = false;
  }
}

// Liga o botao de teste de um card ao backend (gera uma calculadora e mede o tempo).
function wireTestButton(test, result, model) {
  test.addEventListener('click', async () => {
    test.disabled = true;
    result.hidden = false;
    result.className = 'model-result pending';
    const startedAt = Date.now();
    const tick = () => {
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      result.textContent = `Gerando calculadora... ${seconds}s`;
    };
    tick();
    const liveTimer = setInterval(tick, 100);
    try {
      const outcome = await bridge.testModel(model);
      clearInterval(liveTimer);
      if (outcome && outcome.ok) {
        result.className = 'model-result ok';
        result.replaceChildren();
        const head = document.createElement('div');
        head.className = 'model-result-head';
        const status = document.createElement('span');
        const tokenInfo = Number(outcome.totalTokens) > 0
          ? `, consumindo ${outcome.totalTokens} tokens`
          : '';
        status.textContent = `Respondeu em ${formatElapsed(outcome.elapsedMs)}${tokenInfo}`;
        head.append(status);
        if (outcome.reply) {
          const copyReply = document.createElement('button');
          copyReply.type = 'button';
          copyReply.className = 'model-copy-reply';
          copyReply.textContent = 'Copiar resposta';
          copyReply.addEventListener('click', async () => {
            await bridge.copy(outcome.reply);
            copyReply.textContent = 'Copiado';
            copyReply.classList.add('copied');
            setTimeout(() => {
              copyReply.textContent = 'Copiar resposta';
              copyReply.classList.remove('copied');
            }, 1200);
          });
          head.append(copyReply);
        }
        result.append(head);
        if (outcome.reply) {
          const reply = document.createElement('pre');
          reply.className = 'model-result-reply';
          reply.textContent = outcome.reply;
          result.append(reply);
        }
      } else {
        result.className = 'model-result fail';
        const elapsed = outcome && outcome.elapsedMs ? ` (${formatElapsed(outcome.elapsedMs)})` : '';
        result.textContent = `Falhou${elapsed}: ${(outcome && outcome.error) || 'sem resposta'}`;
      }
    } catch (error) {
      clearInterval(liveTimer);
      result.className = 'model-result fail';
      result.textContent = `Falhou: ${error?.message || 'erro desconhecido'}`;
    } finally {
      test.disabled = false;
    }
  });
}

// Formulario inline de edicao (nome + provider/modelo) dentro do card.
function buildEditForm(entry, status) {
  const form = document.createElement('form');
  form.className = 'model-edit-form hidden';

  const nameLabel = document.createElement('label');
  nameLabel.className = 'field-label';
  nameLabel.textContent = 'Nome do modelo';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = entry.label;

  const idLabel = document.createElement('label');
  idLabel.className = 'field-label';
  idLabel.textContent = 'provider/modelo';
  const idInput = document.createElement('input');
  idInput.type = 'text';
  idInput.value = entry.model;

  const error = document.createElement('div');
  error.className = 'form-error';

  const actions = document.createElement('div');
  actions.className = 'add-model-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'button ghost';
  cancel.textContent = 'Cancelar';
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'button primary';
  save.textContent = 'Salvar';
  actions.append(cancel, save);

  form.append(nameLabel, nameInput, idLabel, idInput, error, actions);

  cancel.addEventListener('click', () => form.classList.add('hidden'));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const label = nameInput.value.trim();
    const model = idInput.value.trim();
    if (!model) {
      error.textContent = 'Informe o provider/modelo.';
      return;
    }
    const duplicated = catalogOf(status)
      .some((other) => other.model !== entry.model && other.model === model);
    if (duplicated) {
      error.textContent = 'Ja existe um modelo com esse provider/modelo.';
      return;
    }
    const catalog = catalogOf(status).map((other) => other.model === entry.model
      ? { label: label || model, model, icon: other.icon }
      : other);
    const priority = priorityOf(status).map((id) => (id === entry.model ? model : id));
    persistModels(catalog, priority);
  });

  return form;
}

// Constroi o grid de modelos na ordem de prioridade. No modo automatico mostra
// numero de prioridade + setas de reordenar; no manual mostra o toggle de escolha.
function buildModelGrid(status) {
  const fragment = document.createDocumentFragment();
  const ordered = orderedEntries(status);
  const auto = Boolean(status.autoToggle);
  const current = activeModelOf(status);
  const canRemove = catalogOf(status).length > 1;

  ordered.forEach((entry, index) => {
    const isActive = entry.model === current;
    const card = document.createElement('div');
    card.className = 'model-card' + (isActive ? ' active' : '');
    card.dataset.model = entry.model;

    const head = document.createElement('div');
    head.className = 'model-card-head';

    const icon = document.createElement('span');
    icon.className = 'model-icon';
    if (modelIcons) modelIcons.renderInto(icon, entry.icon, entry.label);

    const name = document.createElement('div');
    name.className = 'model-card-name';
    const strong = document.createElement('strong');
    strong.textContent = entry.label;
    const code = document.createElement('span');
    code.textContent = entry.model;
    const tag = document.createElement('span');
    tag.className = 'model-active-tag';
    tag.textContent = 'Em uso';
    tag.hidden = !isActive;
    name.append(strong, code, tag);
    head.append(icon, name);

    if (auto) {
      // Modo automatico: numero da prioridade + setas para reordenar.
      const rank = document.createElement('div');
      rank.className = 'model-rank';
      const badge = document.createElement('span');
      badge.className = 'model-rank-badge';
      badge.textContent = String(index + 1);
      const arrows = document.createElement('div');
      arrows.className = 'model-rank-arrows';
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'rank-arrow';
      up.textContent = '▲';
      up.title = 'Subir prioridade';
      up.disabled = index === 0;
      const down = document.createElement('button');
      down.type = 'button';
      down.className = 'rank-arrow';
      down.textContent = '▼';
      down.title = 'Descer prioridade';
      down.disabled = index === ordered.length - 1;
      arrows.append(up, down);
      rank.append(badge, arrows);
      head.append(rank);

      const reorder = (delta) => {
        const priority = ordered.map((item) => item.model);
        const target = index + delta;
        if (target < 0 || target >= priority.length) return;
        [priority[index], priority[target]] = [priority[target], priority[index]];
        persistModels(catalogOf(status), priority);
      };
      up.addEventListener('click', () => reorder(-1));
      down.addEventListener('click', () => reorder(1));
    } else {
      // Modo manual: toggle de escolha do modelo fixo de redirecionamento.
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'model-toggle toggle' + (isActive ? ' on' : '');
      toggle.setAttribute('role', 'switch');
      toggle.setAttribute('aria-checked', isActive ? 'true' : 'false');
      toggle.setAttribute('aria-label', `Usar ${entry.label}`);
      toggle.innerHTML = '<span class="toggle-track"><span class="toggle-thumb"></span></span>';
      toggle.addEventListener('click', async () => {
        if (selectingModel || toggle.classList.contains('on')) return;
        selectingModel = true;
        try {
          renderStatus(await bridge.selectModel(entry.model));
        } catch (error) {
          elements.messageLine.querySelector('span:last-child').textContent =
            error?.message || 'Nao foi possivel selecionar o modelo.';
        } finally {
          selectingModel = false;
        }
      });
      head.append(toggle);
    }

    const actions = document.createElement('div');
    actions.className = 'model-card-actions';
    const test = document.createElement('button');
    test.type = 'button';
    test.className = 'model-test';
    test.textContent = 'Testar';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'model-edit';
    edit.textContent = 'Editar';
    actions.append(test, edit);
    if (canRemove) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'model-remove';
      remove.textContent = 'Remover';
      remove.addEventListener('click', () => {
        const catalog = catalogOf(status).filter((other) => other.model !== entry.model);
        const priority = priorityOf(status).filter((id) => id !== entry.model);
        persistModels(catalog, priority);
      });
      actions.append(remove);
    }

    const editForm = buildEditForm(entry, status);
    edit.addEventListener('click', () => editForm.classList.toggle('hidden'));

    const result = document.createElement('div');
    result.className = 'model-result';
    result.hidden = true;
    wireTestButton(test, result, entry.model);

    card.append(head, actions, editForm, result);
    fragment.append(card);
  });

  elements.modelGrid.replaceChildren(fragment);
}

// Re-renderiza o modal de modelo a partir do status. So reconstroi o grid quando a
// assinatura (catalogo + prioridade + modo + modelo ativo) realmente muda, para nao
// perder resultados de teste em aberto a cada tick de status.
function renderModelModal(status) {
  if (!elements.modelGrid) return;
  const auto = Boolean(status.autoToggle);
  if (elements.autoToggleSwitch) {
    elements.autoToggleSwitch.classList.toggle('on', auto);
    elements.autoToggleSwitch.setAttribute('aria-checked', auto ? 'true' : 'false');
    elements.autoToggleSwitch.disabled = !status.unlocked;
  }
  if (elements.selectModeHint) {
    elements.selectModeHint.textContent = auto
      ? 'Modo automatico: arraste a prioridade com as setas. O proxy usa sempre o primeiro modelo da lista com alguma API livre e desce a lista quando todas tomam 429, voltando ao topo assim que liberar.'
      : 'Ligue o toggle do modelo que o proxy deve usar. So um fica ligado por vez. Use "Testar" para mandar um prompt complexo e medir o tempo de resposta.';
  }
  const signature = JSON.stringify({
    auto,
    active: activeModelOf(status),
    selected: status.selectedModel,
    catalog: catalogOf(status),
    priority: priorityOf(status)
  });
  if (signature !== modelGridSignature) {
    modelGridSignature = signature;
    buildModelGrid(status);
  }
}

function openSelect() {
  renderModelModal(lastStatus);
  elements.selectModal.classList.remove('hidden');
}

function openConfig() {
  if (!elements.apiFields.children.length) {
    const fieldCount = Math.max(lastStatus.keyCount || 0, 3);
    for (let index = 0; index < fieldCount; index++) {
      addApiField('', index < lastStatus.keyCount ? index : null);
    }
  }
  elements.configModal.classList.remove('hidden');
}

elements.unlockForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  elements.unlockError.textContent = '';
  try {
    const status = await bridge.unlock(elements.passwordInput.value);
    elements.passwordInput.value = '';
    elements.unlockModal.classList.add('hidden');
    renderStatus(status);
    if (!status.keyCount) openConfig();
  } catch (error) {
    elements.unlockError.textContent = error?.message || 'Nao foi possivel desbloquear.';
  }
});

elements.configButton.addEventListener('click', openConfig);
elements.closeConfigButton.addEventListener('click', () => elements.configModal.classList.add('hidden'));
elements.addApiButton.addEventListener('click', () => addApiField());
elements.configForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  elements.configError.textContent = '';
  const apiKeys = [...elements.apiFields.querySelectorAll('input')].map((input) => ({
    value: input.value.trim(),
    existingIndex: input.dataset.existingIndex === undefined
      ? null
      : Number(input.dataset.existingIndex)
  }));
  try {
    const status = await bridge.saveConfig({
      apiKeys,
      port: Number(elements.portInput.value),
      requestDelayMs: Number(elements.delayInput.value)
    });
    [...elements.apiFields.querySelectorAll('input')].forEach((input) => { input.value = ''; });
    elements.apiFields.replaceChildren();
    elements.configModal.classList.add('hidden');
    renderStatus(status);
  } catch (error) {
    elements.configError.textContent = error?.message || 'Nao foi possivel salvar.';
  }
});

if (elements.selectModelButton) elements.selectModelButton.addEventListener('click', openSelect);
if (elements.closeSelectButton) {
  elements.closeSelectButton.addEventListener('click', () => elements.selectModal.classList.add('hidden'));
}

// Liga/desliga a alternancia automatica de modelo.
if (elements.autoToggleSwitch) {
  elements.autoToggleSwitch.addEventListener('click', async () => {
    if (busyModels) return;
    busyModels = true;
    try {
      renderStatus(await bridge.setAutoToggle(!lastStatus.autoToggle));
    } catch (error) {
      elements.messageLine.querySelector('span:last-child').textContent =
        error?.message || 'Nao foi possivel alternar o modo automatico.';
    } finally {
      busyModels = false;
    }
  });
}

// Mostra/esconde o formulario de adicionar modelo.
if (elements.addModelButton) {
  elements.addModelButton.addEventListener('click', () => {
    elements.addModelForm.classList.toggle('hidden');
    if (!elements.addModelForm.classList.contains('hidden')) {
      elements.addModelError.textContent = '';
      elements.addModelName.focus();
    }
  });
}
if (elements.cancelAddModelButton) {
  elements.cancelAddModelButton.addEventListener('click', () => {
    elements.addModelForm.classList.add('hidden');
    elements.addModelName.value = '';
    elements.addModelId.value = '';
    elements.addModelError.textContent = '';
  });
}
if (elements.addModelForm) {
  elements.addModelForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    elements.addModelError.textContent = '';
    const label = elements.addModelName.value.trim();
    const model = elements.addModelId.value.trim();
    if (!label || !model) {
      elements.addModelError.textContent = 'Preencha o nome e o provider/modelo.';
      return;
    }
    if (catalogOf(lastStatus).some((entry) => entry.model === model)) {
      elements.addModelError.textContent = 'Esse provider/modelo ja esta na lista.';
      return;
    }
    // Novo modelo entra no catalogo (icone vazio = placeholder com a 1a letra) e no
    // FIM da fila de prioridades; pode ser reordenado depois.
    const catalog = [...catalogOf(lastStatus), { label, model, icon: '' }];
    const priority = [...priorityOf(lastStatus), model];
    elements.addModelName.value = '';
    elements.addModelId.value = '';
    elements.addModelForm.classList.add('hidden');
    await persistModels(catalog, priority);
  });
}
if (elements.penaltyButton) elements.penaltyButton.addEventListener('click', openPenalty);
if (elements.copyLogButton) {
  elements.copyLogButton.addEventListener('click', async () => {
    const text = buildLogText(lastStatus);
    if (!text) return;
    await bridge.copy(text);
    const original = elements.copyLogButton.textContent;
    elements.copyLogButton.textContent = 'Copiado';
    setTimeout(() => { elements.copyLogButton.textContent = original; }, 1000);
  });
}
if (elements.closePenaltyButton) {
  elements.closePenaltyButton.addEventListener('click', () => elements.penaltyModal.classList.add('hidden'));
}
setInterval(() => {
  if (elements.penaltyModal && !elements.penaltyModal.classList.contains('hidden')) {
    renderPenalties(lastStatus);
  }
}, 1000);

elements.startButton.addEventListener('click', async () => renderStatus(await bridge.startProxy()));
elements.stopButton.addEventListener('click', async () => renderStatus(await bridge.stopProxy()));
elements.savePortButton.addEventListener('click', async () => {
  try {
    renderStatus(await bridge.savePort(elements.portInput.value));
  } catch (error) {
    elements.messageLine.querySelector('span:last-child').textContent = error?.message || 'Porta invalida.';
  }
});
elements.saveDelayButton.addEventListener('click', async () => {
  try {
    renderStatus(await bridge.saveDelay(elements.delayInput.value));
  } catch (error) {
    elements.messageLine.querySelector('span:last-child').textContent = error?.message || 'Delay invalido.';
  }
});

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((item) => item.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.remove('active'));
  tab.classList.add('active');
  document.querySelector(`[data-panel="${tab.dataset.tab}"]`).classList.add('active');
}));
document.querySelectorAll('[data-copy-target]').forEach((button) => button.addEventListener('click', async () => {
  await bridge.copy(byId(button.dataset.copyTarget).textContent);
  const original = button.textContent;
  button.textContent = 'Copiado';
  setTimeout(() => { button.textContent = original; }, 1000);
}));

bridge.onStatus(renderStatus);
bridge.getStatus().then((status) => {
  renderStatus(status);
  elements.unlockHint.textContent = status.hasConfig
    ? 'Use a senha criada quando as APIs foram salvas. Ela nao fica armazenada.'
    : 'Crie uma senha para criptografar suas APIs. Ela nao podera ser recuperada.';
});
