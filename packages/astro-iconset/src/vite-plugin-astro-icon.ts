import type { AstroConfig, AstroIntegrationLogger } from "astro";
import { createHash } from "node:crypto";
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Plugin } from "vite";
import type {
  AstroIconCollectionMap,
  IconCollection,
  IntegrationOptions,
} from "../typings/integration";
import {
  loadLocalCollectionFromDir,
  loadMergedLocalIconDirs,
} from "./loaders/loadLocalCollection.js";
import loadIconifyCollections from "./loaders/loadIconifyCollections.js";
import processSvgFile from "./loaders/processSvgFile.js";

interface PluginContext extends Pick<AstroConfig, "root" | "output"> {
  logger: AstroIntegrationLogger;
}

const DEFAULT_ICON_DIR = "src/icons";

function validateIconifyPrefixKey(key: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(key)) {
    throw new Error(
      `[astro-iconset] Invalid iconDirs key "${key}". Use a lowercase Iconify-style prefix (letters, digits, hyphens).`,
    );
  }
}

function dedupeResolvedPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const n = normalize(p);
    if (seen.has(n)) {
      throw new Error(
        `[astro-iconset] Duplicate iconDir path after resolve: "${p}"`,
      );
    }
    seen.add(n);
    out.push(p);
  }
  return out;
}

function resolveLocalIconConfig(opts: IntegrationOptions, root: URL) {
  const rootPath = fileURLToPath(root);
  const { iconDirs } = opts;

  if (
    iconDirs?.local !== undefined &&
    "iconDir" in opts &&
    opts.iconDir !== undefined
  ) {
    throw new Error(
      "[astro-iconset] Use either `iconDir` or `iconDirs.local`, not both.",
    );
  }

  let localRelPaths: string[];
  if (iconDirs?.local !== undefined) {
    localRelPaths = [iconDirs.local];
  } else {
    const raw = opts.iconDir !== undefined ? opts.iconDir : DEFAULT_ICON_DIR;
    if (Array.isArray(raw)) {
      if (raw.length === 0) {
        throw new Error("[astro-iconset] iconDir cannot be an empty array.");
      }
      localRelPaths = raw;
    } else {
      localRelPaths = [raw];
    }
  }

  const localRootsAbs = dedupeResolvedPaths(
    localRelPaths.map((p) => resolve(rootPath, p)),
  );

  const namedDirs: Record<string, string> = {};
  if (iconDirs) {
    for (const [prefix, relPath] of Object.entries(iconDirs)) {
      if (prefix === "local") {
        continue;
      }
      validateIconifyPrefixKey(prefix);
      namedDirs[prefix] = resolve(rootPath, relPath);
    }
  }

  const seenPaths = new Set(localRootsAbs.map((p) => normalize(p)));
  for (const [prefix, absPath] of Object.entries(namedDirs)) {
    const n = normalize(absPath);
    if (seenPaths.has(n)) {
      throw new Error(
        `[astro-iconset] Directory "${absPath}" is used more than once (iconDirs.${prefix} overlaps another icon path).`,
      );
    }
    seenPaths.add(n);
  }

  const watchRoots = [...localRootsAbs, ...Object.values(namedDirs)];

  const localLabel =
    localRelPaths.length === 1 ? localRelPaths[0]! : localRelPaths.join(", ");

  return { localRootsAbs, namedDirs, watchRoots, localLabel };
}

function pathIsUnderAnyRoot(filePath: string, roots: string[]): boolean {
  const f = normalize(filePath);
  for (const r of roots) {
    const root = normalize(r);
    if (f === root || f.startsWith(root + sep)) {
      return true;
    }
  }
  return false;
}

export function createPlugin(
  opts: IntegrationOptions,
  ctx: PluginContext,
): Plugin {
  let collections: AstroIconCollectionMap | undefined;
  const { root } = ctx;
  const virtualModuleId = "virtual:astro-iconset";
  const resolvedVirtualModuleId = "\0" + virtualModuleId;
  const { include = {}, svgoOptions } = opts;
  const { localRootsAbs, namedDirs, watchRoots, localLabel } =
    resolveLocalIconConfig(opts, root);

  async function loadFilesystemCollections(): Promise<void> {
    collections = await loadIconifyCollections({ root, include });

    for (const prefix of Object.keys(namedDirs)) {
      if (collections[prefix]) {
        throw new Error(
          `[astro-iconset] Icon set prefix "${prefix}" conflicts with an installed @iconify-json collection. Rename the iconDirs key or adjust dependencies/include.`,
        );
      }
    }

    if (localRootsAbs.length > 0) {
      const local = await loadMergedLocalIconDirs(localRootsAbs, svgoOptions);
      collections["local"] = local;
    }

    for (const [prefix, absPath] of Object.entries(namedDirs)) {
      collections[prefix] = await loadLocalCollectionFromDir(
        absPath,
        prefix,
        svgoOptions,
      );
    }

    logCollections(collections, ctx, { localLabel });
    await generateIconTypeDefinitions(Object.values(collections), root);
  }

  const localIconSets = [
    ...(localRootsAbs.length > 0 ? (["local"] as const) : []),
    ...Object.keys(namedDirs),
  ];

  return {
    name: "astro-iconset",
    enforce: "pre",
    async resolveId(id, importer) {
      if (id === virtualModuleId) {
        return resolvedVirtualModuleId;
      }
      if (id.startsWith("\0icon-import:")) {
        return id;
      }
      if (!hasIconQuery(id)) return;
      const clean = stripQuery(id);
      if (!clean.endsWith(".svg")) return;

      // Let Vite resolve aliases and absolute/relative paths
      const resolved = await this.resolve(clean, importer, {
        skipSelf: true,
      });
      if (!resolved) {
        return;
      }
      const abs = normalize(resolved.id);

      const token = Buffer.from(abs, "utf-8").toString("base64url");
      return `\0icon-import:${token}`;
    },

    async load(id) {
      if (id.startsWith("\0icon-import:")) {
        const token = id.slice("\0icon-import:".length);
        const filePath = Buffer.from(token, "base64url").toString("utf-8");
        this.addWatchFile(filePath);
        try {
          const icon = await processSvgFile(filePath, svgoOptions);
          return `export default ${JSON.stringify(icon)}`;
        } catch (ex) {
          ctx.logger.error(
            `[astro-iconset] Failed to load ${filePath}: ${ex instanceof Error ? ex.message : String(ex)}`,
          );
          throw ex;
        }
      }
      if (id === resolvedVirtualModuleId) {
        try {
          await loadFilesystemCollections();
        } catch (ex) {
          const message = ex instanceof Error ? ex.message : String(ex);
          ctx.logger.error(`[astro-iconset] Failed to load icon collections: ${message}`);
          throw new Error(`[astro-iconset] Build aborted: could not load icon collections. ${message}`);
        }
        return `export default ${JSON.stringify(collections ?? {})};\nexport const config = ${JSON.stringify({ include, localIconSets })}`;
      }
    },
    configureServer(server) {
      const { watcher, moduleGraph } = server;
      for (const r of watchRoots) {
        watcher.add(join(r, "**", "*.svg"));
      }
      watcher.on("all", async (_, filepath: string) => {
        const parsedPath = parse(filepath);
        const isSvgFileInIconDir =
          pathIsUnderAnyRoot(filepath, watchRoots) && parsedPath.ext === ".svg";
        const isAstroConfig = parsedPath.name === "astro.config";
        if (!isSvgFileInIconDir && !isAstroConfig) return;
        ctx.logger.info(`Local icons changed, reloading`);
        try {
          collections = undefined;
          await loadFilesystemCollections();
          moduleGraph.invalidateAll();
          server.ws.send({ type: "full-reload" });
        } catch (ex) {
          ctx.logger.error(
            `[astro-iconset] Failed to reload icon collections: ${ex instanceof Error ? ex.message : String(ex)}`,
          );
        }
      });
    },
  };
}

function logCollections(
  collections: AstroIconCollectionMap,
  { logger }: PluginContext,
  { localLabel }: { localLabel: string },
) {
  if (Object.keys(collections).length === 0) {
    logger.warn("No icons detected!");
    return;
  }
  const parts: string[] = [];
  for (const k of Object.keys(collections)) {
    if (k === "local") {
      parts.push(`local (${localLabel})`);
    } else {
      parts.push(k);
    }
  }
  logger.info(`Loaded icons from ${parts.join(", ")}`);
}

async function generateIconTypeDefinitions(
  collections: IconCollection[],
  rootDir: URL,
  defaultPack = "local",
): Promise<void> {
  const typeFile = new URL("./.astro/icon.d.ts", rootDir);
  await ensureDir(new URL("./", typeFile));
  const oldHash = await tryGetHash(typeFile);
  const currentHash = collectionsHash(collections);
  if (currentHash === oldHash) {
    return;
  }
  await writeFile(
    typeFile,
    `// Automatically generated by astro-iconset
// ${currentHash}

declare module 'virtual:astro-iconset' {
\texport type Icon = ${
      collections.length > 0
        ? collections
            .map((collection) =>
              Object.keys(collection.icons)
                .concat(Object.keys(collection.aliases ?? {}))
                .map(
                  (icon) =>
                    `\n\t\t| "${
                      collection.prefix === defaultPack
                        ? ""
                        : `${collection.prefix}:`
                    }${icon}"`,
                ),
            )
            .flat(1)
            .join("")
        : "never"
    };
}`,
  );
}

function collectionsHash(collections: IconCollection[]): string {
  const hash = createHash("sha256");
  for (const collection of collections) {
    hash.update(collection.prefix);
    hash.update(
      Object.keys(collection.icons)
        .concat(Object.keys(collection.aliases ?? {}))
        .sort()
        .join(","),
    );
  }
  return hash.digest("hex");
}

async function tryGetHash(path: URL): Promise<string | void> {
  try {
    const text = await readFile(path, { encoding: "utf-8" });
    return text.split("\n", 3)[1]?.replace("// ", "");
  } catch {}
}

async function ensureDir(path: URL): Promise<void> {
  try {
    await mkdir(path, { recursive: true });
  } catch {}
}

function hasIconQuery(id: string): boolean {
  const q = id.indexOf("?");
  if (q === -1) return false;
  const query = id.slice(q + 1);
  for (const part of query.split("&")) {
    const key = part.split("=", 1)[0];
    if (key === "icon") return true;
  }
  return false;
}

function stripQuery(id: string): string {
  const q = id.indexOf("?");
  return q === -1 ? id : id.slice(0, q);
}
