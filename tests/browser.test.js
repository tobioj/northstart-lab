// Real-browser acceptance (headless Chrome/Edge via DevTools Protocol), judged by the JS port of
// the application's ChallengeClassifier. All non-loopback requests are intercepted and blocked,
// so no external site is contacted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChrome } from './harness/browser.js';
import { runBrowserSuite, EXPECTED_VERDICTS, expectedVendors, verdictPair, SECRET_SENTINELS, INTERNAL_LANES, roleOf, ROLE_PATHS } from './harness/suite.js';
import { SPECIAL } from './harness/special-fixtures.js';

const skip = process.env.NORTHSTAR_SKIP_BROWSER === '1' ? 'NORTHSTAR_SKIP_BROWSER=1' : (!findChrome() && 'no Chrome/Edge installed');

test('browser: 14 lanes through three origins, classifier verdicts, clean continuation, proxy fixtures, no leaks', { skip, timeout: 240000 }, async (t) => {
  const r = await runBrowserSuite();

  await t.test('all 14 lanes load through the parent origin and report "Page loaded"', () => {
    assert.equal(Object.keys(r.lanes).length, 14);
    for (const [id, l] of Object.entries(r.lanes)) {
      assert.equal(l.rec.navigationError, null, id);
      assert.equal(l.rec.pageStatus, 'Page loaded', id);
      assert.equal(l.rec.document.status, INTERNAL_LANES[id].fixture.status, id);
      assert.equal(roleOf(l.rec.document.url, r.hosts), 'parent', id);
      assert.match(new URL(l.rec.document.url).pathname, new RegExp(`^/scenario/${INTERNAL_LANES[id].route}/${INTERNAL_LANES[id].code}\\.`));
    }
  });

  await t.test('each lane gets exactly its expected ChallengeClassifier verdict in the browser', () => {
    for (const [id, l] of Object.entries(r.lanes)) {
      assert.deepEqual(verdictPair(l.verdict), EXPECTED_VERDICTS[id], `${id}: ${JSON.stringify(l.verdict)}`);
      assert.deepEqual(l.vendors, expectedVendors(id), `${id} matches more than its own signature`);
    }
    const recaptchaFrame = r.lanes['lane-11'].input.frames[0];
    assert.deepEqual(recaptchaFrame.box.slice(2), [304, 78], 'reCAPTCHA anchor renders at checkbox size');
    assert.equal(recaptchaFrame.visible, true);
  });

  await t.test('every request goes to the right role origin: widget resources only on widget, verification only on verify', () => {
    for (const [id, l] of Object.entries(r.lanes)) {
      for (const u of l.rec.requests) {
        if (l.rec.environmentInjected.includes(u)) continue;
        const role = roleOf(u, r.hosts);
        assert.ok(role, `${id}: non-lab request ${u}`);
        const path = new URL(u).pathname;
        assert.ok(ROLE_PATHS[role].some((re) => re.test(path)), `${id}: ${role} served ${path}`);
      }
      const widgetCalls = l.rec.requests.filter((u) => roleOf(u, r.hosts) === 'widget');
      if (id === 'control' || id === 'lane-01' || id === 'lane-13') assert.deepEqual(widgetCalls, [], `${id} made widget calls`);
      else assert.ok(widgetCalls.length > 0, `${id} made no widget calls`);
      assert.ok(l.rec.requests.some((u) => roleOf(u, r.hosts) === 'verify' && /\/api\/settle\//.test(u)), `${id} never settled`);
    }
  });

  await t.test('completion settles on the verify origin and the next navigation has no verdict', () => {
    for (const [id, l] of Object.entries(r.lanes)) {
      const c = l.rec.continuation;
      assert.ok(c, `${id} no continuation`);
      assert.equal(c.document.status, 200, id);
      assert.equal(c.scenarioState, 'Scenario complete', id);
      assert.match(new URL(c.location).pathname, /^\/continue\//);
      assert.equal(l.continuationVerdict.challenge, false, `${id} continuation: ${JSON.stringify(l.continuationVerdict)}`);
      assert.deepEqual(l.continuationVendors, [], id);
      assert.deepEqual(c.frameUrls, [], id);
    }
    assert.equal(r.receipts.length, 14, 'one receipt per scenario instance');
    assert.equal(new Set(r.receipts.map((e) => `${e.route}/${e.instance}`)).size, 14, 'separate evidence directories');
  });

  await t.test('no actual provider domain or other external site is contacted', () => {
    for (const [id, l] of Object.entries(r.lanes)) assert.deepEqual(l.rec.blockedExternal, [], `${id} attempted ${l.rec.blockedExternal}`);
  });

  await t.test('no secrets in pages; browser storage and cookies stay empty', () => {
    for (const [id, l] of Object.entries(r.lanes)) {
      for (const snap of [l.rec, l.rec.continuation]) {
        for (const v of Object.values(SECRET_SENTINELS)) assert.ok(!snap.html.includes(v), id);
        assert.deepEqual(snap.localStorage, {}, id);
        assert.deepEqual(snap.sessionStorage, {}, id);
        assert.equal(snap.documentCookie, '', id);
        assert.deepEqual(snap.cookies, [], id);
      }
    }
    const log = r.serverLog.join('\n');
    for (const v of Object.values(SECRET_SENTINELS)) assert.ok(!log.includes(v));
  });

  await t.test('YouTube account gate renders through its parent route and is classified', () => {
    const l = r.lanes[SPECIAL.youtubeGate.lane];
    assert.ok(l.rec.text.includes(SPECIAL.youtubeGate.text));
    assert.deepEqual(verdictPair(l.verdict), SPECIAL.youtubeGate.expectedVerdict);
  });

  await t.test('proxy 407 / 502 fixtures are Chromium transport errors at chrome-error://chromewebdata/ with the classifier outcome expected', () => {
    for (const [variant, res] of Object.entries(r.special.proxyGateway)) {
      const { rec, gatewayLog } = res;
      const spec = SPECIAL.proxyGateway.variants[variant];
      assert.ok(spec.expectedBrowserErrors.includes(rec.navigationError), `${variant}: ${rec.navigationError}`);
      assert.equal(rec.errorPage?.url, SPECIAL.proxyGateway.errorPageUrl, variant);
      assert.equal(rec.errorPage?.unreachableUrl, spec.probeUrl, variant);
      assert.ok(rec.errorPage.text.includes(spec.expectedErrorText), `${variant} error page text: ${rec.errorPage.text}`);
      assert.deepEqual(rec.blockedExternal, [], variant);
      assert.deepEqual(verdictPair(res.verdict), spec.expectedVerdict, `${variant} verdict`);
      assert.equal(res.marker, spec.expectedMarker, `${variant} proxy_transport_marker`);
      if (spec.expectedMarkerWithIplock502) assert.equal(res.markerWithIplock502, spec.expectedMarkerWithIplock502);
      if (spec.gatewayStatus) {
        const probeHost = new URL(spec.probeUrl).host;
        assert.ok(gatewayLog.some((e) => (e.target.includes(probeHost)) && e.status === spec.gatewayStatus), `${variant}: ${JSON.stringify(gatewayLog)}`);
        assert.ok(gatewayLog.every((e) => e.status === spec.gatewayStatus), 'gateway never forwards');
      }
    }
    const auth = r.special.proxyGateway.proxy_auth_407.rec.authChallenges;
    assert.ok(auth.length > 0);
    assert.deepEqual({ source: auth[0].source, scheme: auth[0].scheme, realm: auth[0].realm }, SPECIAL.proxyGateway.variants.proxy_auth_407.expectedAuthChallenge);
  });
});
