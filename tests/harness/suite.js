// Shared harness used by tests and evidence: starts the Northstar server on loopback for the
// three role origins, drives a real headless browser through all 14 lanes (scenario page, then
// "Complete scenario" -> verification origin -> continuation page) and the proxy transport
// fixtures, and returns structured observations.
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import { startServer } from '../../functions/node-adapter.js';
import { readEnvFile } from '../../scripts/lib/env.js';
import { matchObservation } from '../reference-matcher.js';
import { launchBrowser, visit } from './browser.js';
import { SPECIAL, startFailingGateway, findClosedPort } from './special-fixtures.js';

export const ROOT = new URL('../../', import.meta.url);
export const INTERNAL_LANES = JSON.parse(readFileSync(new URL('configuration/lanes.internal.json', ROOT), 'utf8')).lanes;
export const LOCAL_ENV_PATH = new URL('configuration/local.env', ROOT);

// Sentinel secrets injected into the environment to prove nothing leaks (responses, logs, pages).
export const SECRET_SENTINELS = {
  NORTHSTAR_TOKEN_SIGNING_KEY: 'NORTHSTAR-SENTINEL-TOKEN-SIGNING-KEY-000000000001',
  NORTHSTAR_MANAGEMENT_AUTHORITY: 'NORTHSTAR-SENTINEL-MANAGEMENT-AUTHORITY-0000000002',
  NORTHSTAR_HCAPTCHA_SECRET: '0xNORTHSTARSENTINELHCAPTCHASECRET000000',
  NORTHSTAR_RECAPTCHA_SECRET: 'NORTHSTAR-SENTINEL-RECAPTCHA-SECRET-0001',
  NORTHSTAR_PROVIDER_API_KEY: 'NORTHSTAR-SENTINEL-API-KEY-0002',
};

/** Local env with origins rewritten to the given port. */
export function localEnv(extra = {}, port = 8787) {
  const base = readEnvFile(LOCAL_ENV_PATH);
  for (const k of ['NORTHSTAR_PARENT_ORIGIN', 'NORTHSTAR_WIDGET_ORIGIN', 'NORTHSTAR_VERIFY_ORIGIN']) {
    base[k] = base[k].replace(/:\d+$/, `:${port}`);
  }
  return { ...base, ...extra };
}

export function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** Start the lab on a free loopback port with origins matching that port. */
export async function startLab({ extra = {}, onEvidence, now } = {}) {
  const port = await freePort();
  const env = localEnv(extra, port);
  const logs = [];
  const { server, store } = await startServer({ env, port, log: (l) => logs.push(l), onEvidence, now });
  const origins = { parent: env.NORTHSTAR_PARENT_ORIGIN, widget: env.NORTHSTAR_WIDGET_ORIGIN, verify: env.NORTHSTAR_VERIFY_ORIGIN };
  const hosts = Object.fromEntries(Object.entries(origins).map(([r, o]) => [r, new URL(o).hostname]));
  return { server, port, env, logs, origins, hosts, store, close: () => new Promise((r) => server.close(r)) };
}

/** Registry vendor a lane must trigger at the origin ([] for clean control, the Cloudflare lane before its edge rule, and the YouTube gate). */
export function expectedVendors(laneId) {
  const l = INTERNAL_LANES[laneId];
  const a = l.registryVendor || l.assignment;
  return ['control', 'cloudflare', 'youtube_account_gate'].includes(a) ? [] : [a];
}

/** Which role origin served a URL, or null when it is not one of the lab origins. */
export function roleOf(url, hosts) {
  let h;
  try { h = new URL(url).hostname; } catch { return null; }
  return Object.entries(hosts).find(([, host]) => host === h)?.[0] || null;
}

export const ROLE_PATHS = {
  parent: [/^\/$/, /^\/scenario\//, /^\/continue\//, /^\/assets\//, /^\/favicon\.ico$/],
  widget: [/^\/widget\//, /^\/resources\//, /^\/images\//, /^\/assets\//, /^\/favicon\.ico$/],
  verify: [/^\/api\/(input|verify|settle|status)\//],
};

export function observationOf(rec, { urls } = {}) {
  return {
    status: rec.document?.status,
    headers: rec.document?.headers || {},
    urls: (urls || rec.requests).filter((u) => !rec.environmentInjected.includes(u)),
    frames: rec.frameUrls || [],
  };
}

export async function runBrowserSuite({ screenshotsDir = null, log = () => {} } = {}) {
  const evidence = [];
  const lab = await startLab({ extra: SECRET_SENTINELS, onEvidence: (e) => evidence.push(e) });
  const gateways = { proxy_auth_407: await startFailingGateway({ status: 407 }), tunnel_502: await startFailingGateway({ status: 502 }) };
  const closedPort = await findClosedPort();
  const browser = await launchBrowser();
  if (screenshotsDir) mkdirSync(screenshotsDir, { recursive: true });
  const shot = (name) => (screenshotsDir ? join(screenshotsDir, `${name}.png`) : undefined);
  const results = { browser: browser.executable, port: lab.port, origins: lab.origins, hosts: lab.hosts, lanes: {}, special: {}, serverLog: lab.logs, receipts: evidence };
  try {
    for (const [laneId, lane] of Object.entries(INTERNAL_LANES)) {
      const url = `${lab.origins.parent}/scenario/${lane.route}`;
      log(`visiting ${laneId} (${lane.route})`);
      const rec = await visit(browser, url, { complete: true, screenshotPath: shot(laneId) });
      const scenarioRequests = rec.continuation ? rec.requests.slice(0, rec.requests.length - rec.continuation.requests.length) : rec.requests;
      const observation = observationOf(rec, { urls: scenarioRequests });
      const cont = rec.continuation;
      const continuationObservation = cont ? {
        status: cont.document?.status,
        headers: cont.document?.headers || {},
        urls: cont.requests.filter((u) => !rec.environmentInjected.includes(u)),
        frames: cont.frameUrls || [],
      } : null;
      results.lanes[laneId] = {
        url, rec, observation, hits: matchObservation(observation),
        continuationObservation, continuationHits: continuationObservation ? matchObservation(continuationObservation) : null,
      };
    }

    // Proxy transport fixtures: only the probe URL may use the (local, always-failing) gateway.
    const probe = SPECIAL.proxyGateway.probeUrl;
    const proxyAllow = (u) => u.startsWith(probe);
    results.special.proxyGateway = {};
    for (const [variant, gw] of Object.entries(gateways)) {
      log(`visiting proxy ${variant}`);
      const rec = await visit(browser, probe, { proxyServer: `http://127.0.0.1:${gw.port}`, proxyAllow, screenshotPath: shot(`special-proxy-${variant}`) });
      results.special.proxyGateway[variant] = { rec, gatewayLog: [...gw.seen] };
    }
    log('visiting proxy proxy_unreachable');
    const unreachable = await visit(browser, probe, { proxyServer: `http://127.0.0.1:${closedPort}`, proxyAllow, screenshotPath: shot('special-proxy-proxy_unreachable') });
    results.special.proxyGateway.proxy_unreachable = { rec: unreachable, gatewayLog: [] };
  } finally {
    await browser.close();
    await lab.close();
    for (const gw of Object.values(gateways)) gw.server.close();
  }
  return results;
}
