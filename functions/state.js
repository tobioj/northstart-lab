// Per-instance scenario state (one record per token instance id).
//
// The default store is in-memory: correct for a single Node process (local, container, VM).
// On multi-instance serverless platforms the record may not be visible to every instance;
// token validation stays correct there because it is stateless, and an adapter can pass a
// shared store (Workers KV, Vercel KV, Netlify Blobs) with the same async interface.

export const STATES = ['issued', 'input', 'verified', 'settled', 'revoked'];

export class MemoryStore {
  constructor({ maxEntries = 10000 } = {}) {
    this.maxEntries = maxEntries;
    this.map = new Map();
  }

  async get(id) {
    return this.map.get(id) || null;
  }

  async put(id, record, now) {
    if (!this.map.has(id) && this.map.size >= this.maxEntries) this.#evict(now);
    this.map.set(id, record);
  }

  async list() {
    return [...this.map.entries()].map(([id, record]) => ({ id, record }));
  }

  #evict(now) {
    for (const [id, r] of this.map) if (r.expiresAt <= now) this.map.delete(id);
    while (this.map.size >= this.maxEntries) this.map.delete(this.map.keys().next().value);
  }
}

/** Fresh record for a validated token. */
export function newRecord(token) {
  return { code: token.code, state: 'issued', expiresAt: token.expiresAt, steps: {}, input: null, receipt: null };
}
