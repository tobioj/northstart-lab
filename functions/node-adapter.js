// Node http adapter (local development and generic Node hosting).
import http from 'node:http';
import { handleRequest } from './handler.js';
import { MemoryStore } from './state.js';
import { TOKEN_IN_TEXT } from './tokens.js';

// Only these request headers reach the handler (no cookies, no forwarding headers).
const FORWARDED = [
  'origin', 'referer', 'accept', 'content-type', 'authorization',
  'access-control-request-method', 'access-control-request-headers',
  'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest',
];
const MAX_BODY = 4096;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Paths are logged without query strings and with scenario tokens redacted. */
export function redactPath(path) {
  return path.replace(TOKEN_IN_TEXT, '<token>').slice(0, 200);
}

/**
 * @param {object} o
 * @param {Record<string,string>} o.env
 * @param {(event: object) => (void|Promise<void>)} [o.onEvidence]  receives settled receipts
 */
export function startServer({ env, port = 0, bind = '127.0.0.1', log = (line) => console.log(line), store = new MemoryStore(), onEvidence, now } = {}) {
  const ctx = { store, onEvidence, now };
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const hostHeader = String(req.headers.host || '');
    let pathOnly = '/';
    let status = 500;
    try {
      let url = null;
      if (/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(hostHeader)) {
        try { url = new URL(`http://${hostHeader}${req.url}`); } catch { url = null; }
      }
      let response;
      // Exact routing: raw dot segments are refused instead of being silently normalized.
      const rawPath = String(req.url || '').split('?')[0];
      if (/(^|\/)\.{1,2}(\/|$)/.test(rawPath) || /%2e/i.test(rawPath)) url = null;
      if (!url) {
        response = new Response('Bad request\n', { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      } else {
        pathOnly = url.pathname;
        const headers = {};
        for (const h of FORWARDED) if (typeof req.headers[h] === 'string') headers[h] = req.headers[h];
        const method = String(req.method || 'GET').toUpperCase();
        const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
        response = await handleRequest(new Request(url, { method, headers, body }), env, ctx);
      }
      status = response.status;
      const out = {};
      response.headers.forEach((v, k) => { out[k] = v; });
      res.writeHead(status, out);
      if (req.method === 'HEAD' || response.body === null) res.end();
      else res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      status = status === 500 ? 500 : status;
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Internal error\n');
    } finally {
      // Method, host, redacted path (no query string), status, timing. Never headers, bodies or config.
      const safeHost = hostHeader.replace(/[^A-Za-z0-9.:-]/g, '?').slice(0, 100);
      log(`${req.method} ${safeHost} ${redactPath(pathOnly)} ${status} ${Date.now() - started}ms`);
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, () => resolve({ server, port: server.address().port, store }));
  });
}
