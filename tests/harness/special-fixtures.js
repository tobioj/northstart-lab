// Local-only special-condition fixtures (never deployed, never given public DNS):
//   1. Google /sorry/ rate-limit page   2. YouTube account-confirmation gate
//   3. Browser proxy gateway error (a local gateway that returns 502, plus an unreachable proxy port)
import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { escapeHtml } from '../../functions/render.js';

export const SPECIAL = JSON.parse(readFileSync(new URL('./special-fixtures.json', import.meta.url), 'utf8'));

function page(title, text) {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
    `<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></main></body></html>\n`;
}

/** Render a special fixture response without any network: { status, headers, body }. */
export function renderSpecial(name) {
  const f = SPECIAL[name];
  return {
    status: f.status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    body: page(f.title, f.text),
  };
}

/** HTTP server for the harness fixtures (google sorry + youtube gate), loopback only. */
export function startHarnessServer({ port = 0 } = {}) {
  const server = http.createServer((req, res) => {
    const host = String(req.headers.host || '').split(':')[0].toLowerCase();
    const path = new URL(req.url, 'http://x').pathname;
    if (host !== SPECIAL.harnessHost) { res.writeHead(421, { 'content-type': 'text/plain' }); return res.end('unknown host\n'); }
    const match = ['googleRateLimit', 'youtubeGate'].find((k) => SPECIAL[k].localPath === path);
    if (!match) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found\n'); }
    const r = renderSpecial(match);
    res.writeHead(r.status, r.headers);
    res.end(r.body);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

/** A local "proxy" that fails every request and CONNECT tunnel with 502 Bad Gateway. */
export function startFailingGateway({ port = 0 } = {}) {
  const server = http.createServer((req, res) => {
    res.writeHead(502, { 'content-type': 'text/plain', connection: 'close' });
    res.end('Bad Gateway\n');
  });
  server.on('connect', (req, socket) => {
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

/** Reserve then release a loopback port so nothing listens on it (unreachable proxy). */
export function findClosedPort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
