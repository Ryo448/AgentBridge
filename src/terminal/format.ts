import type { ApiRequestLogEvent } from '../services/runtime.ts';
import { c } from './theme.ts';

// Formatacoes de texto compartilhadas pelas telas (espelham renderer.js do
// desktop): tempo decorrido, mensagem amigavel de cada evento de log, contagem
// regressiva do castigo e os snippets de integracao Codex/Claude.

export function formatElapsed(milliseconds: unknown): string {
  const value = Number(milliseconds);
  if (!Number.isFinite(value)) return '';
  if (value < 1000) return `${Math.max(0, Math.round(value))} ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
}

export function formatCountdown(milliseconds: number): string {
  const total = Math.max(0, Math.floor(Number(milliseconds) / 1000));
  const pad = (value: number) => String(value).padStart(2, '0');
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

// Mensagem amigavel de uma linha do log, ja colorida por tipo de evento.
export function usageMessage(entry: ApiRequestLogEvent): string {
  const target = entry.path ? `${entry.method || ''} ${entry.path}`.trim() : '';
  switch (entry.type) {
    case 'received':
      return c.muted(`Cliente chamou ${target}`);
    case 'rejected':
      return c.red(`Cliente rejeitado ${target} HTTP ${entry.status}: ${entry.message || 'chave invalida'}`);
    case 'completed_client':
      return c.green(`Cliente recebeu HTTP ${entry.status} ${target} em ${formatElapsed(entry.elapsedMs)}`);
    case 'failed_client':
      return c.red(`Erro no proxy ${target}: ${entry.message || 'falha desconhecida'}`);
    case 'rate_limit_wait':
      return c.amber(`Aguardando throttle de RPM por ${formatElapsed(entry.waitMs)}`);
    case 'delay':
      return c.faint(`Esperando delay de ${formatElapsed(entry.delayMs)}`);
    case 'called':
      return c.text(`API ${entry.apiNumber} selecionada`);
    case 'started':
      return c.text(`API ${entry.apiNumber} comecou a responder em ${formatElapsed(entry.elapsedMs)}${entry.model ? c.faint(` · ${entry.model}`) : ''}`);
    case 'completed':
      return c.green(`API ${entry.apiNumber} respondeu em ${formatElapsed(entry.elapsedMs)}${Number(entry.totalTokens) > 0 ? `, ${entry.totalTokens} tokens` : ''}`);
    case 'upstream_error':
      return c.red(`NVIDIA erro HTTP ${entry.status} na API ${entry.apiNumber}${entry.model ? ` (${entry.model})` : ''}: ${entry.message || 'sem detalhe'}`);
    case 'cancelled':
      return c.amber(`Stream cancelado na API ${entry.apiNumber}: ${entry.message || 'cliente desconectou'}`);
    case 'model_switch':
      return c.accentStrong(`Modelo trocado automaticamente${entry.message ? ` ${entry.message}` : ''} para ${entry.model || '?'}`);
    case 'error':
      return c.red(`Erro na API ${entry.apiNumber || '?'}: ${entry.message || 'sem detalhe'}`);
    default:
      return c.text(`API ${entry.apiNumber} chamada`);
  }
}

export type Shell = 'bash' | 'powershell';

// Bloco do ~/.codex/config.toml (independente de shell).
export function codexConfigToml(baseUrl: string): string {
  return [
    'model = "AgentBridge"',
    'model_provider = "agentbridge"',
    '',
    '[model_providers.agentbridge]',
    'name = "NVIDIA via AgentBridge"',
    `base_url = "${baseUrl}/v1"`,
    'wire_api = "responses"',
    'env_key = "AGENTBRIDGE_API_KEY"'
  ].join('\n');
}

// Variavel de ambiente do Codex, ja no formato do shell escolhido.
export function codexEnv(apiKey: string, shell: Shell): string {
  return shell === 'powershell'
    ? `$env:AGENTBRIDGE_API_KEY="${apiKey}"`
    : `export AGENTBRIDGE_API_KEY="${apiKey}"`;
}

// Bloco completo do Claude Code para um shell especifico (cole e ja inicia).
export function claudeSnippet(baseUrl: string, apiKey: string, shell: Shell): string {
  if (shell === 'powershell') {
    return [
      `$env:ANTHROPIC_BASE_URL="${baseUrl}"`,
      `$env:ANTHROPIC_AUTH_TOKEN="${apiKey}"`,
      '$env:ANTHROPIC_MODEL="AgentBridge"',
      '$env:ANTHROPIC_DEFAULT_HAIKU_MODEL=$env:ANTHROPIC_MODEL',
      '$env:ANTHROPIC_DEFAULT_SONNET_MODEL=$env:ANTHROPIC_MODEL',
      '$env:ANTHROPIC_DEFAULT_OPUS_MODEL=$env:ANTHROPIC_MODEL',
      'claude'
    ].join('\n');
  }
  return [
    `export ANTHROPIC_BASE_URL="${baseUrl}"`,
    `export ANTHROPIC_AUTH_TOKEN="${apiKey}"`,
    'export ANTHROPIC_MODEL="AgentBridge"',
    'export ANTHROPIC_DEFAULT_HAIKU_MODEL=$ANTHROPIC_MODEL',
    'export ANTHROPIC_DEFAULT_SONNET_MODEL=$ANTHROPIC_MODEL',
    'export ANTHROPIC_DEFAULT_OPUS_MODEL=$ANTHROPIC_MODEL',
    'claude'
  ].join('\n');
}
