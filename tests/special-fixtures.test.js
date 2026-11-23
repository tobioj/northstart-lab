// Special conditions without public hostnames.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { withLab, request } from './helpers.js';
import { SPECIAL, googleSorryObservation, startFailingGateway, findClosedPort } from './harness/special-fixtures.js';
import { classify, proxyTransportMarker, responseSignal } from './reference-classifier.js';
import { verdictPair } from './harness/suite.js';
import { INTERNAL_LANES } from './harness/suite.js';

const connect = (port, target) => new Promise((resolve, reject) => {
  const s = net.connect(port, '127.0.0.1', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
  let buf = '';
  s.on('data', (d) => { buf += d; });
  s.on('end', () => resolve(buf));
  s.on('error', reject);
});

test('Google /sorry/ is a protocol-level fixture: Google hostname, /sorry/index, 429, expected text', () => {
  const obs = googleSorryObservation();
  const u = new URL(obs.url);
  assert.equal(SPECIAL.googleRateLimit.mode, 'protocol-only');
  assert.equal(u.hostname, 'www.google.com');
  assert.equal(u.pathname, '/sorry/index');
  assert.equal(obs.status, 429);
  assert.ok(obs.text.includes('unusual traffic'));
  const v = classify({ url: obs.url, response: responseSignal(obs), pageText: obs.text });
  assert.deepEqual(verdictPair(v), SPECIAL.googleRateLimit.expectedVerdict);
  assert.equal(v.attribution, 'TRANSIENT_THROTTLE');
});

test('Google /sorry/ is never served by an owned page or visited by the browser harness', async () => {
  await withLab(async (lab) => {
    for (const role of ['parent', 'widget', 'verify']) {
      for (const p of ['/sorry/index', '/sorry/', '/sorry/index?continue=x']) assert.ok([400, 404].includes((await lab[role](p)).status), `${role}${p}`);
    }
  });
  const harness = readFileSync(new URL('./harness/suite.js', import.meta.url), 'utf8');
  const browserTest = readFileSync(new URL('./browser.test.js', import.meta.url), 'utf8');
  for (const src of [harness, browserTest]) assert.ok(!/visit\([^)]*google/i.test(src) && !src.includes('SPECIAL.googleRateLimit.url'), 'browser visits Google fixture');
  // An owned path named /sorry/index would not be equivalent: the classifier needs the Google host.
  assert.equal(classify({ url: 'https://northstar-parent.example.com/sorry/index' }).challenge, false);
});

test('proxy 407 gateway: CONNECT gets 407 with a Basic proxy challenge, recorded as evidence', async () => {
  const gw = await startFailingGateway({ status: 407 });
  try {
    const reply = await connect(gw.port, 'northstar-proxy-probe.invalid:443');
    assert.match(reply, /^HTTP\/1\.1 407 Proxy Authentication Required/);
    assert.match(reply, /Proxy-Authenticate: Basic realm="northstar-fixture"/);
    assert.deepEqual(gw.seen, [{ method: 'CONNECT', target: 'northstar-proxy-probe.invalid:443', status: 407 }]);
  } finally { gw.server.close(); }
});

test('proxy 502 gateway: CONNECT and plain requests get 502 with an empty body; a closed port refuses', async () => {
  const gw = await startFailingGateway({ status: 502 });
  try {
    assert.match(await connect(gw.port, 'northstar-proxy-probe.invalid:443'), /^HTTP\/1\.1 502/);
    const plain = await request({ port: gw.port, host: 'northstar-proxy-probe.invalid', path: '/' });
    assert.equal(plain.status, 502);
    assert.equal(plain.body, '', 'empty body so Chromium shows its own HTTP ERROR 502 document');
  } finally { gw.server.close(); }
  const closed = await findClosedPort();
  await assert.rejects(new Promise((resolve, reject) => {
    const s = net.connect(closed, '127.0.0.1', () => { s.destroy(); resolve(); });
    s.on('error', reject);
  }));
});

test('proxy fixtures are transport fixtures, not hosted HTTP error pages', async () => {
  for (const v of Object.values(SPECIAL.proxyGateway.variants)) assert.ok(v.expectedBrowserErrors.every((e) => e.startsWith('net::ERR_')));
  assert.equal(SPECIAL.proxyGateway.errorPageUrl, 'chrome-error://chromewebdata/');
  // A hosted page that merely returns 502 is not a transport fixture.
  assert.equal(classify({ url: 'https://northstar-parent.example.com/', pageText: 'HTTP ERROR 502' }).challenge, false);
  // Only Chromium's error document with the HTTP ERROR text is a proxy verdict.
  assert.deepEqual(verdictPair(classify({ url: 'chrome-error://chromewebdata/', pageText: 'HTTP ERROR 407' })), ['PROXY_GATEWAY', 'PROXY_GATEWAY_ERROR']);
  assert.equal(classify({ url: 'chrome-error://chromewebdata/', pageText: 'ERR_TUNNEL_CONNECTION_FAILED' }).challenge, false);
  assert.equal(proxyTransportMarker({ url: 'chrome-error://chromewebdata/', errorText: 'net::ERR_TUNNEL_CONNECTION_FAILED' }), 'proxy_gateway_407');
  await withLab(async (lab) => {
    for (const status of [407, 502]) for (const role of ['parent', 'widget', 'verify']) {
      const r = await lab[role]('/');
      assert.notEqual(r.status, status);
    }
  });
});

test('YouTube account gate is the controlled browser route /scenario/youtube-account-gate/{token}', async () => {
  assert.equal(INTERNAL_LANES[SPECIAL.youtubeGate.lane].route, 'youtube-account-gate');
  await withLab(async (lab) => {
    const token = await lab.issue('youtube-account-gate');
    const r = await lab.parent(`/scenario/youtube-account-gate/${token}`);
    assert.equal(r.status, 200);
    const text = r.body.replace(/<[^>]+>/g, ' ').replaceAll('&#39;', "'");
    assert.ok(text.includes(SPECIAL.youtubeGate.text));
    assert.deepEqual(verdictPair(classify({ url: `${lab.origins.parent}/scenario/youtube-account-gate/${token}`, pageText: text })), SPECIAL.youtubeGate.expectedVerdict);
    // No other lane carries the gate sentence.
    for (const lane of Object.values(INTERNAL_LANES)) {
      if (lane.route === 'youtube-account-gate') continue;
      const p = await lab.parent(`/scenario/${lane.route}/${await lab.issue(lane.route)}`);
      const t = p.body.replace(/<[^>]+>/g, ' ').replaceAll('&#39;', "'").toLowerCase();
      assert.ok(!t.includes("sign in to confirm you're not a bot") && !t.includes('please sign in to continue'), lane.route);
    }
  });
});

test('no special condition has a hostname of its own', async () => {
  await withLab(async (lab) => {
    assert.equal(Object.keys(lab.hosts).length, 3);
    for (const host of Object.values(lab.hosts)) assert.ok(!/google|youtube|proxy|harness|sorry/.test(host));
    for (const host of ['northstar-harness.localhost', 'www.google.com', 'www.youtube.com']) assert.equal((await lab.raw(host, '/')).status, 421);
  });
});
