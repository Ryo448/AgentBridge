const LOCAL_TOOL_SYSTEM_PROMPT = [
  'ENVIRONMENT',
  '- AgentBridge is serving a local coding-agent client such as Codex CLI or Claude Code.',
  '- All tools in this request are executed by that local client against the user workspace.',
  '- The workspace runs on Windows and the default shell is PowerShell. Emit PowerShell-compatible commands only; never use bash/Unix syntax.',
  '- PowerShell equivalents: use Get-ChildItem instead of "ls -la", Remove-Item instead of "rm -rf", Copy-Item instead of "cp", Move-Item instead of "mv", Get-Content instead of "cat", and Select-String or rg instead of "grep". Chain commands with ";" not "&&". Use Windows-style paths.',
  '- When a tool is needed, emit the exact function/tool call requested by the client and wait for its result.',
  '- Do not claim you need remote filesystem access, a cloud sandbox, provider-side tools, or non-Windows workspace paths.',
  '- Do not invent command output or file contents; use tool calls for local inspection and edits.',
  '',
  'EDITING FILES',
  '- Use dedicated file edit or patch tools for file modifications whenever the client exposes them, especially tools named apply_patch, edit, str_replace, create_file, or similar.',
  '- Prefer small surgical patches over replacing entire files: change only the lines that must change and leave the rest of the file byte-for-byte intact.',
  '- Before editing, read the relevant file or exact lines unless the user already provided the full content.',
  '- Preserve unrelated user changes and keep edits scoped to the requested behavior.',
  '- With Codex apply_patch, emit a proper patch envelope: a line "*** Begin Patch", then "*** Update File: <path>", then context lines, "-" for removed lines and "+" for added lines, ending with "*** End Patch". Do not paste a full new file body in place of a diff.',
  '- Do not use shell redirection, heredocs, Set-Content, Out-File, echo-to-file, cat-to-file, Python scripts, or Node scripts to overwrite whole source files when an edit or patch tool is available.',
  '',
  'SHELL COMMANDS',
  '- Use shell or command tools mainly for inspection, search, tests, builds, and formatters.',
  '- For searching files, prefer rg or rg --files when available.',
  '- If only a shell/command tool is available, do not rewrite whole files; invoke the client patch mechanism (for example run apply_patch with a "*** Begin Patch" envelope) and apply the smallest possible change.'
].join('\n');

function toolName(tool: any) {
  if (typeof tool?.function?.name === 'string') return tool.function.name;
  if (typeof tool?.name === 'string') return tool.name;
  if (typeof tool?.type === 'string') return tool.type;
  return '';
}

function toolDescription(tool: any) {
  if (typeof tool?.function?.description === 'string') return tool.function.description;
  if (typeof tool?.description === 'string') return tool.description;
  return '';
}

function buildToolInventoryPrompt(tools: any[]) {
  const names = [...new Set(tools.map(toolName).filter(Boolean))];
  const patchTools = names.filter((name) => /patch|edit|str_replace|create|write_file/i.test(name));
  const shellTools = names.filter((name) => /shell|bash|powershell|command|exec|terminal/i.test(name));
  const descriptions = tools
    .map((tool) => {
      const name = toolName(tool);
      const description = toolDescription(tool);
      return name && description ? `${name}: ${description}` : name;
    })
    .filter(Boolean)
    .slice(0, 20);

  return [
    names.length ? `Client-advertised tools: ${names.join(', ')}.` : '',
    patchTools.length
      ? `For file edits, prefer these edit/patch tools: ${patchTools.join(', ')}.`
      : 'No dedicated edit/patch tool was advertised; perform edits through the available shell/command tool by running apply_patch with a "*** Begin Patch" envelope, and never overwrite a whole file.',
    shellTools.length
      ? `Treat these as command/shell tools, not primary file editors: ${shellTools.join(', ')}.`
      : '',
    descriptions.length ? `Tool descriptions: ${descriptions.join(' | ')}.` : ''
  ].filter(Boolean).join(' ');
}

function hasClientTools(body: Record<string, unknown>) {
  return Array.isArray(body.tools) && body.tools.length > 0;
}

function hasLocalToolPrompt(messages: any[]) {
  return messages.some((message) =>
    message?.role === 'system' &&
    typeof message.content === 'string' &&
    message.content.includes('All tools in this request are executed by that local client')
  );
}

export function withLocalToolInstructions(body: Record<string, unknown>) {
  if (!hasClientTools(body)) return body;

  const messages = Array.isArray(body.messages) ? [...body.messages] : [];
  if (hasLocalToolPrompt(messages)) return { ...body, messages };
  const tools = body.tools as any[];

  return {
    ...body,
    messages: [
      {
        role: 'system',
        content: [
          LOCAL_TOOL_SYSTEM_PROMPT,
          buildToolInventoryPrompt(tools)
        ].filter(Boolean).join(' ')
      },
      ...messages
    ]
  };
}

export const LOCAL_TOOL_INSTRUCTION_MARKER =
  'All tools in this request are executed by that local client';

export const LOCAL_TOOL_EDIT_POLICY_MARKER =
  'Use dedicated file edit or patch tools for file modifications';
