// Interactive oracle endpoints, widget verification rules, /complete/{token} gating,
// RemoteFixtureServer management APIs, and strong-consistency NetlifyBlobsStore persistence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../functions/handler.js';
import { buildExpected, ORACLE_MIN_HOLD_MS, ORACLE_SPINNER_MS } from '../functions/oracle.js';
import { MemoryStore } from '../functions/state.js';
import {
  NetlifyBlobsStore,
  NETLIFY_STORE_NAME,
  NETLIFY_STORE_CONSISTENCY,
  createNetlifyBlobsStore,
} from '../functions/netlify-blobs-store.js';
import { withLab } from './helpers.js';
import { localEnv } from './harness/suite.js';

const AUTH = 'oracle-management-authority-'.padEnd(48, 'o');

function ptrEvent(overrides = {}) {
  return {
    type: 'pointerdown',
    trusted: true,
    x: 0.5,
    y: 0.5,
    cell: null,
    target: 'checkbox',
    key: null,
    pointer_id: 1,
    widget_width: 240,
    widget_height: 48,
    frame_width: 540,
    frame_height: 660,
    client_ms: 100,
    ...overrides,
  };
}

function makeFakeBlobBackend() {
  const map = new Map();
  const calls = [];
  const rawStore = {
    async get(key, opts) {
      calls.push({ op: 'get', key, opts });
      if (!map.has(key)) return null;
      const raw = map.get(key);
      return opts && opts.type === 'json' ? JSON.parse(raw) : raw;
    },
    async setJSON(key, value) {
      calls.push({ op: 'setJSON', key });
      map.set(key, JSON.stringify(value));
    },
    async list(opts = {}) {
      calls.push({ op: 'list', opts });
      const prefix = opts.prefix || '';
      const blobs = [];
      for (const key of map.keys()) {
        if (key.startsWith(prefix)) blobs.push({ key, etag: `etag-${key}` });
      }
      return { blobs };
    },
  };
  return { map, calls, rawStore };
}

test('oracle management endpoints require Bearer authority, refuse CORS, and reject bad input', async () => {
  await withLab({ extra: { NORTHSTAR_MANAGEMENT_AUTHORITY: AUTH } }, async (lab) => {
    const createRun = (body, headers = {}) => lab.verify('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

    assert.equal((await createRun({ scenario: 'checkbox', seed: 1 })).status, 401);
    assert.equal((await createRun({ scenario: 'checkbox', seed: 1 }, { authorization: 'Bearer wrong' })).status, 401);
    assert.equal(
      (await createRun({ scenario: 'checkbox', seed: 1 }, { authorization: `Bearer ${AUTH}`, origin: lab.origins.parent })).status,
      403,
      'never callable from a browser origin',
    );
    assert.equal(
      (await lab.verify('/api/runs', { method: 'OPTIONS', headers: { origin: lab.origins.parent } })).status,
      403,
    );
    assert.equal(
      (await createRun({ scenario: 'unknown-widget', seed: 1 }, { authorization: `Bearer ${AUTH}` })).status,
      400,
    );
    assert.equal(
      (await createRun({ scenario: 'checkbox', seed: 'not-int' }, { authorization: `Bearer ${AUTH}` })).status,
      400,
    );

    const created = await createRun({ scenario: 'checkbox', seed: 42 }, { authorization: `Bearer ${AUTH}` });
    assert.equal(created.status, 200);
    const run = JSON.parse(created.body);
    assert.equal(run.scenario, 'checkbox');
    assert.equal(run.provider_lane, 'recaptcha');
    assert.equal(run.seed, 42);
    assert.ok(run.url.startsWith(`${lab.origins.parent}/scenario/recaptcha/`));

    // Evidence & reset also enforce Bearer and reject Origin.
    assert.equal((await lab.verify(`/api/evidence/${run.token}`)).status, 401);
    assert.equal((await lab.verify(`/api/evidence/${run.token}`, { headers: { authorization: `Bearer ${AUTH}`, origin: lab.origins.widget } })).status, 403);
    const evRes = await lab.verify(`/api/evidence/${run.token}`, { headers: { authorization: `Bearer ${AUTH}` } });
    assert.equal(evRes.status, 200);
    const ev = JSON.parse(evRes.body);
    assert.equal(ev.scenario, 'checkbox');
    assert.equal(ev.completed, false);
    assert.equal(ev.continuation_reached, false);
  });
});

test('oracle checkbox enforces widget origin, isTrusted, /complete gating, and /api/reset revocation', async () => {
  await withLab({ extra: { NORTHSTAR_MANAGEMENT_AUTHORITY: AUTH } }, async (lab) => {
    const created = await lab.verify('/api/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${AUTH}`, 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'checkbox', seed: 7 }),
    });
    const { token } = JSON.parse(created.body);

    // Unsettled /complete returns 409.
    assert.equal((await lab.parent(`/complete/${token}`)).status, 409);

    // Parent page loads and embeds the cross-origin widget iframe.
    const parentPage = await lab.parent(`/scenario/recaptcha/${token}`);
    assert.equal(parentPage.status, 200);
    assert.ok(parentPage.body.includes('data-oracle="true"'));
    assert.ok(parentPage.body.includes(`${lab.origins.widget}/widget/recaptcha/${token}/`));

    // Oracle /api/input refuses parent origin (must come from widget origin).
    const badOrigin = await lab.api('input', token, {
      headers: { origin: lab.origins.parent },
      body: JSON.stringify(ptrEvent({ type: 'pointerdown', trusted: true, target: 'checkbox' })),
    });
    assert.equal(badOrigin.status, 403);

    // Untrusted synthetic events do not verify.
    await lab.api('input', token, {
      headers: { origin: lab.origins.widget },
      body: JSON.stringify(ptrEvent({ type: 'pointerdown', trusted: false, target: 'checkbox' })),
    });
    await lab.api('input', token, {
      headers: { origin: lab.origins.widget },
      body: JSON.stringify(ptrEvent({ type: 'pointerup', trusted: false, target: 'checkbox' })),
    });
    const badVerify = JSON.parse((await lab.api('verify', token, {
      headers: { origin: lab.origins.widget, 'content-type': 'application/json' },
      body: '{}',
    })).body);
    assert.equal(badVerify.accepted, false);

    // Reset produces a fresh clean token and revokes the old one.
    const resetRes = await lab.verify(`/api/reset/${token}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${AUTH}` },
    });
    assert.equal(resetRes.status, 200);
    const reset = JSON.parse(resetRes.body);
    assert.equal(reset.ok, true);
    assert.equal(reset.reset, true);
    assert.notEqual(reset.token, token);
    assert.equal((await lab.parent(`/complete/${token}`)).status, 410);

    // Trusted gesture on the fresh token succeeds end-to-end.
    const fresh = reset.token;
    assert.equal((await lab.api('input', fresh, {
      headers: { origin: lab.origins.widget },
      body: JSON.stringify(ptrEvent({ type: 'pointerdown', trusted: true, target: 'checkbox' })),
    })).status, 200);
    assert.equal((await lab.api('input', fresh, {
      headers: { origin: lab.origins.widget },
      body: JSON.stringify(ptrEvent({ type: 'pointerup', trusted: true, target: 'checkbox', client_ms: 145 })),
    })).status, 200);
    const verified = JSON.parse((await lab.api('verify', fresh, {
      headers: { origin: lab.origins.widget, 'content-type': 'application/json' },
      body: '{}',
    })).body);
    assert.equal(verified.accepted, true);
    assert.equal(verified.state, 'verified');

    const settled = JSON.parse((await lab.api('settle', fresh, {
      headers: { origin: lab.origins.widget, 'content-type': 'application/json' },
      body: '{}',
    })).body);
    assert.equal(settled.state, 'settled');
    assert.match(settled.receipt.receipt, /^nsr_/);

    const completePage = await lab.parent(`/complete/${fresh}`);
    assert.equal(completePage.status, 200);
    assert.ok(completePage.body.includes('id="continuation"'));

    const ev = JSON.parse((await lab.verify(`/api/evidence/${fresh}`, { headers: { authorization: `Bearer ${AUTH}` } })).body);
    assert.equal(ev.completed, true);
    assert.equal(ev.is_trusted, true);
    assert.equal(ev.continuation_reached, true);
  });
});

test('oracle spinner, press-and-hold, grid-3x3, grid-4x4, and slider verify exact timing, puzzle SVG, and geometry', async () => {
  const env = localEnv({
    NORTHSTAR_TOKEN_SIGNING_KEY: 'oracle-direct-key-'.padEnd(48, 'k'),
    NORTHSTAR_MANAGEMENT_AUTHORITY: AUTH,
  });
  const P = env.NORTHSTAR_PARENT_ORIGIN;
  const W = env.NORTHSTAR_WIDGET_ORIGIN;
  const V = env.NORTHSTAR_VERIFY_ORIGIN;
  const store = new MemoryStore();
  let clockMs = 1_750_000_000_000;
  const ctx = () => ({ store, now: () => Math.floor(clockMs / 1000), nowMs: () => clockMs });

  const create = async (scenario, seed) => {
    const r = await handleRequest(new Request(`${V}/api/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${AUTH}`, 'content-type': 'application/json' },
      body: JSON.stringify({ scenario, seed }),
    }), env, ctx());
    assert.equal(r.status, 200, scenario);
    return r.json();
  };
  const postStep = async (step, token, body = {}) => {
    const r = await handleRequest(new Request(`${V}/api/${step}/${token}`, {
      method: 'POST',
      headers: { origin: W, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }), env, ctx());
    return { status: r.status, json: await r.json() };
  };
  const evidence = async (token) => {
    const r = await handleRequest(new Request(`${V}/api/evidence/${token}`, {
      headers: { authorization: `Bearer ${AUTH}` },
    }), env, ctx());
    assert.equal(r.status, 200);
    return r.json();
  };

  // 1. Spinner: < ORACLE_SPINNER_MS returns 409, >= ORACLE_SPINNER_MS settles.
  const sp = await create('spinner', 11);
  assert.equal((await postStep('settle', sp.token)).status, 409);
  clockMs += ORACLE_SPINNER_MS + 50;
  const spDone = await postStep('settle', sp.token);
  assert.equal(spDone.status, 200);
  assert.equal(spDone.json.state, 'settled');
  assert.equal((await evidence(sp.token)).is_trusted, true);

  // 2. Press-and-hold: short hold rejected, >= ORACLE_MIN_HOLD_MS accepted.
  const hold = await create('press-and-hold', 12);
  await postStep('input', hold.token, ptrEvent({ type: 'pointerdown', target: 'hold', pointer_id: 2 }));
  clockMs += 1500;
  await postStep('input', hold.token, ptrEvent({ type: 'pointerup', target: 'hold', pointer_id: 2 }));
  assert.equal((await postStep('verify', hold.token)).json.accepted, false);
  await postStep('input', hold.token, ptrEvent({ type: 'pointerdown', target: 'hold', pointer_id: 3 }));
  clockMs += ORACLE_MIN_HOLD_MS + 100;
  await postStep('input', hold.token, ptrEvent({ type: 'pointerup', target: 'hold', pointer_id: 3 }));
  assert.equal((await postStep('verify', hold.token)).json.accepted, true);
  assert.equal((await postStep('settle', hold.token)).json.state, 'settled');
  assert.equal((await evidence(hold.token)).is_trusted, true);

  // 3. Grid-3x3 and Grid-4x4: puzzle.svg requires parent/widget Referer, verifies exact cells + trusted clicks.
  for (const [scenario, widget, seed] of [['grid-3x3', 'grid3', 13], ['grid-4x4', 'grid4', 14]]) {
    const g = await create(scenario, seed);
    const svgBlocked = await handleRequest(new Request(`${W}/images/recaptcha/${g.token}/puzzle.svg`), env, ctx());
    assert.equal(svgBlocked.status, 403);
    const svgOk = await handleRequest(new Request(`${W}/images/recaptcha/${g.token}/puzzle.svg`, {
      headers: { referer: `${W}/widget/recaptcha/${g.token}/fx/recaptcha/api2/bframe/gate-checkbox-b/bframe` },
    }), env, ctx());
    assert.equal(svgOk.status, 200);
    assert.match(await svgOk.text(), /<svg/);

    const expected = buildExpected(widget, seed);
    for (const cell of expected.cells) {
      await postStep('input', g.token, ptrEvent({ type: 'pointerdown', target: 'tile', cell }));
      await postStep('input', g.token, ptrEvent({ type: 'pointerup', target: 'tile', cell }));
    }
    await postStep('input', g.token, ptrEvent({ type: 'pointerdown', target: 'verify' }));
    await postStep('input', g.token, ptrEvent({ type: 'pointerup', target: 'verify' }));
    assert.equal((await postStep('verify', g.token, { cells: [0] })).json.accepted, false);
    assert.equal((await postStep('verify', g.token, { cells: expected.cells })).json.accepted, true);
    assert.equal((await postStep('settle', g.token)).json.state, 'settled');
    assert.equal((await evidence(g.token)).is_trusted, true);
  }

  // 4. Slider: rejects drag without pointermove, accepts left-to-target trusted drag.
  const sl = await create('slider', 15);
  const expectedSlider = buildExpected('slider', 15);
  await postStep('input', sl.token, ptrEvent({ type: 'pointerdown', target: 'slider', x: 0.08, pointer_id: 5 }));
  await postStep('input', sl.token, ptrEvent({ type: 'pointerup', target: 'slider', x: expectedSlider.target, pointer_id: 5 }));
  assert.equal((await postStep('verify', sl.token)).json.accepted, false, 'missing pointermove');
  await postStep('input', sl.token, ptrEvent({ type: 'pointerdown', target: 'slider', x: 0.08, pointer_id: 6 }));
  await postStep('input', sl.token, ptrEvent({ type: 'pointermove', target: 'slider', x: expectedSlider.target * 0.5, pointer_id: 6 }));
  await postStep('input', sl.token, ptrEvent({ type: 'pointerup', target: 'slider', x: expectedSlider.target, pointer_id: 6 }));
  assert.equal((await postStep('verify', sl.token)).json.accepted, true);
  assert.equal((await postStep('settle', sl.token)).json.state, 'settled');
  assert.equal((await handleRequest(new Request(`${P}/complete/${sl.token}`), env, ctx())).status, 200);
  const slEv = await evidence(sl.token);
  assert.equal(slEv.completed, true);
  assert.equal(slEv.is_trusted, true);
  assert.equal(slEv.continuation_reached, true);
});

test('NetlifyBlobsStore requests consistency:"strong", persists read-after-write across fresh instances, and falls back to MemoryStore locally', async () => {
  // 1. Local fallback when Netlify runtime env is absent.
  const localStore = await createNetlifyBlobsStore({ env: {} });
  assert.ok(localStore instanceof MemoryStore);

  // 2. Strong-consistency options verified via injected getStoreFn.
  const { rawStore, calls } = makeFakeBlobBackend();
  const getStoreArgs = [];
  const makeInstanceStore = () => createNetlifyBlobsStore({
    env: { NETLIFY: 'true' },
    getStoreFn: (opts) => {
      getStoreArgs.push(opts);
      return rawStore;
    },
  });

  const firstStore = await makeInstanceStore();
  assert.ok(firstStore instanceof NetlifyBlobsStore);
  assert.deepEqual(getStoreArgs[0], {
    name: NETLIFY_STORE_NAME,
    consistency: NETLIFY_STORE_CONSISTENCY,
  });
  assert.equal(NETLIFY_STORE_NAME, 'northstar-state');
  assert.equal(NETLIFY_STORE_CONSISTENCY, 'strong');

  // 3. Full multi-request oracle flow where EVERY HTTP request constructs a brand-new
  //    NetlifyBlobsStore adapter (simulating independent serverless invocations).
  const env = localEnv({
    NORTHSTAR_TOKEN_SIGNING_KEY: 'netlify-blobs-test-key-'.padEnd(48, 'b'),
    NORTHSTAR_MANAGEMENT_AUTHORITY: AUTH,
  });
  const P = env.NORTHSTAR_PARENT_ORIGIN;
  const W = env.NORTHSTAR_WIDGET_ORIGIN;
  const V = env.NORTHSTAR_VERIFY_ORIGIN;

  const invoke = async (req) => handleRequest(req, env, { store: await makeInstanceStore() });

  const created = await (await invoke(new Request(`${V}/api/runs`, {
    method: 'POST',
    headers: { authorization: `Bearer ${AUTH}`, 'content-type': 'application/json' },
    body: JSON.stringify({ scenario: 'checkbox', seed: 99 }),
  }))).json();

  assert.equal((await invoke(new Request(`${V}/api/input/${created.token}`, {
    method: 'POST',
    headers: { origin: W, 'content-type': 'application/json' },
    body: JSON.stringify(ptrEvent({ type: 'pointerdown', target: 'checkbox' })),
  }))).status, 200);
  assert.equal((await invoke(new Request(`${V}/api/input/${created.token}`, {
    method: 'POST',
    headers: { origin: W, 'content-type': 'application/json' },
    body: JSON.stringify(ptrEvent({ type: 'pointerup', target: 'checkbox' })),
  }))).status, 200);
  assert.equal((await (await invoke(new Request(`${V}/api/verify/${created.token}`, {
    method: 'POST',
    headers: { origin: W, 'content-type': 'application/json' },
    body: '{}',
  }))).json()).accepted, true);
  assert.equal((await (await invoke(new Request(`${V}/api/settle/${created.token}`, {
    method: 'POST',
    headers: { origin: W, 'content-type': 'application/json' },
    body: '{}',
  }))).json()).state, 'settled');
  assert.equal((await invoke(new Request(`${P}/complete/${created.token}`))).status, 200);

  const ev = await (await invoke(new Request(`${V}/api/evidence/${created.token}`, {
    headers: { authorization: `Bearer ${AUTH}` },
  }))).json();
  assert.equal(ev.completed, true);
  assert.equal(ev.is_trusted, true);
  assert.equal(ev.continuation_reached, true);

  // Also confirm list() reads back the persisted blob entry.
  const listed = await (await makeInstanceStore()).list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].record.state, 'settled');
  assert.ok(calls.some((c) => c.op === 'setJSON'));
  assert.ok(calls.some((c) => c.op === 'get' && c.opts && c.opts.type === 'json'));
});
