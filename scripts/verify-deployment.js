// Post-deployment check against YOUR deployed hostnames (HTTPS). Contacts only the 12 hosts
// listed in the env file, and only when you pass --i-approve-external-requests.
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

const report = [];
for (const [laneId, lane] of Object.entries(LANES)) {
  const host = env[lane.hostVariable];
  const row = { laneId, host };
  try {
    row.tls = await certInfo(host);
    for (const path of ['/healthz', '/readyz', '/fixture-manifest.json', '/']) {
      const r = await fetch(`https://${host}${path}`, { redirect: 'manual' });
      row[path] = { status: r.status, cfMitigated: r.headers.get('cf-mitigated'), cfRay: Boolean(r.headers.get('cf-ray')), server: r.headers.get('server') };
    }
    row.expectedRootStatus = lane.fixture.status;
  } catch (e) { row.error = e.message; }
  report.push(row);
  const root = row['/'] || {};
  console.log(`${laneId.padEnd(8)} ${host}  tls=${row.tls?.authorized ? 'ok' : row.tls?.error}  healthz=${row['/healthz']?.status}  readyz=${row['/readyz']?.status}  /=${root.status} (expect ${lane.fixture.status}${laneId === 'lane-01' ? ', or 403 + cf-mitigated once the WAF rule is on' : ''})  cf-mitigated=${root.cfMitigated || '-'}`);
}
const dir = join(ROOT, env.NORTHSTAR_EVIDENCE_DIRECTORY || 'evidence');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'deployment-verification.json'), JSON.stringify(report, null, 2));
const leaks = report.filter((r) => r.laneId !== 'lane-01' && r['/']?.cfMitigated);
if (leaks.length) { console.error(`WAF rule is matching non-lane-01 hosts: ${leaks.map((r) => r.host).join(', ')} - disable it now.`); process.exit(2); }
console.log(`\nSaved ${join(env.NORTHSTAR_EVIDENCE_DIRECTORY || 'evidence', 'deployment-verification.json')}`);
