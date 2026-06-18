# AgentBridge NVIDIA

Gateway local para usar a API NVIDIA em clientes OpenAI, Codex CLI e Claude Code.

## Desktop

```powershell
npm install
npm run desktop
```

Ao abrir, informe a senha usada para criptografar as APIs. O arquivo e salvo em:

```text
Documentos\AgentBridge\config.json
```

A senha nunca e persistida. As chaves descriptografadas ficam somente na memoria
enquanto o aplicativo esta aberto.

## Build do instalador (Windows .exe)

Gera o instalador NSIS em `release-agentbridge\`:

```powershell
npm install
npm run dist:win
```

O instalador permite escolher o diretorio de instalacao, cria atalho na area de
trabalho e no menu Iniciar. O executavel gerado fica em
`release-agentbridge\AgentBridge Setup x.y.z.exe`.

## API local

- Autenticacao: `EuAmoORyo`
- Chat Completions: `http://localhost:3000/v1/chat/completions`
- Responses: `http://localhost:3000/v1/responses`
- Anthropic Messages: `http://localhost:3000/v1/messages`
- Health: `http://localhost:3000/health`

As requisicoes sao distribuidas automaticamente por chave para respeitar 35 RPM sem criar rajadas longas. O delay extra padrao e 0 ms.
Cada chave aceita no maximo 35 reservas por minuto. Quando todas atingem o
limite, novas requisicoes aguardam a virada do minuto antes de continuar.

## Modo terminal

```powershell
$env:NVIDIA_API_KEYS="nvapi-chave-1,nvapi-chave-2"
npm start
```

O proxy nao possui modelo padrao. Sempre defina o identificador NVIDIA desejado
no campo `model` do cliente ou da requisicao.

## Licenca

GPL-3.0
