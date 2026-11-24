// Strong-consistency Netlify Blobs store adapter for Northstar Lab serverless deployments.
// Uses @netlify/blobs getStore({ name: 'northstar-state', consistency: 'strong' }) so
// POST /api/runs, multi-step Vision /api/input|verify|settle, /complete/{token}, and
// GET /api/evidence/{token} see read-after-write consistency across Netlify function instances.
// Falls back cleanly to MemoryStore locally when Netlify Blobs runtime context is absent.

import { MemoryStore } from './state.js';

export const NETLIFY_STORE_NAME = 'northstar-state';
export const NETLIFY_STORE_CONSISTENCY = 'strong';
const DEFAULT_PREFIX = 'ns:';

export class NetlifyBlobsStore {
  constructor(blobStore, { prefix = DEFAULT_PREFIX } = {}) {
    if (!blobStore || typeof blobStore.get !== 'function' || typeof blobStore.list !== 'function') {
      throw new Error('Valid Netlify Blobs store instance is required');
    }
    this.blobStore = blobStore;
    this.prefix = prefix;
  }

  async get(id) {
    if (!id) return null;
    const record = await this.blobStore.get(this.prefix + id, { type: 'json' });
    return record || null;
  }

  async put(id, record) {
    if (!id) return;
    if (typeof this.blobStore.setJSON === 'function') {
      await this.blobStore.setJSON(this.prefix + id, record);
      return;
    }
    await this.blobStore.set(this.prefix + id, JSON.stringify(record));
  }

  async list() {
    const listed = await this.blobStore.list({ prefix: this.prefix });
    const blobs = Array.isArray(listed && listed.blobs) ? listed.blobs : [];
    const entries = [];
    for (const item of blobs) {
      if (!item || typeof item.key !== 'string' || !item.key.startsWith(this.prefix)) continue;
      const record = await this.blobStore.get(item.key, { type: 'json' });
      if (record) entries.push({ id: item.key.slice(this.prefix.length), record });
    }
    return entries;
  }
}

export function isNetlifyBlobsEnvironment(env) {
  if (globalThis.Netlify && globalThis.Netlify.context) return true;
  if (!env || typeof env !== 'object') return false;
  return Boolean(env.NETLIFY === 'true' || env.NETLIFY_BLOBS_CONTEXT || env.SITE_ID);
}

/**
 * Create a strong-consistency NetlifyBlobsStore when running inside Netlify's runtime
 * (or when a getStoreFn test double is injected); otherwise fall back cleanly to MemoryStore.
 */
export async function createNetlifyBlobsStore({ env = {}, getStoreFn = null, fallback = null } = {}) {
  const defaultFallback = fallback || new MemoryStore();
  if (typeof getStoreFn === 'function') {
    const raw = getStoreFn({ name: NETLIFY_STORE_NAME, consistency: NETLIFY_STORE_CONSISTENCY });
    return new NetlifyBlobsStore(raw);
  }
  if (!isNetlifyBlobsEnvironment(env)) {
    return defaultFallback;
  }
  try {
    const mod = await import('@netlify/blobs');
    if (typeof mod.getStore !== 'function') return defaultFallback;
    const raw = mod.getStore({ name: NETLIFY_STORE_NAME, consistency: NETLIFY_STORE_CONSISTENCY });
    return new NetlifyBlobsStore(raw);
  } catch {
    return defaultFallback;
  }
}
