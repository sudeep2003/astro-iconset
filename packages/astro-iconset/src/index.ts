import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Stats } from "node:fs";
import type { IntegrationOptions } from "../typings/integration";
import { createPlugin } from "./vite-plugin-astro-icon.js";
import type { AstroIntegration } from "astro";

/** Icon data from `import icon from "./file.svg?icon"` for `<Icon icon={icon} />`. */
export type { AstroIconImport } from "../typings/astro-icon-import";

export default function createIntegration(
  opts: IntegrationOptions = {},
): AstroIntegration {
  return {
    name: "astro-iconset",
    hooks: {
      "astro:config:setup"({ updateConfig, config, logger, injectScript }) {
        const external =
          config.output === "static" ? ["@iconify-json/*"] : undefined;
        const { root, output } = config;
        updateConfig({
          vite: {
            plugins: [createPlugin(opts, { root, output, logger })],
            ssr: {
              external,
            },
            optimizeDeps: {
              exclude: [
                "astro-iconset/components/react",
                "astro-iconset/components/preact",
                "astro-iconset/components/solid",
                "astro-iconset/components/svelte",
                "astro-iconset/components/vue",
              ],
            },
          },
        });

        // Client script: on every page, relocate <symbol> elements into a
        // hidden <svg id="icon-sprite"> right after <body>.  For static builds
        // astro:build:done already does this, so the script finds nothing.
        // For dev SSR the symbols are scattered in-place – the script moves
        // them into the central sprite.
        injectScript("head-inline", `
document.addEventListener("DOMContentLoaded",function(){
  var s=document.querySelectorAll('symbol[id^="icon:"]');
  if(!s.length)return;
  var sp=document.getElementById("icon-sprite");
  var cr=!sp;
  if(!sp){sp=document.createElementNS("http://www.w3.org/2000/svg","svg");sp.id="icon-sprite";sp.setAttribute("aria-hidden","true");sp.style.display="none";}
  var seen=new Set;
  for(var i=0;i<s.length;i++){var sym=s[i],id=sym.getAttribute("id");if(!id||seen.has(id)){sym.remove();continue}seen.add(id);sp.appendChild(sym);}
  if(cr)document.body.insertBefore(sp,document.body.firstChild);
});
`);
      },
      "astro:build:done"({ dir }) {
        return collectSpriteIntoBody(dir);
      },
    },
  };
}

async function collectSpriteIntoBody(dir: URL): Promise<void> {
  const outDir = dir.pathname;
  const htmlFiles: string[] = [];

  async function walk(d: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry);
      let s: Stats;
      try {
        s = await stat(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        await walk(full);
      } else if (entry.endsWith(".html")) {
        htmlFiles.push(full);
      }
    }
  }

  await walk(outDir);

  for (const filePath of htmlFiles) {
    try {
      const html = await readFile(filePath, "utf-8");
      if (html.includes('<svg id="icon-sprite"')) continue;

      // Extract all <symbol id="icon:..."> elements from the HTML
      const symbols: string[] = [];
      const seenIds = new Set<string>();
      const extracted = html.replace(
        /<symbol[^>]*?\s+id="(icon:[^"]+)"[^>]*>.*?<\/symbol>/gs,
        (match, id) => {
          if (!seenIds.has(id)) {
            seenIds.add(id);
            symbols.push(match);
          }
          return "";
        },
      );

      if (symbols.length === 0) continue;

      const sprite = `<svg id="icon-sprite" aria-hidden="true" style="display:none">\n${symbols.join("\n")}\n</svg>`;
      const updated = extracted.replace("<body>", `<body>\n${sprite}\n`);
      await writeFile(filePath, updated, "utf-8");
    } catch {
      // skip unreadable files
    }
  }
}
