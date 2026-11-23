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
const save = (name, data) => writeFileSync(join(dir, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n');
const step = (m) => console.log(`- ${m}`);

// 1. Build SHA
const buildInfo = build({ quiet: true });
let git = null;
try { git = execSync('git rev-parse HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not a git repo */ }
save('build.json', { buildId: buildInfo.id, sourceSha256: buildInfo.sourceSha, gitCommit: git, node: process.version, generatedAt: new Date().toISOString() });
step(`build ${buildInfo.id}`);

const { LANES } = await import('../functions/generated/data.js');
const { loadConfig, configFingerprint, sanitizedConfig } = await import('../configuration/config.js');
const { startServer } = await import('../functions/node-adapter.js');
const { request } = await import('../tests/helpers.js');
const { runBrowserSuite, INTERNAL_LANES, expectedVendors } = await import('../tests/harness/suite.js');
const { findChrome } = await import('../tests/harness/browser.js');

// 2. Configuration fingerprint + sanitized example
const config = loadConfig(env, LANES);
save('config-fingerprint.txt', `${await configFingerprint(config, LANES)}\n`);
save('config-sanitized.json', sanitizedConfig(config, LANES));
save('config-example.env', readFileSync(join(ROOT, 'configuration', 'northstar.env.example'), 'utf8'));
step('configuration fingerprint');

// 3. PROTECTED hostname -> lane manifest (internal; do not publish)
save('hostname-lane-manifest.PROTECTED.json', {
  notice: 'PROTECTED SETUP EVIDENCE - contains the internal lane assignment. Do not publish.',
  lanes: Object.fromEntries(Object.entries(INTERNAL_LANES).map(([id, l]) => [id, {
    localHost: env[l.hostVariable], deployedHost: `${l.label}.<ROOT_DOMAIN>`, assignment: l.assignment, setupType: l.setupType,
    fixture: l.fixture, widget: l.widget || null,
  }])),
});
step('hostname-to-lane manifest');

// 4. Health checks + HTTP request capture
const { server, port } = await startServer({ env, port: 0, log: () => {} });
const health = [];
const capture = {};
for (const [id, l] of Object.entries(INTERNAL_LANES)) {
  const host = env[l.hostVariable];
  for (const path of ['/healthz', '/readyz']) {
    const r = await request({ port, host, path });
    health.push(`${id.padEnd(8)} ${`${host}${path}`.padEnd(42)} ${r.status} ${r.body.replace(/\s+/g, ' ').trim()}`);
  }
  const page = await request({ port, host });
  capture[id] = { host, request: `GET http://${host}/`, status: page.status, responseHeaders: page.headers };
}
for (const path of ['/', '/healthz']) {
  const r = await request({ port, host: 'unknown.localhost', path });
  health.push(`unknown  ${`unknown.localhost${path}`.padEnd(42)} ${r.status} ${r.body.replace(/\s+/g, ' ').trim()}`);
}
server.close();
save('health-check.txt', health.join('\n') + '\n');
step('health checks');

// 5. Browser run: screenshots + network capture + special fixtures
if (findChrome()) {
  const r = await runBrowserSuite({ screenshotsDir: join(dir, 'screenshots') });
  for (const [id, l] of Object.entries(r.lanes)) {
    Object.assign(capture[id], {
      browserRequests: l.rec.requests.filter((u) => !l.rec.environmentInjected.includes(u)),
      blockedExternalAttempts: l.rec.blockedExternal,
      localSecuritySoftwareInjections: l.rec.environmentInjected.length,
      frames: l.rec.frameUrls,
      signatureHits: l.hits,
      expected: expectedVendors(id),
      pass: JSON.stringify(l.hits.map((h) => h.vendor)) === JSON.stringify(expectedVendors(id)),
      storage: { localStorage: l.rec.localStorage, sessionStorage: l.rec.sessionStorage, cookies: l.rec.cookies.length },
    });
  }
  capture.specialFixtures = {
    googleRateLimit: { url: r.special.googleRateLimit.rec.document?.url, status: r.special.googleRateLimit.rec.document?.status, text: r.special.googleRateLimit.rec.text, answeredLocally: r.special.googleRateLimit.rec.answeredLocally, blockedExternal: r.special.googleRateLimit.rec.blockedExternal },
    youtubeGate: { url: r.special.youtubeGate.rec.document?.url, status: r.special.youtubeGate.rec.document?.status, text: r.special.youtubeGate.rec.text, answeredLocally: r.special.youtubeGate.rec.answeredLocally, blockedExternal: r.special.youtubeGate.rec.blockedExternal },
    proxyGateway: Object.fromEntries(Object.entries(r.special.proxyGateway).map(([k, v]) => [k, { navigationError: v.navigationError }])),
  };
  capture.browser = r.browser;
  step('browser screenshots + request capture');
} else {
  capture.browser = 'SKIPPED: no Chrome/Edge found';
}
save('request-capture.json', capture);

// 6. Automated test results
const t = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', 'tests/*.test.js'], { cwd: ROOT, encoding: 'utf8' });
// eslint-disable-next-line no-control-regex
const testOut = `${t.stdout}${t.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
save('test-results.txt', testOut);
const summary = (testOut.match(/ℹ (tests|pass|fail|skipped) \d+/g) || []).join(', ');
step(`tests: ${summary || `exit ${t.status}`}`);

// 7. Index
const shots = Object.keys(INTERNAL_LANES).map((id) => `- [${id}](screenshots/${id}.png)`).join('\n');
save('SUMMARY.md', `# Northstar Lab - setup evidence

| Item | File |
|---|---|
| Build SHA | build.json (\`${buildInfo.id}\`, source sha256 \`${buildInfo.sourceSha.slice(0, 16)}...\`${git ? `, git ${git.slice(0, 12)}` : ', not a git repo'}) |
| Configuration fingerprint | config-fingerprint.txt |
| Sanitized configuration example | config-example.env, config-sanitized.json |
| Hostname-to-lane manifest (PROTECTED) | hostname-lane-manifest.PROTECTED.json |
| Health-check output | health-check.txt |
| Request-capture output | request-capture.json |
| Screenshots | screenshots/ |
| Automated test results | test-results.txt (${summary || `exit ${t.status}`}) |
| DNS record template | ../deployment/dns-plan.md |
| Deployment checklist | ../deployment/deployment-checklist.md |
| TLS checklist | ../deployment/tls-checklist.md |
| Rollback instructions | ../deployment/rollback.md |
| Items waiting for you | ../deployment/waiting-on-you.md |

## Screenshots
${shots}
- [Google rate-limit fixture](screenshots/special-googleRateLimit.png)
- [YouTube gate fixture](screenshots/special-youtubeGate.png)
- [Proxy gateway 502](screenshots/special-proxy-tunnel_502.png)
- [Proxy unreachable](screenshots/special-proxy-proxy_unreachable.png)

Generated ${new Date().toISOString()} - local only, no external website contacted.
`);
console.log(`\nEvidence written to ${relative(ROOT, dir)}/ (tests exit code ${t.status})`);
process.exit(t.status === 0 ? 0 : 1);
