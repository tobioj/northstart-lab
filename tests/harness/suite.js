// Shared harness used by tests and evidence: starts the Northstar server + special-fixture
// harness on loopback, drives a real headless browser through all 12 lanes and the 3
// special fixtures, and returns structured observations.
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../../functions/node-adapter.js';
import { readEnvFile } from '../../scripts/lib/env.js';
import { matchObservation } from '../reference-matcher.js';
import { launchBrowser, visit } from './browser.js';
import { SPECIAL, renderSpecial, startHarnessServer, startFailingGateway, findClosedPort } from './special-fixtures.js';

export const ROOT = new URL('../../', import.meta.url);
export const INTERNAL_LANES = JSON.parse(readFileSync(new URL('configuration/lanes.internal.json', ROOT), 'utf8')).lanes;
export const LOCAL_ENV_PATH = new URL('configuration/local.env', ROOT);

// Sentinel "secrets" injected into the environment to prove nothing leaks.
export const SECRET_SENTINELS = {
  NORTHSTAR_HCAPTCHA_SECRET: '0xNORTHSTARSENTINELHCAPTCHASECRET000000',
  NORTHSTAR_RECAPTCHA_SECRET: 'NORTHSTAR-SENTINEL-RECAPTCHA-SECRET-0001',
  NORTHSTAR_PROVIDER_API_KEY: 'NORTHSTAR-SENTINEL-API-KEY-0002',
};

export function localEnv(extra = {}) {
  return { ...readEnvFile(LOCAL_ENV_PATH), ...extra };
}

/** Which vendors a lane is expected to trigger *at the origin* (Cloudflare lane is clean until the edge rule is on). */
export function expectedVendors(laneId) {
  const a = INTERNAL_LANES[laneId].assignment;
  return a === 'control' || a === 'cloudflare' ? [] : [a];
}

/** Allowed (but still blocked in automated runs) third-party hosts per lane. */
export function approvedExternalHosts(laneId) {
  const a = INTERNAL_LANES[laneId].assignment;
  if (a === 'hcaptcha') return ['hcaptcha.com'];
  if (a === 'recaptcha') return ['www.google.com', 'www.gstatic.com', 'recaptcha.google.com'];
  return [];
}

export async function runBrowserSuite({ screenshotsDir = null, log = () => {} } = {}) {
  const logs = [];
  const env = localEnv(SECRET_SENTINELS);
  const { server, port } = await startServer({ env, port: 0, log: (l) => logs.push(l) });
  const harness = await startHarnessServer();
  const gateway = await startFailingGateway();
  const closedPort = await findClosedPort();
  const browser = await launchBrowser();
  if (screenshotsDir) mkdirSync(screenshotsDir, { recursive: true });
  const shot = (name) => (screenshotsDir ? join(screenshotsDir, `${name}.png`) : undefined);
  const results = { browser: browser.executable, port, lanes: {}, special: {}, serverLog: logs };
  try {
    for (const laneId of Object.keys(INTERNAL_LANES)) {
      const host = env[INTERNAL_LANES[laneId].hostVariable];
      const url = `http://${host}:${port}/`;
      log(`visiting ${laneId}`);
      const rec = await visit(browser, url, { screenshotPath: shot(laneId) });
      const observation = {
        status: rec.document?.status,
        headers: rec.document?.headers || {},
        urls: rec.requests.filter((u) => !rec.environmentInjected.includes(u)),
        frames: rec.frameUrls || [],
      };
      results.lanes[laneId] = { url, rec, observation, hits: matchObservation(observation) };
    }

    // Special fixture 1 + 2: virtual Google / YouTube URLs answered locally by the harness.
    const virtual = {};
    for (const name of ['googleRateLimit', 'youtubeGate']) {
      virtual[SPECIAL[name].virtualUrl] = renderSpecial(name);
      // The browser's automatic favicon request is answered locally too (never sent out).
      virtual[new URL('/favicon.ico', SPECIAL[name].virtualUrl).href] = { status: 404, headers: { 'content-type': 'text/plain' }, body: '' };
    }
    for (const name of ['googleRateLimit', 'youtubeGate']) {
      log(`visiting ${name}`);
      const rec = await visit(browser, SPECIAL[name].virtualUrl, { virtual, screenshotPath: shot(`special-${name}`) });
      results.special[name] = { rec };
      // Same fixture via the plain local harness host as well.
      const localUrl = `http://${SPECIAL.harnessHost}:${harness.port}${SPECIAL[name].localPath}`;
      results.special[name].local = await visit(browser, localUrl);
    }

    // Special fixture 3: proxy gateway errors.
    log('visiting proxy gateway variants');
    results.special.proxyGateway = {
      tunnel_502: await visit(browser, SPECIAL.proxyGateway.probeUrl, { proxyServer: `http://127.0.0.1:${gateway.port}`, screenshotPath: shot('special-proxy-tunnel_502') }),
      proxy_unreachable: await visit(browser, SPECIAL.proxyGateway.probeUrl, { proxyServer: `http://127.0.0.1:${closedPort}`, screenshotPath: shot('special-proxy-proxy_unreachable') }),
    };
  } finally {
    await browser.close();
    server.close(); harness.server.close(); gateway.server.close();
  }
  return results;
}
