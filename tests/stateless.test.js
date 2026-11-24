// Serverless behaviour: scenario steps may be served by DIFFERENT function instances (separate
// in-memory stores, same signing key). Signed progress proofs replace shared storage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../functions/handler.js';
import { MemoryStore } from '../functions/state.js';
import { localEnv } from './harness/suite.js';

const env = localEnv({ NORTHSTAR_TOKEN_SIGNING_KEY: 'shared-key-'.padEnd(48, 's') });
const P = env.NORTHSTAR_PARENT_ORIGIN;
const V = env.NORTHSTAR_VERIFY_ORIGIN;
const instance = () => ({ store: new MemoryStore() });

async function issue(ctx, route = 'datadome') {
  const r = await handleRequest(new Request(`${P}/scenario/${route}`), env, ctx);
  return r.headers.get('location').split('/').pop();
}
async function step(ctx, token, name, { proof, body } = {}) {
  const r = await handleRequest(new Request(`${V}/api/${name}/${token}`, {
    method: 'POST',
    headers: { origin: P, 'content-type': 'application/json', ...(proof ? { 'x-northstar-proof': proof } : {}) },
    body,
  }), env, ctx);
  return { status: r.status, json: await r.json() };
}
const INPUT = '{"value":"acknowledged"}';

test('without a proof, another instance cannot continue the flow (why proofs exist)', async () => {
  const token = await issue(instance());
  assert.equal((await step(instance(), token, 'input', { body: INPUT })).status, 200);
  assert.equal((await step(instance(), token, 'verify')).status, 409);
});

test('with the proof from the previous step, every step can be served by a different instance', async () => {
  const token = await issue(instance());
  const r1 = await step(instance(), token, 'input', { body: INPUT });
  const r2 = await step(instance(), token, 'verify', { proof: r1.json.proof });
  const r3 = await step(instance(), token, 'settle', { proof: r2.json.proof });
  assert.deepEqual([r1.status, r2.status, r3.status], [200, 200, 200]);
  assert.equal(r3.json.state, 'settled');
  assert.match(r3.json.receipt.receipt, /^nsr_/);
  const status = await handleRequest(new Request(`${V}/api/status/${token}`, { headers: { origin: P, 'x-northstar-proof': r3.json.proof } }), env, instance());
  assert.equal((await status.json()).state, 'settled');
});

test('the continuation page on a fresh instance shows completion only with the proof', async () => {
  const token = await issue(instance());
  const r1 = await step(instance(), token, 'input', { body: INPUT });
  const r2 = await step(instance(), token, 'verify', { proof: r1.json.proof });
  const r3 = await step(instance(), token, 'settle', { proof: r2.json.proof });
  const plain = await (await handleRequest(new Request(`${P}/continue/${token}`), env, instance())).text();
  assert.ok(plain.includes('Scenario not complete'));
  const withProof = await (await handleRequest(new Request(`${P}/continue/${token}?p=${encodeURIComponent(r3.json.proof)}`), env, instance())).text();
  assert.ok(withProof.includes('Scenario complete'));
  const garbage = await (await handleRequest(new Request(`${P}/continue/${token}?p=garbage`), env, instance())).text();
  assert.ok(garbage.includes('Scenario not complete'));
});

test('proofs cannot be replayed on another token instance, tampered with, or used to skip steps', async () => {
  const a = await issue(instance());
  const b = await issue(instance());
  const r1 = await step(instance(), a, 'input', { body: INPUT });
  const r2 = await step(instance(), a, 'verify', { proof: r1.json.proof });
  assert.equal((await step(instance(), b, 'settle', { proof: r2.json.proof })).status, 409, 'proof from another instance');
  const forged = r2.json.proof.slice(0, -2) + (r2.json.proof.at(-2) === 'A' ? 'B' : 'A') + r2.json.proof.at(-1);
  assert.equal((await step(instance(), a, 'settle', { proof: forged })).status, 409, 'tampered proof');
  assert.equal((await step(instance(), a, 'settle', { proof: r1.json.proof })).status, 409, 'input-only proof cannot settle');
  assert.equal((await step(instance(), a, 'settle', { proof: 'x'.repeat(5000) })).status, 409, 'oversized proof');
});

test('a proof from another deployment (different signing key) is rejected', async () => {
  const token = await issue(instance());
  const r1 = await step(instance(), token, 'input', { body: INPUT });
  const otherEnv = { ...env, NORTHSTAR_TOKEN_SIGNING_KEY: 'another-key-'.padEnd(48, 'o') };
  const r = await handleRequest(new Request(`${V}/api/verify/${token}`, { method: 'POST', headers: { origin: P, 'x-northstar-proof': r1.json.proof } }), otherEnv, instance());
  assert.equal(r.status, 404, 'token itself is invalid under another key');
});
