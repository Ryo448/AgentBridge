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

## Modo terminal

```powershell
$env:NVIDIA_API_KEYS="nvapi-chave-1,nvapi-chave-2"
npm start
```

O proxy não exige modelo padrão, então o que você colocar em `model` sempre será redirecionado para o modelo setado internamente por padrão.

## Licença

GPL-3.0

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
