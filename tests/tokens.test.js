// Lane isolation through tokens: random per instance, bound to one lane, expiring, unforgeable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withLab } from './helpers.js';
import { INTERNAL_LANES } from './harness/suite.js';
import { issueToken, verifyToken } from '../functions/tokens.js';
import { loadConfig } from '../configuration/config.js';
import { LANES } from '../functions/generated/data.js';
import { localEnv } from './harness/suite.js';

const firstWidgetPath = (lane) => {
  for (const [kind, prefix] of [['resources', 'resources'], ['frames', 'widget'], ['images', 'images']]) {
    if (lane.fixture[kind].length) return (token) => `/${prefix}/${lane.route}/${token}/${lane.fixture[kind][0]}`;
  }
  return null;
};

test('tokens are random per instance and carry their lane code', async () => {
  await withLab(async (lab) => {
    const a = await lab.issue('datadome');
    const b = await lab.issue('datadome');
    assert.notEqual(a, b);
    assert.match(a, /^02\.[A-Za-z0-9_-]{22}\.[0-9a-z]+\.[A-Za-z0-9_-]{43}$/);
  });
});

test('cross-lane tokens are rejected on parent, widget, continuation and verify', async () => {
  await withLab(async (lab) => {
    const lanes = Object.values(INTERNAL_LANES);
    for (const owner of lanes) {
      const token = await lab.issue(owner.route);
      for (const other of lanes) {
        if (other === owner) continue;
        assert.equal((await lab.parent(`/scenario/${other.route}/${token}`)).status, 404, `${owner.route} token on ${other.route} page`);
        const wp = firstWidgetPath(other);
        if (wp) assert.equal((await lab.widget(wp(token), { headers: lab.fromParent() })).status, 404, `${owner.route} token on ${other.route} widget`);
      }
      // The token still works for its own lane.
      assert.equal((await lab.parent(`/scenario/${owner.route}/${token}`)).status, owner.fixture.status);
      const own = firstWidgetPath(owner);
      if (own) assert.equal((await lab.widget(own(token), { headers: lab.fromParent() })).status, 200);
    }
  });
});

test('a lane code swapped into a token invalidates its signature', async () => {
  await withLab(async (lab) => {
    const token = await lab.issue('datadome');
    const forged = `03${token.slice(2)}`;
    assert.equal((await lab.parent(`/scenario/aws-waf/${forged}`)).status, 404);
    assert.equal((await lab.api('status', forged)).status, 404);
    assert.equal((await lab.parent(`/continue/${forged}`)).status, 404);
  });
});

test('unknown, malformed and tampered tokens are rejected everywhere', async () => {
  await withLab(async (lab) => {
    const real = await lab.issue('kasada');
    const tampered = real.slice(0, -1) + (real.endsWith('A') ? 'B' : 'A');
    for (const t of ['x', '06.abc', tampered, '06.AAAAAAAAAAAAAAAAAAAAAA.zzzzzz.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA']) {
      assert.equal((await lab.parent(`/scenario/kasada/${t}`)).status, 404, t);
      assert.equal((await lab.widget(`/resources/kasada/${t}/fx/kpsdk/ips.js`, { headers: lab.fromParent() })).status, 404, t);
      assert.equal((await lab.api('status', t)).status, 404, t);
      assert.equal((await lab.api('input', t)).status, 404, t);
      assert.equal((await lab.parent(`/continue/${t}`)).status, 404, t);
    }
  });
});

test('tokens from another deployment (different signing key) are rejected', async () => {
  const other = await loadConfig(localEnv({ NORTHSTAR_TOKEN_SIGNING_KEY: 'another-deployment-key-'.padEnd(40, 'z') }), LANES);
  const { token } = await issueToken(other, '02');
  await withLab(async (lab) => {
    assert.equal((await lab.parent(`/scenario/datadome/${token}`)).status, 404);
    assert.equal((await lab.api('status', token)).status, 404);
  });
});

test('expired tokens are rejected (410) on parent, widget, verify and continuation', async () => {
  let clock = Math.floor(Date.now() / 1000);
  await withLab({ now: () => clock, extra: { NORTHSTAR_TOKEN_TTL: '60' } }, async (lab) => {
    const token = await lab.issue('imperva');
    assert.equal((await lab.parent(`/scenario/imperva/${token}`)).status, 403, 'valid before expiry');
    clock += 61;
    assert.equal((await lab.parent(`/scenario/imperva/${token}`)).status, 410);
    assert.equal((await lab.widget(`/resources/imperva/${token}/_incapsula_resource?swjiylwa=northstar`, { headers: lab.fromParent() })).status, 410);
    assert.equal((await lab.api('input', token)).status, 410);
    assert.equal((await lab.api('status', token)).status, 410);
    assert.equal((await lab.parent(`/continue/${token}`)).status, 410);
  });
});

test('verifyToken unit: reasons are precise', async () => {
  const cfg = await loadConfig(localEnv(), LANES);
  const now = 1_800_000_000;
  const { token } = await issueToken(cfg, '05', { now, ttl: 100 });
  assert.deepEqual((await verifyToken(cfg, token, { expectedCode: '05', now })).ok, true);
  assert.equal((await verifyToken(cfg, token, { expectedCode: '06', now })).reason, 'cross_lane');
  assert.equal((await verifyToken(cfg, token, { now: now + 100 })).reason, 'expired');
  assert.equal((await verifyToken(cfg, `${token}x`, { now })).reason, 'malformed');
  const mid = token.length - 10;
  const tampered = token.slice(0, mid) + (token[mid] === 'a' ? 'b' : 'a') + token.slice(mid + 1);
  assert.equal((await verifyToken(cfg, tampered, { now })).reason, 'invalid');
  // Non-canonical base64url (padding-bit variant of the same MAC) is refused.
  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const idx = ALPHA.indexOf(token.at(-1));
  assert.equal(idx % 4, 0, 'issued MAC is canonical');
  assert.equal((await verifyToken(cfg, token.slice(0, -1) + ALPHA[idx + 1], { now })).reason, 'malformed');
});

test('widget requests validate the current fixture state (closed after settle or revoke)', async () => {
  const authority = 'management-authority-for-tests-'.padEnd(40, 'm');
  await withLab({ extra: { NORTHSTAR_MANAGEMENT_AUTHORITY: authority } }, async (lab) => {
    const path = (t) => `/resources/arkose/${t}/fx/arkoselabs.com/v2/api.js`;
    const settled = await lab.issue('arkose');
    assert.equal((await lab.widget(path(settled), { headers: lab.fromParent() })).status, 200);
    for (const step of ['input', 'verify', 'settle']) assert.equal((await lab.api(step, settled)).status, 200, step);
    assert.equal((await lab.widget(path(settled), { headers: lab.fromParent() })).status, 410);

    const revoked = await lab.issue('arkose');
    const r = await lab.verify(`/api/manage/revoke/${revoked}`, { method: 'POST', headers: { authorization: `Bearer ${authority}` } });
    assert.equal(r.status, 200);
    assert.equal((await lab.widget(path(revoked), { headers: lab.fromParent() })).status, 410);
    assert.equal((await lab.parent(`/scenario/arkose/${revoked}`)).status, 410);
    assert.equal((await lab.api('input', revoked)).status, 410);
  });
});
