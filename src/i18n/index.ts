import type { Locale } from './translations.ts';
import { messages, SUPPORTED_LOCALES, LOCALE_LABELS, LOCALE_FLAGS } from './translations.ts';
import { detectSystemLocale } from './detect.ts';

// ---------------------------------------------------------------------------
// Estado global do i18n (singleton). A funcao t() e usada em todo o app.
// ---------------------------------------------------------------------------

let currentLocale: Locale = 'en';
let initialized = false;

export type { Locale } from './translations.ts';

// Metadados dos idiomas para UIs de selecao.
export interface LocaleOption {
  code: Locale;
  label: string;       // nome nativo (ex.: "Português (Brasil)")
  flag: string;        // bandeira emoji (ex.: "🇧🇷")
}

// Lista de idiomas exibida nos seletores (Electron e terminal).
export function availableLocales(): LocaleOption[] {
  return SUPPORTED_LOCALES.map((code) => ({
    code,
    label: LOCALE_LABELS[code],
    flag: LOCALE_FLAGS[code]
  }));
}

// Inicializa o locale: carrega do config salvo, ou detecta do SO.
// Chamado pelo vault/desktop/terminal depois que o config existe.
export function initLocale(savedLocale?: string | null): void {
  if (savedLocale && isLocale(savedLocale)) {
    currentLocale = savedLocale;
  } else {
    currentLocale = detectSystemLocale();
  }
  initialized = true;
}

// Forca um locale (chamado pelo seletor de idioma). Persiste no config
// via vault.saveConfig; o caller e responsavel pela persistencia.
export function setLocale(locale: Locale): void {
  currentLocale = locale;
  initialized = true;
}

// Retorna o locale atual (para persistir no config).
export function getLocale(): Locale {
  if (!initialized) initLocale();
  return currentLocale;
}

// Funcao de traducao. Substitui {chave} pelos valores em replacements.
export function t(key: string, replacements?: Record<string, string | number>): string {
  if (!initialized) initLocale();

  const map = messages[currentLocale];
  let value: string = map[key] ?? messages['en'][key] ?? key;

  if (replacements) {
    for (const [k, v] of Object.entries(replacements)) {
      value = value.replace(`{${k}}`, String(v));
    }
  }

  return value;
}

// Retorna o mapa inteiro de mensagens para o locale atual (usado pelo Electron
// para enviar ao renderer, que nao tem acesso ao i18n do backend diretamente).
export function getMessages(): Record<string, string> {
  if (!initialized) initLocale();
  return messages[currentLocale] ?? messages['en'];
}

function isLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}