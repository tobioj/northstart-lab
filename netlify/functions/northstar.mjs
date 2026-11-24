// Netlify adapter (Functions v2, Web-standard Request/Response). Handles every path on every
// hostname attached to the site; the handler picks the role from the Host header.
// Uses strong-consistency Netlify Blobs in Netlify runtime and falls back to MemoryStore locally.
import { handleRequest } from '../../functions/handler.js';
import { MemoryStore } from '../../functions/state.js';
import { createNetlifyBlobsStore } from '../../functions/netlify-blobs-store.js';

const fallbackStore = new MemoryStore();

export default async (request) => {
  const store = await createNetlifyBlobsStore({ env: process.env, fallback: fallbackStore });
  return handleRequest(request, process.env, { store });
};

export const config = { path: '/*', preferStatic: false };
