import http from 'node:http';
import { startLab } from './harness/suite.js';

/** HTTP request to 127.0.0.1 with an explicit Host header (no DNS involved). */
export function request({ port, host, path = '/', method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { host: `${host}:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Start a lab (origins on a free port) and give the test a small client bound to it. */
export async function withLab(opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  const lab = await startLab(opts);
  const at = (role) => (path, o = {}) => request({ port: lab.port, host: lab.hosts[role], path, ...o });
  const client = {
    ...lab,
    parent: at('parent'),
    widget: at('widget'),
    verify: at('verify'),
    raw: (host, path, o = {}) => request({ port: lab.port, host, path, ...o }),
    /** Issue a token through the public parent route. */
    async issue(route) {
      const r = await at('parent')(`/scenario/${route}`);
      if (r.status !== 303) throw new Error(`issue ${route}: ${r.status}`);
      return r.headers.location.split('/').pop();
    },
    /** Request from a page on the parent origin. */
    fromParent: () => ({ referer: `${lab.origins.parent}/` }),
    api: (step, token, o = {}) => at('verify')(`/api/${step}/${token}`, {
      method: step === 'status' ? 'GET' : 'POST',
      ...o,
      headers: { origin: lab.origins.parent, ...(step === 'input' ? { 'content-type': 'application/json' } : {}), ...(o.headers || {}) },
      body: step === 'input' && o.body === undefined ? '{"value":"acknowledged"}' : o.body,
    }),
  };
  try { return await fn(client); } finally { await lab.close(); }
}

/** Extract script/iframe/img URLs from lane HTML. */
export function extractResources(html) {
  const grab = (re) => [...html.matchAll(re)].map((m) => m[1].replaceAll('&amp;', '&'));
  return {
    scripts: grab(/<script[^>]+src="([^"]+)"/g),
    frames: grab(/<iframe[^>]+src="([^"]+)"/g),
    images: grab(/<img[^>]+src="([^"]+)"/g),
  };
}
