// Verification origin: CORS, state machine, separate per-instance state and receipts, management.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withLab } from './helpers.js';
import { INTERNAL_LANES } from './harness/suite.js';

const AUTH = 'management-authority-for-tests-'.padEnd(40, 'm');

test('scenario endpoints accept only the configured parent origin (explicit CORS, never wildcard, no credentials)', async () => {
  await withLab(async (lab) => {
    const token = await lab.issue('datadome');
    const ok = await lab.api('status', token);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['access-control-allow-origin'], lab.origins.parent);
    assert.equal(ok.headers['access-control-allow-credentials'], undefined);
    assert.match(ok.headers.vary, /Origin/);
    for (const origin of [lab.origins.widget, lab.origins.verify, 'https://attacker.example', 'null', '*']) {
      const r = await lab.api('status', token, { headers: { origin } });
      assert.equal(r.status, 403, origin);
      assert.equal(r.headers['access-control-allow-origin'], undefined);
    }
    const none = await lab.verify(`/api/status/${token}`);
    assert.equal(none.status, 403, 'no Origin header');
  });
});

test('preflight: allowed only for the parent origin and the step method', async () => {
  await withLab(async (lab) => {
    const token = await lab.issue('datadome');
    const pre = (origin, method) => lab.verify(`/api/input/${token}`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': method } });
    const ok = await pre(lab.origins.parent, 'POST');
    assert.equal(ok.status, 204);
    assert.equal(ok.headers['access-control-allow-methods'], 'GET, POST');
    assert.equal(ok.headers['access-control-allow-headers'], 'content-type, x-northstar-proof');
    assert.equal((await pre(lab.origins.parent, 'DELETE')).status, 403);
    assert.equal((await pre('https://attacker.example', 'POST')).status, 403);
  });
});

test('state machine: input -> verify -> settle, in order, once', async () => {
  await withLab(async (lab) => {
    const token = await lab.issue('perimeterx');
    assert.equal((await lab.api('verify', token)).status, 409, 'verify before input');
    assert.equal((await lab.api('settle', token)).status, 409, 'settle before verify');
    assert.equal((await lab.api('input', token, { body: '{"value":"other"}' })).status, 400);
    assert.equal((await lab.api('input', token, { body: '{"value":"acknowledged","extra":1}' })).status, 400);
    assert.equal((await lab.api('input', token, { body: 'not json' })).status, 400);
    assert.equal((await lab.api('input', token, { headers: { 'content-type': 'text/plain' } })).status, 400);
    assert.equal((await lab.api('input', token, { body: JSON.stringify({ value: 'x'.repeat(2000) }) })).status, 400, 'oversized body');
    assert.equal((await lab.api('input', token)).status, 200);
    assert.equal((await lab.api('input', token)).status, 409, 'input twice');
    assert.equal((await lab.api('verify', token)).status, 200);
    const settled = JSON.parse((await lab.api('settle', token)).body);
    assert.equal(settled.state, 'settled');
    assert.equal(settled.lane, '04');
    assert.match(settled.receipt.receipt, /^nsr_/);
    assert.match(settled.receipt.signature, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await lab.api('settle', token)).status, 409, 'settle twice');
    const status = JSON.parse((await lab.api('status', token)).body);
    assert.deepEqual(status.receipt, settled.receipt);
    assert.deepEqual(Object.keys(status.steps), ['input', 'verified', 'settled']);
  });
});

test('completion state and receipts are separate for every scenario instance (and evidence goes to separate directories)', async () => {
  const events = [];
  await withLab({ onEvidence: (e) => events.push(e) }, async (lab) => {
    const a = await lab.issue('geetest');
    const b = await lab.issue('geetest');
    const c = await lab.issue('hcaptcha');
    for (const step of ['input', 'verify', 'settle']) assert.equal((await lab.api(step, a)).status, 200);
    assert.equal(JSON.parse((await lab.api('status', b)).body).state, 'issued', 'sibling instance untouched');
    assert.equal(JSON.parse((await lab.api('status', c)).body).state, 'issued', 'other lane untouched');
    for (const step of ['input', 'verify', 'settle']) assert.equal((await lab.api(step, c)).status, 200);
    const ra = JSON.parse((await lab.api('status', a)).body).receipt;
    const rc = JSON.parse((await lab.api('status', c)).body).receipt;
    assert.notEqual(ra.receipt, rc.receipt);
    assert.notEqual(ra.instance, rc.instance);
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((e) => e.route), ['geetest', 'hcaptcha']);
    assert.notEqual(`${events[0].route}/${events[0].instance}`, `${events[1].route}/${events[1].instance}`);
  });
});

test('every lane completes its own flow on the verification origin', async () => {
  await withLab(async (lab) => {
    for (const lane of Object.values(INTERNAL_LANES)) {
      const token = await lab.issue(lane.route);
      for (const step of ['input', 'verify', 'settle']) assert.equal((await lab.api(step, token)).status, 200, `${lane.route} ${step}`);
      const cont = await lab.parent(`/continue/${token}`);
      assert.equal(cont.status, 200);
      assert.ok(cont.body.includes('Scenario complete'));
    }
  });
});

test('management endpoints are disabled unless an authority is configured', async () => {
  await withLab(async (lab) => {
    assert.equal((await lab.verify('/api/manage/instances', { headers: { authorization: `Bearer ${AUTH}` } })).status, 404);
  });
});

test('management access is restricted separately from scenario endpoints', async () => {
  await withLab({ extra: { NORTHSTAR_MANAGEMENT_AUTHORITY: AUTH } }, async (lab) => {
    const list = (headers) => lab.verify('/api/manage/instances', { headers });
    assert.equal((await list({})).status, 401);
    assert.equal((await list({ authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await list({ authorization: `Bearer ${AUTH}`, origin: lab.origins.parent })).status, 403, 'never from a browser page');
    assert.equal((await lab.verify('/api/manage/instances', { method: 'OPTIONS', headers: { origin: lab.origins.parent } })).status, 403);
    // A scenario-origin page cannot reach management through the scenario CORS grant.
    assert.equal((await lab.api('status', 'x', { headers: { authorization: `Bearer ${AUTH}` } })).status, 404);

    const issued = await lab.verify('/api/manage/instances', { method: 'POST', headers: { authorization: `Bearer ${AUTH}`, 'content-type': 'application/json' }, body: '{"lane":"akamai"}' });
    assert.equal(issued.status, 201);
    const body = JSON.parse(issued.body);
    assert.ok(body.scenario.startsWith(`${lab.origins.parent}/scenario/akamai/05.`));
    assert.equal((await lab.verify('/api/manage/instances', { method: 'POST', headers: { authorization: `Bearer ${AUTH}`, 'content-type': 'application/json' }, body: '{"lane":"nope"}' })).status, 400);
    const rows = JSON.parse((await list({ authorization: `Bearer ${AUTH}` })).body).instances;
    assert.ok(rows.some((r) => r.lane === '05' && r.state === 'issued'));
    assert.ok(!JSON.stringify(rows).includes(body.token), 'list never returns tokens');
    // Management is not reachable on the parent or widget origins.
    assert.equal((await lab.parent('/api/manage/instances', { headers: { authorization: `Bearer ${AUTH}` } })).status, 404);
    assert.equal((await lab.widget('/api/manage/instances', { headers: { authorization: `Bearer ${AUTH}` } })).status, 404);
  });
});
