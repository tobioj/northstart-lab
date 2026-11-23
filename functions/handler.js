// Platform-neutral Northstar Lab request handler.
// Signature: handleRequest(request: Request, env: object) => Promise<Response>
// Adapters (Node, Vercel, Netlify, Cloudflare) only translate in/out of this function.
// No filesystem, database, cookies, storage or logging of configuration values.
import { BUILD, LANES, PAGES, TEMPLATES, ASSETS } from './generated/data.js';
import { loadConfig, laneReadiness, configFingerprint } from '../configuration/config.js';
import { renderLanePage, contentSecurityPolicy } from './render.js';

const ENDPOINTS = ['/', '/healthz', '/readyz', '/fixture-manifest.json'];
const FIXTURE_SCRIPT = '/* Northstar controlled fixture resource. Intentionally inert. */\n';

const configCache = new WeakMap();
function configFor(env) {
  if (!env || typeof env !== 'object') return loadConfig({}, LANES);
  let cfg = configCache.get(env);
  if (!cfg) { cfg = loadConfig(env, LANES); configCache.set(env, cfg); }
  return cfg;
}

function baseHeaders(lane) {
  return {
    'cache-control': 'no-store',
    'content-security-policy': contentSecurityPolicy(lane),
    'x-frame-options': 'SAMEORIGIN',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    'cross-origin-opener-policy': 'same-origin',
    'x-robots-tag': 'noindex, nofollow',
  };
}

function respond(status, body, type, headers = {}) {
  return new Response(body, { status, headers: { 'content-type': type, ...headers } });
}
const json = (status, obj, headers) => respond(status, JSON.stringify(obj, null, 2) + '\n', 'application/json; charset=utf-8', headers);
const text = (status, body, headers) => respond(status, body, 'text/plain; charset=utf-8', headers);

function corsHeaders(request, config) {
  const origin = request.headers.get('origin');
  if (!origin || !config.allowedOrigins.includes(origin.toLowerCase())) return {};
  return { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, HEAD', vary: 'Origin' };
}

function fixtureRoute(lane, pathname) {
  for (const p of lane.fixture.scripts) if (new URL(p, 'http://x').pathname === pathname) return 'script';
  for (const p of lane.fixture.frames) if (new URL(p, 'http://x').pathname === pathname) return 'frame';
  return null;
}

async function route(request, env) {
  const config = configFor(env);
  if (!config.ok) return json(503, { status: 'unavailable' }, baseHeaders(null));

  const url = new URL(request.url);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const laneId = config.hostToLane.get(host);
  // Unknown hosts are refused outright; there is no default/fallback lane.
  if (!laneId) return json(421, { status: 'unknown_host' }, baseHeaders(null));

  const lane = LANES[laneId];
  const headers = { ...baseHeaders(lane), ...corsHeaders(request, config) };
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    return Object.keys(corsHeaders(request, config)).length
      ? new Response(null, { status: 204, headers })
      : text(403, 'Forbidden\n', headers);
  }
  if (method !== 'GET' && method !== 'HEAD') return text(405, 'Method not allowed\n', { ...headers, allow: 'GET, HEAD' });

  const readiness = laneReadiness(config, laneId, LANES);
  const path = url.pathname;
  let res;

  if (path === '/healthz') {
    res = json(200, { status: 'ok' }, headers);
  } else if (path === '/readyz') {
    res = readiness.ready
      ? json(200, { status: 'ready', lane: laneId }, headers)
      : json(503, { status: 'not_ready', lane: laneId, reason: readiness.reason }, headers);
  } else if (path === '/fixture-manifest.json') {
    res = json(200, {
      name: 'Northstar Lab',
      environment: config.environment,
      build: BUILD.id,
      lane: { id: laneId, name: PAGES[laneId].title, host },
      ready: readiness.ready,
      endpoints: ENDPOINTS,
      configFingerprint: await configFingerprint(config, LANES),
    }, headers);
  } else if (path === '/robots.txt') {
    res = text(200, 'User-agent: *\nDisallow: /\n', headers);
  } else if (ASSETS[path]) {
    res = respond(200, ASSETS[path].body, ASSETS[path].type, headers);
  } else if (path === '/') {
    if (!readiness.ready) {
      res = text(503, 'Lane not ready\n', headers);
    } else {
      const port = url.port ? `:${url.port}` : '';
      const html = renderLanePage({
        templates: TEMPLATES,
        page: PAGES[laneId],
        lane,
        build: BUILD,
        environment: config.environment,
        controlUrl: `${url.protocol}//${config.laneHosts.control}${port}/`,
        siteKey: config.siteKeys[laneId],
      });
      // Fixture status and headers apply to the lane document only.
      res = respond(lane.fixture.status, html, 'text/html; charset=utf-8', { ...headers, ...lane.fixture.headers });
    }
  } else {
    const kind = fixtureRoute(lane, path);
    if (kind === 'script') res = respond(200, FIXTURE_SCRIPT, 'text/javascript; charset=utf-8', headers);
    else if (kind === 'frame') res = respond(200, TEMPLATES.frame, 'text/html; charset=utf-8', headers);
    else res = text(404, 'Not found\n', headers);
  }

  return method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res;
}

export async function handleRequest(request, env) {
  try {
    return await route(request, env);
  } catch {
    // Never expose stack traces or configuration details.
    return text(500, 'Internal error\n', baseHeaders(null));
  }
}

export { BUILD };
