// Signal isolation (HTTP level, no browser), judged by the JS port of the application's
// ChallengeClassifier: each lane yields exactly its expected verdict, sibling and continuation
// pages stay clean, and every registered provider stays covered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withLab, extractResources } from './helpers.js';
import { INTERNAL_LANES, EXPECTED_VERDICTS, expectedVendors, verdictPair } from './harness/suite.js';
import { classify, allMatchingVendors, responseSignal, SIGNATURES } from './reference-classifier.js';

const DEFAULT_FRAME = [0, 0, 352, 80]; // site.css default iframe box (22rem x 5rem)
const visibleText = (html) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replaceAll('&#39;', "'").replace(/\s+/g, ' ');

/** Load a lane page and every widget resource it references; return the classifier input. */
async function observe(lab, lane) {
  const token = await lab.issue(lane.route);
  const pageUrl = `${lab.origins.parent}/scenario/${lane.route}/${token}`;
  const page = await lab.parent(`/scenario/${lane.route}/${token}`);
  const { scripts, frames, images } = extractResources(page.body);
  const abs = (u) => new URL(u, pageUrl).href;
  const events = [responseSignal({ url: pageUrl, status: page.status, headers: page.headers })];
  for (const u of [...scripts, ...frames, ...images].map(abs)) {
    const url = new URL(u);
    const role = Object.entries(lab.origins).find(([, o]) => o === url.origin)?.[0];
    const r = await lab[role](url.pathname + url.search, { headers: lab.fromParent() });
    events.push(responseSignal({ url: u, status: r.status, headers: r.headers }));
  }
  const size = lane.fixture.frameSize;
  const input = {
    url: pageUrl,
    response: events[0],
    networkEvents: events,
    frames: frames.map(abs).map((url) => ({ url, visible: true, box: size ? [0, 0, size[0], size[1]] : DEFAULT_FRAME })),
    pageText: visibleText(page.body),
  };
  return { token, page, events, input, html: page.body };
}

test('every lane gets exactly its expected classifier verdict', async () => {
  await withLab(async (lab) => {
    for (const [laneId, lane] of Object.entries(INTERNAL_LANES)) {
      const { input, events } = await observe(lab, lane);
      const v = classify(input);
      assert.deepEqual(verdictPair(v), EXPECTED_VERDICTS[laneId], `${laneId}: ${JSON.stringify(v)}`);
      assert.deepEqual(allMatchingVendors(input), expectedVendors(laneId), `${laneId} matches more than its own signature`);
      for (const e of events.slice(1)) assert.equal(e.status, 200, `${laneId} ${e.url}`);
    }
  });
});

test('all 11 registered providers remain covered (10 by origin fixtures, Cloudflare by its edge rule)', () => {
  const registry = SIGNATURES.map((s) => s.vendor).sort();
  assert.equal(registry.length, 11);
  const origin = new Set(Object.keys(INTERNAL_LANES).flatMap(expectedVendors));
  const edge = Object.values(INTERNAL_LANES).filter((l) => l.edge).map((l) => l.assignment.toUpperCase());
  assert.deepEqual([...new Set([...origin, ...edge])].sort(), registry);
  assert.deepEqual(edge, ['CLOUDFLARE']);
});

test('the Cloudflare lane is classified once the edge adds cf-mitigated (simulated edge response)', () => {
  const input = { url: 'https://northstar-parent.example.com/scenario/cloudflare', response: responseSignal({ url: 'https://northstar-parent.example.com/scenario/cloudflare', status: 403, headers: { 'CF-Mitigated': 'challenge', server: 'cloudflare' } }) };
  assert.deepEqual(verdictPair(classify(input)), ['CLOUDFLARE', 'JS_POW_AUTO']);
  // Proxying alone (cf-ray, server: cloudflare) is not a challenge.
  assert.equal(classify({ url: input.url, response: responseSignal({ url: input.url, status: 200, headers: { server: 'cloudflare', 'cf-ray': 'x' } }) }).challenge, false);
});

test('fixture lanes exercise every signal type of their signature', async () => {
  const required = {
    'lane-02': ['response_header', 'resource_url', 'cdp_frame'], 'lane-03': ['response_header', 'resource_url', 'cdp_frame'],
    'lane-04': ['resource_url', 'cdp_frame'], 'lane-05': ['response_header', 'resource_url'], 'lane-06': ['response_header', 'resource_url'],
    'lane-07': ['response_header', 'resource_url', 'cdp_frame'], 'lane-08': ['resource_url', 'cdp_frame'], 'lane-09': ['resource_url', 'cdp_frame'],
    'lane-10': ['resource_url', 'cdp_frame'], 'lane-11': ['resource_url', 'cdp_frame'], 'lane-12': ['response_header', 'resource_url', 'cdp_frame'],
  };
  await withLab(async (lab) => {
    for (const [laneId, want] of Object.entries(required)) {
      const v = classify((await observe(lab, INTERNAL_LANES[laneId])).input);
      assert.deepEqual(v.signals, want, laneId);
    }
  });
});

test('reCAPTCHA lane is a real checkbox (304 px anchor), not the passive badge the classifier ignores', async () => {
  assert.deepEqual(INTERNAL_LANES['lane-11'].fixture.frameSize, [304, 78]);
  await withLab(async (lab) => {
    const { input, html } = await observe(lab, INTERNAL_LANES['lane-11']);
    assert.match(html, /<iframe [^>]*width="304" height="78"/);
    assert.equal(classify(input).surface, 'WIDGET_CHECKBOX');
    // Same frame at badge size would be ignored: proves the size matters.
    const badge = { ...input, frames: input.frames.map((f) => ({ ...f, box: [0, 0, 256, 60] })) };
    assert.equal(classify(badge).surface, 'PASSIVE_TELEMETRY');
  });
});

test('clean control: no challenge headers, markers, frames, widget calls or external calls', async () => {
  await withLab(async (lab) => {
    const { page, html, input } = await observe(lab, INTERNAL_LANES.control);
    assert.equal(page.status, 200);
    assert.equal(html.includes('<iframe'), false);
    assert.equal(html.includes(lab.origins.widget), false, 'references the widget origin');
    for (const [u] of html.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
      assert.ok(u.startsWith(`${lab.origins.parent}/`) || u === lab.origins.verify, `control references ${u}`);
    }
    const lower = html.toLowerCase();
    for (const sig of SIGNATURES) {
      for (const m of [...sig.urls, ...sig.frames]) assert.ok(!lower.includes(m), `control contains ${m}`);
      for (const [name] of sig.headers) assert.equal(page.headers[name], undefined, name);
    }
    assert.equal(classify(input).challenge, false);
    assert.deepEqual(allMatchingVendors(input), []);
  });
});

test('sibling pages are clean: no lane exposes another lane\'s markers or serves its paths', async () => {
  await withLab(async (lab) => {
    for (const [laneId, lane] of Object.entries(INTERNAL_LANES)) {
      const { html, token } = await observe(lab, lane);
      const own = new Set(expectedVendors(laneId));
      const lower = html.toLowerCase();
      for (const sig of SIGNATURES) {
        if (own.has(sig.vendor)) continue;
        for (const m of [...sig.urls, ...sig.frames]) assert.ok(!lower.includes(m), `${laneId} page contains ${sig.vendor} marker ${m}`);
      }
      for (const other of Object.values(INTERNAL_LANES)) {
        if (other === lane) continue;
        for (const p of other.fixture.resources) {
          const r = await lab.widget(`/resources/${lane.route}/${token}/${p}`, { headers: lab.fromParent() });
          assert.equal(r.status, 404, `${other.route} resource under ${lane.route}`);
        }
      }
    }
  });
});

test('navigation after each scenario is clean (continuation page has no verdict)', async () => {
  await withLab(async (lab) => {
    for (const lane of Object.values(INTERNAL_LANES)) {
      const token = await lab.issue(lane.route);
      const settle = [];
      for (const step of ['input', 'verify', 'settle']) {
        const r = await lab.api(step, token);
        assert.equal(r.status, 200);
        settle.push(responseSignal({ url: `${lab.origins.verify}/api/${step}/${token}`, status: r.status, headers: r.headers }));
      }
      const url = `${lab.origins.parent}/continue/${token}`;
      const r = await lab.parent(`/continue/${token}`);
      assert.equal(r.status, 200);
      const { scripts, frames, images } = extractResources(r.body);
      assert.deepEqual([...frames, ...images], []);
      assert.deepEqual(scripts, ['/assets/page.js']);
      const response = responseSignal({ url, status: r.status, headers: r.headers });
      const input = { url, response, networkEvents: [...settle, response, responseSignal({ url: new URL('/assets/page.js', url).href, status: 200, headers: {} })], frames: [], pageText: visibleText(r.body) };
      assert.equal(classify(input).challenge, false, `${lane.route} continuation: ${JSON.stringify(classify(input))}`);
      assert.deepEqual(allMatchingVendors(input), []);
      const withoutControlLink = r.body.replace(`href="${lab.origins.parent}/scenario/clean-control"`, '');
      assert.ok(!withoutControlLink.includes(`/${lane.route}`), `continuation page names ${lane.route}`);
    }
  });
});

test('route names never collide with another lane\'s registry markers (even if the main frame is reported as a frame)', () => {
  for (const [laneId, lane] of Object.entries(INTERNAL_LANES)) {
    const own = new Set(expectedVendors(laneId));
    const urls = [`https://h/scenario/${lane.route}/t`, `https://h/scenario/${lane.route}`];
    const vendors = allMatchingVendors({
      networkEvents: urls.map((url) => responseSignal({ url, status: 200 })),
      frames: [...urls, `https://h/widget/${lane.route}/t/`].map((url) => ({ url, visible: true, box: null })),
    });
    for (const v of vendors) assert.ok(own.has(v), `${lane.route} route alone matches ${v}`);
  }
});
