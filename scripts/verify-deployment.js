// Post-deployment check against YOUR three deployed origins (HTTPS). Contacts only the three
// hosts in the env file, and only when you pass --i-approve-external-requests.
//   npm run verify-deployment -- --env-file configuration/deploy.env --i-approve-external-requests
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import tls from 'node:tls';
import { readEnvFile } from './lib/env.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LANES = JSON.parse(readFileSync(join(ROOT, 'configuration', 'lanes.internal.json'), 'utf8')).lanes;
const { values: a } = parseArgs({ options: { 'env-file': { type: 'string', default: 'configuration/deploy.env' }, 'i-approve-external-requests': { type: 'boolean', default: false } } });
if (!a['i-approve-external-requests']) { console.error('Refusing: pass --i-approve-external-requests to contact your deployed hosts.'); process.exit(1); }
const env = readEnvFile(join(ROOT, a['env-file']));
const origins = { parent: env.NORTHSTAR_PARENT_ORIGIN, widget: env.NORTHSTAR_WIDGET_ORIGIN, verify: env.NORTHSTAR_VERIFY_ORIGIN };

function certInfo(host) {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port: 443, servername: host, timeout: 10000 }, () => {
      const c = s.getPeerCertificate();
      resolve({ authorized: s.authorized, error: s.authorizationError || null, subject: c.subject?.CN, altNames: c.subjectaltname, validTo: c.valid_to, issuer: c.issuer?.O });
      s.end();
    });
    s.on('error', (e) => resolve({ authorized: false, error: e.code || e.message }));
    s.on('timeout', () => { s.destroy(); resolve({ authorized: false, error: 'timeout' }); });
  });
}

const report = { origins: {}, lanes: {} };
const problems = [];
for (const [role, origin] of Object.entries(origins)) {
  const host = new URL(origin).hostname;
  const row = { host, tls: await certInfo(host) };
  for (const path of ['/healthz', '/readyz', '/fixture-manifest.json', '/definitely-not-a-route']) {
    const r = await fetch(`${origin}${path}`, { redirect: 'manual' });
    row[path] = { status: r.status, cfMitigated: r.headers.get('cf-mitigated'), cfRay: Boolean(r.headers.get('cf-ray')) };
  }
  if (!row.tls.authorized) problems.push(`${role}: TLS ${row.tls.error}`);
  if (row['/healthz'].status !== 200) problems.push(`${role}: /healthz ${row['/healthz'].status}`);
  if (row['/definitely-not-a-route'].status !== 404) problems.push(`${role}: unknown path returned ${row['/definitely-not-a-route'].status}`);
  report.origins[role] = row;
  console.log(`${role.padEnd(7)} ${host}  tls=${row.tls.authorized ? 'ok' : row.tls.error}  healthz=${row['/healthz'].status}  readyz=${row['/readyz'].status}  unknown-path=${row['/definitely-not-a-route'].status}`);
}

for (const [laneId, lane] of Object.entries(LANES)) {
  const isEdge = lane.edge === 'cloudflare';
  const row = { route: lane.route, expectedStatus: lane.fixture.status };
  try {
    const issue = await fetch(`${origins.parent}/scenario/${lane.route}`, { redirect: 'manual' });
    row.issue = { status: issue.status, cfMitigated: issue.headers.get('cf-mitigated') };
    const location = issue.headers.get('location');
    if (issue.status === 303 && location) {
      const page = await fetch(new URL(location, origins.parent), { redirect: 'manual' });
      const html = await page.text();
      row.page = { status: page.status, cfMitigated: page.headers.get('cf-mitigated'), edgeScriptInjected: html.includes('/cdn-cgi/challenge-platform') };
    }
  } catch (e) { row.error = e.message; }
  const mitigated = row.issue?.cfMitigated || row.page?.cfMitigated;
  if (!isEdge && mitigated) problems.push(`${laneId}: cf-mitigated on a non-Cloudflare lane (WAF rule too broad - disable it now)`);
  if (!isEdge && row.page?.edgeScriptInjected) problems.push(`${laneId}: Cloudflare injected /cdn-cgi/challenge-platform (turn off Bot Fight Mode / JS detections for the parent host)`);
  if (!isEdge && row.page && row.page.status !== lane.fixture.status) problems.push(`${laneId}: status ${row.page.status}, expected ${lane.fixture.status}`);
  report.lanes[laneId] = row;
  console.log(`${laneId.padEnd(8)} /scenario/${lane.route.padEnd(22)} issue=${row.issue?.status}  page=${row.page?.status ?? '-'} (expect ${lane.fixture.status}${isEdge ? ', or 403 + cf-mitigated once the WAF rule is on' : ''})  cf-mitigated=${mitigated || '-'}`);
}

const dir = join(ROOT, env.NORTHSTAR_EVIDENCE_DIRECTORY || 'evidence');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'deployment-verification.json'), JSON.stringify({ ...report, problems }, null, 2));
console.log(`\nSaved ${join(env.NORTHSTAR_EVIDENCE_DIRECTORY || 'evidence', 'deployment-verification.json')}`);
if (problems.length) { console.error(`\nProblems:\n - ${problems.join('\n - ')}`); process.exit(2); }
