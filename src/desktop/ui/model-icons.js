// Catalogo de modelos NVIDIA expostos no proxy. Cada item vira um card no modal
// "Selecionar modelo": tem um toggle para escolher o modelo de redirecionamento
// (so um pode ficar ligado por vez) e um botao para enviar um prompt de teste
// (gerar uma calculadora em Python com UI) medindo o tempo de resposta.
window.agentBridgeModels = [
  { key: 'nemotron', label: 'Nemotron', model: 'nvidia/nemotron-3-ultra-550b-a55b' },
  { key: 'kimi', label: 'Kimi', model: 'moonshotai/kimi-k2.6' },
  { key: 'deepseek', label: 'Deepseek v4 flash', model: 'deepseek-ai/deepseek-v4-flash' },
  { key: 'deepseek', label: 'Deepseek v4 pro', model: 'deepseek-ai/deepseek-v4-pro' },
  { key: 'minimax', label: 'Minimax M3', model: 'minimaxai/minimax-m3' },
  { key: 'qwen', label: 'Qwen', model: 'qwen/qwen3.5-397b-a17b' }
];

window.agentBridgeModelIcons = {
  nemotron: `<svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect x="10" y="10" width="100" height="100" rx="20" fill="#76b900"/>
<path d="M38 84V36h10l24 30V36h10v48H72L48 54v30H38Z" fill="#0c1a00"/>
</svg>`,
  kimi: `<svg width="24" height="25" viewBox="0 0 24 25" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M21.7202 0.939941C22.9502 0.939941 23.9502 1.93994 23.9502 3.16994C23.9502 4.39994 22.9502 5.39994 21.7202 5.39994H19.7502C19.6002 5.39994 19.4902 5.27994 19.4902 5.13994V3.16994C19.4902 1.93994 20.4902 0.939941 21.7202 0.939941Z" fill="#1783FF"/>
<path d="M9.39 13.9501L17.82 5.59012C17.98 5.43012 17.89 5.12012 17.68 5.12012H13.14C13.14 5.12012 13.04 5.14012 13 5.18012L3.92 14.1901C3.78 14.3301 3.57 14.2101 3.57 13.9801V5.39012C3.57 5.24012 3.47 5.12012 3.35 5.12012H0.219999C0.0999993 5.12012 0 5.24012 0 5.39012V23.9201C0 24.0701 0.0999993 24.1901 0.219999 24.1901H3.35C3.47 24.1901 3.57 24.0701 3.57 23.9201V20.1401C3.57 20.0601 3.6 19.9801 3.65 19.9301L6.47 17.1401C6.54 17.0701 6.63 17.0601 6.71 17.1101L14.24 22.6501C15.47 23.4801 16.85 23.9901 18.25 24.1401C18.37 24.1501 18.48 24.0301 18.48 23.8701V20.3101C18.48 20.1701 18.4 20.0601 18.29 20.0501C17.47 19.9201 16.66 19.6001 15.94 19.1101L9.42 14.3901C9.28 14.3001 9.27 14.0701 9.39 13.9501Z" fill="#1783FF"/>
</svg>`,
  qwen: `<svg width="200" height="200" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M119.12 163.03H98.88L87.54 144.71H49.64L61.26 126.39H80.7L38.42 55.29H61.26L83.3 19.03L93.56 37.35L83.3 55.29H161.58L151.32 72.54L170.76 106.28H151.32L141.16 88.34L101.18 163.03H119.12Z" fill="#615ced"/>
<path d="M127.86 79.83H76.14L101.18 122.11L127.86 79.83Z" fill="#615ced"/>
</svg>`,
  minimax: `<svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect x="10" y="10" width="100" height="100" rx="20" fill="#ec5a2a"/>
<path d="M30 84V36h11l19 26 19-26h11v48H79V57L60 82 41 57v27H30Z" fill="#fff3ea"/>
</svg>`,
  deepseek: `<svg fill="none" height="1320" viewBox="3.771 6.973 23.993 17.652" width="2500" xmlns="http://www.w3.org/2000/svg"><path d="m27.501 8.469c-.252-.123-.36.111-.508.23-.05.04-.093.09-.135.135-.368.395-.797.652-1.358.621-.821-.045-1.521.213-2.14.842-.132-.776-.57-1.238-1.235-1.535-.349-.155-.701-.309-.944-.645-.171-.238-.217-.504-.303-.765-.054-.159-.108-.32-.29-.348-.197-.031-.274.135-.352.273-.31.567-.43 1.192-.419 1.825.028 1.421.628 2.554 1.82 3.36.136.093.17.186.128.321-.081.278-.178.547-.264.824-.054.178-.135.217-.324.14a5.448 5.448 0 0 1 -1.719-1.169c-.848-.82-1.614-1.726-2.57-2.435-.225-.166-.449-.32-.681-.467-.976-.95.128-1.729.383-1.82.267-.096.093-.428-.77-.424s-1.653.293-2.659.677a2.782 2.782 0 0 1 -.46.135 9.554 9.554 0 0 0 -2.853-.1c-1.866.21-3.356 1.092-4.452 2.6-1.315 1.81-1.625 3.87-1.246 6.018.399 2.261 1.552 4.136 3.326 5.601 1.837 1.518 3.955 2.262 6.37 2.12 1.466-.085 3.1-.282 4.942-1.842.465.23.952.322 1.762.392.623.059 1.223-.031 1.687-.127.728-.154.677-.828.414-.953-2.132-.994-1.665-.59-2.09-.916 1.084-1.285 2.717-2.619 3.356-6.94.05-.343.007-.558 0-.837-.004-.168.034-.235.228-.254a4.084 4.084 0 0 0 1.529-.47c1.382-.757 1.938-1.997 2.07-3.485.02-.227-.004-.463-.243-.582zm-12.041 13.391c-2.067-1.627-3.07-2.162-3.483-2.138-.387.021-.318.465-.233.754.089.285.205.482.368.732.113.166.19.414-.112.598-.666.414-1.823-.139-1.878-.166-1.347-.793-2.473-1.842-3.267-3.276-.765-1.38-1.21-2.861-1.284-4.441-.02-.383.093-.518.472-.586a4.692 4.692 0 0 1 1.514-.04c2.109.31 3.905 1.255 5.41 2.749.86.853 1.51 1.871 2.18 2.865.711 1.057 1.478 2.063 2.454 2.887.343.289.619.51.881.672-.792.088-2.117.107-3.022-.61zm.99-6.38a.304.304 0 1 1 .609 0c0 .17-.136.304-.306.304a.3.3 0 0 1 -.303-.305zm3.077 1.581c-.197.08-.394.15-.584.159a1.246 1.246 0 0 1 -.79-.252c-.27-.227-.463-.354-.546-.752a1.752 1.752 0 0 1 .016-.582c.07-.324-.008-.531-.235-.72-.187-.155-.422-.196-.682-.196a.551.551 0 0 1 -.252-.078c-.108-.055-.197-.19-.112-.356.027-.053.159-.183.19-.207.352-.201.758-.135 1.134.016.349.142.611.404.99.773.388.448.457.573.678.906.174.264.333.534.441.842.066.192-.02.35-.248.448z" fill="#4d6bfe"/></svg>`
};

// Desenha o icone de um modelo dentro de `element`. Se `iconKey` casar com um SVG
// embutido (deepseek, kimi, nemotron, qwen, minimax), usa esse SVG. Caso contrario
// (modelos adicionados pelo usuario, sem icone), desenha um placeholder com a
// primeira letra do nome -- assim nao e preciso criar um SVG novo para cada modelo.
window.agentBridgeModelIcons.renderInto = (element, iconKey, label) => {
  const svg = iconKey ? window.agentBridgeModelIcons[iconKey] : '';
  if (typeof svg === 'string' && svg.trim()) {
    element.innerHTML = svg;
    return;
  }
  const source = String(label || iconKey || '?').trim();
  const letter = (source ? source[0] : '?').toUpperCase();
  const placeholder = document.createElement('span');
  placeholder.className = 'model-icon-letter';
  placeholder.textContent = letter;
  element.replaceChildren(placeholder);
};
