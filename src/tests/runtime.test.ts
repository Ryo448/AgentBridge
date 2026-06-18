import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireApiKey,
  clearRuntimeConfig,
  getActiveModel,
  getEffectiveModel,
  isAutoToggleEnabled,
  markApiRateLimited,
  onApiKeyPenalized,
  pickAvailableModel,
  resolveAvailableModel,
  setApiPenaltyUntil,
  setAutoToggle,
  setModelPriority,
  getRuntimeStatus,
  onApiKeyUsed,
  pruneApiRequestLogs,
  RPM_PACING_INTERVAL_MS,
  setRuntimeConfig
} from '../services/runtime.ts';

test('runtime sticks to the current key until it is penalized, then advances', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['key-1', 'key-2', 'key-3'] });
  let now = 500_000;
  const options = {
    now: () => now,
    sleep: async (milliseconds: number) => {
      now += milliseconds;
    }
  };
  // Sem 429, o fluxo gruda na chave atual.
  assert.equal((await acquireApiKey(options)).apiKey, 'key-1');
  assert.equal((await acquireApiKey(options)).apiKey, 'key-1');
  // 429 na key-1 -> castigo de 1h e o fluxo segue a partir da key-2.
  markApiRateLimited({ apiNumber: 1, timestamp: now });
  assert.equal((await acquireApiKey(options)).apiKey, 'key-2');
  assert.equal((await acquireApiKey(options)).apiKey, 'key-2');
  // 429 na key-2 -> segue para a key-3.
  markApiRateLimited({ apiNumber: 2, timestamp: now });
  assert.equal((await acquireApiKey(options)).apiKey, 'key-3');
  clearRuntimeConfig();
});

test('runtime penalizes per model: 429 no Kimi nao bloqueia o Deepseek', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['key-1', 'key-2'] });
  let now = 500_000;
  const options = (model: string) => ({
    model,
    now: () => now,
    sleep: async (milliseconds: number) => {
      now += milliseconds;
    }
  });
  // Kimi gruda na key-1; ao tomar 429 no Kimi, a key-1 fica de castigo SO no Kimi.
  assert.equal((await acquireApiKey(options('kimi'))).apiKey, 'key-1');
  markApiRateLimited({ apiNumber: 1, model: 'kimi', timestamp: now });
  // Kimi agora segue na key-2 (key-1 de castigo no Kimi).
  assert.equal((await acquireApiKey(options('kimi'))).apiKey, 'key-2');
  // key-2 tambem leva 429 no Kimi -> nenhuma chave atende o Kimi.
  markApiRateLimited({ apiNumber: 2, model: 'kimi', timestamp: now });
  await assert.rejects(() => acquireApiKey(options('kimi')), /castigo/);

  // O Deepseek nao foi penalizado em nenhuma chave: continua elegivel, sem cooldown
  // por causa da troca de modelo. A chave 1 segue chamavel no Deepseek.
  assert.equal((await acquireApiKey(options('deepseek'))).apiKey, 'key-1');

  // A mesma API pode acumular castigo em mais de um modelo (Kimi + Deepseek).
  markApiRateLimited({ apiNumber: 1, model: 'deepseek', timestamp: now });
  const api1 = getRuntimeStatus(now).apiUsage[0];
  assert.equal(api1.resting, true);
  assert.equal(api1.penalties.length, 2);
  assert.deepEqual(api1.penalties.map((p) => p.model).sort(), ['deepseek', 'kimi']);
  clearRuntimeConfig();
});

test('runtime throws AllKeysRestingError when every key is in penalty', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['key-1', 'key-2'] });
  let now = 500_000;
  const options = {
    now: () => now,
    sleep: async (milliseconds: number) => {
      now += milliseconds;
    }
  };
  markApiRateLimited({ apiNumber: 1, timestamp: now });
  markApiRateLimited({ apiNumber: 2, timestamp: now });
  await assert.rejects(() => acquireApiKey(options), /castigo/);
  // Uma hora depois a primeira chave volta a ficar disponivel.
  now += 60 * 60_000 + 1;
  assert.equal((await acquireApiKey(options)).apiKey, 'key-1');
  clearRuntimeConfig();
});

test('runtime emits penalty events and restores penalties from disk', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['key-1', 'key-2'] });
  const events: Array<{ apiNumber: number; penaltyUntil: number }> = [];
  const unsubscribe = onApiKeyPenalized((event) =>
    events.push({ apiNumber: event.apiNumber, penaltyUntil: event.penaltyUntil })
  );
  const now = Date.now();
  markApiRateLimited({ apiNumber: 1, timestamp: now });
  assert.equal(events.length, 1);
  assert.equal(events[0].apiNumber, 1);
  assert.ok(events[0].penaltyUntil > now);
  const status = getRuntimeStatus(now);
  assert.equal(status.apiUsage[0].resting, true);
  assert.equal(status.apiUsage[0].penaltyStartedAt, now);
  unsubscribe();
  clearRuntimeConfig();

  // Restauracao no arranque: castigo ainda valido volta; castigo expirado e ignorado.
  setRuntimeConfig({ apiKeys: ['key-1'] });
  setApiPenaltyUntil(1, Date.now() + 60 * 60_000, Date.now());
  assert.equal(getRuntimeStatus().apiUsage[0].resting, true);
  clearRuntimeConfig();

  setRuntimeConfig({ apiKeys: ['key-1'] });
  setApiPenaltyUntil(1, Date.now() - 1000);
  assert.equal(getRuntimeStatus().apiUsage[0].resting, false);
  clearRuntimeConfig();
});

test('runtime keeps all traffic on the current key and respects 35 RPM', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['key-1', 'key-2'] });
  let now = 120_000;
  const sleepCalls: number[] = [];
  const options = {
    now: () => now,
    sleep: async (milliseconds: number) => {
      sleepCalls.push(milliseconds);
      now += milliseconds;
    }
  };

  // Sticky: sem 429, todo o trafego fica na key-1 e a key-2 espera a vez dela.
  const reservations = [];
  for (let index = 0; index < 70; index++) {
    reservations.push(await acquireApiKey(options));
  }
  assert.equal(reservations.filter((item) => item.apiKey === 'key-1').length, 70);
  assert.equal(reservations.filter((item) => item.apiKey === 'key-2').length, 0);
  // O limite de 35 RPM por chave continua sendo respeitado como protecao.
  assert.ok(reservations.every((item) => item.requestsThisMinute <= 35));
  // O pacing fino nunca espera mais que um intervalo; a unica espera maior e a
  // reabertura da janela de RPM quando os 35 sao atingidos.
  const pacingSleeps = sleepCalls.filter((milliseconds) => milliseconds <= RPM_PACING_INTERVAL_MS);
  assert.ok(pacingSleeps.length > 0);
});

test('runtime keeps RPM window anchored after the wall-clock minute changes', async () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['key-1'] });
  let now = 59_500;
  const options = {
    now: () => now,
    sleep: async (milliseconds: number) => {
      now += milliseconds;
    }
  };

  await acquireApiKey(options);
  now = 60_100;
  const second = await acquireApiKey(options);
  const status = getRuntimeStatus(now);

  assert.equal(second.requestsThisMinute, 2);
  assert.equal(status.requestsThisMinute, 2);
  assert.equal(status.apiUsage[0].resetsAt, 119_500);
  clearRuntimeConfig();
});

test('runtime preserves usage for unchanged keys when config is saved again', async () => {
  clearRuntimeConfig();
  let now = 180_000;
  const options = {
    now: () => now,
    sleep: async (milliseconds: number) => {
      now += milliseconds;
    }
  };
  setRuntimeConfig({ apiKeys: ['key-1', 'key-1'] });
  await acquireApiKey(options);
  setRuntimeConfig({ apiKeys: ['key-1'], port: 4000 });

  const status = getRuntimeStatus(now);
  assert.equal(status.keyCount, 1);
  assert.equal((await acquireApiKey(options)).requestsThisMinute, 2);
  clearRuntimeConfig();
});

test('runtime stores configurable request delay with zero ms fallback', () => {
  clearRuntimeConfig();
  setRuntimeConfig({ apiKeys: ['key-1'] });
  assert.equal(getRuntimeStatus().requestDelayMs, 0);

  setRuntimeConfig({ apiKeys: ['key-1'], requestDelayMs: 0 });
  assert.equal(getRuntimeStatus().requestDelayMs, 0);
  clearRuntimeConfig();
});

test('runtime reports current-minute usage and which API was selected', async () => {
  clearRuntimeConfig();
  const events: Array<{ apiNumber: number; totalRequestsThisMinute: number }> = [];
  const unsubscribe = onApiKeyUsed((event) => events.push(event));
  let now = 240_000;
  const options = {
    now: () => now,
    sleep: async (milliseconds: number) => {
      now += milliseconds;
    }
  };
  setRuntimeConfig({ apiKeys: ['key-1', 'key-2'] });

  await acquireApiKey(options);
  await acquireApiKey(options);
  await acquireApiKey(options);

  const status = getRuntimeStatus(now);
  assert.equal(status.requestsThisMinute, 3);
  assert.deepEqual(status.apiUsage.map((item) => item.requestsThisMinute), [3, 0]);
  assert.deepEqual(
    events.map((event) => [event.apiNumber, event.totalRequestsThisMinute]),
    [[1, 1], [1, 2], [1, 3]]
  );

  unsubscribe();
  clearRuntimeConfig();
});

test('auto: getEffectiveModel volta para o topo da prioridade quando ele libera', () => {
  clearRuntimeConfig();
  const priority = ['pro', 'kimi', 'flash', 'nemotron'];
  setRuntimeConfig({ apiKeys: ['key-1', 'key-2'], autoToggle: true, modelPriority: priority });
  const now = 800_000;

  // Sem castigo: usa o modelo de maior prioridade.
  assert.equal(getEffectiveModel(now), 'pro');

  // Todas as chaves de castigo no 'pro' -> cai para o 'kimi'.
  markApiRateLimited({ apiNumber: 1, model: 'pro', timestamp: now });
  markApiRateLimited({ apiNumber: 2, model: 'pro', timestamp: now });
  assert.equal(pickAvailableModel([], now), 'kimi');
  assert.equal(getEffectiveModel(now), 'kimi');
  assert.equal(getActiveModel(), 'kimi');

  // 'kimi' tambem satura -> 'flash'. 'pro' segue saturado.
  markApiRateLimited({ apiNumber: 1, model: 'kimi', timestamp: now });
  markApiRateLimited({ apiNumber: 2, model: 'kimi', timestamp: now });
  assert.equal(getEffectiveModel(now), 'flash');

  // Uma hora depois o 'pro' libera: a proxima request volta para ele (reavaliacao
  // do topo a cada chamada).
  const later = now + 60 * 60_000 + 1;
  assert.equal(getEffectiveModel(later), 'pro');
  clearRuntimeConfig();
});

test('auto: resolveAvailableModel pula os modelos ja esgotados (failover na request)', () => {
  clearRuntimeConfig();
  setRuntimeConfig({
    apiKeys: ['key-1'],
    autoToggle: true,
    modelPriority: ['pro', 'kimi', 'flash']
  });
  const now = 900_000;
  // Esgotou 'pro' e 'kimi' na request atual: o resolvedor entrega 'flash'.
  assert.equal(resolveAvailableModel(['pro', 'kimi'], now), 'flash');
  // Esgotou todos: nao ha para onde correr -> null (proxy devolve 429).
  assert.equal(resolveAvailableModel(['pro', 'kimi', 'flash'], now), null);
  clearRuntimeConfig();
});

test('auto: modo manual ignora a lista de prioridades e usa o modelo fixo', () => {
  clearRuntimeConfig();
  setRuntimeConfig({
    apiKeys: ['key-1'],
    selectedModel: 'meu-fixo',
    autoToggle: false,
    modelPriority: ['pro', 'kimi']
  });
  assert.equal(isAutoToggleEnabled(), false);
  assert.equal(getEffectiveModel(1_000_000), 'meu-fixo');

  // Ligar o auto passa a usar a lista de prioridades.
  setAutoToggle(true);
  setModelPriority(['pro', 'kimi']);
  assert.equal(getEffectiveModel(1_000_000), 'pro');
  clearRuntimeConfig();
});

test('runtime prunes API request logs after the third minute', () => {
  const now = 1_000_000;
  const logs = [
    { timestamp: now - 180_001, type: 'called' },
    { timestamp: now - 180_000, type: 'started' },
    { timestamp: now - 1_000, type: 'completed' }
  ];

  assert.deepEqual(
    pruneApiRequestLogs(logs, now).map((entry) => entry.type),
    ['started', 'completed']
  );
});
