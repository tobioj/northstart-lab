// Isolation: the deployable code has no I/O beyond the request, no dependencies,
// and references no external website other than the two approved widget loaders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const DEPLOYABLE = ['../functions/handler.js', '../functions/render.js', '../configuration/config.js', '../functions/generated/data.js'];

test('deployable modules import nothing but each other (no fs, net, db, child_process)', () => {
  for (const f of DEPLOYABLE) {
    const src = read(f);
    for (const m of src.matchAll(/\bimport\s[^'"]*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1] || m[2];
      assert.ok(spec.startsWith('./') || spec.startsWith('../'), `${f} imports ${spec}`);
    }
    assert.ok(!/process\.env/.test(src), `${f} reads process.env directly (must use the env argument)`);
    assert.ok(!/console\.(log|info|warn|error)/.test(src), `${f} logs`);
  }
});

test('no runtime or dev dependencies (nothing to install, nothing to compromise)', () => {
  const pkg = JSON.parse(read('../package.json'));
  assert.deepEqual(pkg.dependencies, {});
  assert.deepEqual(pkg.devDependencies, {});
});

test('the only absolute external URLs in deployable code are the approved widget loaders', () => {
  const allowed = new Set([
    'https://js.hcaptcha.com/1/api.js', 'https://hcaptcha.com', 'https://*.hcaptcha.com',
    'https://www.google.com/recaptcha/api.js', 'https://www.google.com/recaptcha/', 'https://www.gstatic.com/recaptcha/',
    'https://recaptcha.google.com/recaptcha/', 'http://x',
  ]);
  for (const f of DEPLOYABLE) {
    for (const [u] of read(f).matchAll(/https?:\/\/[^\s'"`<>)\\,]+/g)) assert.ok(allowed.has(u), `${f}: ${u}`);
  }
});

test('page scripts never touch cookies or browser storage', () => {
  const js = read('../pages/shared/page.js');
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(js));
});
