// Start the Northstar Lab Node server.
//   node scripts/serve.js --env-file configuration/local.env
// Without --env-file it uses process.env only (generic Node hosting).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { build } from './build.js';
import { readEnvFile, northstarOnly } from './lib/env.js';
import { loadConfig } from '../configuration/config.js';

const args = process.argv.slice(2);
const fileIdx = args.indexOf('--env-file');
const env = { ...northstarOnly(process.env), ...(fileIdx >= 0 ? readEnvFile(args[fileIdx + 1]) : {}) };

build({ quiet: true });
const { LANES, BUILD } = await import('../functions/generated/data.js');
const { startServer } = await import('../functions/node-adapter.js');

const config = await loadConfig(env, LANES);
if (!config.ok) {
  console.error('Northstar Lab configuration is not valid; every request will receive 503:');
  for (const e of config.errors) console.error(`  - ${e}`);
}
for (const w of config.warnings || []) console.warn(`  warning: ${w}`);

// Settled receipts are written to <evidence>/scenarios/<route>/<instance>/receipt.json
// (one directory per scenario instance). Local/Node hosting only.
const project = resolve(import.meta.dirname, '..');
const evidenceRoot = env.NORTHSTAR_EVIDENCE_DIRECTORY ? resolve(project, env.NORTHSTAR_EVIDENCE_DIRECTORY) : null;
const onEvidence = evidenceRoot && !relative(project, evidenceRoot).startsWith('..')
  ? ({ route, instance, receipt }) => {
    const dir = join(evidenceRoot, 'scenarios', route, instance);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  }
  : undefined;

const port = Number(env.NORTHSTAR_PORT || process.env.PORT || 8787);
const bind = env.NORTHSTAR_BIND || '127.0.0.1';
await startServer({ env, port, bind, onEvidence });
console.log(`Northstar Lab ${BUILD.id} listening on http://${bind}:${port}`);
if (config.ok) {
  console.log(`  parent  ${config.origins.parent}/`);
  console.log(`  widget  ${config.origins.widget}/healthz`);
  console.log(`  verify  ${config.origins.verify}/healthz`);
  console.log('  scenarios (each link issues a fresh token):');
  for (const lane of Object.values(LANES)) console.log(`    ${config.origins.parent}/scenario/${lane.route}`);
}
