import readline from 'node:readline';
import { c, screen, padEndVisible, visibleLength } from './theme.ts';

// Camada de interacao da TUI: cuida do raw-mode do stdin, dispatch de teclas e
// dos componentes bloqueantes (menu por setas, prompt de texto, senha mascarada,
// confirmacao). Tudo desenha a tela inteira a cada frame para evitar artefatos.

export type Key = {
  name: string;
  sequence: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  str: string;
};

type KeyHandler = (key: Key) => void;

let currentHandler: KeyHandler | null = null;
let onExit: (() => void) | null = null;
let started = false;

export function startInput(exit: () => void): void {
  if (started) return;
  started = true;
  onExit = exit;
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('keypress', (str: string, key: readline.Key | undefined) => {
    const normalized: Key = {
      name: key?.name || '',
      sequence: key?.sequence || str || '',
      ctrl: Boolean(key?.ctrl),
      meta: Boolean(key?.meta),
      shift: Boolean(key?.shift),
      str: typeof str === 'string' ? str : ''
    };
    // Ctrl+C encerra de forma limpa, nao importa a tela ativa.
    if (normalized.ctrl && normalized.name === 'c') {
      onExit?.();
      return;
    }
    currentHandler?.(normalized);
  });
}

export function stopInput(): void {
  if (!started) return;
  started = false;
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write(screen.showCursor);
}

export function setKeyHandler(handler: KeyHandler | null): void {
  currentHandler = handler;
}

export function getSize(): { cols: number; rows: number } {
  return {
    cols: Math.max(64, process.stdout.columns || 96),
    rows: Math.max(20, process.stdout.rows || 30)
  };
}

// Desenha um frame completo: esconde cursor, limpa e escreve as linhas.
export function drawFrame(lines: string[]): void {
  process.stdout.write(screen.hideCursor + screen.clear + lines.join('\n'));
}

// Espera uma unica tecla (usado pelo loop do dashboard junto de um timer).
export function readKey(): Promise<Key> {
  return new Promise((resolve) => {
    const prev = currentHandler;
    setKeyHandler((key) => {
      setKeyHandler(prev);
      resolve(key);
    });
  });
}

function isEnter(key: Key) {
  return key.name === 'return' || key.name === 'enter';
}
function isEscape(key: Key) {
  return key.name === 'escape';
}
function isPrintable(key: Key) {
  return (
    !key.ctrl &&
    !key.meta &&
    key.str.length === 1 &&
    key.str.charCodeAt(0) >= 0x20 &&
    key.str.charCodeAt(0) !== 0x7f
  );
}

export type MenuItem<T> = {
  label: string;
  value: T;
  hint?: string;
  disabled?: boolean;
};

// Menu vertical com navegacao por setas (ou j/k), Enter seleciona, Esc cancela.
// `header` sao linhas ja estilizadas mostradas acima da lista. Devolve o value
// escolhido ou null (Esc).
export function selectMenu<T>(options: {
  header: string[];
  items: MenuItem<T>[];
  footer?: string;
  initialIndex?: number;
  allowEscape?: boolean;
}): Promise<T | null> {
  const items = options.items;
  let index = options.initialIndex ?? 0;
  // Comeca em um item habilitado.
  if (items[index]?.disabled) {
    const firstEnabled = items.findIndex((item) => !item.disabled);
    if (firstEnabled >= 0) index = firstEnabled;
  }

  return new Promise((resolve) => {
    const render = () => {
      const lines = [...options.header, ''];
      items.forEach((item, i) => {
        const selected = i === index;
        const pointer = selected ? c.accent('  ❯ ') : '    ';
        let label = item.label;
        if (item.disabled) label = c.faint(label);
        else if (selected) label = c.bold(c.text(label));
        else label = c.text(label);
        let line = pointer + label;
        if (item.hint) line += '  ' + c.faint(item.hint);
        lines.push(line);
      });
      lines.push('');
      lines.push(
        options.footer ||
          c.faint('  ↑/↓ navegar · Enter selecionar' + (options.allowEscape !== false ? ' · Esc voltar' : ''))
      );
      drawFrame(lines);
    };

    const move = (delta: number) => {
      const total = items.length;
      let next = index;
      for (let step = 0; step < total; step++) {
        next = (next + delta + total) % total;
        if (!items[next].disabled) break;
      }
      index = next;
      render();
    };

    setKeyHandler((key) => {
      if (key.name === 'up' || key.str === 'k') move(-1);
      else if (key.name === 'down' || key.str === 'j') move(1);
      else if (isEnter(key)) {
        const item = items[index];
        if (item && !item.disabled) {
          setKeyHandler(null);
          resolve(item.value);
        }
      } else if (isEscape(key) && options.allowEscape !== false) {
        setKeyHandler(null);
        resolve(null);
      }
    });
    render();
  });
}

// Prompt de texto com edicao de linha. `mask` troca os caracteres por • (senha).
// Enter confirma, Esc cancela (resolve null). `validate` retorna mensagem de erro
// ou null. Mantem o foco apos erro.
export function promptText(options: {
  header: string[];
  label: string;
  mask?: boolean;
  initial?: string;
  placeholder?: string;
  footer?: string;
  allowEmpty?: boolean;
  validate?: (value: string) => string | null;
}): Promise<string | null> {
  let value = options.initial ?? '';
  let error = '';

  return new Promise((resolve) => {
    const render = () => {
      const lines = [...options.header, ''];
      lines.push('  ' + c.muted(options.label));
      const shown = options.mask ? '•'.repeat(value.length) : value;
      const field =
        value.length === 0 && options.placeholder
          ? c.faint(options.placeholder)
          : c.text(shown) + c.accent('▏');
      const inner = padEndVisible(field, 52);
      lines.push('  ' + c.accent('▎ ') + inner);
      if (error) lines.push('  ' + c.red(error));
      else lines.push('');
      lines.push('');
      lines.push(options.footer || c.faint('  Enter confirmar · Esc cancelar'));
      drawFrame(lines);
    };

    setKeyHandler((key) => {
      if (isEnter(key)) {
        const trimmed = value;
        if (!options.allowEmpty && trimmed.trim().length === 0) {
          error = 'Nao pode ficar vazio.';
          render();
          return;
        }
        if (options.validate) {
          const message = options.validate(trimmed);
          if (message) {
            error = message;
            render();
            return;
          }
        }
        setKeyHandler(null);
        resolve(trimmed);
      } else if (isEscape(key)) {
        setKeyHandler(null);
        resolve(null);
      } else if (key.name === 'backspace') {
        value = value.slice(0, -1);
        error = '';
        render();
      } else if (key.ctrl && key.name === 'u') {
        value = '';
        error = '';
        render();
      } else if (isPrintable(key)) {
        value += key.str;
        error = '';
        render();
      }
    });
    render();
  });
}

// Confirmacao y/n. Default configuravel. Esc = default.
export function confirm(options: {
  header: string[];
  question: string;
  defaultYes?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const lines = [...options.header, ''];
    lines.push('  ' + c.text(options.question));
    lines.push('');
    lines.push(
      '  ' +
        c.faint(options.defaultYes ? '[S/n]' : '[s/N]') +
        c.faint('  ·  Enter confirma')
    );
    drawFrame(lines);

    setKeyHandler((key) => {
      if (key.str === 's' || key.str === 'S' || key.str === 'y' || key.str === 'Y') {
        setKeyHandler(null);
        resolve(true);
      } else if (key.str === 'n' || key.str === 'N') {
        setKeyHandler(null);
        resolve(false);
      } else if (isEnter(key)) {
        setKeyHandler(null);
        resolve(Boolean(options.defaultYes));
      } else if (isEscape(key)) {
        setKeyHandler(null);
        resolve(Boolean(options.defaultYes));
      }
    });
  });
}

// Mostra uma tela informativa e espera qualquer tecla.
export function pause(options: { lines: string[]; footer?: string }): Promise<void> {
  return new Promise((resolve) => {
    drawFrame([
      ...options.lines,
      '',
      options.footer || c.faint('  Pressione qualquer tecla para voltar...')
    ]);
    setKeyHandler(() => {
      setKeyHandler(null);
      resolve();
    });
  });
}

// Util para montar uma linha "label: valor" alinhada.
export function field(label: string, value: string, labelWidth = 16): string {
  return '  ' + c.muted(padEndVisible(label, labelWidth)) + value;
}

export { visibleLength };
