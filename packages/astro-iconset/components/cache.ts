export interface CacheEntry {
  count: number;
  body: string;
  viewBox: string;
}

export const cache = new WeakMap<Request, Map<string, CacheEntry>>();