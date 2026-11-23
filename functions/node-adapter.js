// Node http adapter (local development and generic Node hosting).
import http from 'node:http';
import { handleRequest } from './handler.js';

const FORWARDED = ['origin', 'accept', 'access-control-request-method'];

export function startServer({ env, port = 0, bind = '127.0.0.1', log = (line) => console.log(line) } = {}) {
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
      if (!url) {
        response = new Response('Bad request\n', { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      } else {
        pathOnly = url.pathname;
        const headers = {};
        for (const h of FORWARDED) if (typeof req.headers[h] === 'string') headers[h] = req.headers[h];
        response = await handleRequest(new Request(url, { method: req.method, headers }), env);
      }
      status = response.status;
      const out = {};
      response.headers.forEach((v, k) => { out[k] = v; });
      res.writeHead(status, out);
      if (req.method === 'HEAD' || response.body === null) res.end();
      else res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      status = 500;
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Internal error\n');
    } finally {
      // Method, host, path (no query string), status, timing. Never headers or config.
      const safeHost = hostHeader.replace(/[^A-Za-z0-9.:-]/g, '?').slice(0, 100);
      log(`${req.method} ${safeHost} ${pathOnly.slice(0, 200)} ${status} ${Date.now() - started}ms`);
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, () => resolve({ server, port: server.address().port }));
  });
}
