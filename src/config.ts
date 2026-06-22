export const APP_NAME = 'AgentBridge';
export const APP_VERSION = '3.5.0';
export const INTERNAL_API_KEY = 'EuAmoORyo';
export const DEFAULT_PORT = 3000;
// Modelo NVIDIA padrao para onde o proxy redireciona qualquer chamada quando o
// usuario ainda nao escolheu nenhum dentro do app. O redirecionamento e SEMPRE
// ativo: o cliente pode mandar "AgentBridge", "gpt-5" ou qualquer coisa que o
// proxy reescreve para o modelo selecionado.
export const DEFAULT_MODEL = 'deepseek-ai/deepseek-v4-pro';

// Um item do catalogo de modelos selecionaveis. `model` e o id real "provider/modelo"
// enviado para a NVIDIA; `label` e o nome amigavel exibido; `icon` e a chave do SVG
// embutido (deepseek, kimi, nemotron, qwen, minimax). Modelos adicionados pelo
// usuario usam icon vazio: a UI desenha um placeholder com a primeira letra do nome.
export type ModelCatalogEntry = {
  label: string;
  model: string;
  icon: string;
};

// Catalogo padrao de modelos. Pode ser editado, reordenado e ampliado pelo usuario;
// os valores aqui sao apenas o ponto de partida quando ainda nao ha nada salvo.
export const DEFAULT_MODEL_CATALOG: ModelCatalogEntry[] = [
  { label: 'Deepseek v4 pro', model: 'deepseek-ai/deepseek-v4-pro', icon: 'deepseek' },
  { label: 'Kimi', model: 'moonshotai/kimi-k2.6', icon: 'kimi' },
  { label: 'Deepseek v4 flash', model: 'deepseek-ai/deepseek-v4-flash', icon: 'deepseek' },
  { label: 'Nemotron', model: 'nvidia/nemotron-3-ultra-550b-a55b', icon: 'nemotron' },
  { label: 'Qwen', model: 'qwen/qwen3.5-397b-a17b', icon: 'qwen' },
  { label: 'Minimax M3', model: 'minimaxai/minimax-m3', icon: 'minimax' }
];

// Ordem de prioridade padrao do failover automatico de modelo (ids "provider/modelo").
// O proxy sempre tenta o primeiro disponivel desta lista, caindo para o proximo
// quando todas as chaves do atual estao de castigo (429).
export const DEFAULT_MODEL_PRIORITY: string[] = DEFAULT_MODEL_CATALOG.map((item) => item.model);

// Alternancia automatica de modelo desligada por padrao: o usuario liga no app.
export const DEFAULT_AUTO_TOGGLE = false; // alternancia automatica de modelo
// Nome fixo que o usuario coloca no client (Codex/Claude). Nunca chega na NVIDIA:
// e sempre substituido pelo modelo selecionado no proxy.
export const FIXED_CLIENT_MODEL = 'AgentBridge';
export const NVIDIA_CHAT_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
export const REQUEST_DELAY_MS = 0;
export const NVIDIA_RPM_LIMIT = 35;
export const RATE_LIMIT_WINDOW_MS = 60_000;
// Castigo aplicado a uma chave que recebeu HTTP 429: ela fica fora do rodizio
// por este tempo (1 hora) antes de poder ser chamada de novo. Contado por chave,
// em paralelo -- nao e um limite universal.
export const RATE_LIMIT_PENALTY_MS = 60 * 60_000;
// Teto so para socket realmente morto. Como nao ha mais retry/failover, NAO
// abortamos um prefill saudavel: contextos grandes podem demorar bem mais que 120s
// ate o primeiro token, e abortar so forcava o cliente a reenviar tudo de novo.
export const FIRST_RESPONSE_TIMEOUT_MS = 600_000;

// Idioma padrao da interface. Se nao houver config salva, a deteccao automatica
// do SO decide; se a deteccao falhar, cai para 'en'.
export const DEFAULT_LOCALE = 'en';
