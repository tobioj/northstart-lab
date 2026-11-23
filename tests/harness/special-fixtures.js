// Special-condition fixtures without public hostnames (never deployed, never given DNS):
//   1. Google /sorry/   protocol-level fixture: the classifier input (URL, status, body text) only.
//   2. Proxy gateway    local gateways that answer 407 / 502 (and an unreachable port) so the
//                       browser produces real transport errors at chrome-error://chromewebdata/.
// The YouTube account gate is a regular parent-origin lane (/scenario/youtube-account-gate/{token}).
import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';

export const SPECIAL = JSON.parse(readFileSync(new URL('./special-fixtures.json', import.meta.url), 'utf8'));

/** The Google /sorry/ classifier input. Built in memory; never served by any origin or browser. */
export function googleSorryObservation() {
  const f = SPECIAL.googleRateLimit;
  return { url: f.url, status: f.status, headers: { ...f.headers }, text: f.text };
}

/**
 * A local "proxy" that fails every CONNECT tunnel (and plain request) with a fixed status.
 * Records what it saw (method + target + status) as protocol evidence.
 * @param {{status: 407|502, port?: number}} o
 */
export function startFailingGateway({ status = 502, port = 0 } = {}) {
  const seen = [];
  const reason = status === 407 ? 'Proxy Authentication Required' : 'Bad Gateway';
  const extra = status === 407 ? 'Proxy-Authenticate: Basic realm="northstar-fixture"\r\n' : '';
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, target: String(req.url).slice(0, 200), status });
    // Empty body: Chromium then shows its own error document ("HTTP ERROR <status>") at
    // chrome-error://chromewebdata/ instead of rendering a hosted page.
    res.writeHead(status, { 'content-length': '0', connection: 'close', ...(status === 407 ? { 'proxy-authenticate': 'Basic realm="northstar-fixture"' } : {}) });
    res.end();
  });
  server.on('clientError', (err, socket) => socket.destroy());
  server.on('connect', (req, socket) => {
    socket.on('error', () => {}); // the browser may reset the tunnel socket first
    seen.push({ method: 'CONNECT', target: String(req.url).slice(0, 200), status });
    socket.end(`HTTP/1.1 ${status} ${reason}\r\n${extra}Content-Length: 0\r\nConnection: close\r\n\r\n`);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, seen })));
}

/** Reserve then release a loopback port so nothing listens on it (unreachable proxy). */
export function findClosedPort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
