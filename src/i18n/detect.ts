import type { Locale } from './translations.ts';

// Detecta o idioma do SO e mapeia para um dos 5 suportados.
// Se nao conseguir identificar ou nao estiver na lista, retorna 'en'.

let systemLocale: string | null = null;

// Permite que o main.ts do Electron injete o locale obtido via
// electronApp.getLocale() antes do primeiro uso.
export function setSystemLocale(value: string): void {
  systemLocale = value;
}

export function detectSystemLocale(): Locale {
  const raw = systemLocale ?? resolvePlatformLocale();
  return normalizeLocale(raw);
}

function resolvePlatformLocale(): string {
  // Node.js / terminal: tenta variaveis de ambiente comuns e o Intl.
  // No Windows, LANG geralmente nao existe, entao usamos Intl.
  if (process.env.LANG) return process.env.LANG;
  if (process.env.LC_ALL) return process.env.LC_ALL;
  if (process.env.LC_MESSAGES) return process.env.LC_MESSAGES;

  try {
    // Intl.DateTimeFormat fornece o locale do sistema no Windows.
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return 'en';
  }
}

function normalizeLocale(raw: string): Locale {
  const cleaned = raw.trim().toLowerCase().replace(/_/g, '-');

  // pt-BR
  if (cleaned.startsWith('pt')) return 'pt-BR';

  // de
  if (cleaned.startsWith('de')) return 'de';

  // ru
  if (cleaned.startsWith('ru')) return 'ru';

  // zh-CN (mandarim simplificado)
  if (cleaned.startsWith('zh')) {
    if (cleaned.includes('hant') || cleaned.includes('hk') || cleaned.includes('tw')) {
      return 'zh-CN'; // fallback: app so tem simplificado
    }
    return 'zh-CN';
  }

  // en (fallback para qualquer outro)
  return 'en';
}