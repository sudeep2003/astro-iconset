/// <reference types="vite/client" />
/// <reference path="../../typings/virtual.d.ts" />
import { getIconData, iconToSVG, replaceIDs } from "@iconify/utils";
import type { AstroIconCollectionMap } from "../../typings/integration";
import type { AstroIconImport } from "../../typings/astro-icon-import";
import collections_mod, { config } from "virtual:astro-iconset";

const _collections = ((collections_mod as any).default ?? collections_mod) as AstroIconCollectionMap;

const _config = config ?? {};

export interface ResolveIconInput {
  name?: string;
  icon?: AstroIconImport;
  size?: number | string;
  width?: number | string;
  height?: number | string;
  title?: string;
  desc?: string;
}

export interface ResolvedIcon {
  attrs: Record<string, string>;
  inner: string;
  symbolId: string;
  symbolBody: string;
  symbolViewBox: string;
  dataAttr?: {
    name: string;
    value: string;
  };
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function importedCacheKey(i: { body?: string; width?: number | string; height?: number | string }): string {
  let hash = 5381;
  const raw = `${i.body ?? ""}:${i.width ?? ""}:${i.height ?? ""}`;
  for (let j = 0; j < raw.length; j++) {
    hash = ((hash << 5) + hash) + raw.charCodeAt(j);
  }
  return `import:${(hash >>> 0).toString(36).padStart(7, "0")}`;
}

export function resolveIcon(input: ResolveIconInput, framework: string): ResolvedIcon {
  const { name, icon, size, width, height, title, desc } = input;

  if (icon != null && name != null) {
    throw new Error('[astro-iconset] Use either "name" or "icon", not both.');
  }
  if (icon == null && name == null) {
    throw new Error('[astro-iconset] Either "name" or "icon" must be provided.');
  }
  if (import.meta.env.DEV) {
    if (size != null && (width != null || height != null)) {
      console.warn('[astro-iconset] Use either "size" or "width"/"height", not both. "width"/"height" takes priority.');
    }
  }

  const resolvedWidth = width ?? size;
  const resolvedHeight = height ?? size;

  let body: string;
  let attrs: Record<string, string> = {};
  let symbolId: string;

  if (icon) {
    const renderData = iconToSVG(icon);
    body = replaceIDs(renderData.body);
    attrs = { ...(renderData.attributes as Record<string, string>) };
    symbolId = `icon:${importedCacheKey(icon)}`;
  } else {
    const iconName = name as string;
    const colonIdx = iconName.indexOf(":");
    const setName = colonIdx === -1 ? "local" : iconName.slice(0, colonIdx);
    const iconKey = colonIdx === -1 ? iconName : iconName.slice(colonIdx + 1);

    const collection = _collections[setName];
    if (!collection)
      throw new Error(`[astro-iconset/${framework}] Icon set "${setName}" not found. Available: ${Object.keys(_collections).join(", ")}`);

    const iconData = getIconData(collection, iconKey);
    if (!iconData)
      throw new Error(`[astro-iconset/${framework}] Icon "${iconKey}" not found in set "${setName}".`);

    const renderData = iconToSVG(iconData);
    body = replaceIDs(renderData.body);
    attrs = { ...(renderData.attributes as Record<string, string>) };
    symbolId = `icon:${collection.prefix}:${iconKey}`;
  }

  const viewBox = attrs.viewBox ?? "";

  if (resolvedWidth != null) attrs.width = String(resolvedWidth);
  if (resolvedHeight != null) attrs.height = String(resolvedHeight);

  const inner =
    (title ? `<title>${escapeHtml(title)}</title>` : "") +
    (desc ? `<desc>${escapeHtml(desc)}</desc>` : "") +
    body;

  const dataIconValue = icon ? "astro-iconset:import" : (name as string);

  const dataAttr =
    _config.dataAttr === false
      ? undefined
      : {
          name: _config.dataAttr ?? "data-icon",
          value: dataIconValue,
        };

  return { attrs, inner, symbolId, symbolBody: body, symbolViewBox: viewBox, dataAttr };
}
