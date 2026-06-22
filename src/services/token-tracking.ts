import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type ModelTokens = {
  inputTokens: number;
  outputTokens: number;
  totalCalls: number;
  recentInputTokens: number;
  recentOutputTokens: number;
  recentTimestamps: number[];
  recentInputAmounts: number[];
  recentOutputAmounts: number[];
};

export type UsedTokensFile = {
  updatedAt: string;
  models: Record<string, ModelTokens>;
  totalInputTokens: number;
  totalOutputTokens: number;
  recentTotalInputTokens: number;
  recentTotalOutputTokens: number;
};

const RECENT_WINDOW_MS = 30 * 60_000;

function emptyModel(): ModelTokens {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalCalls: 0,
    recentInputTokens: 0,
    recentOutputTokens: 0,
    recentTimestamps: [],
    recentInputAmounts: [],
    recentOutputAmounts: []
  };
}

function pruneRecent(state: ModelTokens, now = Date.now()): ModelTokens {
  const cutoff = now - RECENT_WINDOW_MS;
  let removedInput = 0;
  let removedOutput = 0;
  const keep: number[] = [];
  const keepInput: number[] = [];
  const keepOutput: number[] = [];
  for (let i = 0; i < state.recentTimestamps.length; i++) {
    if (state.recentTimestamps[i] >= cutoff) {
      keep.push(state.recentTimestamps[i]);
      keepInput.push(state.recentInputAmounts[i] || 0);
      keepOutput.push(state.recentOutputAmounts[i] || 0);
    } else {
      removedInput += state.recentInputAmounts[i] || 0;
      removedOutput += state.recentOutputAmounts[i] || 0;
    }
  }
  return {
    ...state,
    recentInputTokens: Math.max(0, (state.recentInputTokens || 0) - removedInput),
    recentOutputTokens: Math.max(0, (state.recentOutputTokens || 0) - removedOutput),
    recentTimestamps: keep,
    recentInputAmounts: keepInput,
    recentOutputAmounts: keepOutput
  };
}

export function readTokenUsage(filePath: string): UsedTokensFile {
  try {
    if (!existsSync(filePath)) return emptyUsage();
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as any;
    const now = Date.now();
    const models: Record<string, ModelTokens> = {};
    let totalInput = 0;
    let totalOutput = 0;
    let recentInput = 0;
    let recentOutput = 0;
    if (raw.models && typeof raw.models === 'object') {
      for (const [model, entry] of Object.entries(raw.models)) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as any;
        const pruned = pruneRecent({
          inputTokens: Number(e.inputTokens) || 0,
          outputTokens: Number(e.outputTokens) || 0,
          totalCalls: Number(e.totalCalls) || 0,
          recentInputTokens: Number(e.recentInputTokens || e.last24hInputTokens) || 0,
          recentOutputTokens: Number(e.recentOutputTokens || e.last24hOutputTokens) || 0,
          recentTimestamps: Array.isArray(e.recentTimestamps || e.last24hTimestamps) ? (e.recentTimestamps || e.last24hTimestamps) : [],
          recentInputAmounts: Array.isArray(e.recentInputAmounts || e.last24hInputAmounts) ? (e.recentInputAmounts || e.last24hInputAmounts) : [],
          recentOutputAmounts: Array.isArray(e.recentOutputAmounts || e.last24hOutputAmounts) ? (e.recentOutputAmounts || e.last24hOutputAmounts) : []
        }, now);
        models[model] = pruned;
        totalInput += pruned.inputTokens;
        totalOutput += pruned.outputTokens;
        recentInput += pruned.recentInputTokens;
        recentOutput += pruned.recentOutputTokens;
      }
    }
    return {
      updatedAt: new Date().toISOString(),
      models,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      recentTotalInputTokens: recentInput,
      recentTotalOutputTokens: recentOutput
    };
  } catch {
    return emptyUsage();
  }
}

function emptyUsage(): UsedTokensFile {
  return {
    updatedAt: new Date().toISOString(),
    models: {},
    totalInputTokens: 0,
    totalOutputTokens: 0,
    recentTotalInputTokens: 0,
    recentTotalOutputTokens: 0
  };
}

// ── Acumulador em memoria + debounce para evitar race condition ──

type PendingEntry = { model: string; inputTokens: number; outputTokens: number; now: number };

// Acumulador global: mapeia filePath -> array de entradas pendentes.
const pending = new Map<string, PendingEntry[]>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 2000;

function flush(filePath: string): void {
  timers.delete(filePath);
  const entries = pending.get(filePath);
  if (!entries || !entries.length) return;
  pending.set(filePath, []);
  try {
    const usage = readTokenUsage(filePath);
    for (const { model, inputTokens, outputTokens, now } of entries) {
      const entry = usage.models[model] || emptyModel();
      entry.inputTokens += inputTokens;
      entry.outputTokens += outputTokens;
      entry.totalCalls++;
      entry.recentInputTokens = (entry.recentInputTokens || 0) + inputTokens;
      entry.recentOutputTokens = (entry.recentOutputTokens || 0) + outputTokens;
      entry.recentTimestamps = entry.recentTimestamps || [];
      entry.recentInputAmounts = entry.recentInputAmounts || [];
      entry.recentOutputAmounts = entry.recentOutputAmounts || [];
      entry.recentTimestamps.push(now);
      entry.recentInputAmounts.push(inputTokens);
      entry.recentOutputAmounts.push(outputTokens);
      pruneRecent(entry, now);
      usage.models[model] = entry;
      usage.totalInputTokens += inputTokens;
      usage.totalOutputTokens += outputTokens;
    }
    usage.recentTotalInputTokens = Object.values(usage.models).reduce((sum, m) => sum + (m.recentInputTokens || 0), 0);
    usage.recentTotalOutputTokens = Object.values(usage.models).reduce((sum, m) => sum + (m.recentOutputTokens || 0), 0);
    usage.updatedAt = new Date().toISOString();
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(usage, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Tracking de tokens nao pode derrubar o proxy.
  }
}

export function recordTokenUsage(
  filePath: string,
  model: string,
  inputTokens: number,
  outputTokens: number
): void {
  try {
    const entry: PendingEntry = { model, inputTokens, outputTokens, now: Date.now() };
    const list = pending.get(filePath) || [];
    list.push(entry);
    pending.set(filePath, list);

    // Debounce: se ja tem timer, cancela e agenda de novo. Assim o flush so
    // roda depois que a ultima requisicao desta leva ficar quieta por 2s.
    const existing = timers.get(filePath);
    if (existing) clearTimeout(existing);
    timers.set(filePath, setTimeout(() => flush(filePath), DEBOUNCE_MS));
  } catch {
    // Tracking de tokens nao pode derrubar o proxy.
  }
}

// Forca o flush imediato (ex.: antes de ler o arquivo ou ao desligar).
export function flushTokenUsage(filePath: string): void {
  const existing = timers.get(filePath);
  if (existing) {
    clearTimeout(existing);
    flush(filePath);
  }
}