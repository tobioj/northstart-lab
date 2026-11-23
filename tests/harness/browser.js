// Minimal Chrome DevTools Protocol driver (no dependencies; uses an installed Chrome/Edge).
// Every page request is intercepted: loopback hosts continue and anything else is BLOCKED and
// recorded - so automated runs never contact external websites. In proxy-fixture contexts only
// the probe URL may use the (local, always-failing) gateway; everything else is blocked.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome() {
  const candidates = [
    process.env.NORTHSTAR_CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || null;
}

class CDP {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new CDP(ws));
      ws.onerror = () => reject(new Error('CDP websocket error'));
    });
  }
  constructor(ws) {
    this.ws = ws; this.nextId = 0; this.pending = new Map(); this.listeners = new Set();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
      } else for (const l of this.listeners) l(msg);
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
}

const BROWSER_FLAGS = [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-component-update', '--disable-sync', '--disable-default-apps', '--disable-extensions',
  '--disable-domain-reliability', '--disable-client-side-phishing-detection', '--metrics-recording-only',
  '--no-pings', '--disable-breakpad', '--hide-scrollbars', '--window-size=1000,820',
  '--disable-features=OptimizationHints,MediaRouter,Translate,AutofillServerCommunication,InterestFeedContentSuggestions,HttpsUpgrades,HttpsFirstBalancedModeAutoEnable',
];

export async function launchBrowser() {
  const exe = findChrome();
  if (!exe) throw new Error('No Chrome/Edge found (set NORTHSTAR_CHROME_PATH)');
  const profile = mkdtempSync(join(tmpdir(), 'northstar-browser-'));
  const extra = process.platform === 'linux' && process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : [];
  const proc = spawn(exe, [...BROWSER_FLAGS, ...extra, `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('browser did not start')), 20000);
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(t); resolve(m[1]); }
    });
    proc.on('exit', () => { clearTimeout(t); reject(new Error('browser exited early')); });
  });
  const cdp = await CDP.connect(wsUrl);
  return {
    cdp,
    executable: exe,
    async close() {
      try { await Promise.race([cdp.send('Browser.close'), delay(3000)]); } catch { /* ignore */ }
      try { cdp.ws.close(); } catch { /* ignore */ }
      proc.kill();
      await delay(500);
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* temp profile */ }
    },
  };
}

const isLoopback = (h) => h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '[::1]';

// Scripts injected into pages by local security software on this machine (not by the
// pages). Still blocked; recorded separately so they cannot mask a real page leak.
export const ENVIRONMENT_INJECTION_HOSTS = [/(^|\.)kaspersky-labs\.com$/i];
const isEnvironmentInjection = (h) => ENVIRONMENT_INJECTION_HOSTS.some((re) => re.test(h));

const lowerHeaders = (h) => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k.toLowerCase(), v]));

async function snapshot(s) {
  const { result } = await s('Runtime.evaluate', {
    returnByValue: true,
    expression: `JSON.stringify({
      location: location.href,
      title: document.title,
      pageStatus: (document.getElementById('page-status') || {}).textContent || null,
      scenarioState: (document.getElementById('scenario-state') || {}).textContent || null,
      html: document.documentElement.outerHTML,
      text: document.body ? document.body.innerText : '',
      localStorage: (() => { try { return Object.assign({}, localStorage); } catch (e) { return {}; } })(),
      sessionStorage: (() => { try { return Object.assign({}, sessionStorage); } catch (e) { return {}; } })(),
      documentCookie: (() => { try { return document.cookie; } catch (e) { return ''; } })(),
      iframeSrcs: [...document.querySelectorAll('iframe')].map((f) => f.src)
    })`,
  });
  const snap = JSON.parse(result.value);
  const { frameTree } = await s('Page.getFrameTree');
  const frames = [];
  (function walk(node) { for (const c of node.childFrames || []) { frames.push(c.frame.url); walk(c); } })(frameTree);
  snap.frameUrls = [...new Set([...frames, ...snap.iframeSrcs])];
  snap.cookies = (await s('Network.getCookies')).cookies;
  return snap;
}

/**
 * Load one URL in a fresh, isolated browser context and record everything observable.
 * @param {object} opts
 * @param {string} [opts.proxyServer] route this context through a proxy; only proxyAllow URLs may use it
 * @param {(url: string) => boolean} [opts.proxyAllow]
 * @param {boolean} [opts.complete] click #complete-button and record the continuation page
 * @param {string} [opts.screenshotPath]
 */
export async function visit(browser, url, { proxyServer, proxyAllow = () => false, complete = false, screenshotPath, settleMs = 700 } = {}) {
  const { cdp } = browser;
  const { browserContextId } = await cdp.send('Target.createBrowserContext',
    proxyServer ? { proxyServer, proxyBypassList: '' } : {});
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
  let { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => cdp.send(m, p, sessionId);

  const rec = { url, requests: [], blockedExternal: [], environmentInjected: [], responses: [], authChallenges: [], navigationError: null };
  let onLoad; let loaded = new Promise((r) => { onLoad = r; });
  const off = cdp.on(async (msg) => {
    if (msg.sessionId !== sessionId) return;
    const p = msg.params;
    if (msg.method === 'Fetch.requestPaused') {
      const reqUrl = p.request.url;
      rec.requests.push(reqUrl);
      let host = '';
      try { host = new URL(reqUrl).hostname; } catch { /* data: etc */ }
      try {
        if ((!proxyServer && isLoopback(host)) || reqUrl.startsWith('data:') || (proxyServer && proxyAllow(reqUrl))) {
          await s('Fetch.continueRequest', { requestId: p.requestId });
        } else if (isEnvironmentInjection(host)) {
          rec.environmentInjected.push(reqUrl);
          await s('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' });
        } else {
          rec.blockedExternal.push(reqUrl);
          await s('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' });
        }
      } catch { /* target closing */ }
    } else if (msg.method === 'Fetch.authRequired') {
      // Record the challenge as evidence; credentials are never supplied.
      rec.authChallenges.push({ source: p.authChallenge.source, scheme: p.authChallenge.scheme, realm: p.authChallenge.realm, url: p.request.url });
      try { await s('Fetch.continueWithAuth', { requestId: p.requestId, authChallengeResponse: { response: 'CancelAuth' } }); } catch { /* closing */ }
    } else if (msg.method === 'Network.responseReceived') {
      rec.responses.push({ url: p.response.url, status: p.response.status, headers: p.response.headers, type: p.type, frameId: p.frameId });
    } else if (msg.method === 'Page.loadEventFired') onLoad();
  });

  await s('Page.enable');
  await s('Network.enable');
  await s('Network.setCacheDisabled', { cacheDisabled: true });
  await s('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }], handleAuthRequests: Boolean(proxyServer) });

  const nav = await s('Page.navigate', { url });
  if (nav.errorText) rec.navigationError = nav.errorText;
  else { await Promise.race([loaded, delay(10000)]); await delay(settleMs); }

  const mainDoc = (after = 0) => {
    const doc = rec.responses.slice(after).filter((r) => r.type === 'Document' && r.frameId === nav.frameId).pop();
    return doc ? { url: doc.url, status: doc.status, headers: lowerHeaders(doc.headers) } : null;
  };
  rec.document = mainDoc();

  if (!rec.navigationError) {
    Object.assign(rec, await snapshot(s));
  } else {
    // Chromium replaces the page with its internal error document (often in a new renderer):
    // re-attach if needed and record the error document's URL.
    await delay(500);
    let tree = null;
    try { tree = (await s('Page.getFrameTree')).frameTree; } catch {
      const again = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      sessionId = again.sessionId;
      tree = ((await cdp.send('Page.getFrameTree', {}, sessionId).catch(() => ({}))) || {}).frameTree || null;
    }
    rec.errorPage = tree ? { url: tree.frame.url, unreachableUrl: tree.frame.unreachableUrl || null } : null;
  }

  const shoot = async (path) => {
    let shot;
    try {
      shot = await s('Page.captureScreenshot', { format: 'png' });
    } catch {
      await delay(500);
      const again = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, again.sessionId).catch(() => null);
    }
    if (shot) writeFileSync(path, Buffer.from(shot.data, 'base64'));
  };

  if (complete && !rec.navigationError) {
    if (screenshotPath) await shoot(screenshotPath);
    const reqIdx = rec.requests.length;
    const resIdx = rec.responses.length;
    loaded = new Promise((r) => { onLoad = r; });
    await s('Runtime.evaluate', { expression: "document.getElementById('complete-button').click()" });
    await Promise.race([loaded, delay(10000)]);
    await delay(settleMs);
    const snap = await snapshot(s);
    rec.continuation = { ...snap, requests: rec.requests.slice(reqIdx), document: mainDoc(resIdx) };
  }

  if (screenshotPath && complete && !rec.navigationError) await shoot(screenshotPath.replace(/\.png$/, '-continue.png'));
  else if (screenshotPath && !complete) await shoot(screenshotPath);
  off();
  await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  return rec;
}
