// Deployment plan: exactly three DNS hostnames, hostname- and path-scoped Cloudflare rule,
// and no remaining 12-host instructions in the authoritative documents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { makePlan } from '../scripts/plan.js';

test('plan creates exactly three DNS records, TTL 300, parent-only proxy', async () => {
  const p = await makePlan({ root: 'example.com', platform: 'vercel', target: 'cname.vercel-dns-0.com' });
  assert.equal(p.ok, true, JSON.stringify(p.errors));
  assert.deepEqual(p.rows.map((r) => [r.role, r.host, r.proxied]), [
    ['parent', 'northstar-parent.example.com', true],
    ['widget', 'northstar-widget.example.com', false],
    ['verify', 'northstar-verify.example.com', false],
  ]);
  const zoneLines = p.zone.split('\n').filter((l) => l && !l.startsWith(';'));
  assert.equal(zoneLines.length, 3);
  for (const l of zoneLines) assert.match(l, /^northstar-(parent|widget|verify)\s+300 IN CNAME cname\.vercel-dns-0\.com\.$/);
  assert.ok(!/\*/.test(p.zone), 'no wildcard');
  assert.equal(p.env.NORTHSTAR_ENABLED, 'false');
  assert.equal(p.env.NORTHSTAR_PARENT_ORIGIN, 'https://northstar-parent.example.com');
  assert.ok(!Object.keys(p.env).some((k) => /_HOST$|SIGNING|AUTHORITY|SECRET/.test(k)), 'no per-lane hosts or secrets in deploy.env');
  const cf = await makePlan({ root: 'example.com', platform: 'cloudflare' });
  assert.ok(cf.rows.every((r) => r.proxied));
});

test('Cloudflare WAF rule matches only the Cloudflare lane path on the parent host', async () => {
  const p = await makePlan({ root: 'example.com' });
  assert.equal(p.wafExpression, '(http.host eq "northstar-parent.example.com" and (http.request.uri.path eq "/scenario/cloudflare" or starts_with(http.request.uri.path, "/scenario/cloudflare/")))');
  assert.ok(!p.wafExpression.includes('northstar-widget') && !p.wafExpression.includes('northstar-verify'));
  assert.match(p.configRule, /Hostname equals northstar-parent\.example\.com/);
});

test('plan refuses invalid roots', async () => {
  assert.equal((await makePlan({ root: '' })).ok, false);
  assert.equal((await makePlan({ root: 'bad domain' })).ok, false);
});

test('repository documents no longer instruct creating 12 DNS records or per-lane hostnames', () => {
  const docs = ['../README.md', '../SETUP-GUIDE.md', ...readdirSync(new URL('../deployment/', import.meta.url)).filter((f) => f.endsWith('.md')).map((f) => `../deployment/${f}`)];
  for (const d of docs) {
    const t = readFileSync(new URL(d, import.meta.url), 'utf8');
    const body = t.replace(/<!-- migration-note -->[\s\S]*?<!-- \/migration-note -->/g, '');
    assert.ok(!/\b12 (DNS )?(records|hostnames|hosts|custom domains|domains|domain aliases)\b/i.test(body), `${d} still mentions 12 records/hostnames`);
    assert.ok(!/northstar-(0\d|1[01]|control)\./.test(body), `${d} still names a per-lane hostname`);
    assert.ok(!/NORTHSTAR_LANE_\d\d_HOST|NORTHSTAR_CONTROL_HOST/.test(body), `${d} still uses per-lane host variables`);
  }
});

test('every script and adapter parses (catches CLI-only breakage the other tests do not import)', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const files = [
    ...readdirSync(new URL('../scripts/', import.meta.url)).filter((f) => f.endsWith('.js')).map((f) => `../scripts/${f}`),
    '../deployment/adapters/vercel/api/northstar.js', '../deployment/adapters/cloudflare/worker.js',
    '../deployment/adapters/netlify/netlify/functions/northstar.mjs', '../tests/harness/serve-harness.js',
  ];
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(f, import.meta.url))], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});
