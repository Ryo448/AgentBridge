import { spawn } from 'node:child_process';

// Copia texto para a area de transferencia sem dependencias externas.
//  - Windows: clip
//  - macOS:   pbcopy
//  - Linux:   wl-copy (Wayland) -> xclip -> xsel (X11)
//  - Fallback universal: OSC 52, que faz o proprio terminal copiar (funciona em
//    muitos emuladores modernos, inclusive por SSH).

export type CopyResult = 'native' | 'osc52' | 'failed';

function tryCommand(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
    child.stdin.on('error', () => resolve(false));
    child.stdin.end(text);
  });
}

function writeOsc52(text: string): void {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  process.stdout.write(`\x1b]52;c;${b64}\x07`);
}

export async function copyToClipboard(text: string): Promise<CopyResult> {
  let ok = false;
  if (process.platform === 'win32') {
    ok = await tryCommand('clip', [], text);
  } else if (process.platform === 'darwin') {
    ok = await tryCommand('pbcopy', [], text);
  } else {
    ok =
      (await tryCommand('wl-copy', [], text)) ||
      (await tryCommand('xclip', ['-selection', 'clipboard'], text)) ||
      (await tryCommand('xsel', ['--clipboard', '--input'], text));
  }
  if (ok) return 'native';
  try {
    writeOsc52(text);
    return 'osc52';
  } catch {
    return 'failed';
  }
}
