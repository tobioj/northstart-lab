// Northstar Lab configuration loader and validator.
// Platform-neutral: takes a plain env object (the process environment on Node/Vercel/Netlify,
// the `env` binding on Cloudflare Workers). Never reads files, never logs values.
// Fails closed: any problem => { ok: false } and the handler serves 503 everywhere.

const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const ENV_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

// Words that must never appear in a public lane label (keeps hostnames neutral).
export const NON_NEUTRAL_WORDS = [
  'cloudflare', 'datadome', 'aws', 'waf', 'perimeterx', 'akamai', 'kasada', 'imperva',
  'incapsula', 'arkose', 'funcaptcha', 'geetest', 'hcaptcha', 'recaptcha', 'captcha',
  'challenge', 'bot', 'google', 'youtube', 'proxy',
];

// Public site-key formats. Private secrets have different shapes and are refused.
const SITE_KEY_RULES = {
  hcaptcha: {
    valid: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
    looksSecret: (v) => /^0x[0-9a-f]+$/i.test(v) || /^ES_/i.test(v),
  },
  recaptcha: {
    valid: (v) => /^6L[0-9A-Za-z_-]{38}$/.test(v),
    // Google's published *test secret*; a real secret cannot be told apart by shape,
    // which is why secrets are never read by this project at all.
    looksSecret: (v) => v === '6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe',
  },
};

function read(env, key) {
  const v = env && typeof env === 'object' ? env[key] : undefined;
  return typeof v === 'string' ? v.trim() : '';
}

function list(value) {
  return value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * Validate the internal lane definitions (build-time and test-time).
 * Refuses duplicated assignments, labels and host variables.
 */
export function validateLaneDefinitions(lanes) {
  const errors = [];
  const seen = { assignment: new Map(), label: new Map(), hostVariable: new Map() };
  for (const [laneId, lane] of Object.entries(lanes || {})) {
    for (const field of ['assignment', 'label', 'hostVariable']) {
      const v = lane[field];
      if (!v) { errors.push(`lane ${laneId}: missing ${field}`); continue; }
      if (seen[field].has(v)) errors.push(`duplicate ${field} "${v}" in ${seen[field].get(v)} and ${laneId}`);
      seen[field].set(v, laneId);
    }
    if (!lane.fixture || !Number.isInteger(lane.fixture.status)) errors.push(`lane ${laneId}: fixture.status missing`);
  }
  return errors;
}

/**
 * Load and validate runtime configuration.
 * @param {Record<string,string>} env
 * @param {Record<string,object>} lanes  lane definitions (bundled, assignment names optional)
 */
export function loadConfig(env, lanes) {
  if (read(env, 'NORTHSTAR_ENABLED') !== 'true') {
    return { ok: false, enabled: false, errors: ['NORTHSTAR_ENABLED is not "true" (disabled by default)'] };
  }
  const errors = [];

  const environment = read(env, 'NORTHSTAR_ENVIRONMENT').toLowerCase();
  if (!environment) errors.push('NORTHSTAR_ENVIRONMENT is missing');
  else if (!ENV_NAME_RE.test(environment)) errors.push('NORTHSTAR_ENVIRONMENT must be lowercase letters, digits or hyphens');
  if (environment === 'production' || environment === 'prod') errors.push('NORTHSTAR_ENVIRONMENT may not be production');

  const rootDomain = read(env, 'NORTHSTAR_ROOT_DOMAIN').toLowerCase().replace(/\.$/, '');
  if (!rootDomain) errors.push('NORTHSTAR_ROOT_DOMAIN is missing');
  else if (!HOST_RE.test(rootDomain)) errors.push('NORTHSTAR_ROOT_DOMAIN is not a valid hostname');

  // Hosts that must never serve a lane: the apex, www, and anything listed as production.
  const protectedHosts = new Set([rootDomain, `www.${rootDomain}`, ...list(read(env, 'NORTHSTAR_PRODUCTION_HOSTS'))]);

  const hostToLane = new Map();
  const laneHosts = {};
  for (const [laneId, lane] of Object.entries(lanes || {})) {
    const variable = lane.hostVariable;
    const host = read(env, variable).toLowerCase().replace(/\.$/, '');
    if (!host) { errors.push(`${variable} is missing (no fallback is derived)`); continue; }
    if (!HOST_RE.test(host)) { errors.push(`${variable} is not a valid hostname`); continue; }
    if (rootDomain && !host.endsWith(`.${rootDomain}`)) errors.push(`${variable} must be a subdomain of NORTHSTAR_ROOT_DOMAIN`);
    if (protectedHosts.has(host)) errors.push(`${variable} points at a protected/production host`);
    const label = rootDomain && host.endsWith(`.${rootDomain}`) ? host.slice(0, -(rootDomain.length + 1)) : host;
    const bad = NON_NEUTRAL_WORDS.find((w) => label.includes(w));
    if (bad) errors.push(`${variable} is not neutral (contains a reserved word)`);
    if (hostToLane.has(host)) errors.push(`${variable} duplicates the host already assigned to ${hostToLane.get(host)}`);
    else hostToLane.set(host, laneId);
    laneHosts[laneId] = host;
  }

  errors.push(...validateLaneDefinitions(lanes).filter((e) => !e.includes('missing assignment')));

  // Public site keys only. Values are never placed in error messages.
  const siteKeys = {};
  for (const [laneId, lane] of Object.entries(lanes || {})) {
    if (!lane.widget) continue;
    const rule = SITE_KEY_RULES[lane.widget.kind];
    const value = read(env, lane.widget.siteKeyVariable);
    if (!rule) { errors.push(`lane ${laneId}: unknown widget kind`); continue; }
    if (!value) continue; // lane reports not-ready instead of failing the whole environment
    if (rule.looksSecret(value)) errors.push(`${lane.widget.siteKeyVariable} looks like a PRIVATE secret; only public site keys belong here`);
    else if (!rule.valid(value)) errors.push(`${lane.widget.siteKeyVariable} is not a valid public site key`);
    else siteKeys[laneId] = value;
  }

  const allowedOrigins = [];
  for (const origin of list(read(env, 'NORTHSTAR_ALLOWED_ORIGINS'))) {
    let ok = false;
    try {
      const u = new URL(origin);
      ok = (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === origin && u.origin !== 'null';
    } catch { ok = false; }
    if (!ok || origin === '*') errors.push('NORTHSTAR_ALLOWED_ORIGINS contains an invalid origin (wildcards are not allowed)');
    else allowedOrigins.push(origin);
  }

  if (errors.length) return { ok: false, enabled: true, errors };

  return {
    ok: true,
    enabled: true,
    environment,
    rootDomain,
    hostToLane,
    laneHosts,
    siteKeys,
    allowedOrigins,
  };
}

/** A lane is ready when its own requirements are met (e.g. widget lanes need a site key). */
export function laneReadiness(config, laneId, lanes) {
  const lane = lanes[laneId];
  if (!lane) return { ready: false, reason: 'unknown lane' };
  if (lane.widget && !config.siteKeys[laneId]) return { ready: false, reason: `${lane.widget.siteKeyVariable} is not set` };
  return { ready: true };
}

/** Sanitized, stable view of configuration (no key values) used for fingerprinting/evidence. */
export function sanitizedConfig(config, lanes) {
  if (!config.ok) return { ok: false };
  return {
    enabled: config.enabled,
    environment: config.environment,
    rootDomain: config.rootDomain,
    hosts: Object.fromEntries(Object.keys(lanes).map((id) => [id, config.laneHosts[id]])),
    siteKeysPresent: Object.fromEntries(Object.entries(lanes).filter(([, l]) => l.widget).map(([id]) => [id, Boolean(config.siteKeys[id])])),
    allowedOrigins: config.allowedOrigins,
  };
}

/** sha256 fingerprint of the sanitized configuration plus hashed site keys. Works on Node and Workers. */
export async function configFingerprint(config, lanes) {
  const material = JSON.stringify({
    ...sanitizedConfig(config, lanes),
    siteKeyHashes: await Promise.all(Object.keys(config.siteKeys || {}).sort().map(async (k) => [k, await sha256(config.siteKeys[k])])),
  });
  return `sha256:${(await sha256(material)).slice(0, 16)}`;
}

export async function sha256(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
