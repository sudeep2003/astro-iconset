/// <reference types="vite/client" />

export function registerSymbol(id: string, body: string, viewBox: string): boolean {
  if (import.meta.env.SSR) return false;
  ensureClientSprite();
  const sprite = document.getElementById("icon-sprite") as unknown as SVGSVGElement;
  if (!sprite) return false;
  const existing = sprite.querySelector(`[id="${id.replace(/[!"#$%&'()*+,./:;<=>?@[\]^`{|}~]/g, "\\$&")}"]`);
  if (existing) return false;
  const symbol = document.createElementNS("http://www.w3.org/2000/svg", "symbol");
  symbol.id = id;
  symbol.setAttribute("viewBox", viewBox);
  symbol.innerHTML = body;
  sprite.appendChild(symbol);
  return true;
}

function ensureClientSprite(): void {
  if (document.getElementById("icon-sprite")) return;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = "icon-sprite";
  svg.setAttribute("aria-hidden", "true");
  svg.style.display = "none";
  document.body.insertBefore(svg, document.body.firstChild);
}
