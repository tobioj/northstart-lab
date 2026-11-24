// Platform-neutral Northstar Lab request handler for the three role origins.
// Signature: handleRequest(request: Request, env: object, ctx?: {store, onEvidence, now, nowMs}) => Promise<Response>
// Adapters (Node, Vercel, Netlify, Cloudflare) only translate in/out of this function.
// No filesystem, database, cookies, storage or logging of configuration values.
//
//   parent  /                                  start page
//           /scenario/{route}                  issue a fresh token -> 303 /scenario/{route}/{token}
//           /scenario/{route}/{token}          scenario page (lane status + headers on this document only)
//           /continue/{token}                  clean continuation page (legacy + stateless proof flow)
//           /complete/{token}                  gated post-settlement continuation page (#continuation)
//   widget  /widget/{route}/{token}/{path}     fixture or interactive oracle frame (framable only by parent)
//           /resources/{route}/{token}/{path}  fixture script
//           /images/{route}/{token}/{path}     fixture image or deterministic puzzle SVG
//   verify  /api/input|verify|settle/{token}   POST, CORS for parent or widget origin (never wildcard)
//           /api/status/{token}                GET,  CORS for parent or widget origin (never wildcard)
//           /api/runs                          POST issue seeded oracle run      (bearer; never CORS)
//           /api/evidence/{token}              GET oracle/run evidence JSON      (bearer; never CORS)
//           /api/reset/{token}                 POST reset/revoke run instance    (bearer; never CORS)
//           /api/manage/instances              GET list / POST issue             (bearer; never CORS)
//           /api/manage/revoke/{token}         POST                              (bearer; never CORS)
//   all     /healthz /readyz /fixture-manifest.json /robots.txt
import { BUILD, LANES, PAGES, TEMPLATES, ASSETS } from './generated/data.js';
import { loadConfig, laneReadiness, configFingerprint, sha256 } from '../configuration/config.js';
import {
  renderParentPage,
  renderOracleParentPage,
  renderOracleWidgetFrame,
  renderCompletePage,
  contentSecurityPolicy,
} from './render.js';
import {
  issueToken,
  verifyToken,
  signText,
  secretEquals,
  nowSeconds,
  b64url,
  makeProof,
  readProof,
} from './tokens.js';
import { MemoryStore, newRecord, STATES } from './state.js';
import {
  ORACLE_SPINNER_MS,
  resolveOracleScenario,
  normalizeSeed,
  createOracleRecord,
  recordOracleInput,
  verifyOracleSubmission,
  renderPuzzleSvg,
  buildOracleEvidence,
} from './oracle.js';

const FIXTURE_SCRIPT = '/* Northstar controlled fixture resource. Intentionally inert. */\n';
const MAX_BODY = 1024;
const ENDPOINTS = {
  parent: ['/', '/scenario/{lane}', '/scenario/{lane}/{token}', '/continue/{token}', '/complete/{token}', '/healthz', '/readyz', '/fixture-manifest.json'],
  widget: ['/widget/{lane}/{token}/{path}', '/resources/{lane}/{token}/{path}', '/images/{lane}/{token}/{path}', '/healthz', '/readyz', '/fixture-manifest.json'],
  verify: ['/api/input/{token}', '/api/verify/{token}', '/api/settle/{token}', '/api/status/{token}', '/healthz', '/readyz', '/fixture-manifest.json'],
};
const ROLE_NAMES = { parent: 'Northstar Parent', widget: 'Northstar Widget', verify: 'Northstar Verify' };

const defaultStore = new MemoryStore();
const configCache = new WeakMap();
function configFor(env) {
  if (!env || typeof env !== 'object') return loadConfig({}, LANES);
  let cfg = configCache.get(env);
  if (!cfg) { cfg = loadConfig(env, LANES); configCache.set(env, cfg); }
  return cfg;
}

// ---------------------------------------------------------------- responses

function securityHeaders(csp, { framable = false } = {}) {
  return {
    'cache-control': 'no-store',
    'content-security-policy': csp,
    ...(framable ? {} : { 'x-frame-options': 'DENY' }),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    'x-robots-tag': 'noindex, nofollow',
  };
}
const LOCKED = () => securityHeaders(contentSecurityPolicy('locked'));

function respond(status, body, type, headers = {}) {
  return new Response(body, { status, headers: { 'content-type': type, ...headers } });
}
const json = (status, obj, headers = LOCKED()) => respond(status, JSON.stringify(obj, null, 2) + '\n', 'application/json; charset=utf-8', headers);
const text = (status, body, headers = LOCKED()) => respond(status, body, 'text/plain; charset=utf-8', headers);
const notFound = (headers) => text(404, 'Not found\n', headers);

// ---------------------------------------------------------------- helpers

function splitPath(pathname) {
  // Exact routing: no empty segments, no dot segments, no encoded slashes.
  if (pathname.includes('//') || /%2f|%5c/i.test(pathname)) return null;
  const parts = pathname.split('/').slice(1);
  if (parts.some((p) => p === '.' || p === '..')) return null;
  return parts;
}

function originOf(value) {
  try { return new URL(value).origin.toLowerCase(); } catch { return null; }
}

/** The request comes from a page on the parent origin (Origin header, else Referer origin). */
function fromParent(request, config) {
  const origin = request.headers.get('origin');
  if (origin) return origin.toLowerCase() === config.origins.parent;
  const referer = request.headers.get('referer');
  return Boolean(referer) && originOf(referer) === config.origins.parent;
}

/** For puzzle SVG images loaded inside widget iframes, accept either parent or widget Referer/Origin. */
function fromParentOrWidget(request, config) {
  const origin = request.headers.get('origin');
  if (origin) {
    const lowered = origin.toLowerCase();
    return lowered === config.origins.parent || lowered === config.origins.widget;
  }
  const referer = request.headers.get('referer');
  if (!referer) return false;
  const refOrigin = originOf(referer);
  return refOrigin === config.origins.parent || refOrigin === config.origins.widget;
}

function laneUrls(config, laneId, token, { realWidget }) {
  const lane = LANES[laneId];
  if (realWidget) return {};
  const base = (kind) => `${config.origins.widget}/${kind}/${lane.route}/${token}/`;
  return {
    scripts: lane.fixture.resources.map((p) => base('resources') + p),
    frames: lane.fixture.frames.map((p) => base('widget') + p),
    images: lane.fixture.images.map((p) => base('images') + p),
    frameSize: lane.fixture.frameSize || null,
  };
}

function oracleWidgetUrls(config, spec, token) {
  const base = (kind) => `${config.origins.widget}/${kind}/${spec.route}/${token}/`;
  return {
    scripts: (spec.resources || []).map((p) => base('resources') + p),
    frames: spec.framePath ? [base('widget') + spec.framePath] : [],
    images: [],
  };
}

async function tokenFor(config, token, expectedLaneId, now) {
  const expectedCode = expectedLaneId ? LANES[expectedLaneId].code : null;
  const v = await verifyToken(config, token, { expectedCode, now });
  if (!v.ok) return v;
  if (!config.laneByCode.has(v.code)) return { ok: false, reason: 'invalid' };
  return { ...v, laneId: config.laneByCode.get(v.code) };
}

function tokenFailure(reason, headers) {
  return reason === 'expired' ? json(410, { status: 'expired' }, headers) : json(404, { status: 'unknown_token' }, headers);
}

/**
 * Current record for a token instance: the store record, advanced by a valid signed
 * progress proof when the request carries one (so legacy steps may land on different instances).
 */
async function recordFor(ctx, t, proof = null) {
  let rec = await ctx.store.get(t.id);
  const p = proof ? await readProof(ctx.config, t.id, proof) : null;
  if (p && (!rec || (rec.mode !== 'oracle' && STATES.indexOf(p.state) > STATES.indexOf(rec.state)))) {
    rec = { ...newRecord(t), ...p };
  }
  return rec || newRecord(t);
}

async function settleReceipt(config, record, t) {
  const body = {
    receipt: `nsr_${b64url(globalThis.crypto.getRandomValues(new Uint8Array(12)))}`,
    lane: t.code,
    instance: (await sha256(t.id)).slice(0, 16),
    steps: record.steps,
    build: BUILD.id,
    environment: config.environment,
    ...(record.run_id ? { run_id: record.run_id, scenario: record.scenario } : {}),
  };
  return { ...body, signature: await signText(config, JSON.stringify(body)) };
}

async function settleRecord(ctx, record, t) {
  const { config, now, nowMs } = ctx;
  const settledIso = new Date(nowMs).toISOString();
  record.state = 'settled';
  record.steps = { ...record.steps, settled: settledIso };
  record.receipt = await settleReceipt(config, record, t);
  if (record.mode === 'oracle') {
    record.settlement = { settled: true, at: settledIso, receipt: record.receipt };
  }
  if (ctx.onEvidence) {
    try {
      await ctx.onEvidence({
        type: 'receipt',
        laneId: t.laneId,
        route: LANES[t.laneId].route,
        instance: record.receipt.instance,
        receipt: record.receipt,
      });
    } catch { /* evidence is best effort */ }
  }
  await ctx.store.put(t.id, record, now);
  return record;
}

// ---------------------------------------------------------------- parent origin

async function parentRoute(ctx) {
  const { config, url, parts, method, now } = ctx;
  if (method !== 'GET' && method !== 'HEAD') return text(405, 'Method not allowed\n', { ...LOCKED(), allow: 'GET, HEAD' });
  const controlUrl = `${config.origins.parent}/scenario/${LANES.control.route}`;
  const pageCsp = (o) => securityHeaders(contentSecurityPolicy('parent-page', { origins: config.origins, ...o }));
  const common = { templates: TEMPLATES, build: BUILD, environment: config.environment, controlUrl };

  if (url.pathname === '/') {
    return respond(200, renderParentPage({ ...common, page: PAGES.index }), 'text/html; charset=utf-8', { ...pageCsp({}), 'cross-origin-opener-policy': 'same-origin' });
  }

  if (parts[0] === 'scenario' && (parts.length === 2 || (parts.length === 3 && parts[2] === '') || parts.length === 3)) {
    const laneId = config.laneByRoute.get(parts[1]);
    if (!laneId) return notFound();
    const readiness = laneReadiness(config, laneId, LANES);
    if (!readiness.ready) return text(503, 'Lane not ready\n');

    if (parts.length === 2 || parts[2] === '') {
      const issued = await issueToken(config, LANES[laneId].code, { now });
      return new Response(null, { status: 303, headers: { ...LOCKED(), location: `/scenario/${LANES[laneId].route}/${issued.token}` } });
    }

    const t = await tokenFor(config, parts[2], laneId, now);
    if (!t.ok) return tokenFailure(t.reason);
    const record = await ctx.store.get(t.id);
    if (record && record.state === 'revoked') return json(410, { status: 'revoked' });

    if (record && record.mode === 'oracle') {
      const spec = resolveOracleScenario(record.scenario);
      if (!spec) return notFound();
      if (spec.autoComplete && !record.receipt) {
        record.continuation_reached = true;
        await settleRecord(ctx, record, t);
      }
      const widgetUrls = oracleWidgetUrls(config, spec, parts[2]);
      const usesWidget = Object.values(widgetUrls).some((l) => l.length);
      const html = renderOracleParentPage({ origins: config.origins, spec, token: parts[2], widgetUrls });
      return respond(spec.status, html, 'text/html; charset=utf-8', {
        ...pageCsp({ usesWidget, usesVerify: true }),
        'cross-origin-opener-policy': 'same-origin',
        ...(spec.headers || {}),
      });
    }

    const lane = LANES[laneId];
    const realWidget = config.realWidgets && lane.widget ? { kind: lane.widget.kind, siteKey: config.siteKeys[laneId] } : null;
    const widgetUrls = laneUrls(config, laneId, parts[2], { realWidget });
    const usesWidget = ['scripts', 'frames', 'images'].some((k) => (widgetUrls[k] || []).length);
    const html = renderParentPage({
      ...common,
      page: PAGES[laneId],
      widgetUrls,
      realWidget,
      scenario: { verifyOrigin: config.origins.verify, token: parts[2], continueUrl: `${config.origins.parent}/continue/${parts[2]}` },
    });
    // Fixture status and headers apply to the scenario document only.
    return respond(lane.fixture.status, html, 'text/html; charset=utf-8', {
      ...pageCsp({ usesWidget, usesVerify: true, realWidget: realWidget && realWidget.kind }),
      'cross-origin-opener-policy': 'same-origin',
      ...lane.fixture.headers,
    });
  }

  if (parts[0] === 'continue' && parts.length === 2) {
    const t = await tokenFor(config, parts[1], null, now);
    if (!t.ok) return tokenFailure(t.reason);
    const record = await recordFor(ctx, t, url.searchParams.get('p'));
    if (record.state === 'settled' && !record.continuation_reached) {
      record.continuation_reached = true;
      await ctx.store.put(t.id, record, now);
    }
    const state = record.state === 'settled' ? 'Scenario complete' : 'Scenario not complete';
    return respond(200, renderParentPage({ ...common, page: PAGES.continue, status: state }), 'text/html; charset=utf-8', {
      ...pageCsp({}), 'cross-origin-opener-policy': 'same-origin',
    });
  }

  if (parts[0] === 'complete' && parts.length === 2) {
    const t = await tokenFor(config, parts[1], null, now);
    if (!t.ok) return tokenFailure(t.reason);
    const record = await ctx.store.get(t.id);
    if (!record) return json(409, { status: 'pending', reason: 'not_settled' });
    if (record.state === 'revoked') return json(410, { status: 'revoked' });
    if (record.state !== 'settled' || !record.receipt) {
      return json(409, { status: 'pending', state: record.state });
    }
    record.continuation_reached = true;
    let recurUrl = null;
    if (record.mode === 'oracle' && record.scenario === 'recurrence') {
      recurUrl = `${config.origins.parent}/scenario/${record.provider_lane}/${parts[1]}`;
      record.prior_receipts = [...(record.prior_receipts || []), record.receipt];
      record.receipt = null;
      record.state = 'issued';
      record.generation = (record.generation || 0) + 1;
    }
    await ctx.store.put(t.id, record, now);
    return respond(200, renderCompletePage({ recurUrl }), 'text/html; charset=utf-8', {
      ...pageCsp({}), 'cross-origin-opener-policy': 'same-origin',
    });
  }

  return notFound();
}

// ---------------------------------------------------------------- widget origin

const WIDGET_KINDS = { widget: 'frames', resources: 'resources', images: 'images' };

async function widgetRoute(ctx) {
  const { config, url, parts, method, request, now } = ctx;
  if (method !== 'GET' && method !== 'HEAD') return text(405, 'Method not allowed\n', { ...LOCKED(), allow: 'GET, HEAD' });
  const kind = WIDGET_KINDS[parts[0]];
  if (!kind || parts.length < 4) return notFound();

  // 1. lane route exists
  const laneId = config.laneByRoute.get(parts[1]);
  if (!laneId) return notFound();
  const lane = LANES[laneId];
  const rest = parts.slice(3).join('/') + url.search;

  // 2. token valid, unexpired and bound to this lane
  const t = await tokenFor(config, parts[2], laneId, now);
  if (!t.ok) {
    if (!lane.fixture[kind].includes(rest) && rest !== 'puzzle.svg') return notFound();
    return tokenFailure(t.reason);
  }

  const record = await ctx.store.get(t.id);
  const corp = { 'cross-origin-resource-policy': 'same-site' };

  // Oracle interactive widget / puzzle / resource paths.
  if (record && record.mode === 'oracle') {
    const spec = resolveOracleScenario(record.scenario);
    if (!spec) return notFound();
    if (record.state === 'settled' || record.state === 'revoked') {
      if (spec.widget !== 'passive') return json(410, { status: 'closed' });
    }
    if (kind === 'frames') {
      if (rest !== spec.framePath) return notFound();
      if (!fromParent(request, config)) return text(403, 'Forbidden\n');
      const cspKind = spec.widget === 'passive' ? 'widget-frame' : 'oracle-widget-frame';
      return respond(200, renderOracleWidgetFrame({ origins: config.origins, record, token: parts[2] }), 'text/html; charset=utf-8', {
        ...securityHeaders(contentSecurityPolicy(cspKind, { origins: config.origins }), { framable: true }),
      });
    }
    if (kind === 'images') {
      if (rest !== 'puzzle.svg' || !['grid3', 'grid4', 'slider'].includes(record.widget)) return notFound();
      if (!fromParentOrWidget(request, config)) return text(403, 'Forbidden\n');
      return respond(200, renderPuzzleSvg(record.expected), 'image/svg+xml', { ...LOCKED(), ...corp });
    }
    if (kind === 'resources') {
      if (!(spec.resources || []).includes(rest)) return notFound();
      if (!fromParent(request, config)) return text(403, 'Forbidden\n');
      return respond(200, FIXTURE_SCRIPT, 'text/javascript; charset=utf-8', { ...LOCKED(), ...corp });
    }
    return notFound();
  }

  // Legacy 14-lane fixture paths (strict exact match & parent-origin only).
  if (!lane.fixture[kind].includes(rest)) return notFound();
  if (!fromParent(request, config)) return text(403, 'Forbidden\n');
  if (record && (record.state === 'settled' || record.state === 'revoked')) return json(410, { status: 'closed' });

  if (kind === 'frames') {
    return respond(200, TEMPLATES.frame, 'text/html; charset=utf-8', {
      ...securityHeaders(contentSecurityPolicy('widget-frame', { origins: config.origins }), { framable: true }),
    });
  }
  if (kind === 'images') return respond(200, TEMPLATES.image, 'image/svg+xml', { ...LOCKED(), ...corp });
  return respond(200, FIXTURE_SCRIPT, 'text/javascript; charset=utf-8', { ...LOCKED(), ...corp });
}

// ---------------------------------------------------------------- verification origin

function corsFor(request, config) {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  const lowered = origin.toLowerCase();
  if (lowered !== config.origins.parent && lowered !== config.origins.widget) return null;
  return {
    'access-control-allow-origin': lowered,
    'access-control-allow-methods': 'GET, POST',
    'access-control-allow-headers': 'content-type, x-northstar-proof',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

async function readJson(request, { allowEmpty = false } = {}) {
  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0 && allowEmpty) return { value: {} };
  const type = (request.headers.get('content-type') || '').toLowerCase();
  if (!type.startsWith('application/json')) return { error: 'content-type must be application/json' };
  if (buf.byteLength > MAX_BODY) return { error: 'body too large' };
  try { return { value: JSON.parse(new TextDecoder().decode(buf)) }; } catch { return { error: 'invalid JSON' }; }
}

async function publicState(config, record, t) {
  return {
    lane: LANES[t.laneId].code,
    state: record.state,
    steps: record.steps,
    receipt: record.receipt,
    proof: record.state === 'issued' || record.state === 'revoked' ? null : await makeProof(config, t.id, record),
  };
}

const SCENARIO_STEPS = {
  input: { method: 'POST', from: ['issued'], to: 'input' },
  verify: { method: 'POST', from: ['input'], to: 'verified' },
  settle: { method: 'POST', from: ['verified'], to: 'settled' },
  status: { method: 'GET', from: null, to: null },
};

async function authorizeManagement(ctx) {
  const { config, method, request } = ctx;
  // Management is never exposed to browsers (no CORS) and is disabled unless an authority is configured.
  if (!config.managementAuthority) return { ok: false, response: notFound() };
  if (request.headers.get('origin') || method === 'OPTIONS') return { ok: false, response: json(403, { status: 'forbidden' }) };
  const auth = request.headers.get('authorization') || '';
  const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!(await secretEquals(presented, config.managementAuthority))) {
    return { ok: false, response: json(401, { status: 'unauthorized' }, { ...LOCKED(), 'www-authenticate': 'Bearer' }) };
  }
  return { ok: true };
}

async function verifyRoute(ctx) {
  const { config, parts, method, request, now, nowMs } = ctx;
  if (parts[0] !== 'api') return notFound();
  if (parts[1] === 'manage') return manageRoute(ctx);
  if (parts[1] === 'runs' || parts[1] === 'evidence' || parts[1] === 'reset') return oracleManageRoute(ctx);

  const step = SCENARIO_STEPS[parts[1]];
  if (!step || parts.length !== 3) return notFound();
  const cors = corsFor(request, config);
  // Only pages on the configured parent or widget origin may call scenario endpoints.
  if (!cors) return json(403, { status: 'forbidden' });
  const headers = { ...LOCKED(), ...cors };
  if (method === 'OPTIONS') {
    const wanted = (request.headers.get('access-control-request-method') || '').toUpperCase();
    return wanted === step.method ? new Response(null, { status: 204, headers }) : json(403, { status: 'forbidden' }, headers);
  }
  if (method !== step.method && !(step.method === 'GET' && method === 'HEAD')) {
    return json(405, { status: 'method_not_allowed' }, { ...headers, allow: step.method });
  }

  const t = await tokenFor(config, parts[2], null, now);
  if (!t.ok) return tokenFailure(t.reason, headers);
  const record = await recordFor(ctx, t, request.headers.get('x-northstar-proof'));
  if (record.state === 'revoked') return json(410, { status: 'revoked' }, headers);

  if (parts[1] === 'status') return json(200, await publicState(config, record, t), headers);

  // Interactive & spinner oracle handling (strict isTrusted / coordinate / dwell / drag verification).
  if (record.mode === 'oracle') {
    const reqOrigin = (request.headers.get('origin') || '').toLowerCase();
    if (reqOrigin !== config.origins.widget) {
      return json(403, { status: 'forbidden', reason: 'widget_origin_required' }, headers);
    }
    if (parts[1] === 'input') {
      const body = await readJson(request);
      if (body.error) return json(400, { status: 'bad_request', reason: body.error }, headers);
      const outcome = recordOracleInput(record, body.value, nowMs);
      if (outcome.error) return json(outcome.status || 400, { status: 'rejected', reason: outcome.error }, headers);
      await ctx.store.put(t.id, record, now);
      return json(200, outcome.result, headers);
    }
    if (parts[1] === 'verify') {
      const body = await readJson(request, { allowEmpty: true });
      if (body.error) return json(400, { status: 'bad_request', reason: body.error }, headers);
      const outcome = verifyOracleSubmission(record, body.value || {}, nowMs);
      if (outcome.error) return json(outcome.status || 409, { status: 'conflict', reason: outcome.error, state: record.state }, headers);
      await ctx.store.put(t.id, record, now);
      return json(200, outcome.result, headers);
    }
    if (parts[1] === 'settle') {
      if (record.widget === 'spinner') {
        if (record.state !== 'issued') return json(409, { status: 'conflict', state: record.state }, headers);
        if (nowMs - record.created_at_ms < ORACLE_SPINNER_MS) {
          return json(409, { status: 'pending', reason: 'automatic_proof_not_settled', state: record.state }, headers);
        }
        await settleRecord(ctx, record, t);
        return json(200, { ...(await publicState(config, record, t)), accepted: true }, headers);
      }
      if (record.state !== 'verified') return json(409, { status: 'conflict', state: record.state }, headers);
      await settleRecord(ctx, record, t);
      return json(200, { ...(await publicState(config, record, t)), accepted: true }, headers);
    }
  }

  // Legacy 14-lane sequential state machine + stateless signed progress proofs.
  if (!step.from.includes(record.state)) return json(409, { status: 'conflict', state: record.state }, headers);
  if (parts[1] === 'input') {
    const body = await readJson(request);
    if (body.error) return json(400, { status: 'bad_request', reason: body.error }, headers);
    const v = body.value;
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).join() !== 'value' || v.value !== 'acknowledged') {
      return json(400, { status: 'bad_request', reason: 'expected {"value":"acknowledged"}' }, headers);
    }
    record.input = 'acknowledged';
  }
  if (step.to === 'settled') {
    await settleRecord(ctx, record, t);
    return json(200, await publicState(config, record, t), headers);
  }
  record.state = step.to;
  record.steps = { ...record.steps, [step.to]: new Date(nowMs).toISOString() };
  await ctx.store.put(t.id, record, now);
  return json(200, await publicState(config, record, t), headers);
}

async function oracleManageRoute(ctx) {
  const authCheck = await authorizeManagement(ctx);
  if (!authCheck.ok) return authCheck.response;
  const { config, parts, method, request, now, nowMs } = ctx;

  if (parts[1] === 'runs' && parts.length === 2) {
    if (method !== 'POST') return json(405, { status: 'method_not_allowed' }, { ...LOCKED(), allow: 'POST' });
    const body = await readJson(request);
    if (body.error) return json(400, { status: 'bad_request', reason: body.error });
    const payload = body.value || {};
    const spec = resolveOracleScenario(payload.scenario);
    if (!spec) return json(400, { status: 'bad_request', reason: 'unknown scenario' });
    const seed = normalizeSeed(payload.seed);
    if (seed === null) return json(400, { status: 'bad_request', reason: 'seed must be an integer' });
    const ttl = payload.ttl === undefined || payload.ttl === null ? config.tokenTtl : Number(payload.ttl);
    if (!Number.isFinite(ttl) || ttl < 5 || ttl > 86400) {
      return json(400, { status: 'bad_request', reason: 'ttl must be between 5 and 86400 seconds' });
    }
    const lane = LANES[spec.laneId];
    const issued = await issueToken(config, lane.code, { now, ttl: Math.floor(ttl) });
    const record = createOracleRecord(issued, spec, { seed, nowMs });
    await ctx.store.put(issued.id, record, now);
    return json(200, {
      token: issued.token,
      run_id: record.run_id,
      scenario: spec.id,
      provider_lane: spec.route,
      seed,
      expiresAt: issued.expiresAt,
      url: `${config.origins.parent}/scenario/${spec.route}/${issued.token}`,
    });
  }

  if (parts[1] === 'evidence' && parts.length === 3) {
    if (method !== 'GET' && method !== 'HEAD') return json(405, { status: 'method_not_allowed' }, { ...LOCKED(), allow: 'GET, HEAD' });
    const t = await tokenFor(config, parts[2], null, now);
    if (!t.ok) return tokenFailure(t.reason);
    const record = await recordFor(ctx, t);
    return json(200, buildOracleEvidence(record, LANES[t.laneId].route, nowMs));
  }

  if (parts[1] === 'reset' && parts.length === 3) {
    if (method !== 'POST') return json(405, { status: 'method_not_allowed' }, { ...LOCKED(), allow: 'POST' });
    const t = await tokenFor(config, parts[2], null, now);
    if (!t.ok) return tokenFailure(t.reason);
    const oldRecord = await recordFor(ctx, t);
    const previousState = oldRecord.state;
    oldRecord.state = 'revoked';
    oldRecord.steps = { ...oldRecord.steps, revoked: new Date(nowMs).toISOString() };
    await ctx.store.put(t.id, oldRecord, now);
    if (oldRecord.mode === 'oracle') {
      const spec = resolveOracleScenario(oldRecord.scenario);
      if (spec) {
        const remainingTtl = Math.max(5, Math.min(86400, oldRecord.expiresAt - now));
        const issued = await issueToken(config, LANES[spec.laneId].code, { now, ttl: remainingTtl });
        const replacement = createOracleRecord(issued, spec, { seed: oldRecord.seed, nowMs });
        await ctx.store.put(issued.id, replacement, now);
        return json(200, {
          ok: true,
          reset: true,
          previous_state: previousState,
          token: issued.token,
          run_id: replacement.run_id,
          scenario: spec.id,
          url: `${config.origins.parent}/scenario/${spec.route}/${issued.token}`,
        });
      }
    }
    return json(200, { ok: true, reset: true, previous_state: previousState, status: 'revoked' });
  }

  return notFound();
}

async function manageRoute(ctx) {
  const authCheck = await authorizeManagement(ctx);
  if (!authCheck.ok) return authCheck.response;
  const { config, parts, method, request, now, nowMs } = ctx;

  if (parts[2] === 'instances' && parts.length === 3) {
    if (method === 'GET') {
      const rows = (await ctx.store.list()).map(({ id, record }) => ({
        lane: record.code, state: record.state, expiresAt: record.expiresAt, receipt: record.receipt ? record.receipt.receipt : null, instanceRef: id.slice(0, 6),
      }));
      return json(200, { instances: rows });
    }
    if (method === 'POST') {
      const body = await readJson(request);
      if (body.error) return json(400, { status: 'bad_request', reason: body.error });
      const laneId = body.value && config.laneByRoute.get(body.value.lane);
      if (!laneId) return json(400, { status: 'bad_request', reason: 'unknown lane' });
      const issued = await issueToken(config, LANES[laneId].code, { now });
      await ctx.store.put(issued.id, newRecord(issued), now);
      return json(201, { token: issued.token, scenario: `${config.origins.parent}/scenario/${LANES[laneId].route}/${issued.token}`, expiresAt: issued.expiresAt });
    }
    return json(405, { status: 'method_not_allowed' }, { ...LOCKED(), allow: 'GET, POST' });
  }
  if (parts[2] === 'revoke' && parts.length === 4) {
    if (method !== 'POST') return json(405, { status: 'method_not_allowed' }, { ...LOCKED(), allow: 'POST' });
    const t = await tokenFor(config, parts[3], null, now);
    if (!t.ok) return tokenFailure(t.reason);
    const record = await recordFor(ctx, t);
    record.state = 'revoked';
    record.steps = { ...record.steps, revoked: new Date(nowMs).toISOString() };
    await ctx.store.put(t.id, record, now);
    return json(200, { status: 'revoked' });
  }
  return notFound();
}

// ---------------------------------------------------------------- dispatch

async function commonRoute(ctx) {
  const { config, role, url, method } = ctx;
  const path = url.pathname;
  if (!['/healthz', '/readyz', '/fixture-manifest.json', '/robots.txt'].includes(path) && !ASSETS[path]) return null;
  if (method !== 'GET' && method !== 'HEAD') return text(405, 'Method not allowed\n', { ...LOCKED(), allow: 'GET, HEAD' });
  const notReady = Object.keys(LANES).map((id) => [id, laneReadiness(config, id, LANES)]).filter(([, r]) => !r.ready);
  if (path === '/healthz') return json(200, { status: 'ok', role });
  if (path === '/readyz') {
    return notReady.length
      ? json(503, { status: 'not_ready', role, reasons: notReady.map(([, r]) => r.reason) })
      : json(200, { status: 'ready', role });
  }
  if (path === '/fixture-manifest.json') {
    return json(200, {
      name: ROLE_NAMES[role],
      role,
      environment: config.environment,
      build: BUILD.id,
      ready: notReady.length === 0,
      endpoints: ENDPOINTS[role],
      configFingerprint: await configFingerprint(config, LANES),
    });
  }
  if (path === '/robots.txt') return text(200, 'User-agent: *\nDisallow: /\n');
  // Shared static assets: parent pages and widget frames only.
  if (role === 'verify') return notFound();
  return respond(200, ASSETS[path].body, ASSETS[path].type, LOCKED());
}

async function route(request, env, ctx) {
  const config = await configFor(env);
  if (!config.ok) return json(503, { status: 'unavailable' });

  const url = new URL(request.url);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const role = config.hostToRole.get(host);
  // Unknown hosts are refused outright; there is no default/fallback origin.
  if (!role) return json(421, { status: 'unknown_host' });

  const method = request.method.toUpperCase();
  const parts = splitPath(url.pathname);
  if (!parts) return notFound();
  const now = ctx.now ? ctx.now() : nowSeconds();
  const nowMs = ctx.nowMs ? ctx.nowMs() : (ctx.now ? now * 1000 : Date.now());
  const c = { config, role, url, parts, method, request, now, nowMs, store: ctx.store || defaultStore, onEvidence: ctx.onEvidence };

  let res = await commonRoute(c);
  if (!res) {
    if (role === 'parent') res = await parentRoute(c);
    else if (role === 'widget') res = await widgetRoute(c);
    else res = await verifyRoute(c);
  }
  return method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res;
}

export async function handleRequest(request, env, ctx = {}) {
  try {
    return await route(request, env, ctx || {});
  } catch {
    // Never expose stack traces or configuration details.
    return text(500, 'Internal error\n');
  }
}

export { BUILD };
