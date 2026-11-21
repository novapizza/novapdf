// Page image cache and request queues.
//
// * Results are cached as object URLs keyed by everything that affects the pixels.
// * Thumbnails and full-page views have separate budgets, so a few large page
//   renders never push out the thumbnails of a long document (and vice versa).
// * Thumbnail requests are queued newest-first with limited concurrency and are
//   dropped if their thumbnail scrolls out of view before they start.
// * Page-view requests have their own lane (the backend gives them their own
//   worker, which renders one page at a time). Only a couple are sent at once, so
//   the lane can still reorder: the page with the lowest rank (the one the reader
//   is looking at) goes first, and pages that left the view before starting are
//   dropped. Jumping far into a document therefore never waits behind renders of
//   pages it scrolled past.

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
/** Requests sent to the backend at once, per kind. Two views keep the worker busy
 *  (one rendering, one waiting in the pipe) while leaving the rest reorderable. */
export const CONCURRENCY: Record<Kind, number> = { thumb: 3, view: 2 };

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

/** Lower runs sooner. Read when the job is picked, so it can change while it waits. */
export type Rank = () => number;

interface Job {
  key: string;
  req: RenderRequest;
  resolve: (url: string) => void;
  reject: (e: unknown) => void;
  signal?: AbortSignal;
  rank?: Rank;
}
const queues: Record<Kind, Job[]> = { thumb: [], view: [] };
const active: Record<Kind, number> = { thumb: 0, view: 0 };

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

function run(kind: Kind, job: Job) {
  active[kind] += 1;
  const p = api
    .renderPage(job.req)
    .then((blob) => store(job.key, blob, kind))
    .finally(() => {
      inflight.delete(job.key);
      active[kind] -= 1;
      pump(kind);
    });
  inflight.set(job.key, p);
  p.then(job.resolve, job.reject);
}

/** Index of the next job: thumbnails newest first (what the user is looking at now),
 *  views by rank, oldest first among equals. */
function next(kind: Kind, queue: Job[]): number {
  if (kind === "thumb") return queue.length - 1;
  let best = 0;
  let bestRank = Infinity;
  for (let i = 0; i < queue.length; i++) {
    const r = queue[i].rank?.() ?? 0;
    if (r < bestRank) {
      best = i;
      bestRank = r;
    }
  }
  return best;
}

function pump(kind: Kind) {
  const queue = queues[kind];
  while (active[kind] < CONCURRENCY[kind] && queue.length > 0) {
    const [job] = queue.splice(next(kind, queue), 1);
    if (job.signal?.aborted) {
      job.reject(new DOMException("Aborted", "AbortError"));
      continue;
    }
    const existing = inflight.get(job.key);
    if (existing) {
      existing.then(job.resolve, job.reject);
      continue;
    }
    run(kind, job);
  }
}

/**
 * Renders a page (or returns the cached image). `signal` drops the request if it is
 * aborted before it starts; `rank` orders queued page views (lower first).
 */
export function requestRender(req: RenderRequest, signal?: AbortSignal, rank?: Rank): Promise<string> {
  const hit = cached(req);
  if (hit) return Promise.resolve(hit);
  const key = renderKey(req);
  const existing = inflight.get(key);
  if (existing) return existing;

  const kind = req.priority;
  const queued = new Promise<string>((resolve, reject) => {
    const job: Job = { key, req, resolve, reject, signal, rank };
    queues[kind].push(job);
    signal?.addEventListener("abort", () => {
      const i = queues[kind].indexOf(job);
      if (i >= 0) {
        queues[kind].splice(i, 1);
        reject(new DOMException("Aborted", "AbortError"));
      }
    });
    pump(kind);
  });
  // Started right away: hand out the shared in-flight promise, like a duplicate would get.
  const started = inflight.get(key);
  if (!started) return queued;
  queued.catch(() => {}); // its outcome is reported through `started`
  return started;
}
