// Page image cache and request queue.
//
// * Results are cached as object URLs keyed by everything that affects the pixels.
// * Thumbnails and full-page views have separate budgets, so a few large page
//   renders never push out the thumbnails of a long document (and vice versa).
// * Thumbnail requests are queued newest-first with limited concurrency and are
//   dropped if their thumbnail scrolls out of view before they start.
// * Page-view requests skip the queue (the backend gives them their own worker).

import { api, type RenderRequest } from "./api";

type Kind = RenderRequest["priority"];
const MB = 1024 * 1024;
/**
 * Encoded bytes kept alive per kind. Thumbnail JPEGs are ~20-40 KB, so the thumbnail
 * budget holds both sizes (grid and filmstrip) for a 1000-page document. Page views
 * are PNGs of 1-4 MB each, so only the pages around the reader are kept.
 */
export const BUDGET: Record<Kind, { entries: number; bytes: number }> = {
  thumb: { entries: 3000, bytes: 96 * MB },
  view: { entries: 48, bytes: 128 * MB },
};
const THUMB_CONCURRENCY = 3;

interface Entry {
  url: string;
  size: number;
  kind: Kind;
}
const cache = new Map<string, Entry>(); // key -> entry (Map keeps LRU order)
const used: Record<Kind, { entries: number; bytes: number }> = {
  thumb: { entries: 0, bytes: 0 },
  view: { entries: 0, bytes: 0 },
};
const inflight = new Map<string, Promise<string>>();

interface Job {
  key: string;
  req: RenderRequest;
  resolve: (url: string) => void;
  reject: (e: unknown) => void;
  signal?: AbortSignal;
}
const queue: Job[] = [];
let active = 0;

function hash(str: string): string {
  // cyrb53
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

export function renderKey(req: RenderRequest): string {
  const { priority: _ignored, ...rest } = req;
  return hash(JSON.stringify(rest));
}

/** Drops the least recently used entries of one kind until it fits its budget. */
function evict(kind: Kind) {
  const u = used[kind];
  const b = BUDGET[kind];
  while (u.entries > 1 && (u.entries > b.entries || u.bytes > b.bytes)) {
    for (const [key, e] of cache) {
      if (e.kind !== kind) continue;
      cache.delete(key);
      u.entries -= 1;
      u.bytes -= e.size;
      // Safe: an <img> that already loaded this URL keeps its image.
      URL.revokeObjectURL(e.url);
      break;
    }
  }
}

function store(key: string, blob: Blob, kind: Kind): string {
  const url = URL.createObjectURL(blob);
  cache.set(key, { url, size: blob.size, kind });
  used[kind].entries += 1;
  used[kind].bytes += blob.size;
  evict(kind);
  return url;
}

export function cached(req: RenderRequest): string | undefined {
  const key = renderKey(req);
  const e = cache.get(key);
  if (e) {
    cache.delete(key);
    cache.set(key, e);
  }
  return e?.url;
}

function run(job: Job) {
  active += 1;
  const p = api
    .renderPage(job.req)
    .then((blob) => store(job.key, blob, "thumb"))
    .finally(() => {
      inflight.delete(job.key);
      active -= 1;
      pump();
    });
  inflight.set(job.key, p);
  p.then(job.resolve, job.reject);
}

function pump() {
  while (active < THUMB_CONCURRENCY && queue.length > 0) {
    const job = queue.pop()!; // newest first: what the user is looking at now
    if (job.signal?.aborted) {
      job.reject(new DOMException("Aborted", "AbortError"));
      continue;
    }
    const existing = inflight.get(job.key);
    if (existing) {
      existing.then(job.resolve, job.reject);
      continue;
    }
    run(job);
  }
}

export function requestRender(req: RenderRequest, signal?: AbortSignal): Promise<string> {
  const hit = cached(req);
  if (hit) return Promise.resolve(hit);
  const key = renderKey(req);
  const existing = inflight.get(key);
  if (existing) return existing;

  if (req.priority === "view") {
    const p = api
      .renderPage(req)
      .then((blob) => store(key, blob, "view"))
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  return new Promise<string>((resolve, reject) => {
    const job: Job = { key, req, resolve, reject, signal };
    queue.push(job);
    signal?.addEventListener("abort", () => {
      const i = queue.indexOf(job);
      if (i >= 0) {
        queue.splice(i, 1);
        reject(new DOMException("Aborted", "AbortError"));
      }
    });
    pump();
  });
}
