# AgentBridge NVIDIA — Agent Instructions

Gateway local para usar a API NVIDIA em clientes OpenAI, Codex CLI e Claude Code.

## Quick start

```powershell
npm install
npm start              # TUI (terminal interativo) ou headless automático
npm run start:headless # Força modo headless (servidor puro)
npm run desktop        # App Electron (requer build: `npm run build:desktop`)
```

## Key commands

| Command | Purpose |
|---------|---------|
| `npm start` | TUI interativa ou headless (auto-detect) |
| `npm run start:headless` | Headless forçado |
| `npm run desktop` | Electron app (build + launch) |
| `npm run build:desktop` | Compila TypeScript + copia assets para `dist/desktop/` |
| `npm run dist:win` | Gera instalador NSIS em `release-agentbridge/` |
| `npm test` | Roda todos os testes com `tsx --test --test-concurrency=1` |

## Architecture

- **Runtime**: Node.js + Hono (`@hono/node-server`) + TSX para execução direta de TypeScript
- **Build**: `tsc` (tsconfig.desktop.json) + `build.desktop.mjs` que copia UI/assets/preload.cjs para `dist/desktop/`
- **Persistence**: config criptografada em `Documents/AgentBridge/config.json` (AES-256-GCM)
- **Token tracking**: `Documents/AgentBridge/used_tokens.json` com janela rotativa de 30min
- **Penalties**: `Documents/AgentBridge/penalties.json` (cooldowns de 429 compartilhados entre TUI e desktop)

## Structure

- `src/index.ts` — headless server entrypoint + Hono routes
- `src/config.ts` — constants: default models, prices, RPM limits, timeouts
- `src/services/` — nvidia.ts (forwarding), runtime.ts (state), vault.ts (encrypted config), token-tracking.ts, lastPrompt.ts
- `src/routes/` — compatibility.ts (Anthropic/Responses adapters), toolInstructions.ts
- `src/desktop/` — Electron main/renderer/preload
- `src/terminal/` — TUI (app.ts, input.ts, format.ts, theme.ts)
- `src/i18n/` — translations (pt-BR, en, ru) + locale detection
- `src/tests/` — tests run with `tsx --test`

## Routes

| Route | Auth | Notes |
|-------|------|-------|
| `GET /health` | No | Status `ok`/`locked` |
| `GET /v1/tokens/usage` | No | Token usage stats |
| `GET /v1/models` | Yes | Real catalog + pseudo-model `AgentBridge` |
| `GET /v1/models/available` | Yes | `?only_available=1` filters |
| `POST /v1/chat/completions` | Yes | Roteia por model; "AgentBridge" → app selection |
| `POST /v1/responses` | Yes | OpenAI Responses → Chat adapter |
| `POST /v1/messages` | Yes | Anthropic Messages → Chat adapter |
| `POST /v1/direct/chat/completions` | Yes | Strict passthrough, requires real model ID |
| `POST /v1/direct/responses` | Yes | Direct passthrough |
| `POST /v1/direct/messages` | Yes | Direct passthrough |

Auth: `Authorization: Bearer <local-key>` or `x-api-key` header. Default local key: `EuAmoORyo`.

## Model routing

- `model: "AgentBridge"` (or empty) → redirects to app-selected model
- `model: "<provider/model>"` → honors request if key available, else falls back to effective model
- Auto-toggle mode: proxy auto-failover through model priority list when 429s hit
- Hedged failover: when primary model >60s no first HTTP response, launches backup on next available model

## Models (pre-installed, USD per 1M tokens)

| Model | Input | Output |
|-------|-------|--------|
| `deepseek-ai/deepseek-v4-pro` | 0.435 | 0.87 |
| `moonshotai/kimi-k2.6` | 0.66 | 3.50 |
| `deepseek-ai/deepseek-v4-flash` | 0.09 | 0.18 |
| `nvidia/nemotron-3-ultra-550b-a55b` | 0.50 | 2.20 |
| `qwen/qwen3.5-397b-a17b` | 0.385 | 2.45 |
| `minimaxai/minimax-m3` | 0.30 | 1.20 |

## Testing

```powershell
npm test  # --test-concurrency=1 is required to avoid port conflicts
```

Single test file: `tsx --test --test-concurrency=1 src/tests/<file>.test.ts`

## Important quirks

- **Vision routing**: image detection MUST happen BEFORE protocol conversion (`responsesInputToMessages()` / `anthropicMessagesToChat()` strip images). See `resolveTargetModel()` in each route handler — it parses the ORIGINAL body.
- **Three `sanitizeCatalog`/`normalizeCatalog` functions** exist in `main.ts`, `vault.ts`, and `terminal/app.ts`. Any new field in `ModelCatalogEntry` must be mirrored in all three.
- **SSE buffer**: truncated at 65536 bytes (keeping last 16384) — do NOT change thresholds without syncing both `nvidia.ts` and `compatibility.ts`.
- **Stream always forced**: `stream: true` + `stream_options.include_usage: true` even for non-stream requests. Usage is extracted from the final SSE chunk.
- **Version in two places**: `package.json` and `release-agentbridge/latest.yml` must stay in sync.
- **No `git commit`/`git push`** without explicit user authorization.