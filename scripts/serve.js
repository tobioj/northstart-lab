// Start the Northstar Lab Node server.
//   node scripts/serve.js --env-file configuration/local.env
// Without --env-file it uses process.env only (generic Node hosting).
import { build } from './build.js';
import { readEnvFile, northstarOnly } from './lib/env.js';
import { loadConfig } from '../configuration/config.js';

const args = process.argv.slice(2);
const fileIdx = args.indexOf('--env-file');
const env = { ...northstarOnly(process.env), ...(fileIdx >= 0 ? readEnvFile(args[fileIdx + 1]) : {}) };

build({ quiet: true });
const { LANES, BUILD } = await import('../functions/generated/data.js');
const { startServer } = await import('../functions/node-adapter.js');

const config = loadConfig(env, LANES);
if (!config.ok) {
  console.error('Northstar Lab configuration is not valid; every request will receive 503:');
  for (const e of config.errors) console.error(`  - ${e}`);
}

const port = Number(env.NORTHSTAR_PORT || process.env.PORT || 8787);
const bind = env.NORTHSTAR_BIND || '127.0.0.1';
const { port: actual } = await startServer({ env, port, bind });
console.log(`Northstar Lab ${BUILD.id} listening on http://${bind}:${actual}`);
if (config.ok) {
  for (const [id, host] of Object.entries(config.laneHosts)) console.log(`  ${id.padEnd(8)} http://${host}:${actual}/`);
}
