// Assemble a ready-to-deploy folder for one platform. DOES NOT DEPLOY.
//   npm run prepare-deploy -- vercel|netlify|cloudflare|node [--env-file configuration/deploy.env] [--name northstar-lab]
// Output: dist/<platform>/ plus printed, copy-pasteable next steps.
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from './build.js';
import { readEnvFile } from './lib/env.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: { 'env-file': { type: 'string', default: 'configuration/deploy.env' }, name: { type: 'string', default: 'northstar-lab' } },
});
const platform = (positionals[0] || '').toLowerCase();
if (!['vercel', 'netlify', 'cloudflare', 'node'].includes(platform)) {
  console.error('Usage: npm run prepare-deploy -- vercel|netlify|cloudflare|node'); process.exit(1);
}
let envPath = join(ROOT, a['env-file']);
if (!existsSync(envPath)) {
  const fallback = join(ROOT, 'configuration', 'local.env');
  if (a['env-file'] === 'configuration/deploy.env' && existsSync(fallback)) {
    console.error('Note: configuration/deploy.env not found; using configuration/local.env template (run "npm run plan -- --root-domain <ROOT_DOMAIN>" before external deployment).');
    envPath = fallback;
  } else {
    console.error(`${a['env-file']} not found. Run: npm run plan -- --root-domain <ROOT_DOMAIN> first.`);
    process.exit(1);
  }
}
const env = readEnvFile(envPath);
const publicVars = Object.entries(env).filter(([k]) => k.startsWith('NORTHSTAR_') && !/SECRET|SIGNING|AUTHORITY|PASSWORD|PRIVATE/i.test(k));
// The three role hostnames (the only hostname authority).
const hosts = ['NORTHSTAR_PARENT_ORIGIN', 'NORTHSTAR_WIDGET_ORIGIN', 'NORTHSTAR_VERIFY_ORIGIN'].map((k) => { try { return new URL(env[k]).hostname; } catch { return null; } }).filter(Boolean);
if (hosts.length !== 3) { console.error('deploy.env must define NORTHSTAR_PARENT_ORIGIN, NORTHSTAR_WIDGET_ORIGIN and NORTHSTAR_VERIFY_ORIGIN.'); process.exit(1); }
// Secrets are typed by YOU into the platform's own prompt; they never appear in files, logs or chat.
const KEYGEN = `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`;

const buildInfo = build({ quiet: true });
const out = join(ROOT, 'dist', platform);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const copy = (from, to) => cpSync(join(ROOT, from), join(out, to), { recursive: true });

// Shared core (identical for every platform).
copy('functions', 'functions');
rmSync(join(out, 'functions', 'node-adapter.js'));
mkdirSync(join(out, 'configuration'), { recursive: true });
copy('configuration/config.js', 'configuration/config.js');
writeFileSync(join(out, 'package.json'), JSON.stringify({ name: a.name, private: true, type: 'module' }, null, 2) + '\n');

const steps = [];
if (platform === 'vercel') {
  copy('deployment/adapters/vercel/api', 'api');
  copy('deployment/adapters/vercel/vercel.json', 'vercel.json');
  mkdirSync(join(out, 'public'));
  writeFileSync(join(out, 'public', 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  steps.push(`cd dist/vercel`, `vercel link            # select/create the project "${a.name}"`,
    ...publicVars.map(([k, v]) => `vercel env add ${k} production   # value: ${v === '' ? '(leave empty)' : v}`),
    `${KEYGEN}   # generate a signing key locally, then paste it ONLY into the next prompt`,
    'vercel env add NORTHSTAR_TOKEN_SIGNING_KEY production --sensitive',
    '(optional) vercel env add NORTHSTAR_MANAGEMENT_AUTHORITY production --sensitive',
    ...hosts.map((h) => `vercel domains add ${h}`),
    `vercel deploy --prod   # ONLY after external deployment is approved`);
} else if (platform === 'netlify') {
  copy('deployment/adapters/netlify/netlify', 'netlify');
  copy('deployment/adapters/netlify/netlify.toml', 'netlify.toml');
  mkdirSync(join(out, 'public'));
  writeFileSync(join(out, 'public', 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  writeFileSync(
    join(out, 'package.json'),
    JSON.stringify(
      {
        name: a.name,
        private: true,
        type: 'module',
        engines: { node: '>=22' },
        dependencies: { '@netlify/blobs': '^10.0.0 || ^11.0.0' },
      },
      null,
      2,
    ) + '\n',
  );
  steps.push(`cd dist/netlify`, `netlify link   # or: netlify sites:create --name ${a.name}`,
    ...publicVars.map(([k, v]) => `netlify env:set ${k} "${v}"`),
    `${KEYGEN}   # then: Site configuration > Environment variables > NORTHSTAR_TOKEN_SIGNING_KEY, tick "Contains secret values"`,
    `${KEYGEN}   # required for RemoteFixtureServer (/api/runs, /api/evidence): NORTHSTAR_MANAGEMENT_AUTHORITY, tick "Contains secret values"`,
    `Add the three hostnames as domain aliases (Site configuration > Domain management): ${hosts.join(', ')}`,
    'netlify deploy --prod   # ONLY after external deployment is approved');
} else if (platform === 'cloudflare') {
  copy('deployment/adapters/cloudflare/worker.js', 'worker.js');
  const toml = [`name = "${a.name}"`, 'main = "worker.js"', 'compatibility_date = "2026-11-01"', 'workers_dev = false', '',
    'routes = [', ...hosts.map((h) => `  { pattern = "${h}", custom_domain = true },`), ']', '', '[vars]',
    ...publicVars.map(([k, v]) => `${k} = ${JSON.stringify(v)}`)].join('\n') + '\n';
  writeFileSync(join(out, 'wrangler.toml'), toml);
  steps.push('cd dist/cloudflare', 'npx wrangler login', 'npx wrangler deploy --dry-run   # validates, uploads nothing',
    'npx wrangler secret put NORTHSTAR_TOKEN_SIGNING_KEY   # paste a key generated locally; never commit it',
    '(optional) npx wrangler secret put NORTHSTAR_MANAGEMENT_AUTHORITY',
    'npx wrangler deploy             # ONLY after external deployment is approved (creates the 3 custom domains)');
} else {
  copy('functions/node-adapter.js', 'functions/node-adapter.js');
  mkdirSync(join(out, 'scripts', 'lib'), { recursive: true });
  for (const f of ['serve.js', 'build.js', 'lib/env.js']) copy(`scripts/${f}`, `scripts/${f}`);
  copy('pages', 'pages');
  copy('configuration/lanes.internal.json', 'configuration/lanes.internal.json');
  copy('deployment/adapters/node/Dockerfile', 'Dockerfile');
  steps.push('cd dist/node', 'docker build -t northstar-lab .',
    `docker run -p 8787:8787 ${publicVars.map(([k]) => `-e ${k}`).join(' ')} -e NORTHSTAR_TOKEN_SIGNING_KEY northstar-lab   # secret from your container platform's secret store`,
    `Put a TLS-terminating proxy (platform load balancer, Caddy, nginx) in front for: ${hosts.join(', ')} (forward the Host header unchanged).`);
}

writeFileSync(join(out, 'NORTHSTAR-BUILD.txt'), `build=${buildInfo.id}\nsourceSha=${buildInfo.sourceSha}\nplatform=${platform}\n`);
console.log(`Prepared dist/${platform} (build ${buildInfo.id}). Nothing has been deployed.\n\nNext steps:`);
for (const s of steps) console.log(`  ${s}`);
