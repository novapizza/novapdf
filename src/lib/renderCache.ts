// Page image cache and request queue.
//
// * Results are cached as object URLs keyed by everything that affects the pixels.
// * Thumbnail requests are queued newest-first with limited concurrency and are
//   dropped if their thumbnail scrolls out of view before they start.
// * Page-view requests skip the queue (the backend gives them their own worker).

import { api, type RenderRequest } from "./api";

const MAX_ENTRIES = 600;
/** Full-page renders are large; cap the decoded-file bytes we keep alive. */
const MAX_BYTES = 384 * 1024 * 1024;
const THUMB_CONCURRENCY = 3;

const cache = new Map<string, string>(); // key -> object URL (Map keeps LRU order)
const sizes = new Map<string, number>();
let totalBytes = 0;
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

function store(key: string, blob: Blob): string {
  const url = URL.createObjectURL(blob);
  cache.set(key, url);
  sizes.set(key, blob.size);
  totalBytes += blob.size;
  while (cache.size > MAX_ENTRIES || (totalBytes > MAX_BYTES && cache.size > 1)) {
    const [oldKey, oldUrl] = cache.entries().next().value as [string, string];
    cache.delete(oldKey);
    totalBytes -= sizes.get(oldKey) ?? 0;
    sizes.delete(oldKey);
    // Safe: an <img> that already decoded this URL keeps showing it.
    URL.revokeObjectURL(oldUrl);
  }
  return url;
}

export function cached(req: RenderRequest): string | undefined {
  const key = renderKey(req);
  const url = cache.get(key);
  if (url) {
    cache.delete(key);
    cache.set(key, url);
  }
  return url;
}

function run(job: Job) {
  active += 1;
  const p = api
    .renderPage(job.req)
    .then((blob) => store(job.key, blob))
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
      .then((blob) => store(key, blob))
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
