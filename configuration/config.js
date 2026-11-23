// Northstar Lab configuration loader and validator.
// Platform-neutral: takes a plain env object (the process environment on Node/Vercel/Netlify,
// the `env` binding on Cloudflare Workers). Never reads files, never logs values.
// Fails closed: any problem => { ok: false } and the handler serves 503 everywhere.
//
// Three role origins are the ONLY hostname authority:
//   NORTHSTAR_PARENT_ORIGIN  top-level scenario pages and continuation pages
//   NORTHSTAR_WIDGET_ORIGIN  cross-origin frames, scripts, images and synthetic resources
//   NORTHSTAR_VERIFY_ORIGIN  input, verification, state, receipts and management endpoints

const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const ENV_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ROUTE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CODE_RE = /^\d{2}$/;

export const ROLES = ['parent', 'widget', 'verify'];
export const ORIGIN_VARIABLES = {
  parent: 'NORTHSTAR_PARENT_ORIGIN',
  widget: 'NORTHSTAR_WIDGET_ORIGIN',
  verify: 'NORTHSTAR_VERIFY_ORIGIN',
};

// Environments where plain-http *.localhost origins and an ephemeral token key are allowed.
const LOCAL_ENVIRONMENTS = new Set(['local', 'test']);

// Removed by the three-origin migration. If still present they are ignored (never required,
// never used to route) and reported as warnings, so there is exactly one hostname authority.
export const DEPRECATED_VARIABLES = [
  'NORTHSTAR_CONTROL_HOST',
  ...Array.from({ length: 11 }, (_, i) => `NORTHSTAR_LANE_${String(i + 1).padStart(2, '0')}_HOST`),
  'NORTHSTAR_ALLOWED_ORIGINS',
];

// Words that must never appear in a public hostname label (keeps hostnames neutral).
export const NON_NEUTRAL_WORDS = [
  'cloudflare', 'datadome', 'aws', 'waf', 'perimeterx', 'akamai', 'kasada', 'imperva',
  'incapsula', 'arkose', 'funcaptcha', 'geetest', 'hcaptcha', 'recaptcha', 'captcha',
  'challenge', 'bot', 'google', 'youtube', 'proxy',
];

export const TOKEN_TTL_DEFAULT = 900;
export const TOKEN_TTL_MIN = 60;
export const TOKEN_TTL_MAX = 86400;

// Public site-key formats (only used in the opt-in real-widget mode). Secrets are refused.
const SITE_KEY_RULES = {
  hcaptcha: {
    valid: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
    looksSecret: (v) => /^0x[0-9a-f]+$/i.test(v) || /^ES_/i.test(v),
  },
  recaptcha: {
    valid: (v) => /^6L[0-9A-Za-z_-]{38}$/.test(v),
    // Google's published *test secret*; a real secret cannot be told apart by shape,
    // which is why private widget secrets are never read by this project at all.
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
 * Refuses duplicated assignments, routes and codes, and non-relative fixture paths.
 */
export function validateLaneDefinitions(lanes) {
  const errors = [];
  const seen = { assignment: new Map(), route: new Map(), code: new Map() };
  for (const [laneId, lane] of Object.entries(lanes || {})) {
    for (const field of ['assignment', 'route', 'code']) {
      const v = lane[field];
      if (!v) { errors.push(`lane ${laneId}: missing ${field}`); continue; }
      if (seen[field].has(v)) errors.push(`duplicate ${field} "${v}" in ${seen[field].get(v)} and ${laneId}`);
      seen[field].set(v, laneId);
    }
    if (lane.route && !ROUTE_RE.test(lane.route)) errors.push(`lane ${laneId}: route must be lowercase words joined by hyphens`);
    if (lane.code && !CODE_RE.test(lane.code)) errors.push(`lane ${laneId}: code must be two digits`);
    const f = lane.fixture;
    if (!f || !Number.isInteger(f.status)) { errors.push(`lane ${laneId}: fixture.status missing`); continue; }
    if (f.frameSize !== undefined && !(Array.isArray(f.frameSize) && f.frameSize.length === 2 && f.frameSize.every((n) => Number.isInteger(n) && n > 0 && n <= 2000))) {
      errors.push(`lane ${laneId}: fixture.frameSize must be [width, height] in CSS pixels`);
    }
    for (const kind of ['resources', 'frames', 'images']) {
      if (!Array.isArray(f[kind])) { errors.push(`lane ${laneId}: fixture.${kind} must be a list`); continue; }
      for (const p of f[kind]) {
        if (typeof p !== 'string' || !p || p.startsWith('/') || /^[a-z]+:/i.test(p) || p.includes('..') || p.includes('//')) {
          errors.push(`lane ${laneId}: fixture ${kind} path must be relative to the widget route (${p})`);
        }
      }
    }
  }
  return errors;
}

function parseOrigin(raw, { allowLocalHttp }) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/') return null;
  if (u.origin.toLowerCase() !== raw.toLowerCase().replace(/\/$/, '')) return null;
  const host = u.hostname.toLowerCase();
  if (!HOST_RE.test(host)) return null;
  if (u.protocol === 'https:') return { origin: u.origin.toLowerCase(), host };
  if (u.protocol === 'http:' && allowLocalHttp && host.endsWith('.localhost')) return { origin: u.origin.toLowerCase(), host };
  return { insecure: true };
}

async function importHmacKey(raw) {
  return globalThis.crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/**
 * Load and validate runtime configuration.
 * @param {Record<string,string>} env
 * @param {Record<string,object>} lanes  lane definitions (bundled; assignment names optional)
 */
export async function loadConfig(env, lanes) {
  if (read(env, 'NORTHSTAR_ENABLED') !== 'true') {
    return { ok: false, enabled: false, errors: ['NORTHSTAR_ENABLED is not "true" (disabled by default)'] };
  }
  const errors = [];
  const warnings = [];

  const environment = read(env, 'NORTHSTAR_ENVIRONMENT').toLowerCase();
  if (!environment) errors.push('NORTHSTAR_ENVIRONMENT is missing');
  else if (!ENV_NAME_RE.test(environment)) errors.push('NORTHSTAR_ENVIRONMENT must be lowercase letters, digits or hyphens');
  if (environment === 'production' || environment === 'prod') errors.push('NORTHSTAR_ENVIRONMENT may not be production');
  const isLocal = LOCAL_ENVIRONMENTS.has(environment);

  const rootDomain = read(env, 'NORTHSTAR_ROOT_DOMAIN').toLowerCase().replace(/\.$/, '');
  if (!rootDomain) errors.push('NORTHSTAR_ROOT_DOMAIN is missing');
  else if (!HOST_RE.test(rootDomain)) errors.push('NORTHSTAR_ROOT_DOMAIN is not a valid hostname');

  // Hosts that must never serve the lab: the apex, www, and anything listed as production.
  const protectedHosts = new Set([rootDomain, `www.${rootDomain}`, ...list(read(env, 'NORTHSTAR_PRODUCTION_HOSTS'))]);

  const origins = {};
  const hostToRole = new Map();
  for (const role of ROLES) {
    const variable = ORIGIN_VARIABLES[role];
    const raw = read(env, variable);
    if (!raw) { errors.push(`${variable} is missing (no fallback is derived)`); continue; }
    const parsed = parseOrigin(raw, { allowLocalHttp: isLocal });
    if (!parsed) { errors.push(`${variable} must be a bare origin: scheme and host only (no path, query or credentials)`); continue; }
    if (parsed.insecure) { errors.push(`${variable} must use https (plain http is only allowed for *.localhost in a local environment)`); continue; }
    const { origin, host } = parsed;
    if (rootDomain && !host.endsWith(`.${rootDomain}`)) errors.push(`${variable} must be a subdomain of NORTHSTAR_ROOT_DOMAIN`);
    if (protectedHosts.has(host)) errors.push(`${variable} points at a protected/production host`);
    const label = rootDomain && host.endsWith(`.${rootDomain}`) ? host.slice(0, -(rootDomain.length + 1)) : host;
    if (NON_NEUTRAL_WORDS.some((w) => label.includes(w))) errors.push(`${variable} is not neutral (contains a reserved word)`);
    if (hostToRole.has(host)) errors.push(`${variable} duplicates the host already used by the ${hostToRole.get(host)} origin`);
    else hostToRole.set(host, role);
    origins[role] = origin;
  }

  for (const variable of DEPRECATED_VARIABLES) {
    if (read(env, variable)) warnings.push(`${variable} is deprecated and ignored (the three NORTHSTAR_*_ORIGIN values are the only hostname authority)`);
  }

  // Token lifetime (seconds).
  const ttlRaw = read(env, 'NORTHSTAR_TOKEN_TTL');
  let tokenTtl = TOKEN_TTL_DEFAULT;
  if (ttlRaw) {
    tokenTtl = /^\d+$/.test(ttlRaw) ? Number(ttlRaw) : NaN;
    if (!(tokenTtl >= TOKEN_TTL_MIN && tokenTtl <= TOKEN_TTL_MAX)) errors.push(`NORTHSTAR_TOKEN_TTL must be whole seconds between ${TOKEN_TTL_MIN} and ${TOKEN_TTL_MAX}`);
  }

  // Token signing key (SECRET; platform secret storage only). Local/test may use an ephemeral key.
  const keyRaw = read(env, 'NORTHSTAR_TOKEN_SIGNING_KEY');
  let tokenKey = null;
  let tokenKeyMode = 'configured';
  if (keyRaw) {
    if (keyRaw.length < 32) errors.push('NORTHSTAR_TOKEN_SIGNING_KEY must be at least 32 characters');
    else tokenKey = await importHmacKey(new TextEncoder().encode(keyRaw));
  } else if (isLocal) {
    tokenKey = await importHmacKey(globalThis.crypto.getRandomValues(new Uint8Array(32)));
    tokenKeyMode = 'ephemeral';
  } else {
    errors.push('NORTHSTAR_TOKEN_SIGNING_KEY is required outside local/test environments (store it in the platform secret manager)');
  }

  // Management credential (SECRET). Unset = management endpoints are disabled (fail closed).
  const managementAuthority = read(env, 'NORTHSTAR_MANAGEMENT_AUTHORITY') || null;
  if (managementAuthority && managementAuthority.length < 32) errors.push('NORTHSTAR_MANAGEMENT_AUTHORITY must be at least 32 characters when set');

  errors.push(...validateLaneDefinitions(lanes).filter((e) => !e.includes('missing assignment')));

  // Opt-in real provider widgets (lanes 10/11). Off by default: every lane is a controlled
  // fixture on the widget origin and no provider domain is ever contacted.
  const realWidgetsRaw = read(env, 'NORTHSTAR_REAL_WIDGETS') || 'false';
  if (!['true', 'false'].includes(realWidgetsRaw)) errors.push('NORTHSTAR_REAL_WIDGETS must be "true" or "false"');
  const realWidgets = realWidgetsRaw === 'true';
  const siteKeys = {};
  for (const [laneId, lane] of Object.entries(lanes || {})) {
    if (!lane.widget) continue;
    const rule = SITE_KEY_RULES[lane.widget.kind];
    const value = read(env, lane.widget.siteKeyVariable);
    if (!rule) { errors.push(`lane ${laneId}: unknown widget kind`); continue; }
    if (!value) continue;
    if (rule.looksSecret(value)) errors.push(`${lane.widget.siteKeyVariable} looks like a PRIVATE secret; only public site keys belong here`);
    else if (!rule.valid(value)) errors.push(`${lane.widget.siteKeyVariable} is not a valid public site key`);
    else siteKeys[laneId] = value;
  }

  if (errors.length) return { ok: false, enabled: true, errors };

  const laneByRoute = new Map();
  const laneByCode = new Map();
  for (const [laneId, lane] of Object.entries(lanes)) {
    laneByRoute.set(lane.route, laneId);
    laneByCode.set(lane.code, laneId);
  }

  return {
    ok: true,
    enabled: true,
    environment,
    rootDomain,
    origins,
    hostToRole,
    laneByRoute,
    laneByCode,
    tokenTtl,
    tokenKey,
    tokenKeyMode,
    managementAuthority,
    realWidgets,
    siteKeys,
    warnings,
  };
}

/** A lane is ready when its own requirements are met (real-widget lanes need a site key). */
export function laneReadiness(config, laneId, lanes) {
  const lane = lanes[laneId];
  if (!lane) return { ready: false, reason: 'unknown lane' };
  if (config.realWidgets && lane.widget && !config.siteKeys[laneId]) return { ready: false, reason: `${lane.widget.siteKeyVariable} is not set` };
  return { ready: true };
}

/** Sanitized, stable view of configuration (no secret or key values) used for fingerprinting/evidence. */
export function sanitizedConfig(config, lanes) {
  if (!config.ok) return { ok: false };
  return {
    enabled: config.enabled,
    environment: config.environment,
    rootDomain: config.rootDomain,
    origins: config.origins,
    tokenTtl: config.tokenTtl,
    tokenKeyMode: config.tokenKeyMode,
    managementEnabled: Boolean(config.managementAuthority),
    realWidgets: config.realWidgets,
    siteKeysPresent: Object.fromEntries(Object.entries(lanes).filter(([, l]) => l.widget).map(([id]) => [id, Boolean(config.siteKeys[id])])),
  };
}

/** sha256 fingerprint of the sanitized configuration plus hashed public site keys. Works on Node and Workers. */
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
