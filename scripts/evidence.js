// Produce setup evidence locally (no external contact):
//   npm run evidence
// Writes to NORTHSTAR_EVIDENCE_DIRECTORY (default ./evidence, must stay inside the project).
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execSync } from 'node:child_process';
import { build } from './build.js';
import { readEnvFile } from './lib/env.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = readEnvFile(join(ROOT, 'configuration', 'local.env'));
const dir = resolve(ROOT, env.NORTHSTAR_EVIDENCE_DIRECTORY || 'evidence');
if (relative(ROOT, dir).startsWith('..') || dir === ROOT) { console.error('NORTHSTAR_EVIDENCE_DIRECTORY must be a subfolder of the project'); process.exit(1); }
rmSync(dir, { recursive: true, force: true });
mkdirSync(join(dir, 'screenshots'), { recursive: true });
const save = (name, data) => {
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  writeFileSync(join(dir, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n');
};
const step = (m) => console.log(`- ${m}`);
const git = (cmd) => { try { return execSync(`git ${cmd}`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } };

// 1. Build SHA and Git identity of what was tested
const buildInfo = build({ quiet: true });
const gitInfo = { commit: git('rev-parse HEAD'), branch: git('rev-parse --abbrev-ref HEAD'), headTree: git('rev-parse HEAD^{tree}'), workingTreeClean: git('status --porcelain') === '' };
save('build.json', { buildId: buildInfo.id, sourceSha256: buildInfo.sourceSha, git: gitInfo, node: process.version, generatedAt: new Date().toISOString() });
step(`build ${buildInfo.id}`);

const { LANES } = await import('../functions/generated/data.js');
const { loadConfig, configFingerprint, sanitizedConfig } = await import('../configuration/config.js');
const { request } = await import('../tests/helpers.js');
const { runBrowserSuite, INTERNAL_LANES, expectedVendors, startLab, roleOf, ROLE_PATHS } = await import('../tests/harness/suite.js');
const { findChrome } = await import('../tests/harness/browser.js');
const { SPECIAL, googleSorryObservation } = await import('../tests/harness/special-fixtures.js');
const { classifySpecial } = await import('../tests/reference-special.js');

// 2. Configuration fingerprint + sanitized example
const config = await loadConfig(env, LANES);
save('config-fingerprint.txt', `${await configFingerprint(config, LANES)}\n`);
save('config-sanitized.json', sanitizedConfig(config, LANES));
save('config-example.env', readFileSync(join(ROOT, 'configuration', 'northstar.env.example'), 'utf8'));
step('configuration fingerprint');

// 3. PROTECTED hostname / route / evidence matrix (internal; do not publish)
const matrix = Object.fromEntries(Object.entries(INTERNAL_LANES).map(([id, l]) => [id, {
  assignment: l.assignment, setupType: l.setupType, code: l.code,
  parentRoute: `/scenario/${l.route}/{token}`,
  widgetRoutes: [
    ...l.fixture.resources.map((p) => `/resources/${l.route}/{token}/${p}`),
    ...l.fixture.frames.map((p) => `/widget/${l.route}/{token}/${p}`),
    ...l.fixture.images.map((p) => `/images/${l.route}/{token}/${p}`),
  ],
  verifyRoutes: ['/api/input/{token}', '/api/verify/{token}', '/api/settle/{token}', '/api/status/{token}'],
  continuation: '/continue/{token}',
  expectedStatus: l.fixture.status, expectedVendors: expectedVendors(id), edge: l.edge || null,
  evidence: { screenshot: `screenshots/${id}.png`, continuationScreenshot: `screenshots/${id}-continue.png`, receipts: `scenarios/${l.route}/<instance>/receipt.json` },
}]));
save('hostname-route-matrix.PROTECTED.json', {
  notice: 'PROTECTED SETUP EVIDENCE - contains the internal lane assignment. Do not publish.',
  hostnames: { parent: 'northstar-parent.<ROOT_DOMAIN>', widget: 'northstar-widget.<ROOT_DOMAIN>', verify: 'northstar-verify.<ROOT_DOMAIN>' },
  local: { parent: env.NORTHSTAR_PARENT_ORIGIN, widget: env.NORTHSTAR_WIDGET_ORIGIN, verify: env.NORTHSTAR_VERIFY_ORIGIN },
  lanes: matrix,
  specialConditionsWithoutHostnames: { googleRateLimit: 'protocol-only', proxyGateway: 'browser transport (chrome-error://chromewebdata/)', youtubeGate: '/scenario/youtube-account-gate/{token}' },
});
step('hostname / route / evidence matrix');

// 4. Health checks, route isolation (HTTP), receipts to per-instance directories
const receipts = [];
const lab = await startLab({ onEvidence: (e) => receipts.push(e) });
const health = [];
for (const [role, host] of Object.entries(lab.hosts)) {
  for (const path of ['/healthz', '/readyz']) {
    const r = await request({ port: lab.port, host, path });
    health.push(`${role.padEnd(7)} ${`${host}${path}`.padEnd(42)} ${r.status} ${r.body.replace(/\s+/g, ' ').trim()}`);
  }
}
for (const host of ['unknown.challenge.localhost', 'localhost']) {
  const r = await request({ port: lab.port, host, path: '/' });
  health.push(`unknown ${`${host}/`.padEnd(42)} ${r.status} ${r.body.replace(/\s+/g, ' ').trim()}`);
}
save('health-check.txt', health.join('\n') + '\n');

const isolation = [];
const issue = async (route) => (await request({ port: lab.port, host: lab.hosts.parent, path: `/scenario/${route}` })).headers.location.split('/').pop();
const lanesArr = Object.values(INTERNAL_LANES);
for (const owner of lanesArr) {
  const token = await issue(owner.route);
  for (const other of lanesArr) {
    if (other === owner) continue;
    const r = await request({ port: lab.port, host: lab.hosts.parent, path: `/scenario/${other.route}/${token}` });
    isolation.push({ check: 'cross-lane token on parent', token: owner.route, route: other.route, status: r.status, pass: r.status === 404 });
  }
}
const t0 = await issue('datadome');
const chk = async (check, role, path, headers, want) => {
  const r = await request({ port: lab.port, host: lab.hosts[role], path, headers });
  isolation.push({ check, role, path: path.replace(t0, '{token}'), status: r.status, pass: r.status === want });
};
const ref = { referer: `${lab.origins.parent}/` };
await chk('widget resource with parent referer', 'widget', `/resources/datadome/${t0}/fx/captcha-delivery.com/c.js`, ref, 200);
await chk('widget resource without parent', 'widget', `/resources/datadome/${t0}/fx/captcha-delivery.com/c.js`, {}, 403);
await chk('widget resource from foreign parent', 'widget', `/resources/datadome/${t0}/fx/captcha-delivery.com/c.js`, { referer: 'https://attacker.example/' }, 403);
await chk('widget path not declared for lane', 'widget', `/resources/datadome/${t0}/fx/awswaf.com/challenge.js`, ref, 404);
await chk('scenario route on widget origin', 'widget', `/scenario/datadome/${t0}`, {}, 404);
await chk('verify route on parent origin', 'parent', `/api/status/${t0}`, { origin: lab.origins.parent }, 404);
await chk('verify from widget origin', 'verify', `/api/status/${t0}`, { origin: lab.origins.widget }, 403);
await chk('verify from parent origin', 'verify', `/api/status/${t0}`, { origin: lab.origins.parent }, 200);
await chk('unknown scenario route', 'parent', '/scenario/unknown', {}, 404);
await chk('Google /sorry/ is not an owned page', 'parent', '/sorry/index', {}, 404);
for (const route of ['clean-control', 'datadome', 'youtube-account-gate']) {
  const tk = await issue(route);
  for (const s of ['input', 'verify', 'settle']) {
    await request({ port: lab.port, host: lab.hosts.verify, path: `/api/${s}/${tk}`, method: 'POST', headers: { origin: lab.origins.parent, 'content-type': 'application/json' }, body: s === 'input' ? '{"value":"acknowledged"}' : undefined });
  }
}
await lab.close();
save('route-isolation.json', { pass: isolation.every((i) => i.pass), checks: isolation.length, failures: isolation.filter((i) => !i.pass), results: isolation });
for (const e of receipts) save(join('scenarios', e.route, e.instance, 'receipt.json'), e.receipt);
step(`health checks; route isolation ${isolation.filter((i) => i.pass).length}/${isolation.length}`);

// 5. Browser run: screenshots, request capture, signal isolation, proxy transport fixtures
const capture = { browser: null, lanes: {}, specialFixtures: {} };
const signal = {};
if (findChrome()) {
  const r = await runBrowserSuite({ screenshotsDir: join(dir, 'screenshots') });
  capture.browser = r.browser;
  capture.origins = r.origins;
  for (const [id, l] of Object.entries(r.lanes)) {
    const requests = l.rec.requests.filter((u) => !l.rec.environmentInjected.includes(u)).map((u) => ({ role: roleOf(u, r.hosts), url: u.replace(/\d{2}\.[A-Za-z0-9_-]{22}\.[0-9a-z]+\.[A-Za-z0-9_-]{43}/, '{token}') }));
    const misrouted = requests.filter((q) => !q.role || !ROLE_PATHS[q.role].some((re) => re.test(new URL(q.url.replace('{token}', 't')).pathname)));
    capture.lanes[id] = {
      route: INTERNAL_LANES[id].route,
      document: { status: l.rec.document?.status, role: roleOf(l.rec.document?.url, r.hosts) },
      requests, misrouted,
      blockedExternalAttempts: l.rec.blockedExternal,
      localSecuritySoftwareInjections: l.rec.environmentInjected.length,
      frames: (l.rec.frameUrls || []).map((u) => u.replace(/\d{2}\.[A-Za-z0-9_-]{22}\.[0-9a-z]+\.[A-Za-z0-9_-]{43}/, '{token}')),
      storage: { localStorage: l.rec.localStorage, sessionStorage: l.rec.sessionStorage, cookies: l.rec.cookies.length },
      continuation: { status: l.rec.continuation?.document?.status, state: l.rec.continuation?.scenarioState },
    };
    signal[id] = {
      expected: expectedVendors(id), hits: l.hits, continuationHits: l.continuationHits,
      pass: JSON.stringify(l.hits.map((h) => h.vendor)) === JSON.stringify(expectedVendors(id)) && l.continuationHits.length === 0,
    };
  }
  capture.specialFixtures = {
    googleRateLimit: { mode: 'protocol-only', observation: googleSorryObservation(), classification: classifySpecial(googleSorryObservation()), browserVisited: false },
    youtubeGate: { mode: 'browser-route', route: '/scenario/youtube-account-gate/{token}', status: r.lanes['lane-13'].rec.document?.status, textFound: r.lanes['lane-13'].rec.text.includes(SPECIAL.youtubeGate.text) },
    proxyGateway: Object.fromEntries(Object.entries(r.special.proxyGateway).map(([k, v]) => [k, {
      navigationError: v.rec.navigationError, errorPage: v.rec.errorPage, authChallenges: v.rec.authChallenges, gatewayLog: v.gatewayLog, blockedExternal: v.rec.blockedExternal,
      classification: classifySpecial({ errorPageUrl: v.rec.errorPage?.url, netError: v.rec.navigationError }),
    }])),
  };
  capture.browserReceipts = r.receipts.length;
  for (const e of r.receipts) save(join('scenarios', e.route, e.instance, 'receipt.json'), e.receipt);
  step('browser screenshots + request capture');
} else {
  capture.browser = 'SKIPPED: no Chrome/Edge found';
}
save('request-capture.json', capture);
save('signal-isolation.json', { pass: Object.values(signal).every((s) => s.pass), lanes: signal });

// 6. Automated test results
const t = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', 'tests/*.test.js'], { cwd: ROOT, encoding: 'utf8' });
// eslint-disable-next-line no-control-regex
const testOut = `${t.stdout}${t.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
save('test-results.txt', testOut);
const summary = (testOut.match(/ℹ (tests|pass|fail|skipped) \d+/g) || []).join(', ');
step(`tests: ${summary || `exit ${t.status}`}`);

// 7. Index
const shots = Object.entries(INTERNAL_LANES).map(([id, l]) => `- [${id} /scenario/${l.route}](screenshots/${id}.png) · [continuation](screenshots/${id}-continue.png)`).join('\n');
const routeOk = isolation.every((i) => i.pass);
const signalOk = Object.values(signal).length ? Object.values(signal).every((s) => s.pass) : null;
save('SUMMARY.md', `# Northstar Lab - setup evidence (three-origin architecture)

| Item | File |
|---|---|
| Build SHA | build.json (\`${buildInfo.id}\`, source sha256 \`${buildInfo.sourceSha.slice(0, 16)}...\`${gitInfo.commit ? `, git ${gitInfo.commit.slice(0, 12)} on ${gitInfo.branch}${gitInfo.workingTreeClean ? '' : ' + uncommitted changes'}` : ''}) |
| Configuration fingerprint | config-fingerprint.txt |
| Sanitized configuration example | config-example.env, config-sanitized.json |
| Hostname / route / evidence matrix (PROTECTED) | hostname-route-matrix.PROTECTED.json |
| Health-check output | health-check.txt |
| Route isolation | route-isolation.json (${routeOk ? 'PASS' : 'FAIL'}, ${isolation.length} checks) |
| Signal isolation | signal-isolation.json (${signalOk === null ? 'skipped' : signalOk ? 'PASS' : 'FAIL'}, 14 lanes + continuation pages) |
| Request capture | request-capture.json |
| Receipts (one directory per scenario instance) | scenarios/<route>/<instance>/receipt.json |
| Screenshots | screenshots/ |
| Automated test results | test-results.txt (${summary || `exit ${t.status}`}) |

## Screenshots
${shots}
- [Proxy 407](screenshots/special-proxy-proxy_auth_407.png)
- [Proxy 502](screenshots/special-proxy-tunnel_502.png)
- [Proxy unreachable](screenshots/special-proxy-proxy_unreachable.png)

Google /sorry/ is protocol-only (no screenshot by design). Generated ${new Date().toISOString()} - local only, no external website contacted.
`);
console.log(`\nEvidence written to ${relative(ROOT, dir)}/ (tests exit code ${t.status})`);
process.exit(t.status === 0 && routeOk && signalOk !== false ? 0 : 1);
