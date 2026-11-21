// Cache of extracted page text, shared by the page surfaces and paragraph linking.

import { api } from "./api";
import type { PageText } from "./types";

const MAX_ENTRIES = 500;
const cache = new Map<string, Promise<PageText>>(); // insertion order = LRU order

export function loadPageText(docId: number, pageIndex: number): Promise<PageText> {
  const key = `${docId}:${pageIndex}`;
  let p = cache.get(key);
  if (p) {
    cache.delete(key);
    cache.set(key, p);
    return p;
  }
  p = api.extractPage(docId, pageIndex);
  p.catch(() => cache.delete(key));
  cache.set(key, p);
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  return p;
}


