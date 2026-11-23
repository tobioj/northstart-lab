import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request, withServer } from './helpers.js';
import { localEnv, INTERNAL_LANES, SECRET_SENTINELS } from './harness/suite.js';

const env = localEnv(SECRET_SENTINELS);
const PATHS = ['/', '/healthz', '/readyz', '/fixture-manifest.json', '/assets/page.js', '/assets/site.css', '/robots.txt', '/nope'];

test('no secret value appears in any response (HTML, JSON, headers) on any lane', async () => {
  await withServer(env, async ({ port }) => {
    for (const lane of Object.values(INTERNAL_LANES)) {
      const host = env[lane.hostVariable];
      for (const path of [...PATHS, ...lane.fixture.scripts, ...lane.fixture.frames]) {
        const r = await request({ port, host, path });
        const all = r.body + JSON.stringify(r.headers);
        for (const v of Object.values(SECRET_SENTINELS)) assert.ok(!all.includes(v), `${host}${path} leaked a secret`);
      }
    }
  });
});

test('public manifests are allow-listed fields only and contain no keys', async () => {
  await withServer(env, async ({ port }) => {
    for (const lane of Object.values(INTERNAL_LANES)) {
      const r = await request({ port, host: env[lane.hostVariable], path: '/fixture-manifest.json' });
      const m = JSON.parse(r.body);
      assert.deepEqual(Object.keys(m).sort(), ['build', 'configFingerprint', 'endpoints', 'environment', 'lane', 'name', 'ready']);
      assert.ok(!r.body.includes(env.NORTHSTAR_HCAPTCHA_SITE_KEY));
      assert.ok(!r.body.includes(env.NORTHSTAR_RECAPTCHA_SITE_KEY));
      assert.ok(!/datadome|akamai|kasada|imperva|perimeterx|arkose|geetest|hcaptcha|recaptcha|cloudflare|aws/i.test(r.body), 'manifest reveals assignment');
    }
  });
});

test('provider keys and secrets are never logged', async () => {
  await withServer(env, async ({ port, logs }) => {
    for (const lane of Object.values(INTERNAL_LANES)) {
      for (const path of [...PATHS, '/?key=abc']) await request({ port, host: env[lane.hostVariable], path });
    }
    const out = logs.join('\n');
    assert.ok(logs.length > 0);
    for (const v of [...Object.values(SECRET_SENTINELS), env.NORTHSTAR_HCAPTCHA_SITE_KEY, env.NORTHSTAR_RECAPTCHA_SITE_KEY]) {
      assert.ok(!out.includes(v), 'log contains a key');
    }
    assert.ok(!out.includes('key=abc'), 'query strings are not logged');
  });
});

test('source tree contains no private secrets (only published provider TEST site keys)', () => {
  const root = new URL('../', import.meta.url);
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      if (['node_modules', 'evidence', 'dist', '.git'].includes(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p); else if (/\.(js|json|env|example|md|toml|html|css|txt)$/.test(name)) files.push(p);
    }
  })(fileURLToPath(root));
  const secretPatterns = [/0x[0-9a-fA-F]{40}/, /sk_live_[0-9a-zA-Z]+/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /AKIA[0-9A-Z]{16}/];
  for (const f of files) {
    const t = readFileSync(f, 'utf8');
    for (const re of secretPatterns) assert.ok(!re.test(t), `${f} matches ${re}`);
  }
});
