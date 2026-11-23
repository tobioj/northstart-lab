// Shared harness used by tests and evidence: starts the Northstar server on loopback for the
// three role origins, drives a real headless browser through all 14 lanes (scenario page, then
// "Complete scenario" -> verification origin -> continuation page) and the proxy transport
// fixtures, and classifies each with the JS port of the application's ChallengeClassifier.
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import { startServer } from '../../functions/node-adapter.js';
import { readEnvFile } from '../../scripts/lib/env.js';
import { classify, allMatchingVendors, responseSignal, proxyTransportMarker } from '../reference-classifier.js';
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

/**
 * The verdict ChallengeClassifier.classify must return for each lane at the origin:
 * [vendor, surface], or null for "no challenge". The Cloudflare lane is clean until its
 * edge rule is on (then CLOUDFLARE / JS_POW_AUTO from cf-mitigated).
 */
export const EXPECTED_VERDICTS = {
  control: null,
  'lane-01': null,
  'lane-02': ['DATADOME', 'VISUAL_PUZZLE'],
  'lane-03': ['AWS_WAF', 'JS_POW_AUTO'],
  'lane-04': ['PERIMETERX', 'PRESS_AND_HOLD'],
  'lane-05': ['AKAMAI', 'HARD_BLOCK'],
  'lane-06': ['KASADA', 'JS_POW_AUTO'],
  'lane-07': ['IMPERVA', 'JS_POW_AUTO'],
  'lane-08': ['ARKOSE', 'VISUAL_PUZZLE'],
  'lane-09': ['GEETEST', 'VISUAL_PUZZLE'],
  'lane-10': ['HCAPTCHA', 'WIDGET_CHECKBOX'],
  'lane-11': ['RECAPTCHA', 'WIDGET_CHECKBOX'],
  'lane-12': ['AWS_WAF', 'VISUAL_PUZZLE'],
  'lane-13': ['YOUTUBE_BOT_GATE', 'ACCOUNT_MATURATION_GATE'],
};

/** Registry signatures a lane may match at the origin (exactly one, or none). */
export function expectedVendors(laneId) {
  const v = EXPECTED_VERDICTS[laneId];
  return v && v[0] !== 'YOUTUBE_BOT_GATE' ? [v[0]] : [];
}

export const verdictPair = (v) => (v && v.challenge ? [v.vendor, v.surface] : null);

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

/**
 * Build ChallengeClassifier.classify inputs from a browser record, the way the application's
 * ChallengeNetworkTap + CDP inspector would see the page: every response of this navigation
 * (local security-software injections excluded), the document response, child frames with
 * their CSS boxes, and the visible page text.
 */
export function classifierInput(snap, responses, injected = []) {
  const events = responses.filter((r) => !injected.includes(r.url)).map((r) => responseSignal({ url: r.url, status: r.status, headers: r.headers, resourceType: r.type }));
  return {
    url: snap.location,
    response: snap.document ? responseSignal(snap.document) : null,
    networkEvents: events,
    frames: snap.iframeEvidence || [],
    pageText: snap.text,
  };
}

export async function runBrowserSuite({ screenshotsDir = null, log = () => {} } = {}) {
  const evidence = [];
  const lab = await startLab({ extra: SECRET_SENTINELS, onEvidence: (e) => evidence.push(e) });
  const variants = SPECIAL.proxyGateway.variants;
  const gateways = {};
  for (const [name, v] of Object.entries(variants)) if (v.gatewayStatus) gateways[name] = await startFailingGateway({ status: v.gatewayStatus });
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
      const injected = rec.environmentInjected;
      const scenario = { ...rec, document: rec.document };
      const input = classifierInput(scenario, rec.responses.slice(0, rec.scenarioResponseCount ?? rec.responses.length), injected);
      const cont = rec.continuation;
      const continuationInput = cont ? classifierInput(cont, cont.responses, injected) : null;
      results.lanes[laneId] = {
        url, rec, input,
        verdict: classify(input),
        vendors: allMatchingVendors(input),
        continuationInput,
        continuationVerdict: continuationInput ? classify(continuationInput) : null,
        continuationVendors: continuationInput ? allMatchingVendors(continuationInput) : null,
      };
    }

    // Proxy transport fixtures: only the probe URL may use the (local, always-failing) gateway.
    results.special.proxyGateway = {};
    for (const [variant, v] of Object.entries(variants)) {
      log(`visiting proxy ${variant}`);
      const gw = gateways[variant];
      const port = gw ? gw.port : closedPort;
      const rec = await visit(browser, v.probeUrl, { proxyServer: `http://127.0.0.1:${port}`, proxyAllow: (u) => u.startsWith(v.probeUrl), screenshotPath: shot(`special-proxy-${variant}`) });
      const pageText = rec.errorPage?.text || '';
      const url = rec.errorPage?.url || '';
      results.special.proxyGateway[variant] = {
        rec, gatewayLog: gw ? [...gw.seen] : [],
        verdict: classify({ url, pageText }),
        marker: proxyTransportMarker({ url, pageText, errorText: rec.navigationError || '' }),
        markerWithIplock502: proxyTransportMarker({ url, pageText, errorText: rec.navigationError || '', allowIplock502: true }),
      };
    }
  } finally {
    await browser.close();
    await lab.close();
    for (const gw of Object.values(gateways)) gw.server.close();
  }
  return results;
}
