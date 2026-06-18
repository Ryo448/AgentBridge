// Prompt de teste enviado ao modelo pelo botao "Testar Modelo" no modal de
// selecao. Pede uma calculadora em Python com design bonito, potencia e
// exponencial, e exige que o modelo responda SOMENTE com o codigo (sem texto
// antes ou depois) para o resultado ficar limpo e facil de copiar.
export const TEST_PROMPT = [
  'Voce e um engenheiro de software senior especializado em Python.',
  '',
  'Crie uma calculadora em Python com tkinter com um DESIGN MUITO BONITO e moderno:',
  'cores harmonicas, botoes estilizados, espacamento agradavel e um visor destacado.',
  '',
  'Requisitos obrigatorios:',
  '- Operacoes basicas (+, -, *, /) e parenteses, com precedencia correta.',
  '- Potencia (x elevado a y) e funcao exponencial.',
  '- Botoes de igual (=), limpar tudo (C) e apagar o ultimo caractere (backspace).',
  '- Suporte a teclado fisico.',
  '- Tratamento de erros (divisao por zero, expressao invalida) sem travar.',
  '- Codigo organizado em uma classe, limpo e comentado por dentro.',
  '',
  'IMPORTANTE: responda SOMENTE com o codigo Python, dentro de um unico bloco.',
  'NAO escreva nenhuma explicacao, titulo, introducao nem qualquer texto antes ou',
  'depois do codigo. Apenas o codigo, e nada mais.'
].join('\n');
