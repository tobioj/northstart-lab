// Cloudflare Workers adapter (also usable as Cloudflare Pages "_worker.js" advanced mode).
// Non-secret configuration arrives as [vars] in wrangler.toml; nothing secret is needed.
import { handleRequest } from './functions/handler.js';

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};
