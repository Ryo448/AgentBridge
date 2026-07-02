export const APP_NAME = 'AgentBridge';
export const APP_VERSION = '4.2.2';
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
// `inputPrice` e `outputPrice` sao o custo por milhao de tokens (USD) cobrado pela
// NVIDIA para este modelo, usados para calcular a economia no AgentBridge.
export type ModelCatalogEntry = {
  label: string;
  model: string;
  icon: string;
  inputPrice?: number;
  outputPrice?: number;
};

// Precos padrao NVIDIA para os modelos pre-instalados (USD por 1M tokens).
export const DEFAULT_MODEL_PRICES: Record<string, { input: number; output: number }> = {
  'deepseek-ai/deepseek-v4-pro': { input: 0.435, output: 0.87 },
  'deepseek-ai/deepseek-v4-flash': { input: 0.09, output: 0.18 },
  'moonshotai/kimi-k2.6': { input: 0.66, output: 3.50 },
  'nvidia/nemotron-3-ultra-550b-a55b': { input: 0.50, output: 2.20 },
  'minimaxai/minimax-m3': { input: 0.30, output: 1.20 },
  'qwen/qwen3.5-397b-a17b': { input: 0.385, output: 2.45 }
};

// Catalogo padrao de modelos. Pode ser editado, reordenado e ampliado pelo usuario;
// os valores aqui sao apenas o ponto de partida quando ainda nao ha nada salvo.
export const DEFAULT_MODEL_CATALOG: ModelCatalogEntry[] = [
  { label: 'Deepseek v4 pro', model: 'deepseek-ai/deepseek-v4-pro', icon: 'deepseek', inputPrice: 0.435, outputPrice: 0.87 },
  { label: 'Kimi', model: 'moonshotai/kimi-k2.6', icon: 'kimi', inputPrice: 0.66, outputPrice: 3.50 },
  { label: 'Deepseek v4 flash', model: 'deepseek-ai/deepseek-v4-flash', icon: 'deepseek', inputPrice: 0.09, outputPrice: 0.18 },
  { label: 'Nemotron', model: 'nvidia/nemotron-3-ultra-550b-a55b', icon: 'nemotron', inputPrice: 0.50, outputPrice: 2.20 },
  { label: 'Qwen', model: 'qwen/qwen3.5-397b-a17b', icon: 'qwen', inputPrice: 0.385, outputPrice: 2.45 },
  { label: 'Minimax M3', model: 'minimaxai/minimax-m3', icon: 'minimax', inputPrice: 0.30, outputPrice: 1.20 }
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

// Tempo sem primeiro sinal de resposta (primeiro chunk/HTTP 200) antes de
// lancar uma requisicao de backup (hedge) no proximo modelo da prioridade.
// So ativo no modo automatico (autoToggle === true).
export const HEDGE_SLOW_THRESHOLD_MS = 60_000;
// Tempo extra que esperamos o primario responder DEPOIS que o backup ja
// respondeu. Se o primario ainda nao respondeu neste prazo, cancela o
// primario e fica com o backup.
export const HEDGE_PRIMARY_GRACE_MS = 10_000;
// Quantas requests o modelo backup fica "stickado" como ativo depois de
// ter vencido o hedge (primario muito lento). Durante estas requests nao
// tentamos o modelo de maior prioridade.
export const HEDGE_STICKY_REQUESTS = 5;

// Idioma padrao da interface. Se nao houver config salva, a deteccao automatica
// do SO decide; se a deteccao falhar, cai para 'en'.
export const DEFAULT_LOCALE = 'en';
