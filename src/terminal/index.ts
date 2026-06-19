import { startStandaloneServer } from '../index.ts';
import { runTui } from './app.ts';

// Ponto de entrada do "modo terminal".
//
//  - Por padrao (terminal interativo) sobe a TUI completa: desbloqueio com senha,
//    leitura das chaves criptografadas em Documentos\AgentBridge\config.json,
//    dashboard ao vivo e todas as telas de configuracao.
//  - Com --headless, ou quando a saida nao e um TTY (pipe/CI/systemd), cai no modo
//    enxuto antigo, que le NVIDIA_API_KEYS do ambiente e apenas serve o gateway.
const headless =
  process.argv.includes('--headless') ||
  process.argv.includes('--no-ui') ||
  !process.stdout.isTTY;

if (headless) {
  startStandaloneServer();
} else {
  runTui().catch((error) => {
    process.stdout.write('\x1b[?25h\x1b[?1049l');
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
