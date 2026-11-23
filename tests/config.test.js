import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, validateLaneDefinitions, configFingerprint, laneReadiness } from '../configuration/config.js';
import { LANES } from '../functions/generated/data.js';
import { INTERNAL_LANES, localEnv } from './harness/suite.js';

test('configuration is disabled by default (empty env)', () => {
  const c = loadConfig({}, LANES);
  assert.equal(c.ok, false);
  assert.equal(c.enabled, false);
});

test('NORTHSTAR_ENABLED must be exactly "true"', () => {
  for (const v of ['1', 'yes', 'TRUE ', 'True', 'false', '']) {
    assert.equal(loadConfig(localEnv({ NORTHSTAR_ENABLED: v }), LANES).ok, false, JSON.stringify(v));
  }
  assert.equal(loadConfig(localEnv(), LANES).ok, true);
});

test('local configuration maps all 12 neutral hosts to the right lanes', () => {
  const c = loadConfig(localEnv(), LANES);
  assert.equal(c.ok, true, JSON.stringify(c.errors));
  assert.equal(c.hostToLane.size, 12);
  assert.equal(c.hostToLane.get('northstar-control.localhost'), 'control');
  for (let i = 1; i <= 11; i++) {
    const n = String(i).padStart(2, '0');
    assert.equal(c.hostToLane.get(`northstar-${n}.localhost`), `lane-${n}`);
  }
});

test('internal mapping assigns each lane to the specified provider', () => {
  const expected = {
    control: 'control', 'lane-01': 'cloudflare', 'lane-02': 'datadome', 'lane-03': 'aws_waf', 'lane-04': 'perimeterx',
    'lane-05': 'akamai', 'lane-06': 'kasada', 'lane-07': 'imperva', 'lane-08': 'arkose', 'lane-09': 'geetest',
    'lane-10': 'hcaptcha', 'lane-11': 'recaptcha',
  };
  assert.deepEqual(Object.fromEntries(Object.entries(INTERNAL_LANES).map(([k, v]) => [k, v.assignment])), expected);
});

test('missing host fails closed (no fallback derived from root domain)', () => {
  const c = loadConfig(localEnv({ NORTHSTAR_LANE_07_HOST: '' }), LANES);
  assert.equal(c.ok, false);
  assert.ok(c.errors.some((e) => e.includes('NORTHSTAR_LANE_07_HOST is missing')));
});

test('missing root domain / environment fail closed', () => {
  assert.equal(loadConfig(localEnv({ NORTHSTAR_ROOT_DOMAIN: '' }), LANES).ok, false);
  assert.equal(loadConfig(localEnv({ NORTHSTAR_ENVIRONMENT: '' }), LANES).ok, false);
  assert.equal(loadConfig(localEnv({ NORTHSTAR_ENVIRONMENT: 'production' }), LANES).ok, false);
});

test('duplicate hostname assignments are rejected', () => {
  const c = loadConfig(localEnv({ NORTHSTAR_LANE_03_HOST: 'northstar-02.localhost' }), LANES);
  assert.equal(c.ok, false);
  assert.ok(c.errors.some((e) => e.includes('duplicates')));
});

test('duplicate internal lane assignments are rejected', () => {
  const dup = structuredClone(INTERNAL_LANES);
  dup['lane-04'].assignment = 'datadome';
  assert.ok(validateLaneDefinitions(dup).some((e) => e.includes('duplicate assignment')));
  assert.deepEqual(validateLaneDefinitions(INTERNAL_LANES), []);
});

test('production / apex / www / outside-root hosts are refused', () => {
  assert.equal(loadConfig(localEnv({ NORTHSTAR_CONTROL_HOST: 'localhost' }), LANES).ok, false);
  assert.equal(loadConfig(localEnv({ NORTHSTAR_CONTROL_HOST: 'www.localhost' }), LANES).ok, false);
  assert.equal(loadConfig(localEnv({ NORTHSTAR_LANE_01_HOST: 'northstar-01.example.com' }), LANES).ok, false);
  assert.equal(loadConfig(localEnv({ NORTHSTAR_PRODUCTION_HOSTS: 'northstar-05.localhost' }), LANES).ok, false);
});

test('provider names are refused in public hostnames', () => {
  for (const bad of ['datadome-test.localhost', 'northstar-captcha.localhost', 'cf-waf.localhost']) {
    const c = loadConfig(localEnv({ NORTHSTAR_LANE_02_HOST: bad }), LANES);
    assert.equal(c.ok, false, bad);
  }
});

test('private secrets are refused in public site-key slots, and errors never echo values', () => {
  const secret = '0x' + 'ab'.repeat(20); // built at runtime so the source scan stays clean
  const c = loadConfig(localEnv({ NORTHSTAR_HCAPTCHA_SITE_KEY: secret }), LANES);
  assert.equal(c.ok, false);
  assert.ok(!JSON.stringify(c.errors).includes(secret));
  assert.equal(loadConfig(localEnv({ NORTHSTAR_RECAPTCHA_SITE_KEY: '6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe' }), LANES).ok, false);
  assert.equal(loadConfig(localEnv({ NORTHSTAR_RECAPTCHA_SITE_KEY: 'not-a-key' }), LANES).ok, false);
});

test('widget lanes without a site key are not ready, others still are', () => {
  const c = loadConfig(localEnv({ NORTHSTAR_HCAPTCHA_SITE_KEY: '' }), LANES);
  assert.equal(c.ok, true);
  assert.equal(laneReadiness(c, 'lane-10', LANES).ready, false);
  assert.equal(laneReadiness(c, 'lane-11', LANES).ready, true);
  assert.equal(laneReadiness(c, 'control', LANES).ready, true);
});

test('CORS origins must be explicit (no wildcard)', () => {
  assert.equal(loadConfig(localEnv({ NORTHSTAR_ALLOWED_ORIGINS: '*' }), LANES).ok, false);
  const c = loadConfig(localEnv({ NORTHSTAR_ALLOWED_ORIGINS: 'http://northstar-control.localhost:8787' }), LANES);
  assert.deepEqual(c.allowedOrigins, ['http://northstar-control.localhost:8787']);
});

test('configuration fingerprint is stable and changes with config', async () => {
  const a = await configFingerprint(loadConfig(localEnv(), LANES), LANES);
  const b = await configFingerprint(loadConfig(localEnv(), LANES), LANES);
  const c = await configFingerprint(loadConfig(localEnv({ NORTHSTAR_ENVIRONMENT: 'other' }), LANES), LANES);
  assert.match(a, /^sha256:[0-9a-f]{16}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('the deployable bundle does not contain the internal lane -> provider mapping', async () => {
  const { readFileSync } = await import('node:fs');
  const bundle = readFileSync(new URL('../functions/generated/data.js', import.meta.url), 'utf8');
  assert.ok(!bundle.includes('"assignment"'));
  for (const name of ['"cloudflare"', '"datadome"', '"perimeterx"', '"kasada"', '"imperva"']) assert.ok(!bundle.includes(name), name);
});
