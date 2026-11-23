// Signal isolation (HTTP level, no browser): each lane exposes exactly its own characteristics,
// sibling and continuation pages stay clean, and every registered provider stays covered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withLab, extractResources } from './helpers.js';
import { INTERNAL_LANES, expectedVendors } from './harness/suite.js';
import { matchObservation, SIGNATURES } from './reference-matcher.js';

/** Load a lane page and every widget resource it references; return the detector observation. */
async function observe(lab, lane) {
  const token = await lab.issue(lane.route);
  const pageUrl = `${lab.origins.parent}/scenario/${lane.route}/${token}`;
  const page = await lab.parent(`/scenario/${lane.route}/${token}`);
  const { scripts, frames, images } = extractResources(page.body);
  const abs = (u) => new URL(u, pageUrl).href;
  const sub = [...scripts, ...frames, ...images].map(abs);
  const statuses = {};
  for (const u of sub) {
    const url = new URL(u);
    const role = Object.entries(lab.origins).find(([, o]) => o === url.origin)?.[0];
    statuses[u] = (await lab[role](url.pathname + url.search, { headers: lab.fromParent() })).status;
  }
  return {
    token, page, statuses, html: page.body,
    observation: { status: page.status, headers: page.headers, urls: [pageUrl, ...sub], frames: frames.map(abs) },
  };
}

test('every lane triggers exactly its own signature (clean control, Cloudflare-at-origin and YouTube gate trigger none)', async () => {
  await withLab(async (lab) => {
    for (const [laneId, lane] of Object.entries(INTERNAL_LANES)) {
      const { observation, statuses } = await observe(lab, lane);
      const hits = matchObservation(observation);
      assert.deepEqual(hits.map((h) => h.vendor), expectedVendors(laneId), `${laneId}: ${JSON.stringify(hits)}`);
      for (const h of hits) assert.notEqual(h.statusMatch, false, `${laneId} status ${observation.status} not in registry statuses`);
      for (const [u, s] of Object.entries(statuses)) assert.equal(s, 200, `${laneId} ${u}`);
    }
  });
});

test('all 11 registered providers remain covered (10 by origin fixtures, Cloudflare by its edge rule)', async () => {
  const registry = SIGNATURES.map((s) => s.vendor).sort();
  assert.equal(registry.length, 11);
  const origin = new Set(Object.keys(INTERNAL_LANES).flatMap(expectedVendors));
  const edge = Object.values(INTERNAL_LANES).filter((l) => l.edge).map((l) => l.assignment);
  assert.deepEqual([...new Set([...origin, ...edge])].sort(), registry);
  assert.deepEqual(edge, ['cloudflare']);
});

test('fixture lanes exercise every marker category of their signature', async () => {
  const required = {
    'lane-02': ['header', 'url', 'frame'], 'lane-03': ['header', 'url', 'frame'], 'lane-04': ['url', 'frame'],
    'lane-05': ['header', 'url'], 'lane-06': ['header', 'url'], 'lane-07': ['header', 'url', 'frame'],
    'lane-08': ['url', 'frame'], 'lane-09': ['url', 'frame'], 'lane-10': ['url', 'frame'], 'lane-11': ['url', 'frame'],
    'lane-12': ['header', 'url', 'frame'],
  };
  await withLab(async (lab) => {
    for (const [laneId, want] of Object.entries(required)) {
      const { observation } = await observe(lab, INTERNAL_LANES[laneId]);
      const [hit] = matchObservation(observation);
      const kinds = new Set(hit.via.map((v) => v.split(':')[0]));
      for (const k of want) assert.ok(kinds.has(k), `${laneId} missing ${k} marker`);
      assert.equal(hit.statusMatch === false, false, `${laneId} status`);
    }
  });
});

test('clean control: no challenge headers, markers, frames, widget calls or external calls', async () => {
  await withLab(async (lab) => {
    const { page, html } = await observe(lab, INTERNAL_LANES.control);
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
  });
});

test('sibling pages are clean: no lane exposes another lane\'s markers', async () => {
  await withLab(async (lab) => {
    for (const [laneId, lane] of Object.entries(INTERNAL_LANES)) {
      const { html, observation } = await observe(lab, lane);
      const own = new Set(expectedVendors(laneId));
      const lower = html.toLowerCase();
      for (const sig of SIGNATURES) {
        if (own.has(sig.vendor)) continue;
        for (const m of [...sig.urls, ...sig.frames]) assert.ok(!lower.includes(m), `${laneId} page contains ${sig.vendor} marker ${m}`);
        for (const [name, value] of sig.headers) {
          const v = observation.headers[name];
          assert.ok(v === undefined || !String(v).toLowerCase().includes(value) || value === '', `${laneId} carries ${sig.vendor} header ${name}`);
          if (value === '') assert.equal(v, undefined, `${laneId} carries ${sig.vendor} header ${name}`);
        }
      }
      // Other lanes' resource paths are never served under this lane's route.
      for (const other of Object.values(INTERNAL_LANES)) {
        if (other === lane) continue;
        for (const p of other.fixture.resources) {
          const r = await lab.widget(`/resources/${lane.route}/${observation.urls[0].split('/').pop()}/${p}`, { headers: lab.fromParent() });
          assert.equal(r.status, 404, `${other.route} resource under ${lane.route}`);
        }
      }
    }
  });
});

test('navigation after each scenario is clean (continuation page carries no signal)', async () => {
  await withLab(async (lab) => {
    for (const lane of Object.values(INTERNAL_LANES)) {
      const token = await lab.issue(lane.route);
      for (const step of ['input', 'verify', 'settle']) assert.equal((await lab.api(step, token)).status, 200);
      const url = `${lab.origins.parent}/continue/${token}`;
      const r = await lab.parent(`/continue/${token}`);
      assert.equal(r.status, 200);
      const { scripts, frames, images } = extractResources(r.body);
      assert.deepEqual([...frames, ...images], []);
      assert.deepEqual(scripts, ['/assets/page.js']);
      const hits = matchObservation({ status: r.status, headers: r.headers, urls: [url, ...scripts.map((s) => new URL(s, url).href)], frames });
      assert.deepEqual(hits, [], `${lane.route} continuation: ${JSON.stringify(hits)}`);
      assert.ok(!r.body.includes(lab.origins.widget));
      const withoutControlLink = r.body.replace(`href="${lab.origins.parent}/scenario/clean-control"`, '');
      assert.ok(!withoutControlLink.includes(`/${lane.route}`), `continuation page names ${lane.route}`);
    }
  });
});

test('route names never collide with another lane\'s registry markers', () => {
  for (const [laneId, lane] of Object.entries(INTERNAL_LANES)) {
    const own = new Set(expectedVendors(laneId));
    const path = `/scenario/${lane.route}/`;
    const hits = matchObservation({ urls: [`https://h${path}`, `https://h/resources/${lane.route}/t/`], frames: [`https://h/widget/${lane.route}/t/`] });
    for (const h of hits) assert.ok(own.has(h.vendor), `${lane.route} route alone matches ${h.vendor}`);
  }
});
