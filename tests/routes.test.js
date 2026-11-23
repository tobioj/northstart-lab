import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, withServer } from './helpers.js';
import { localEnv, INTERNAL_LANES } from './harness/suite.js';
import { BUILD, PAGES } from '../functions/generated/data.js';

const env = localEnv();
const hosts = Object.fromEntries(Object.entries(INTERNAL_LANES).map(([id, l]) => [id, env[l.hostVariable]]));

test('all 12 local hostnames serve /, /healthz, /readyz and /fixture-manifest.json', async () => {
  await withServer(env, async ({ port }) => {
    for (const [laneId, host] of Object.entries(hosts)) {
      const page = await request({ port, host });
      assert.equal(page.status, INTERNAL_LANES[laneId].fixture.status, `${laneId} status`);
      assert.match(page.headers['content-type'], /text\/html/);
      assert.ok(page.body.includes(`<title>${PAGES[laneId].title}</title>`), `${laneId} title`);
      assert.ok(page.body.includes(BUILD.id), `${laneId} build id`);
      assert.ok(page.body.includes('id="reload-button"'), `${laneId} reload button`);
      assert.ok(page.body.includes(`href="http://${hosts.control}:${port}/"`), `${laneId} control link`);
      assert.ok(page.body.includes('id="page-status"'), `${laneId} status element`);

      const health = await request({ port, host, path: '/healthz' });
      assert.equal(health.status, 200);
      assert.equal(JSON.parse(health.body).status, 'ok');

      const ready = await request({ port, host, path: '/readyz' });
      assert.equal(ready.status, 200, `${laneId} readyz`);
      assert.equal(JSON.parse(ready.body).lane, laneId);

      const manifest = await request({ port, host, path: '/fixture-manifest.json' });
      assert.equal(manifest.status, 200);
      const m = JSON.parse(manifest.body);
      assert.equal(m.lane.id, laneId);
      assert.equal(m.lane.host, host);
      assert.equal(m.build, BUILD.id);
      assert.equal(m.environment, 'local');
    }
  });
});

test('public pages show only neutral lane names', async () => {
  await withServer(env, async ({ port }) => {
    for (const host of Object.values(hosts)) {
      const { body } = await request({ port, host });
      const visible = body.replace(/<[^>]+>/g, ' ');
      for (const word of ['Cloudflare', 'DataDome', 'AWS', 'PerimeterX', 'Akamai', 'Kasada', 'Imperva', 'Arkose', 'GeeTest', 'hCaptcha', 'reCAPTCHA']) {
        assert.ok(!visible.includes(word), `${host} visible text mentions ${word}`);
      }
    }
  });
});

test('unknown hostnames are rejected with 421 and no fallback lane', async () => {
  await withServer(env, async ({ port }) => {
    for (const host of ['evil.localhost', 'localhost', 'northstar-12.localhost', 'northstar-control.localhost.attacker.test']) {
      for (const path of ['/', '/healthz', '/fixture-manifest.json']) {
        const r = await request({ port, host, path });
        assert.equal(r.status, 421, `${host}${path}`);
        assert.ok(!r.body.includes(host), 'host is not reflected');
      }
    }
  });
});

test('invalid Host header is rejected', async () => {
  await withServer(env, async ({ port }) => {
    const r = await request({ port, host: 'bad host<>' });
    assert.equal(r.status, 400);
  });
});

test('disabled or missing configuration fails closed with 503 on every route', async () => {
  for (const bad of [{}, localEnv({ NORTHSTAR_ENABLED: 'false' }), localEnv({ NORTHSTAR_LANE_04_HOST: '' })]) {
    await withServer(bad, async ({ port }) => {
      for (const path of ['/', '/healthz', '/readyz', '/fixture-manifest.json']) {
        const r = await request({ port, host: 'northstar-control.localhost', path });
        assert.equal(r.status, 503, path);
        assert.deepEqual(JSON.parse(r.body), { status: 'unavailable' });
      }
    });
  }
});

test('widget lane without its site key reports not-ready instead of rendering', async () => {
  await withServer(localEnv({ NORTHSTAR_RECAPTCHA_SITE_KEY: '' }), async ({ port }) => {
    assert.equal((await request({ port, host: hosts['lane-11'], path: '/readyz' })).status, 503);
    assert.equal((await request({ port, host: hosts['lane-11'] })).status, 503);
    assert.equal((await request({ port, host: hosts['lane-10'], path: '/readyz' })).status, 200);
  });
});

test('no directory listings, unknown paths 404, unsupported methods 405', async () => {
  await withServer(env, async ({ port }) => {
    const host = hosts.control;
    for (const path of ['/assets/', '/pages/', '/functions/', '/configuration/lanes.internal.json', '/.env', '/fx/']) {
      assert.equal((await request({ port, host, path })).status, 404, path);
    }
    assert.equal((await request({ port, host, method: 'POST' })).status, 405);
    assert.equal((await request({ port, host, method: 'DELETE' })).status, 405);
    const head = await request({ port, host, method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
  });
});

test('security headers present; no app-identifying headers or cookies', async () => {
  await withServer(env, async ({ port }) => {
    for (const host of Object.values(hosts)) {
      for (const path of ['/', '/healthz', '/assets/site.css']) {
        const r = await request({ port, host, path });
        assert.match(r.headers['content-security-policy'], /frame-ancestors 'self'/);
        assert.equal(r.headers['x-frame-options'], 'SAMEORIGIN');
        assert.equal(r.headers['x-content-type-options'], 'nosniff');
        assert.equal(r.headers['cache-control'], 'no-store');
        assert.equal(r.headers['set-cookie'], undefined);
        assert.equal(r.headers['x-powered-by'], undefined);
        for (const name of Object.keys(r.headers)) assert.ok(!/northstar|x-app|x-session/i.test(name), `header ${name}`);
      }
    }
  });
});

test('CORS is only granted to explicitly configured origins', async () => {
  const allowed = 'http://northstar-control.localhost:8787';
  await withServer(localEnv({ NORTHSTAR_ALLOWED_ORIGINS: allowed }), async ({ port }) => {
    const host = hosts['lane-03'];
    const ok = await request({ port, host, path: '/fixture-manifest.json', headers: { origin: allowed } });
    assert.equal(ok.headers['access-control-allow-origin'], allowed);
    const bad = await request({ port, host, path: '/fixture-manifest.json', headers: { origin: 'https://attacker.example' } });
    assert.equal(bad.headers['access-control-allow-origin'], undefined);
    assert.equal((await request({ port, host, method: 'OPTIONS', headers: { origin: 'https://attacker.example' } })).status, 403);
    assert.equal((await request({ port, host, method: 'OPTIONS', headers: { origin: allowed } })).status, 204);
  });
  await withServer(env, async ({ port }) => {
    const r = await request({ port, host: hosts.control, path: '/healthz', headers: { origin: 'http://northstar-01.localhost:8787' } });
    assert.equal(r.headers['access-control-allow-origin'], undefined, 'no CORS by default');
  });
});

test('server-side errors are generic (no stack traces)', async () => {
  const { handleRequest } = await import('../functions/handler.js');
  const res = await handleRequest({ url: 'not a url', method: 'GET', headers: new Headers() }, env);
  assert.equal(res.status, 500);
  const body = await res.text();
  assert.equal(body, 'Internal error\n');
});
