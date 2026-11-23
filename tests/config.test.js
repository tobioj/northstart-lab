import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig, validateLaneDefinitions, configFingerprint, laneReadiness, sanitizedConfig, DEPRECATED_VARIABLES } from '../configuration/config.js';
import { LANES } from '../functions/generated/data.js';
import { INTERNAL_LANES, localEnv, SECRET_SENTINELS } from './harness/suite.js';

const KEY = { NORTHSTAR_TOKEN_SIGNING_KEY: 'k'.repeat(40) };

test('configuration is disabled by default (empty env)', async () => {
  const c = await loadConfig({}, LANES);
  assert.equal(c.ok, false);
  assert.equal(c.enabled, false);
});

test('NORTHSTAR_ENABLED must be exactly "true"', async () => {
  for (const v of ['1', 'yes', 'TRUE ', 'True', 'false', '']) {
    assert.equal((await loadConfig(localEnv({ NORTHSTAR_ENABLED: v }), LANES)).ok, false, JSON.stringify(v));
  }
  assert.equal((await loadConfig(localEnv(), LANES)).ok, true);
});

test('three role origins are the only hostname authority', async () => {
  const c = await loadConfig(localEnv(), LANES);
  assert.equal(c.ok, true, JSON.stringify(c.errors));
  assert.deepEqual([...c.hostToRole.entries()], [
    ['parent.challenge.localhost', 'parent'], ['widget.challenge.localhost', 'widget'], ['verify.challenge.localhost', 'verify'],
  ]);
  assert.equal(c.origins.parent, 'http://parent.challenge.localhost:8787');
  const local = readFileSync(new URL('../configuration/local.env', import.meta.url), 'utf8');
  const example = readFileSync(new URL('../configuration/northstar.env.example', import.meta.url), 'utf8');
  for (const text of [local, example]) assert.ok(!/^NORTHSTAR_(CONTROL|LANE_\d\d)_HOST=/m.test(text), 'per-lane host variables remain');
});

test('old per-lane host variables are not required and never route (deprecated warnings only)', async () => {
  const old = Object.fromEntries(DEPRECATED_VARIABLES.map((k) => [k, 'northstar-02.challenge.localhost']));
  const c = await loadConfig(localEnv(old), LANES);
  assert.equal(c.ok, true);
  assert.equal(c.hostToRole.size, 3);
  assert.equal(c.hostToRole.has('northstar-02.challenge.localhost'), false);
  assert.equal(c.warnings.length, DEPRECATED_VARIABLES.length);
  assert.ok(!JSON.stringify(c.warnings).includes('northstar-02'), 'warnings do not echo values');
});

test('14 lanes: 11 registered providers + AWS WAF CAPTCHA + clean control + YouTube gate', () => {
  const expected = {
    control: ['clean-control', 'control'], 'lane-01': ['cloudflare', 'cloudflare'], 'lane-02': ['datadome', 'datadome'],
    'lane-03': ['aws-waf', 'aws_waf'], 'lane-04': ['perimeterx', 'perimeterx'], 'lane-05': ['akamai', 'akamai'],
    'lane-06': ['kasada', 'kasada'], 'lane-07': ['imperva', 'imperva'], 'lane-08': ['arkose', 'arkose'],
    'lane-09': ['geetest', 'geetest'], 'lane-10': ['hcaptcha', 'hcaptcha'], 'lane-11': ['recaptcha', 'recaptcha'],
    'lane-12': ['aws-waf-captcha', 'aws_waf_captcha'], 'lane-13': ['youtube-account-gate', 'youtube_account_gate'],
  };
  assert.deepEqual(Object.fromEntries(Object.entries(INTERNAL_LANES).map(([k, v]) => [k, [v.route, v.assignment]])), expected);
});

test('missing origin fails closed (no fallback derived from root domain)', async () => {
  for (const v of ['NORTHSTAR_PARENT_ORIGIN', 'NORTHSTAR_WIDGET_ORIGIN', 'NORTHSTAR_VERIFY_ORIGIN']) {
    const c = await loadConfig(localEnv({ [v]: '' }), LANES);
    assert.equal(c.ok, false, v);
    assert.ok(c.errors.some((e) => e.includes(`${v} is missing`)));
  }
});

test('missing root domain / environment fail closed; production refused', async () => {
  assert.equal((await loadConfig(localEnv({ NORTHSTAR_ROOT_DOMAIN: '' }), LANES)).ok, false);
  assert.equal((await loadConfig(localEnv({ NORTHSTAR_ENVIRONMENT: '' }), LANES)).ok, false);
  assert.equal((await loadConfig(localEnv({ NORTHSTAR_ENVIRONMENT: 'production' }), LANES)).ok, false);
});

test('duplicate role hostnames are rejected', async () => {
  const c = await loadConfig(localEnv({ NORTHSTAR_WIDGET_ORIGIN: 'http://parent.challenge.localhost:8787' }), LANES);
  assert.equal(c.ok, false);
  assert.ok(c.errors.some((e) => e.includes('duplicates')));
});

test('duplicate internal lane assignments, routes and codes are rejected', () => {
  for (const [field, value] of [['assignment', 'datadome'], ['route', 'datadome'], ['code', '02']]) {
    const dup = structuredClone(INTERNAL_LANES);
    dup['lane-04'][field] = value;
    assert.ok(validateLaneDefinitions(dup).some((e) => e.includes(`duplicate ${field}`)), field);
  }
  const abs = structuredClone(INTERNAL_LANES);
  abs['lane-02'].fixture.resources = ['https://captcha-delivery.com/c.js'];
  assert.ok(validateLaneDefinitions(abs).some((e) => e.includes('must be relative')));
  assert.deepEqual(validateLaneDefinitions(INTERNAL_LANES), []);
});

test('origins must be bare https origins (http only for *.localhost locally)', async () => {
  const bad = [
    'http://parent.example.com', 'https://parent.challenge.localhost:8787/path', 'https://user:pw@parent.challenge.localhost',
    'https://parent.challenge.localhost/?q=1', 'parent.challenge.localhost', 'ftp://parent.challenge.localhost',
  ];
  for (const v of bad) assert.equal((await loadConfig(localEnv({ NORTHSTAR_PARENT_ORIGIN: v }), LANES)).ok, false, v);
  // Outside local/test, plain http is refused even for .localhost.
  const staging = await loadConfig(localEnv({ NORTHSTAR_ENVIRONMENT: 'staging', ...KEY }), LANES);
  assert.equal(staging.ok, false);
  assert.ok(staging.errors.some((e) => e.includes('must use https')));
  const good = await loadConfig({
    NORTHSTAR_ENABLED: 'true', NORTHSTAR_ENVIRONMENT: 'staging', NORTHSTAR_ROOT_DOMAIN: 'example.com', ...KEY,
    NORTHSTAR_PARENT_ORIGIN: 'https://northstar-parent.example.com', NORTHSTAR_WIDGET_ORIGIN: 'https://northstar-widget.example.com', NORTHSTAR_VERIFY_ORIGIN: 'https://northstar-verify.example.com',
  }, LANES);
  assert.equal(good.ok, true, JSON.stringify(good.errors));
});

test('production / apex / www / outside-root hosts are refused', async () => {
  assert.equal((await loadConfig(localEnv({ NORTHSTAR_PARENT_ORIGIN: 'http://challenge.localhost:8787' }), LANES)).ok, false);
  assert.equal((await loadConfig(localEnv({ NORTHSTAR_PARENT_ORIGIN: 'http://www.challenge.localhost:8787' }), LANES)).ok, false);
  assert.equal((await loadConfig(localEnv({ NORTHSTAR_VERIFY_ORIGIN: 'http://verify.other.localhost:8787' }), LANES)).ok, false);
  assert.equal((await loadConfig(localEnv({ NORTHSTAR_PRODUCTION_HOSTS: 'widget.challenge.localhost' }), LANES)).ok, false);
});

test('provider names are refused in public hostnames', async () => {
  for (const bad of ['http://datadome.challenge.localhost:8787', 'http://captcha-frames.challenge.localhost:8787', 'http://cf-waf.challenge.localhost:8787']) {
    assert.equal((await loadConfig(localEnv({ NORTHSTAR_WIDGET_ORIGIN: bad }), LANES)).ok, false, bad);
  }
});

test('token signing key: required outside local/test, ephemeral locally, never echoed', async () => {
  const base = {
    NORTHSTAR_ENABLED: 'true', NORTHSTAR_ENVIRONMENT: 'staging', NORTHSTAR_ROOT_DOMAIN: 'example.com',
    NORTHSTAR_PARENT_ORIGIN: 'https://northstar-parent.example.com', NORTHSTAR_WIDGET_ORIGIN: 'https://northstar-widget.example.com', NORTHSTAR_VERIFY_ORIGIN: 'https://northstar-verify.example.com',
  };
  const missing = await loadConfig(base, LANES);
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => e.includes('NORTHSTAR_TOKEN_SIGNING_KEY is required')));
  const short = await loadConfig({ ...base, NORTHSTAR_TOKEN_SIGNING_KEY: 'too-short-secret-value' }, LANES);
  assert.equal(short.ok, false);
  assert.ok(!JSON.stringify(short.errors).includes('too-short-secret-value'));
  assert.equal((await loadConfig(localEnv(), LANES)).tokenKeyMode, 'ephemeral');
  assert.equal((await loadConfig(localEnv(KEY), LANES)).tokenKeyMode, 'configured');
});

test('token TTL and management authority are validated', async () => {
  for (const v of ['59', '86401', 'abc', '-5', '1.5']) assert.equal((await loadConfig(localEnv({ NORTHSTAR_TOKEN_TTL: v }), LANES)).ok, false, v);
  assert.equal((await loadConfig(localEnv({ NORTHSTAR_TOKEN_TTL: '60' }), LANES)).tokenTtl, 60);
  assert.equal((await loadConfig(localEnv({ NORTHSTAR_MANAGEMENT_AUTHORITY: 'short' }), LANES)).ok, false);
  assert.equal((await loadConfig(localEnv(), LANES)).managementAuthority, null, 'management disabled by default');
});

test('private secrets are refused in public site-key slots, and errors never echo values', async () => {
  const secret = '0x' + 'ab'.repeat(20); // built at runtime so the source scan stays clean
  const c = await loadConfig(localEnv({ NORTHSTAR_HCAPTCHA_SITE_KEY: secret }), LANES);
  assert.equal(c.ok, false);
  assert.ok(!JSON.stringify(c.errors).includes(secret));
  assert.equal((await loadConfig(localEnv({ NORTHSTAR_RECAPTCHA_SITE_KEY: '6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe' }), LANES)).ok, false);
});

test('real-widget mode is opt-in; widget lanes need a key only in that mode', async () => {
  const off = await loadConfig(localEnv({ NORTHSTAR_HCAPTCHA_SITE_KEY: '' }), LANES);
  assert.equal(off.realWidgets, false);
  assert.equal(laneReadiness(off, 'lane-10', LANES).ready, true);
  const on = await loadConfig(localEnv({ NORTHSTAR_REAL_WIDGETS: 'true', NORTHSTAR_HCAPTCHA_SITE_KEY: '' }), LANES);
  assert.equal(laneReadiness(on, 'lane-10', LANES).ready, false);
  assert.equal(laneReadiness(on, 'lane-11', LANES).ready, true);
  assert.equal((await loadConfig(localEnv({ NORTHSTAR_REAL_WIDGETS: 'yes' }), LANES)).ok, false);
});

test('sanitized config and fingerprint contain no secret values; fingerprint is stable', async () => {
  const c = await loadConfig(localEnv({ ...SECRET_SENTINELS }), LANES);
  const s = JSON.stringify(sanitizedConfig(c, LANES));
  for (const v of Object.values(SECRET_SENTINELS)) assert.ok(!s.includes(v));
  const a = await configFingerprint(c, LANES);
  const b = await configFingerprint(await loadConfig(localEnv({ ...SECRET_SENTINELS }), LANES), LANES);
  const d = await configFingerprint(await loadConfig(localEnv({ ...SECRET_SENTINELS, NORTHSTAR_ENVIRONMENT: 'test' }), LANES), LANES);
  assert.match(a, /^sha256:[0-9a-f]{16}$/);
  assert.equal(a, b);
  assert.notEqual(a, d);
});

test('the deployable bundle does not contain the internal assignment table', () => {
  const bundle = readFileSync(new URL('../functions/generated/data.js', import.meta.url), 'utf8');
  for (const key of ['"assignment"', '"setupType"', '"edge"', '"registryVendor"']) assert.ok(!bundle.includes(key), key);
  assert.ok(!bundle.includes('aws_waf_captcha') && !bundle.includes('youtube_account_gate'));
});
