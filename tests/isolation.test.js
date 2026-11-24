// Isolation: the deployable code has no I/O beyond the request, no dependencies,
// and references no external website other than the two opt-in widget loaders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const DEPLOYABLE = [
  '../functions/handler.js',
  '../functions/render.js',
  '../functions/tokens.js',
  '../functions/state.js',
  '../functions/oracle.js',
  '../configuration/config.js',
  '../functions/generated/data.js',
];

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

test('runtime dependencies are restricted strictly to @netlify/blobs and zero devDependencies', () => {
  const pkg = JSON.parse(read('../package.json'));
  assert.deepEqual(Object.keys(pkg.dependencies || {}), ['@netlify/blobs']);
  assert.deepEqual(pkg.devDependencies, {});
});

test('the only absolute external URLs in deployable code are the opt-in widget loaders', () => {
  const allowed = new Set([
    'https://js.hcaptcha.com/1/api.js', 'https://hcaptcha.com', 'https://*.hcaptcha.com',
    'https://www.google.com/recaptcha/api.js', 'https://www.google.com/recaptcha/', 'https://www.gstatic.com/recaptcha/',
    'https://recaptcha.google.com/recaptcha/', 'http://x',
    'http://www.w3.org/2000/svg', // XML namespace identifier in the fixture image, never requested
  ]);
  for (const f of DEPLOYABLE) {
    for (const [u] of read(f).matchAll(/https?:\/\/[^\s'"`<>)\\,]+/g)) assert.ok(allowed.has(u), `${f}: ${u}`);
  }
});

test('page and widget scripts never touch cookies or browser storage, and hardcode no origin', () => {
  for (const rel of ['../pages/shared/page.js', '../pages/shared/widget.js']) {
    const js = read(rel);
    assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(js), rel);
    assert.ok(!/https?:\/\//.test(js), `${rel} hardcodes an origin`);
    assert.match(js, /credentials: 'omit'/, rel);
  }
});

test('real provider widgets are off by default (controlled fixtures on the widget origin)', () => {
  for (const f of ['../configuration/northstar.env.example', '../configuration/local.env']) {
    assert.match(read(f), /^NORTHSTAR_REAL_WIDGETS=false$/m, f);
  }
});

test('opt-in real-widget mode renders the official loader and widens CSP only for that lane', async () => {
  const { renderParentPage, contentSecurityPolicy } = await import('../functions/render.js');
  const { TEMPLATES, PAGES, BUILD } = await import('../functions/generated/data.js');
  const html = renderParentPage({ templates: TEMPLATES, page: PAGES['lane-10'], build: BUILD, environment: 'local', controlUrl: '/', realWidget: { kind: 'hcaptcha', siteKey: '10000000-ffff-ffff-ffff-000000000001' } });
  assert.ok(html.includes('src="https://js.hcaptcha.com/1/api.js"'));
  assert.ok(html.includes('data-sitekey="10000000-ffff-ffff-ffff-000000000001"'));
  const origins = { parent: 'https://p.example', widget: 'https://w.example', verify: 'https://v.example' };
  assert.ok(contentSecurityPolicy('parent-page', { origins, realWidget: 'hcaptcha' }).includes('https://*.hcaptcha.com'));
  assert.ok(!contentSecurityPolicy('parent-page', { origins, usesWidget: true }).includes('hcaptcha'));
});
