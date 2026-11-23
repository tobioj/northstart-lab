import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withLab } from './helpers.js';
import { INTERNAL_LANES, SECRET_SENTINELS } from './harness/suite.js';

const leaks = (r) => Object.values(SECRET_SENTINELS).filter((v) => (r.body + JSON.stringify(r.headers)).includes(v));

test('no secret value appears in any response (HTML, JSON, headers) on any origin or route', async () => {
  await withLab({ extra: SECRET_SENTINELS }, async (lab) => {
    for (const role of ['parent', 'widget', 'verify']) {
      for (const p of ['/', '/healthz', '/readyz', '/fixture-manifest.json', '/robots.txt', '/assets/page.js', '/nope']) {
        assert.deepEqual(leaks(await lab[role](p)), [], `${role}${p}`);
      }
    }
    for (const lane of Object.values(INTERNAL_LANES)) {
      const token = await lab.issue(lane.route);
      assert.deepEqual(leaks(await lab.parent(`/scenario/${lane.route}/${token}`)), [], lane.route);
      for (const [kind, prefix] of [['resources', 'resources'], ['frames', 'widget'], ['images', 'images']]) {
        for (const p of lane.fixture[kind]) assert.deepEqual(leaks(await lab.widget(`/${prefix}/${lane.route}/${token}/${p}`, { headers: lab.fromParent() })), []);
      }
      for (const step of ['input', 'verify', 'settle', 'status']) assert.deepEqual(leaks(await lab.api(step, token)), [], `${lane.route} ${step}`);
      assert.deepEqual(leaks(await lab.parent(`/continue/${token}`)), []);
    }
    const auth = SECRET_SENTINELS.NORTHSTAR_MANAGEMENT_AUTHORITY;
    const list = await lab.verify('/api/manage/instances', { headers: { authorization: `Bearer ${auth}` } });
    assert.equal(list.status, 200);
    assert.deepEqual(leaks(list), []);
  });
});

test('public manifests are allow-listed fields only and reveal no assignment or keys', async () => {
  await withLab({ extra: SECRET_SENTINELS }, async (lab) => {
    for (const role of ['parent', 'widget', 'verify']) {
      const r = await lab[role]('/fixture-manifest.json');
      const m = JSON.parse(r.body);
      assert.deepEqual(Object.keys(m).sort(), ['build', 'configFingerprint', 'endpoints', 'environment', 'name', 'ready', 'role']);
      assert.ok(!/datadome|akamai|kasada|imperva|perimeterx|arkose|geetest|hcaptcha|recaptcha|cloudflare|aws|youtube/i.test(r.body), 'manifest reveals lanes');
      assert.ok(!r.body.includes(lab.env.NORTHSTAR_HCAPTCHA_SITE_KEY) && !r.body.includes(lab.env.NORTHSTAR_RECAPTCHA_SITE_KEY));
    }
  });
});

test('secrets, keys, query strings and scenario tokens are never logged', async () => {
  await withLab({ extra: SECRET_SENTINELS }, async (lab) => {
    const tokens = [];
    for (const lane of Object.values(INTERNAL_LANES)) {
      const token = await lab.issue(lane.route);
      tokens.push(token);
      await lab.parent(`/scenario/${lane.route}/${token}?key=abc`);
      for (const step of ['input', 'verify', 'settle']) await lab.api(step, token);
      await lab.parent(`/continue/${token}`);
    }
    await lab.verify('/api/manage/instances', { headers: { authorization: `Bearer ${SECRET_SENTINELS.NORTHSTAR_MANAGEMENT_AUTHORITY}` } });
    const out = lab.logs.join('\n');
    assert.ok(lab.logs.length > 50);
    for (const v of [...Object.values(SECRET_SENTINELS), lab.env.NORTHSTAR_HCAPTCHA_SITE_KEY, lab.env.NORTHSTAR_RECAPTCHA_SITE_KEY]) assert.ok(!out.includes(v), 'log contains a key');
    for (const t of tokens) assert.ok(!out.includes(t), 'log contains a token');
    assert.ok(out.includes('/scenario/datadome/<token>'), 'tokens are redacted, routes kept');
    assert.ok(!out.includes('key=abc'), 'query strings are not logged');
  });
});

test('no public test-traffic markers (Okeg / test-traffic) are introduced in requests, pages or code', async () => {
  const banned = /okeg|test[-_ ]?traffic/i;
  await withLab(async (lab) => {
    for (const lane of Object.values(INTERNAL_LANES)) {
      const issue = await lab.parent(`/scenario/${lane.route}`);
      const page = await lab.parent(issue.headers.location);
      assert.ok(!banned.test(issue.headers.location + page.body + JSON.stringify(page.headers)), lane.route);
    }
  });
  for (const f of ['../functions/handler.js', '../functions/render.js', '../functions/generated/data.js', '../pages/shared/page.js', '../configuration/lanes.internal.json']) {
    assert.ok(!banned.test(readFileSync(new URL(f, import.meta.url), 'utf8')), f);
  }
});

test('source tree contains no private secrets (only published provider TEST site keys)', () => {
  const root = new URL('../', import.meta.url);
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      if (['node_modules', 'evidence', 'dist', '.git'].includes(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p); else if (/\.(js|mjs|json|env|example|md|toml|html|css|txt|yml|yaml)$/.test(name)) files.push(p);
    }
  })(fileURLToPath(root));
  const secretPatterns = [/0x[0-9a-fA-F]{40}/, /sk_live_[0-9a-zA-Z]+/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /AKIA[0-9A-Z]{16}/, /^NORTHSTAR_(TOKEN_SIGNING_KEY|MANAGEMENT_AUTHORITY)=\S+/m];
  for (const f of files) {
    const t = readFileSync(f, 'utf8');
    for (const re of secretPatterns) assert.ok(!re.test(t), `${f} matches ${re}`);
  }
});
