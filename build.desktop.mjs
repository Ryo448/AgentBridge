import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const outDir = join(root, 'dist', 'desktop');
const desktopOutDir = join(outDir, 'desktop');
const tscBin = join(root, 'node_modules', 'typescript', 'bin', 'tsc');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(desktopOutDir, { recursive: true });

execFileSync(process.execPath, [tscBin, '-p', 'tsconfig.desktop.json'], {
  cwd: root,
  stdio: 'inherit'
});

cpSync(join(root, 'src', 'desktop', 'ui'), join(desktopOutDir, 'ui'), { recursive: true });
cpSync(join(root, 'src', 'desktop', 'assets'), join(desktopOutDir, 'assets'), { recursive: true });
cpSync(join(root, 'src', 'desktop', 'preload.cjs'), join(desktopOutDir, 'preload.cjs'));
