// HTTP-level check (no browser): each lane exposes exactly its expected characteristics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, withServer, extractResources } from './helpers.js';
import { localEnv, INTERNAL_LANES, expectedVendors } from './harness/suite.js';
import { matchObservation, SIGNATURES } from './reference-matcher.js';

const env = localEnv();

test('every lane triggers exactly its own signature; control and lane-01 (origin) trigger none', async () => {
  await withServer(env, async ({ port }) => {
    for (const [laneId, lane] of Object.entries(INTERNAL_LANES)) {
      const host = env[lane.hostVariable];
      const page = await request({ port, host });
      const { scripts, frames } = extractResources(page.body);
      const base = `http://${host}:${port}/`;
      const observation = {
        status: page.status,
        headers: page.headers,
        urls: [base, ...scripts.map((s) => new URL(s, base).href), ...frames.map((f) => new URL(f, base).href)],
        frames: frames.map((f) => new URL(f, base).href),
      };
      const hits = matchObservation(observation);
      assert.deepEqual(hits.map((h) => h.vendor), expectedVendors(laneId), `${laneId}: ${JSON.stringify(hits)}`);
      for (const h of hits) assert.notEqual(h.statusMatch, false, `${laneId} status ${page.status} not in registry statuses`);
    }
  });
});

test('fixture lanes cover every marker category the spec requires', async () => {
  const required = {
    datadome: ['header', 'url', 'frame'], aws_waf: ['header', 'url', 'frame'], perimeterx: ['url', 'frame'],
    akamai: ['header', 'url'], kasada: ['header', 'url'], imperva: ['header', 'url', 'frame'],
    arkose: ['url', 'frame'], geetest: ['url', 'frame'], hcaptcha: ['url'], recaptcha: ['url'],
  };
  await withServer(env, async ({ port }) => {
    for (const [laneId, lane] of Object.entries(INTERNAL_LANES)) {
      const want = required[lane.assignment];
      if (!want) continue;
      const host = env[lane.hostVariable];
      const page = await request({ port, host });
      const { scripts, frames } = extractResources(page.body);
      const base = `http://${host}:${port}/`;
      const [hit] = matchObservation({
        status: page.status, headers: page.headers,
        urls: scripts.map((s) => new URL(s, base).href), frames: frames.map((f) => new URL(f, base).href),
      });
      const kinds = new Set(hit.via.map((v) => v.split(':')[0]));
      for (const k of want) assert.ok(kinds.has(k), `${laneId} missing ${k} marker`);
    }
  });
});

test('every fixture resource and frame referenced by a lane is served by that lane only', async () => {
  await withServer(env, async ({ port }) => {
    for (const [laneId, lane] of Object.entries(INTERNAL_LANES)) {
      const host = env[lane.hostVariable];
      for (const p of [...lane.fixture.scripts, ...lane.fixture.frames]) {
        const r = await request({ port, host, path: p });
        assert.equal(r.status, 200, `${laneId} ${p}`);
        // Fixture sub-resources never carry the lane's challenge headers.
        for (const h of Object.keys(lane.fixture.headers)) if (h !== 'server') assert.equal(r.headers[h], undefined);
        const other = laneId === 'control' ? env.NORTHSTAR_LANE_01_HOST : env.NORTHSTAR_CONTROL_HOST;
        assert.equal((await request({ port, host: other, path: p })).status, 404, `${p} leaks to ${other}`);
      }
    }
  });
});

test('control page carries no header, path or frame marker from any signature', async () => {
  await withServer(env, async ({ port }) => {
    const page = await request({ port, host: env.NORTHSTAR_CONTROL_HOST });
    assert.equal(page.status, 200);
    assert.equal(page.body.includes('<iframe'), false);
    const lower = page.body.toLowerCase();
    for (const sig of SIGNATURES) {
      for (const m of [...sig.urls, ...sig.frames]) assert.ok(!lower.includes(m), `control contains ${m}`);
      for (const [name] of sig.headers) if (name !== 'server') assert.equal(page.headers[name], undefined);
    }
  });
});

test('widget lanes load only the official provider script with the configured public key', async () => {
  await withServer(env, async ({ port }) => {
    const h = (await request({ port, host: env.NORTHSTAR_LANE_10_HOST })).body;
    assert.ok(h.includes('src="https://js.hcaptcha.com/1/api.js"'));
    assert.ok(h.includes(`data-sitekey="${env.NORTHSTAR_HCAPTCHA_SITE_KEY}"`));
    const r = (await request({ port, host: env.NORTHSTAR_LANE_11_HOST })).body;
    assert.ok(r.includes('src="https://www.google.com/recaptcha/api.js"'));
    assert.ok(r.includes(`data-sitekey="${env.NORTHSTAR_RECAPTCHA_SITE_KEY}"`));
  });
});
