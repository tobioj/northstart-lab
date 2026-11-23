// Host-based routing for the three role origins, exact paths, methods and security headers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withLab, extractResources } from './helpers.js';
import { INTERNAL_LANES, localEnv, freePort } from './harness/suite.js';
import { startServer } from '../functions/node-adapter.js';
import { request } from './helpers.js';
import { BUILD, PAGES } from '../functions/generated/data.js';

test('each role origin serves /healthz, /readyz and /fixture-manifest.json', async () => {
  await withLab(async (lab) => {
    for (const role of ['parent', 'widget', 'verify']) {
      const health = await lab[role]('/healthz');
      assert.equal(health.status, 200);
      assert.deepEqual(JSON.parse(health.body), { status: 'ok', role });
      const ready = await lab[role]('/readyz');
      assert.equal(ready.status, 200, `${role} readyz`);
      const m = JSON.parse((await lab[role]('/fixture-manifest.json')).body);
      assert.equal(m.role, role);
      assert.equal(m.build, BUILD.id);
      assert.equal(m.environment, 'local');
    }
  });
});

test('all 14 lanes are issued and served through the parent origin only', async () => {
  await withLab(async (lab) => {
    for (const [laneId, lane] of Object.entries(INTERNAL_LANES)) {
      const issue = await lab.parent(`/scenario/${lane.route}`);
      assert.equal(issue.status, 303, laneId);
      assert.match(issue.headers.location, new RegExp(`^/scenario/${lane.route}/${lane.code}\\.`));
      assert.equal((await lab.parent(`/scenario/${lane.route}/`)).status, 303, 'trailing slash also issues');
      const token = issue.headers.location.split('/').pop();
      const page = await lab.parent(`/scenario/${lane.route}/${token}`);
      assert.equal(page.status, lane.fixture.status, `${laneId} status`);
      assert.match(page.headers['content-type'], /text\/html/);
      assert.ok(page.body.includes(`<title>${PAGES[laneId].title}</title>`), `${laneId} title`);
      assert.ok(page.body.includes(BUILD.id), `${laneId} build id`);
      assert.ok(page.body.includes('id="reload-button"'), `${laneId} reload button`);
      assert.ok(page.body.includes('id="page-status"'), `${laneId} status element`);
      assert.ok(page.body.includes(`href="${lab.origins.parent}/scenario/clean-control"`), `${laneId} control link`);
      assert.ok(page.body.includes('id="complete-button"'), `${laneId} completion control`);
      // The same scenario path does not exist on the other origins.
      for (const other of ['widget', 'verify']) assert.equal((await lab[other](`/scenario/${lane.route}/${token}`)).status, 404, `${other} serves scenario`);
    }
  });
});

test('widget resources are referenced only on the widget origin; verification only on the verify origin', async () => {
  await withLab(async (lab) => {
    for (const lane of Object.values(INTERNAL_LANES)) {
      const token = await lab.issue(lane.route);
      const page = await lab.parent(`/scenario/${lane.route}/${token}`);
      const { scripts, frames, images } = extractResources(page.body);
      for (const u of [...scripts, ...frames, ...images]) {
        if (u.startsWith('/assets/')) continue;
        assert.ok(u.startsWith(`${lab.origins.widget}/`), `${lane.route}: ${u}`);
      }
      assert.ok(page.body.includes(`data-verify="${lab.origins.verify}"`));
      // Widget paths are not served by parent or verify.
      for (const u of [...scripts, ...frames, ...images].filter((x) => x.startsWith(lab.origins.widget))) {
        const path = u.slice(lab.origins.widget.length);
        assert.equal((await lab.parent(path, { headers: lab.fromParent() })).status, 404);
        assert.equal((await lab.verify(path, { headers: lab.fromParent() })).status, 404);
      }
      // Verification endpoints are not served by parent or widget.
      for (const role of ['parent', 'widget']) {
        const r = await lab[role](`/api/status/${token}`, { headers: { origin: lab.origins.parent } });
        assert.equal(r.status, 404, `${role} serves /api`);
      }
    }
  });
});

test('unknown scenario routes and unknown paths are rejected on every origin', async () => {
  await withLab(async (lab) => {
    const token = await lab.issue('datadome');
    const parentBad = ['/scenario/unknown', '/scenario/unknown/x', '/scenario/datadome/x/y', '/scenario/', '/scenario', '/scenarios/datadome',
      '/sorry/index', '/continue/', '/continue/x/y', '/fx/captcha-delivery.com/c.js', '/assets/', '/pages/', '/functions/handler.js',
      '/configuration/lanes.internal.json', '/.env', `/scenario/datadome/${token}/extra`, `/scenario/./datadome/${token}`, '/scenario//datadome'];
    for (const p of parentBad) assert.ok([400, 404].includes((await lab.parent(p)).status), `parent ${p}`);
    const widgetBad = ['/', '/widget/', `/widget/datadome/${token}`, `/widget/datadome/${token}/fx/other.js`, `/resources/datadome/${token}/fx/captcha-delivery.com/c.js?x=1`,
      `/resources/datadome/${token}/fx/captcha-delivery.com/../c.js`, `/resources/datadome/${token}/fx%2fcaptcha-delivery.com/c.js`, '/api/status/x', '/sorry/index'];
    for (const p of widgetBad) assert.ok([400, 404].includes((await lab.widget(p, { headers: lab.fromParent() })).status), `widget ${p}`);
    for (const p of ['/', '/api/', '/api/unknown/x', `/api/status/${token}/x`, '/assets/page.js', '/sorry/index']) {
      assert.equal((await lab.verify(p, { headers: { origin: lab.origins.parent } })).status, 404, `verify ${p}`);
    }
  });
});

test('unknown hostnames are rejected with 421 and no fallback origin', async () => {
  await withLab(async (lab) => {
    for (const host of ['evil.challenge.localhost', 'challenge.localhost', 'localhost', 'northstar-02.localhost', 'parent.challenge.localhost.attacker.test']) {
      for (const path of ['/', '/healthz', '/scenario/datadome', '/fixture-manifest.json']) {
        const r = await lab.raw(host, path);
        assert.equal(r.status, 421, `${host}${path}`);
        assert.ok(!r.body.includes(host), 'host is not reflected');
      }
    }
  });
});

test('invalid Host header is rejected', async () => {
  await withLab(async (lab) => {
    assert.equal((await lab.raw('bad host<>', '/')).status, 400);
  });
});

test('disabled or missing configuration fails closed with 503 on every route', async () => {
  for (const bad of [{}, localEnv({ NORTHSTAR_ENABLED: 'false' }), localEnv({ NORTHSTAR_VERIFY_ORIGIN: '' })]) {
    const port = await freePort();
    const { server } = await startServer({ env: bad, port, log: () => {} });
    try {
      for (const path of ['/', '/healthz', '/readyz', '/fixture-manifest.json', '/scenario/datadome']) {
        const r = await request({ port, host: 'parent.challenge.localhost', path });
        assert.equal(r.status, 503, path);
        assert.deepEqual(JSON.parse(r.body), { status: 'unavailable' });
      }
    } finally { server.close(); }
  }
});

test('unsupported methods are 405; HEAD has no body', async () => {
  await withLab(async (lab) => {
    const token = await lab.issue('clean-control');
    assert.equal((await lab.parent('/', { method: 'POST' })).status, 405);
    assert.equal((await lab.parent(`/scenario/clean-control/${token}`, { method: 'DELETE' })).status, 405);
    assert.equal((await lab.widget(`/resources/datadome/${token}/fx/captcha-delivery.com/c.js`, { method: 'POST' })).status, 405);
    assert.equal((await lab.verify(`/api/settle/${token}`, { method: 'GET', headers: { origin: lab.origins.parent } })).status, 405);
    assert.equal((await lab.verify(`/api/status/${token}`, { method: 'POST', headers: { origin: lab.origins.parent } })).status, 405);
    const head = await lab.parent(`/scenario/clean-control/${token}`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
  });
});

test('parent pages: may frame only the widget origin and call only the verify origin', async () => {
  await withLab(async (lab) => {
    const token = await lab.issue('datadome');
    const r = await lab.parent(`/scenario/datadome/${token}`);
    const csp = r.headers['content-security-policy'];
    assert.match(csp, new RegExp(`frame-src ${lab.origins.widget}(;|$)`));
    assert.match(csp, new RegExp(`connect-src ${lab.origins.verify}(;|$)`));
    assert.match(csp, new RegExp(`script-src 'self' ${lab.origins.widget}(;|$)`));
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(r.headers['referrer-policy'], 'strict-origin');
    // Clean control: no widget origin at all in its policy.
    const c = await lab.parent(`/scenario/clean-control/${await lab.issue('clean-control')}`);
    assert.ok(!c.headers['content-security-policy'].includes(lab.origins.widget));
    assert.match(c.headers['content-security-policy'], /frame-src 'none'/);
  });
});

test('widget frames: framable only by the configured parent origin; unrelated parents rejected', async () => {
  await withLab(async (lab) => {
    const token = await lab.issue('datadome');
    const path = `/widget/datadome/${token}/fx/captcha-delivery.com/captcha/?initialcid=northstar-fixture`;
    const ok = await lab.widget(path, { headers: lab.fromParent() });
    assert.equal(ok.status, 200);
    assert.match(ok.headers['content-security-policy'], new RegExp(`frame-ancestors ${lab.origins.parent}$`));
    assert.equal(ok.headers['x-frame-options'], undefined);
    for (const referer of ['https://attacker.example/', `${lab.origins.widget}/`, `${lab.origins.verify}/`, 'not a url']) {
      assert.equal((await lab.widget(path, { headers: { referer } })).status, 403, referer);
    }
    assert.equal((await lab.widget(path)).status, 403, 'no referer/origin');
    assert.equal((await lab.widget(path, { headers: { origin: 'https://attacker.example' } })).status, 403);
    const script = await lab.widget(`/resources/datadome/${token}/fx/captcha-delivery.com/c.js`, { headers: lab.fromParent() });
    assert.equal(script.headers['cross-origin-resource-policy'], 'same-site');
    assert.match(script.headers['content-type'], /javascript/);
  });
});

test('security headers present everywhere; no cookies or app-identifying headers', async () => {
  await withLab(async (lab) => {
    const token = await lab.issue('akamai');
    const responses = [
      await lab.parent('/'), await lab.parent(`/scenario/akamai/${token}`), await lab.parent('/healthz'), await lab.parent('/assets/site.css'),
      await lab.widget(`/resources/akamai/${token}/_sec/cp_challenge/fixture.js`, { headers: lab.fromParent() }), await lab.widget('/healthz'),
      await lab.verify(`/api/status/${token}`, { headers: { origin: lab.origins.parent } }), await lab.verify('/healthz'),
    ];
    for (const r of responses) {
      assert.ok(r.headers['content-security-policy'].includes("default-src 'none'"));
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.equal(r.headers['set-cookie'], undefined);
      assert.equal(r.headers['x-powered-by'], undefined);
      assert.equal(r.headers['access-control-allow-credentials'], undefined);
      for (const name of Object.keys(r.headers)) assert.ok(!/northstar|x-app|x-session/i.test(name), `header ${name}`);
    }
  });
});

test('server-side errors are generic (no stack traces)', async () => {
  const { handleRequest } = await import('../functions/handler.js');
  const res = await handleRequest({ url: 'not a url', method: 'GET', headers: new Headers() }, localEnv());
  assert.equal(res.status, 500);
  assert.equal(await res.text(), 'Internal error\n');
});
