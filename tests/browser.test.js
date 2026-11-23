// Real-browser setup test (headless Chrome/Edge via DevTools Protocol).
// All non-loopback requests are intercepted and blocked, so no external site is contacted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChrome } from './harness/browser.js';
import { runBrowserSuite, expectedVendors, approvedExternalHosts, SECRET_SENTINELS, INTERNAL_LANES } from './harness/suite.js';
import { SPECIAL } from './harness/special-fixtures.js';

const skip = process.env.NORTHSTAR_SKIP_BROWSER === '1' ? 'NORTHSTAR_SKIP_BROWSER=1' : (!findChrome() && 'no Chrome/Edge installed');

test('browser: 12 lanes, 3 special fixtures, no leaks, no external contact', { skip, timeout: 180000 }, async (t) => {
  const r = await runBrowserSuite();

  await t.test('all 12 lanes load in a real browser and report "Page loaded"', () => {
    assert.equal(Object.keys(r.lanes).length, 12);
    for (const [id, l] of Object.entries(r.lanes)) {
      assert.equal(l.rec.navigationError, null, id);
      assert.equal(l.rec.pageStatus, 'Page loaded', id);
      assert.equal(l.rec.document.status, INTERNAL_LANES[id].fixture.status, id);
    }
  });

  await t.test('each lane triggers exactly its expected signature in the browser', () => {
    for (const [id, l] of Object.entries(r.lanes)) {
      assert.deepEqual(l.hits.map((h) => h.vendor), expectedVendors(id), `${id}: ${JSON.stringify(l.hits)}`);
    }
  });

  await t.test('no unrelated external site is contacted (only approved widget hosts are even attempted, and are blocked)', () => {
    for (const [id, l] of Object.entries(r.lanes)) {
      const approved = approvedExternalHosts(id);
      for (const u of l.rec.blockedExternal) {
        const host = new URL(u).hostname;
        assert.ok(approved.some((a) => host === a || host.endsWith(`.${a}`)), `${id} attempted ${host}`);
      }
      if (!approved.length) assert.deepEqual(l.rec.blockedExternal, [], id);
    }
  });

  await t.test('no secrets in HTML; browser storage and cookies stay empty', () => {
    for (const [id, l] of Object.entries(r.lanes)) {
      for (const v of Object.values(SECRET_SENTINELS)) assert.ok(!l.rec.html.includes(v), id);
      assert.deepEqual(l.rec.localStorage, {}, id);
      assert.deepEqual(l.rec.sessionStorage, {}, id);
      assert.equal(l.rec.documentCookie, '', id);
      assert.deepEqual(l.rec.cookies, [], id);
    }
    const log = r.serverLog.join('\n');
    for (const v of Object.values(SECRET_SENTINELS)) assert.ok(!log.includes(v));
  });

  await t.test('Google rate-limit fixture renders at its /sorry/ URL without contacting Google', () => {
    const s = r.special.googleRateLimit;
    assert.equal(s.rec.document.status, 429);
    assert.equal(s.rec.document.url, SPECIAL.googleRateLimit.virtualUrl);
    assert.ok(s.rec.text.includes(SPECIAL.googleRateLimit.text));
    assert.deepEqual(s.rec.blockedExternal, []);
    assert.ok(s.rec.answeredLocally.includes(SPECIAL.googleRateLimit.virtualUrl));
    assert.equal(s.local.document.status, 429);
  });

  await t.test('YouTube gate fixture renders without contacting YouTube', () => {
    const s = r.special.youtubeGate;
    assert.equal(s.rec.document.status, 200);
    assert.ok(s.rec.text.includes(SPECIAL.youtubeGate.text));
    assert.deepEqual(s.rec.blockedExternal, []);
  });

  await t.test('proxy gateway fixture produces browser transport errors', () => {
    for (const [variant, rec] of Object.entries(r.special.proxyGateway)) {
      assert.ok(SPECIAL.proxyGateway.variants[variant].expectedBrowserErrors.includes(rec.navigationError), `${variant}: ${rec.navigationError}`);
    }
  });
});
