import http from 'node:http';
import { startServer } from '../functions/node-adapter.js';

/** HTTP request to 127.0.0.1 with an explicit Host header (no DNS involved). */
export function request({ port, host, path = '/', method = 'GET', headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { host: `${host}:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Start a server with the given env and capture its log lines. */
export async function withServer(env, fn) {
  const logs = [];
  const { server, port } = await startServer({ env, port: 0, log: (l) => logs.push(l) });
  try { return await fn({ port, logs }); } finally { server.close(); }
}

/** Extract same-origin script/iframe URLs from lane HTML. */
export function extractResources(html) {
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1].replaceAll('&amp;', '&'));
  const frames = [...html.matchAll(/<iframe[^>]+src="([^"]+)"/g)].map((m) => m[1].replaceAll('&amp;', '&'));
  return { scripts, frames };
}
