// Deterministic verification oracle and interactive puzzle generator for Northstar Lab.
// Pure Web Standard JS: zero Node built-ins, zero external URLs, zero logging.
// Faithful port of the controlled gate oracle protocol (isTrusted, coordinates, dwell, drag,
// ordered state transitions issued -> input -> verified -> settled).

import { b64url } from './tokens.js';

export const ORACLE_MAX_ATTEMPTS = 8;
export const ORACLE_MAX_EVENTS = 4096;
export const ORACLE_MIN_HOLD_MS = 4800;
export const ORACLE_SPINNER_MS = 2000;
export const ORACLE_SLIDER_TOLERANCE = 0.035;

const ALLOWED_EVENT_TYPES = new Set(['pointerdown', 'pointerup', 'pointermove', 'click', 'keydown', 'keyup']);
const ALLOWED_TARGETS = new Set(['checkbox', 'hold', 'tile', 'verify', 'slider']);

// Scenario catalog accepting BOTH neutral gate_testing scenario IDs and northstar-lab lane routes.
// Frame/resource paths live strictly under the owned widget origin and carry dual markers so
// classifiers work both with live interstitial_rules packs and built-in neutral defaults.
const BASE_SCENARIOS = {
  clear: {
    id: 'clear', laneId: 'control', route: 'clean-control', surface: 'clear', widget: 'none',
    interactive: false, autoComplete: true, status: 200, headers: {}, resources: [], framePath: null,
  },
  'clean-control': {
    id: 'clean-control', laneId: 'control', route: 'clean-control', surface: 'clear', widget: 'none',
    interactive: false, autoComplete: true, status: 200, headers: {}, resources: [], framePath: null,
  },
  passive: {
    id: 'passive', laneId: 'lane-11', route: 'recaptcha', surface: 'passive_telemetry', widget: 'passive',
    interactive: false, autoComplete: true, status: 200, headers: {}, resources: [],
    framePath: 'fx/recaptcha/api2/anchor/gate-checkbox-b/anchor?size=invisible',
    frameWidth: 200, frameHeight: 60,
  },
  spinner: {
    id: 'spinner', laneId: 'lane-01', route: 'cloudflare', surface: 'js_pow_auto', widget: 'spinner',
    interactive: false, autoComplete: false, status: 403,
    headers: { 'cf-mitigated': 'challenge', 'x-gate-edge-mode': 'verify' },
    resources: ['fx/challenges.cloudflare.com/gate-edge/proof-platform/proof.js'],
    framePath: 'fx/challenges.cloudflare.com/lanes/gate-auto-edge/widget',
  },
  cloudflare: {
    id: 'cloudflare', laneId: 'lane-01', route: 'cloudflare', surface: 'js_pow_auto', widget: 'spinner',
    interactive: false, autoComplete: false, status: 403,
    headers: { 'cf-mitigated': 'challenge', 'x-gate-edge-mode': 'verify' },
    resources: ['fx/challenges.cloudflare.com/gate-edge/proof-platform/proof.js'],
    framePath: 'fx/challenges.cloudflare.com/lanes/gate-auto-edge/widget',
  },
  'gate-auto-edge': {
    id: 'gate-auto-edge', laneId: 'lane-01', route: 'cloudflare', surface: 'js_pow_auto', widget: 'spinner',
    interactive: false, autoComplete: false, status: 403,
    headers: { 'cf-mitigated': 'challenge', 'x-gate-edge-mode': 'verify' },
    resources: ['fx/challenges.cloudflare.com/gate-edge/proof-platform/proof.js'],
    framePath: 'fx/challenges.cloudflare.com/lanes/gate-auto-edge/widget',
  },
  checkbox: {
    id: 'checkbox', laneId: 'lane-11', route: 'recaptcha', surface: 'widget_checkbox', widget: 'checkbox',
    interactive: true, autoComplete: false, status: 200, headers: {},
    resources: ['fx/recaptcha/api.js'],
    framePath: 'fx/recaptcha/api2/anchor/gate-checkbox-b/anchor',
  },
  recaptcha: {
    id: 'recaptcha', laneId: 'lane-11', route: 'recaptcha', surface: 'widget_checkbox', widget: 'checkbox',
    interactive: true, autoComplete: false, status: 200, headers: {},
    resources: ['fx/recaptcha/api.js'],
    framePath: 'fx/recaptcha/api2/anchor/gate-checkbox-b/anchor',
  },
  'gate-checkbox-secondary': {
    id: 'gate-checkbox-secondary', laneId: 'lane-11', route: 'recaptcha', surface: 'widget_checkbox', widget: 'checkbox',
    interactive: true, autoComplete: false, status: 200, headers: {},
    resources: ['fx/recaptcha/api.js'],
    framePath: 'fx/recaptcha/api2/anchor/gate-checkbox-b/anchor',
  },
  hcaptcha: {
    id: 'hcaptcha', laneId: 'lane-10', route: 'hcaptcha', surface: 'widget_checkbox', widget: 'checkbox',
    interactive: true, autoComplete: false, status: 200, headers: {},
    resources: ['fx/hcaptcha.com/1/api.js'],
    framePath: 'fx/hcaptcha.com/captcha/checkbox/lanes/gate-checkbox-primary/widget',
  },
  'gate-checkbox-primary': {
    id: 'gate-checkbox-primary', laneId: 'lane-10', route: 'hcaptcha', surface: 'widget_checkbox', widget: 'checkbox',
    interactive: true, autoComplete: false, status: 200, headers: {},
    resources: ['fx/hcaptcha.com/1/api.js'],
    framePath: 'fx/hcaptcha.com/captcha/checkbox/lanes/gate-checkbox-primary/widget',
  },
  'press-and-hold': {
    id: 'press-and-hold', laneId: 'lane-04', route: 'perimeterx', surface: 'press_and_hold', widget: 'hold',
    interactive: true, autoComplete: false, status: 403, headers: {},
    resources: ['fx/captcha.px-cloud.net/captcha.js'],
    framePath: 'fx/px-cloud.net/challenge/lanes/gate-press-hold/widget',
  },
  perimeterx: {
    id: 'perimeterx', laneId: 'lane-04', route: 'perimeterx', surface: 'press_and_hold', widget: 'hold',
    interactive: true, autoComplete: false, status: 403, headers: {},
    resources: ['fx/captcha.px-cloud.net/captcha.js'],
    framePath: 'fx/px-cloud.net/challenge/lanes/gate-press-hold/widget',
  },
  'gate-press-hold': {
    id: 'gate-press-hold', laneId: 'lane-04', route: 'perimeterx', surface: 'press_and_hold', widget: 'hold',
    interactive: true, autoComplete: false, status: 403, headers: {},
    resources: ['fx/captcha.px-cloud.net/captcha.js'],
    framePath: 'fx/px-cloud.net/challenge/lanes/gate-press-hold/widget',
  },
  'grid-3x3': {
    id: 'grid-3x3', laneId: 'lane-11', route: 'recaptcha', surface: 'visual_puzzle', widget: 'grid3',
    interactive: true, autoComplete: false, status: 200, headers: {},
    resources: ['fx/recaptcha/api.js'],
    framePath: 'fx/recaptcha/api2/bframe/gate-checkbox-b/bframe',
  },
  'grid-4x4': {
    id: 'grid-4x4', laneId: 'lane-11', route: 'recaptcha', surface: 'visual_puzzle', widget: 'grid4',
    interactive: true, autoComplete: false, status: 200, headers: {},
    resources: ['fx/recaptcha/api.js'],
    framePath: 'fx/recaptcha/api2/bframe/gate-checkbox-b/bframe',
  },
  datadome: {
    id: 'datadome', laneId: 'lane-02', route: 'datadome', surface: 'visual_puzzle', widget: 'grid3',
    interactive: true, autoComplete: false, status: 403,
    headers: { 'x-datadome': 'protected', 'x-dd-b': '1' },
    resources: ['fx/captcha-delivery.com/c.js'],
    framePath: 'fx/captcha-delivery.com/captcha/lanes/gate-visual-delivery/widget',
  },
  'gate-visual-delivery': {
    id: 'gate-visual-delivery', laneId: 'lane-02', route: 'datadome', surface: 'visual_puzzle', widget: 'grid3',
    interactive: true, autoComplete: false, status: 403,
    headers: { 'x-datadome': 'protected', 'x-dd-b': '1' },
    resources: ['fx/captcha-delivery.com/c.js'],
    framePath: 'fx/captcha-delivery.com/captcha/lanes/gate-visual-delivery/widget',
  },
  arkose: {
    id: 'arkose', laneId: 'lane-08', route: 'arkose', surface: 'visual_puzzle', widget: 'grid3',
    interactive: true, autoComplete: false, status: 200, headers: {},
    resources: ['fx/arkoselabs.com/v2/api.js'],
    framePath: 'fx/arkoselabs.com/fc/gc/lanes/gate-puzzle-box/widget',
  },
  'gate-puzzle-box': {
    id: 'gate-puzzle-box', laneId: 'lane-08', route: 'arkose', surface: 'visual_puzzle', widget: 'grid3',
    interactive: true, autoComplete: false, status: 200, headers: {},
    resources: ['fx/arkoselabs.com/v2/api.js'],
    framePath: 'fx/arkoselabs.com/fc/gc/lanes/gate-puzzle-box/widget',
  },
  'aws-waf-captcha': {
    id: 'aws-waf-captcha', laneId: 'lane-12', route: 'aws-waf-captcha', surface: 'visual_puzzle', widget: 'grid3',
    interactive: true, autoComplete: false, status: 405,
    headers: { 'x-amzn-waf-action': 'captcha' },
    resources: ['fx/captcha.awswaf.com/jsapi.js'],
    framePath: 'fx/awswaf.com/captcha/puzzle/lanes/gate-waf-auto/widget',
  },
  'gate-waf-visual': {
    id: 'gate-waf-visual', laneId: 'lane-12', route: 'aws-waf-captcha', surface: 'visual_puzzle', widget: 'grid3',
    interactive: true, autoComplete: false, status: 405,
    headers: { 'x-amzn-waf-action': 'captcha' },
    resources: ['fx/captcha.awswaf.com/jsapi.js'],
    framePath: 'fx/awswaf.com/captcha/puzzle/lanes/gate-waf-auto/widget',
  },
  slider: {
    id: 'slider', laneId: 'lane-09', route: 'geetest', surface: 'visual_puzzle', widget: 'slider',
    interactive: true, autoComplete: false, status: 200, headers: {},
    resources: ['fx/gcaptcha4.geetest.com/load.js'],
    framePath: 'fx/geetest.com/captcha/lanes/gate-slider-widget/widget',
  },
  geetest: {
    id: 'geetest', laneId: 'lane-09', route: 'geetest', surface: 'visual_puzzle', widget: 'slider',
    interactive: true, autoComplete: false, status: 200, headers: {},
    resources: ['fx/gcaptcha4.geetest.com/load.js'],
    framePath: 'fx/geetest.com/captcha/lanes/gate-slider-widget/widget',
  },
  'gate-slider-widget': {
    id: 'gate-slider-widget', laneId: 'lane-09', route: 'geetest', surface: 'visual_puzzle', widget: 'slider',
    interactive: true, autoComplete: false, status: 200, headers: {},
    resources: ['fx/gcaptcha4.geetest.com/load.js'],
    framePath: 'fx/geetest.com/captcha/lanes/gate-slider-widget/widget',
  },
  'aws-waf': {
    id: 'aws-waf', laneId: 'lane-03', route: 'aws-waf', surface: 'js_pow_auto', widget: 'spinner',
    interactive: false, autoComplete: false, status: 202,
    headers: { 'x-amzn-waf-action': 'challenge' },
    resources: ['fx/awswaf.com/challenge.js'],
    framePath: 'fx/awswaf.com/captcha/lanes/gate-waf-auto/widget',
  },
  'gate-waf-auto': {
    id: 'gate-waf-auto', laneId: 'lane-03', route: 'aws-waf', surface: 'js_pow_auto', widget: 'spinner',
    interactive: false, autoComplete: false, status: 202,
    headers: { 'x-amzn-waf-action': 'challenge' },
    resources: ['fx/awswaf.com/challenge.js'],
    framePath: 'fx/awswaf.com/captcha/lanes/gate-waf-auto/widget',
  },
  kasada: {
    id: 'kasada', laneId: 'lane-06', route: 'kasada', surface: 'js_pow_auto', widget: 'spinner',
    interactive: false, autoComplete: false, status: 429,
    headers: { 'x-kpsdk-ct': 'northstar-fixture', 'x-kpsdk-cd': 'northstar-fixture' },
    resources: ['fx/kpsdk/ips.js'],
    framePath: 'fx/kpsdk/lanes/gate-sdk-auto/widget',
  },
  'gate-sdk-auto': {
    id: 'gate-sdk-auto', laneId: 'lane-06', route: 'kasada', surface: 'js_pow_auto', widget: 'spinner',
    interactive: false, autoComplete: false, status: 429,
    headers: { 'x-kpsdk-ct': 'northstar-fixture', 'x-kpsdk-cd': 'northstar-fixture' },
    resources: ['fx/kpsdk/ips.js'],
    framePath: 'fx/kpsdk/lanes/gate-sdk-auto/widget',
  },
  imperva: {
    id: 'imperva', laneId: 'lane-07', route: 'imperva', surface: 'js_pow_auto', widget: 'spinner',
    interactive: false, autoComplete: false, status: 403,
    headers: { 'x-iinfo': 'northstar-fixture' },
    resources: ['_incapsula_resource?swjiylwa=northstar'],
    framePath: '_incapsula_resource/frame/lanes/gate-resource-auto/widget',
  },
  'gate-resource-auto': {
    id: 'gate-resource-auto', laneId: 'lane-07', route: 'imperva', surface: 'js_pow_auto', widget: 'spinner',
    interactive: false, autoComplete: false, status: 403,
    headers: { 'x-iinfo': 'northstar-fixture' },
    resources: ['_incapsula_resource?swjiylwa=northstar'],
    framePath: '_incapsula_resource/frame/lanes/gate-resource-auto/widget',
  },
  'rate-limit': {
    id: 'rate-limit', laneId: 'lane-01', route: 'cloudflare', surface: 'rate_limit', widget: 'none',
    interactive: false, autoComplete: false, status: 429,
    headers: { 'cf-mitigated': 'challenge', 'x-gate-edge-mode': 'verify', 'retry-after': '5' },
    resources: [], framePath: null, pageText: 'Too many requests',
  },
  'hard-block': {
    id: 'hard-block', laneId: 'lane-05', route: 'akamai', surface: 'hard_block', widget: 'none',
    interactive: false, autoComplete: false, status: 403,
    headers: { server: 'akamaighost', 'akamai-grn': '0.northstar.fixture', 'x-gate-block-server': 'edge-deny' },
    resources: ['_sec/cp_challenge/fixture.js'], framePath: null, pageText: 'Access denied',
  },
  akamai: {
    id: 'akamai', laneId: 'lane-05', route: 'akamai', surface: 'hard_block', widget: 'none',
    interactive: false, autoComplete: false, status: 403,
    headers: { server: 'akamaighost', 'akamai-grn': '0.northstar.fixture', 'x-gate-block-server': 'edge-deny' },
    resources: ['_sec/cp_challenge/fixture.js'], framePath: null, pageText: 'Access denied',
  },
  'gate-hard-block': {
    id: 'gate-hard-block', laneId: 'lane-05', route: 'akamai', surface: 'hard_block', widget: 'none',
    interactive: false, autoComplete: false, status: 403,
    headers: { server: 'akamaighost', 'akamai-grn': '0.northstar.fixture', 'x-gate-block-server': 'edge-deny' },
    resources: ['_sec/cp_challenge/fixture.js'], framePath: null, pageText: 'Access denied',
  },
  'youtube-account-gate': {
    id: 'youtube-account-gate', laneId: 'lane-13', route: 'youtube-account-gate', surface: 'account_readiness', widget: 'none',
    interactive: false, autoComplete: false, status: 200, headers: {}, resources: [], framePath: null,
    pageText: "Sign in to confirm you're not a bot",
  },
  'account-readiness-gate': {
    id: 'account-readiness-gate', laneId: 'lane-13', route: 'youtube-account-gate', surface: 'account_readiness', widget: 'none',
    interactive: false, autoComplete: false, status: 200, headers: {}, resources: [], framePath: null,
    pageText: "Sign in to confirm you're not a bot",
  },
};

const FAULT_CHECKBOX_SCENARIOS = [
  'recurrence', 'wrong-answer', 'provider-timeout', 'frame-disappears', 'browser-closes',
  'frame-reload', 'parent-navigation', 'session-cancelled', 'provider-error',
  'malformed-response', 'missing-credential', 'call-budget', 'token-budget',
  'retry-cooldown', 'stale-frame',
];

export const ORACLE_SCENARIOS = {
  ...BASE_SCENARIOS,
  ...Object.fromEntries(
    FAULT_CHECKBOX_SCENARIOS.map((id) => [
      id,
      { ...BASE_SCENARIOS.checkbox, id, recurrence: id === 'recurrence' },
    ]),
  ),
};

export function resolveOracleScenario(name) {
  if (typeof name !== 'string') return null;
  const key = name.trim().toLowerCase();
  return ORACLE_SCENARIOS[key] || null;
}

/** Deterministic PRNG (mulberry32) so seeded grid/slider puzzles reproduce identically. */
function mulberry32(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normalizeSeed(rawSeed) {
  if (rawSeed === undefined || rawSeed === null) {
    const bytes = globalThis.crypto.getRandomValues(new Uint32Array(1));
    return bytes[0] & 0x7fffffff;
  }
  const n = Number(rawSeed);
  if (!Number.isInteger(n) || !Number.isFinite(n)) return null;
  return Math.abs(n) % 2147483647;
}

export function buildExpected(widget, seed) {
  const rng = mulberry32(seed);
  if (widget === 'grid3' || widget === 'grid4') {
    const size = widget === 'grid4' ? 4 : 3;
    const total = size * size;
    const maxCount = Math.min(5, total - 1);
    const count = 2 + Math.floor(rng() * (maxCount - 2 + 1));
    const pool = Array.from({ length: total }, (_, i) => i);
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }
    return { size, cells: pool.slice(0, count).sort((a, b) => a - b) };
  }
  if (widget === 'slider') {
    return { target: 0.52 + rng() * (0.85 - 0.52), tolerance: ORACLE_SLIDER_TOLERANCE };
  }
  if (widget === 'hold') {
    return { minimum_hold_ms: ORACLE_MIN_HOLD_MS };
  }
  return {};
}

export function createOracleRecord(tokenObj, spec, { seed, nowMs }) {
  const runId = b64url(globalThis.crypto.getRandomValues(new Uint8Array(12)));
  return {
    mode: 'oracle',
    code: tokenObj.code,
    run_id: runId,
    scenario: spec.id,
    laneId: spec.laneId,
    provider_lane: spec.route,
    widget: spec.widget,
    surface: spec.surface,
    interactive: spec.interactive,
    seed,
    expected: buildExpected(spec.widget, seed),
    created_at_ms: nowMs,
    expiresAt: tokenObj.expiresAt,
    state: 'issued',
    steps: { issued: new Date(nowMs).toISOString() },
    input: null,
    events: [],
    attempts: 0,
    generation: 0,
    verification: null,
    settlement: null,
    receipt: null,
    prior_receipts: [],
    continuation_reached: false,
  };
}

export function recordOracleInput(record, event, nowMs) {
  if (!record || record.mode !== 'oracle') return { error: 'Not an oracle instance', status: 409 };
  if (record.state !== 'issued' && record.state !== 'input') {
    return { error: 'Run is terminal; input refused', status: 409 };
  }
  if (record.events.length >= ORACLE_MAX_EVENTS) {
    return { error: 'Input evidence limit exceeded', status: 409 };
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { error: 'Object required', status: 400 };
  }
  if (!ALLOWED_EVENT_TYPES.has(event.type)) {
    return { error: 'Unsupported input event', status: 400 };
  }
  const numericFields = ['x', 'y', 'widget_width', 'widget_height', 'frame_width', 'frame_height', 'client_ms'];
  for (const key of numericFields) {
    const val = event[key];
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      return { error: `Input geometry ${key} must be finite`, status: 400 };
    }
  }
  for (const key of ['widget_width', 'widget_height', 'frame_width', 'frame_height']) {
    if (event[key] <= 0 || event[key] > 16384) {
      return { error: `Invalid input dimension ${key}`, status: 400 };
    }
  }
  if (!ALLOWED_TARGETS.has(event.target)) {
    return { error: 'Unknown input target', status: 400 };
  }
  const cell = event.cell === undefined ? null : event.cell;
  if (cell !== null && (!Number.isInteger(cell) || cell < 0 || cell >= 16)) {
    return { error: 'Invalid tile', status: 400 };
  }
  const pointerId = event.pointer_id;
  if (!Number.isInteger(pointerId)) {
    return { error: 'Invalid pointer_id', status: 400 };
  }
  const keyVal = event.key === undefined ? null : event.key;
  if (keyVal !== null && (typeof keyVal !== 'string' || keyVal.length > 32)) {
    return { error: 'Invalid key', status: 400 };
  }
  const trusted = event.trusted === true;
  const stateBefore = record.state;
  if (record.state === 'issued') {
    record.state = 'input';
    record.steps = { ...record.steps, input: new Date(nowMs).toISOString() };
  }
  const entry = {
    type: event.type,
    trusted,
    x: event.x,
    y: event.y,
    cell,
    target: event.target,
    key: keyVal,
    pointer_id: pointerId,
    widget_width: event.widget_width,
    widget_height: event.widget_height,
    frame_width: event.frame_width,
    frame_height: event.frame_height,
    client_ms: event.client_ms,
    sequence: record.events.length,
    received_at: nowMs / 1000,
    state_before: stateBefore,
    state_after: record.state,
    generation: record.generation,
  };
  record.events.push(entry);
  return { ok: true, result: { sequence: entry.sequence, accepted: trusted, state: record.state } };
}

export function findTrustedGesture(record, target, cell = null) {
  const events = (record.events || []).filter((e) => e.generation === record.generation);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const up = events[i];
    if (up.type !== 'pointerup' || up.target !== target || up.trusted !== true) continue;
    if (cell !== null && up.cell !== cell) continue;
    for (let j = i - 1; j >= 0; j -= 1) {
      const down = events[j];
      if (down.pointer_id !== up.pointer_id) continue;
      if (down.type === 'pointerup') break;
      if (down.type === 'pointerdown') {
        if (down.trusted === true && down.target === target && (cell === null || down.cell === cell)) {
          return { down, up, slice: events.slice(j, i + 1) };
        }
        break;
      }
    }
  }
  return null;
}

export function verifyOracleSubmission(record, submission, nowMs) {
  if (!record || record.mode !== 'oracle') return { error: 'Not an oracle instance', status: 409 };
  if (record.state !== 'issued' && record.state !== 'input') {
    return { error: 'Run is not verifiable in current state', status: 409 };
  }
  if (record.attempts >= ORACLE_MAX_ATTEMPTS) {
    record.state = 'blocked';
    return { ok: true, accepted: false, result: { accepted: false, state: 'blocked', attempts: record.attempts } };
  }
  record.attempts += 1;
  const widget = record.widget;
  let passed = false;
  let reason = 'verification_failed';

  if (widget === 'checkbox') {
    passed = findTrustedGesture(record, 'checkbox') !== null;
    reason = passed ? 'ok' : 'missing_trusted_checkbox_gesture';
  } else if (widget === 'hold') {
    const gesture = findTrustedGesture(record, 'hold');
    if (gesture) {
      const elapsedMs = (gesture.up.received_at - gesture.down.received_at) * 1000;
      passed = elapsedMs >= record.expected.minimum_hold_ms;
      reason = passed ? 'ok' : `hold_too_short_${Math.round(elapsedMs)}ms`;
    } else {
      reason = 'missing_trusted_hold_gesture';
    }
  } else if (widget === 'grid3' || widget === 'grid4') {
    const chosen = submission && Array.isArray(submission.cells) ? submission.cells : null;
    const valid = Boolean(chosen) && chosen.every((c) => Number.isInteger(c));
    const unique = valid ? [...new Set(chosen)].sort((a, b) => a - b) : [];
    const expected = record.expected.cells || [];
    const exactMatch = valid
      && chosen.length === unique.length
      && unique.length === expected.length
      && unique.every((v, idx) => v === expected[idx]);
    const verifyGesture = findTrustedGesture(record, 'verify') !== null;
    const allTilesTrusted = exactMatch && chosen.every((c) => findTrustedGesture(record, 'tile', c) !== null);
    passed = Boolean(exactMatch && verifyGesture && allTilesTrusted);
    reason = passed ? 'ok' : (!exactMatch ? 'wrong_tiles' : (!verifyGesture ? 'missing_trusted_verify' : 'untrusted_tile_click'));
  } else if (widget === 'slider') {
    const gesture = findTrustedGesture(record, 'slider');
    if (gesture) {
      const delta = Math.abs(gesture.up.x - record.expected.target);
      const startedLeft = gesture.down.x < 0.2;
      const hasTrustedMove = gesture.slice.some((e) => e.type === 'pointermove' && e.trusted === true);
      passed = delta <= record.expected.tolerance && startedLeft && hasTrustedMove;
      reason = passed ? 'ok' : 'slider_geometry_mismatch';
    } else {
      reason = 'missing_trusted_slider_gesture';
    }
  } else {
    reason = 'unsupported_widget_for_verify';
  }

  record.verification = {
    accepted: passed,
    attempts: record.attempts,
    reason,
    at: new Date(nowMs).toISOString(),
  };

  if (!passed) {
    return {
      ok: true,
      accepted: false,
      result: { accepted: false, state: record.state, attempts: record.attempts, reason },
    };
  }

  record.state = 'verified';
  record.steps = { ...record.steps, verified: new Date(nowMs).toISOString() };
  return {
    ok: true,
    accepted: true,
    result: { accepted: true, state: record.state, attempts: record.attempts },
  };
}

export function renderPuzzleSvg(expected) {
  const parts = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 480" width="480" height="480">',
    '<rect width="480" height="480" fill="#eeeeee"/>',
  ];
  if (expected && Array.isArray(expected.cells)) {
    const size = expected.size || 3;
    const step = 480 / size;
    const targetSet = new Set(expected.cells);
    for (let cell = 0; cell < size * size; cell += 1) {
      const x = (cell % size) * step;
      const y = Math.floor(cell / size) * step;
      parts.push(`<rect x="${x + 2}" y="${y + 2}" width="${step - 4}" height="${step - 4}" fill="#ffffff" stroke="#aaaaaa" stroke-width="2"/>`);
      if (targetSet.has(cell)) {
        const p1 = `${x + step / 2},${y + 25}`;
        const p2 = `${x + 25},${y + step - 25}`;
        const p3 = `${x + step - 25},${y + step - 25}`;
        parts.push(`<polygon points="${p1} ${p2} ${p3}" fill="rgb(30,100,220)"/>`);
      } else {
        const cx = x + step / 2;
        const cy = y + step / 2;
        const r = step / 2 - 30;
        parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="rgb(180,70,70)"/>`);
      }
    }
  } else {
    const target = expected && typeof expected.target === 'number' ? expected.target : 0.7;
    const x = Math.round(target * 480);
    parts.push('<rect x="0" y="0" width="480" height="480" fill="#ffffff"/>');
    parts.push('<rect x="0" y="210" width="480" height="60" fill="#dddddd"/>');
    parts.push(`<rect x="${x - 10}" y="215" width="20" height="50" fill="rgb(40,180,90)"/>`);
  }
  parts.push('</svg>');
  return parts.join('');
}

export function computeIsTrusted(record) {
  if (!record || record.mode !== 'oracle') return false;
  if (!record.interactive) return true;
  const pointerEvents = (record.events || []).filter((e) => e.type === 'pointerdown' || e.type === 'pointerup');
  if (!pointerEvents.length) return false;
  return pointerEvents.every((e) => e.trusted === true);
}

export function buildOracleEvidence(record, laneRoute, nowMs) {
  const completed = record.state === 'settled';
  const createdMs = typeof record.created_at_ms === 'number' ? record.created_at_ms : nowMs;
  const settledAt = record.settlement && record.settlement.at ? Date.parse(record.settlement.at) : null;
  const elapsedMs = Math.max(0, Math.round((settledAt || nowMs) - createdMs));
  return {
    version: 1,
    synthetic_fixture: true,
    run_id: record.run_id || null,
    scenario: record.scenario || laneRoute,
    provider_lane: record.provider_lane || laneRoute,
    seed: typeof record.seed === 'number' ? record.seed : 0,
    created_at: createdMs / 1000,
    expires_at: record.expiresAt,
    state: record.state,
    completed,
    is_trusted: computeIsTrusted(record),
    attempts: record.attempts || 0,
    input_events: Array.isArray(record.events) ? record.events : [],
    verification: record.verification || { accepted: record.state === 'verified' || record.state === 'settled', attempts: record.attempts || 0 },
    settlement: record.settlement || (record.receipt ? { settled: true, receipt: record.receipt, at: record.steps?.settled || null } : { settled: false }),
    completion_receipt: record.receipt || null,
    superseded_receipts: Array.isArray(record.prior_receipts) ? record.prior_receipts : [],
    continuation_reached: Boolean(record.continuation_reached),
    elapsed_ms: elapsedMs,
  };
}
