# AgentBridge NVIDIA

Gateway local para usar a API NVIDIA em clientes OpenAI, Codex CLI e Claude Code.

## Desktop

```powershell
npm install
npm run desktop
```

Ao abrir, informe a senha usada para criptografar as APIs. O arquivo é salvo em:

```text
Documentos\AgentBridge\config.json
```

A senha nunca é persistida. As chaves descriptografadas ficam somente na memória
enquanto o aplicativo está aberto.

## Build do instalador (Windows .exe)

Gera o instalador NSIS em `release-agentbridge\`:

```powershell
npm install
npm run dist:win
```

O instalador permite escolher o diretório de instalação, cria atalho na área de
trabalho e no menu Iniciar. O executável gerado fica em
`release-agentbridge\AgentBridge Setup x.y.z.exe`.

## API local

- Autenticação: `EuAmoORyo`
- Chat Completions: `http://localhost:3000/v1/chat/completions`
- Responses: `http://localhost:3000/v1/responses`
- Anthropic Messages: `http://localhost:3000/v1/messages`
- Health: `http://localhost:3000/health`

As requisições são distribuídas automáticamente por chave para respeitar 35 RPM sem criar rajadas longas. O delay extra padrão é 0 ms.
Cada chave aceita no máximo 35 reservas por minuto. Quando todas atingem o
limite, novas requisições aguardam a virada do minuto antes de continuar.

## Escolha de modelo pelo client

Os endpoints **padrão** entendem o modelo que o client manda — é assim que um
workspace OpenAI-compatível (Open WebUI, Odysseus, etc.) lista e escolhe modelos
sozinho:

- `GET /v1/models` lista o **catálogo real** de modelos (ids `provider/modelo`,
  cada um com `available: true/false`) **mais** o pseudo-modelo `AgentBridge`.
  Assim o seletor do client é populado com os modelos de verdade.
- `POST /v1/chat/completions` (e também `/v1/responses` e `/v1/messages`) roteia
  conforme o `model` recebido:
  - `model: "AgentBridge"` (ou vazio) → **redireciona** para o modelo selecionado
    no app (modo automático continua valendo). É o que o Codex/Claude usam, então
    nada muda para eles.
  - `model: "<id real>"` → vai **direto** para esse modelo, desde que haja chave
    livre. Se não houver, cai para o modelo efetivo em vez de devolver erro — ou
    seja, nunca quebra a request por causa de modelo.

Exemplo escolhendo um modelo específico:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer EuAmoORyo" \
  -H "Content-Type: application/json" \
  -d '{"model":"moonshotai/kimi-k2.6","messages":[{"role":"user","content":"oi"}]}'
```

### Rotas extras (atalhos para scripts)

Além dos endpoints padrão, existem rotas dedicadas equivalentes:

- `GET /v1/models/available` — mesma listagem do catálogo; aceita
  `?only_available=1` para retornar só os modelos com chave livre agora.
- `POST /v1/direct/chat/completions` · `/v1/direct/responses` ·
  `/v1/direct/messages` — passthrough **estrito**: sempre honram o `model` do
  corpo e exigem um id real (retornam 400 se vier vazio ou `AgentBridge`).

O rodízio de chaves e o castigo de 429 (por modelo) valem em todas as rotas.

## Modo terminal

O **AgentBridge** agora tem suporte nativo para terminal — com ou sem interface
interativa. A entrada é unificada: um único comando (`npm start`) decide
automaticamente qual modo ativar.

| Situação                                    | Modo ativado           |
|---------------------------------------------|------------------------|
| Terminal interativo (PowerShell, bash, etc) | **TUI** completa       |
| Pipe, redirecionamento, CI, systemd         | **Headless** automático|
| `--headless` ou `--no-ui`                   | **Headless** forçado   |

### TUI (interface interativa no terminal)

O modo TUI oferece **100% das funções do app desktop** numa interface bonita em
ANSI, sem Electron nem dependências gráficas:

```powershell
npm install
npm start
```

> **Dica para Windows:** use o **Windows Terminal** (recomendado) ou qualquer
> terminal compatível com ANSI. O PowerShell padrão do Windows 11 funciona bem.

**Primeira execução:** o AgentBridge mostra a tela de desbloqueio. Se ainda não
existir um cofre, ele guia você na criação da senha mestra e no cadastro das
chaves NVIDIA.

**Execuções seguintes:** ele lê o **mesmo cofre criptografado** do desktop
(`Documentos\AgentBridge\config.json`). A senha nunca é salva — só descriptografa
as chaves em memória durante a sessão.

#### Dashboard ao vivo

Assim que você desbloqueia o cofre, o gateway sobe automaticamente e o dashboard
mostra:

- **Proxy:** estado do servidor, porta, número de chaves, delay extra
- **Modelo:** modo manual/automático, modelo alvo, catálogo, RPM por minuto
- **Log ao vivo:** cada requisição que passa pelo proxy, com horário e status

No rodapé, os atalhos disponíveis:

    S iniciar/parar · A APIs · M modelos · C castigos · P porta · D delay · I integração · L limpar log · Q sair

#### Telas de configuração (atalhos)

| Tecla | Tela              | O que faz                                                                 |
|-------|-------------------|---------------------------------------------------------------------------|
| `A`   | **APIs**          | Adiciona, edita ou remove as chaves NVIDIA (criptografadas com AES-256-GCM)|
| `M`   | **Modelos**       | Seleciona modelo, liga **alternância automática**, reordena prioridade,   |
|       |                   | testa modelo e edita o catálogo                                           |
| `C`   | **Castigos (429)**| Mostra as APIs em cooldown com contagem regressiva ao vivo                |
| `P`   | **Porta**         | Altera a porta onde o gateway escuta (1–65535)                            |
| `D`   | **Delay**         | Ajusta o delay extra em ms antes de cada chamada NVIDIA (0–600000)        |
| `I`   | **Integração**    | Gera snippets prontos para Codex CLI, Claude Code e API direta            |

A persistência de castigos (`penalties.json`) é compartilhada com o desktop —
os cooldowns de 429 continuam mesmo se você alternar entre TUI e Electron.

### Headless (servidor puro)

Para servidores, containers, Docker ou systemd — onde você não quer interface
interativa — passe as chaves por variável de ambiente:

```powershell
# PowerShell
$env:NVIDIA_API_KEYS = "nvapi-chave-1,nvapi-chave-2"
npm start -- --headless
```

```bash
# bash / zsh
export NVIDIA_API_KEYS="nvapi-chave-1,nvapi-chave-2"
npm start -- --headless
```

O atalho `npm run start:headless` faz a mesma coisa.

O modo headless também é ativado automaticamente quando a saída **não é um
terminal interativo** — como em pipes (`npm start | tee log.txt`), CI/CD,
systemd ou Docker. Isso significa que o mesmo comando `npm start` funciona nos
dois cenários sem você precisar decorar flags.


---

## Tutorial: Como Obter APIs Gratuitas NVIDIA

Para utilizar o **AgentBridge** com as APIs NVIDIA, siga os passos abaixo:

### 1. Acesse o site NVIDIA Build

1. Abra o navegador e vá para: [https://build.nvidia.com/](https://build.nvidia.com/)
2. Crie e faça login na sua conta.

### 2. Gere sua API Key

1. No painel da NVIDIA, vá até a seção de **API Keys**.
2. Clique em **Generate API Key**.
3. Copie a chave gerada.

### 3. Quantidade de APIs Necessárias

Para que o **AgentBridge** funcione corretamente, você precisa de múltiplas chaves da API NVIDIA. **Infelizmente não vai funcionar sendo várias da mesma conta** — cada chave requer uma conta separada.

| Quantidade | Nível de Performance              |
|------------|-----------------------------------|
| 8 APIs     | Usável com qualidade              |
| 15 APIs    | Ideal para uso regular            |
| 25 APIs    | Perfeito (máximo desempenho)      |

### 4. Implemente no AgentBridge

Após coletar as chaves:

1. Abra o **AgentBridge**.
2. Defina uma senha para criptografar as chaves (localmente).
3. Nos campo de APIs, insira todas as chaves que você juntou.
4. Pronto! O proxy distribuirá automaticamente as requisições entre as chaves para respeitar o limite de 35 requisições por minuto.

> **Dica Importante**: Cada conta NVIDIA suporta até 40 requisições por minuto, mas o AgentBridge limita para 35 para evitar estourar o RPM da API. Com 8+ contas, o AgentBridge alterna entre elas para dar respostas estáveis e contínuas.

---
## Licença

GPL-3.0
