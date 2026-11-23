// Faithful JavaScript port of the application's challenge classifier, used ONLY by setup tests:
//   src/challenges/signatures.py      SIGNATURES (order matters: the first match wins)
//   src/challenges/classifier.py      ChallengeClassifier.classify
//   src/challenges/network_tap.py     ChallengeNetworkTap.record (lowercasing), proxy_transport_marker
// Keep this file in lock-step with those modules. Vendor/surface names are the enum member names.

export const SIGNATURES = [
  { vendor: 'CLOUDFLARE', surface: 'JS_POW_AUTO', headers: [['cf-mitigated', 'challenge']], urls: ['/cdn-cgi/challenge-platform'], frames: ['challenges.cloudflare.com'], statuses: [403, 503] },
  { vendor: 'DATADOME', surface: 'VISUAL_PUZZLE', headers: [['x-datadome', ''], ['x-dd-b', '']], urls: ['captcha-delivery.com'], frames: ['captcha-delivery.com'], statuses: [403] },
  { vendor: 'AWS_WAF', surface: 'JS_POW_AUTO', headers: [['x-amzn-waf-action', '']], urls: ['awswaf.com'], frames: ['awswaf.com'], statuses: [202, 405] },
  { vendor: 'PERIMETERX', surface: 'PRESS_AND_HOLD', headers: [], urls: ['captcha.px-cloud.net'], frames: ['perimeterx', 'px-cloud.net'], statuses: [403] },
  { vendor: 'AKAMAI', surface: 'HARD_BLOCK', headers: [['server', 'akamaighost'], ['akamai-grn', '']], urls: ['/_sec/cp_challenge'], frames: [], statuses: [403] },
  { vendor: 'KASADA', surface: 'JS_POW_AUTO', headers: [['x-kpsdk-ct', ''], ['x-kpsdk-cd', '']], urls: ['ips.js'], frames: [], statuses: [429] },
  { vendor: 'IMPERVA', surface: 'JS_POW_AUTO', headers: [['x-iinfo', '']], urls: ['/_incapsula_resource'], frames: ['_incapsula_resource'], statuses: [200, 403] },
  { vendor: 'ARKOSE', surface: 'VISUAL_PUZZLE', headers: [], urls: ['arkoselabs.com', 'funcaptcha.com'], frames: ['arkoselabs.com', 'funcaptcha.com'], statuses: [] },
  { vendor: 'GEETEST', surface: 'VISUAL_PUZZLE', headers: [], urls: ['gcaptcha4.geetest.com', 'api.geetest.com'], frames: ['geetest.com'], statuses: [] },
  { vendor: 'HCAPTCHA', surface: 'WIDGET_CHECKBOX', headers: [], urls: ['hcaptcha.com/1/api.js'], frames: ['hcaptcha.com'], statuses: [] },
  { vendor: 'RECAPTCHA', surface: 'WIDGET_CHECKBOX', headers: [], urls: ['/recaptcha/'], frames: ['recaptcha/api2', 'recaptcha/enterprise'], statuses: [] },
];

const VISUAL = new Set(['WIDGET_CHECKBOX', 'PRESS_AND_HOLD', 'VISUAL_PUZZLE']);

/** network_tap.ChallengeNetworkTap.record: header names and values lowercased. */
export function responseSignal({ url, status, headers = {}, resourceType = '' }) {
  return {
    url: String(url || ''), status: Number(status || 0), resourceType,
    headers: Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [String(k).toLowerCase(), String(v).toLowerCase()])),
  };
}

const matchesHeaders = (sig, headers) => sig.headers.some(([name, value]) => Object.hasOwn(headers || {}, name) && headers[name].includes(value));
const contains = (values, marker) => values.some((v) => String(v).toLowerCase().includes(marker.toLowerCase()));

function verdict(vendor, surface, url, status, signals, attribution, frameBox = null) {
  return { vendor, surface, challenge: true, visual: VISUAL.has(surface), attribution, url, status, frameBox, signals };
}

/**
 * ChallengeClassifier.classify
 * @param {{url: string, response?: object, networkEvents?: object[], frames?: {url: string, visible?: boolean, box?: number[]|null}[], pageText?: string}} input
 */
export function classify({ url, response = null, networkEvents = [], frames = [], pageText = '' }) {
  const events = [...networkEvents, ...(response ? [response] : [])];
  const resourceUrls = [...events.map((e) => e.url), ...frames.map((f) => f.url)];
  const loweredUrl = String(url || '').toLowerCase();
  const status = response ? response.status : null;
  const headers = response ? response.headers : {};
  const text = String(pageText || '').toLowerCase();

  if (loweredUrl.includes('chrome-error://') && ['http error 407', 'http error 502'].some((t) => text.includes(t))) {
    return verdict('PROXY_GATEWAY', 'PROXY_GATEWAY_ERROR', url, status, ['chrome_error'], 'EXIT_PROXY');
  }
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* urlsplit gives '' */ }
  if (loweredUrl.includes('/sorry/index') && (host === 'google.com' || host.startsWith('google.') || host.startsWith('www.google.'))) {
    return verdict('GOOGLE_SORRY', 'RATE_LIMIT', url, status, ['google_sorry_url'], 'TRANSIENT_THROTTLE');
  }
  if (text.includes("sign in to confirm you're not a bot") || text.includes('please sign in to continue')) {
    return verdict('YOUTUBE_BOT_GATE', 'ACCOUNT_MATURATION_GATE', url, status, ['youtube_maturation_gate'], 'MATURATION_ONLY');
  }

  for (const sig of SIGNATURES) {
    const headerMatch = matchesHeaders(sig, headers) || events.some((e) => matchesHeaders(sig, e.headers));
    const urlMatch = sig.urls.some((m) => contains(resourceUrls, m));
    const matchingFrames = frames.filter((f) => sig.frames.some((m) => f.url.toLowerCase().includes(m)));
    const frameMatch = matchingFrames.length > 0;
    if (!(headerMatch || urlMatch || frameMatch)) continue;
    let surface = sig.surface;
    const signals = [];
    if (headerMatch) signals.push('response_header');
    if (urlMatch) signals.push('resource_url');
    if (frameMatch) signals.push('cdp_frame');
    const frameBox = matchingFrames.find((f) => f.visible && f.box)?.box || null;

    if (sig.vendor === 'RECAPTCHA' && frameMatch) {
      const visibleChallenge = matchingFrames.some((f) => f.url.toLowerCase().includes('/bframe') && f.visible && (!f.box || (f.box[2] >= 250 && f.box[3] >= 200)));
      const passiveAnchor = matchingFrames.every((f) => f.url.toLowerCase().includes('/anchor') && (f.url.toLowerCase().includes('size=invisible') || !f.box || f.box[2] <= 260));
      if (passiveAnchor && !visibleChallenge) {
        return { vendor: sig.vendor, surface: 'PASSIVE_TELEMETRY', challenge: false, visual: false, attribution: 'NONE', url, status, frameBox, signals, summary: 'Passive reCAPTCHA badge ignored.' };
      }
      if (visibleChallenge) surface = 'VISUAL_PUZZLE';
    }
    if (sig.vendor === 'CLOUDFLARE' && status === 429) surface = 'RATE_LIMIT';
    if (sig.vendor === 'AWS_WAF' && headers['x-amzn-waf-action'] === 'captcha') surface = 'VISUAL_PUZZLE';
    const attribution = surface === 'RATE_LIMIT' ? 'TRANSIENT_THROTTLE' : 'FORENSIC_CHALLENGE';
    return verdict(sig.vendor, surface, url, status, signals, attribution, frameBox);
  }
  return { vendor: null, surface: null, challenge: false, visual: false, url, status };
}

/** network_tap.proxy_transport_marker */
export function proxyTransportMarker({ url = '', pageText = '', errorText = '', allowIplock502 = false }) {
  const evidence = [url, pageText, errorText].join(' ').toLowerCase();
  if (evidence.includes('http error 407') || evidence.includes('err_proxy_connection_failed') || evidence.includes('err_tunnel_connection_failed')) return 'proxy_gateway_407';
  if (allowIplock502 && evidence.includes('http error 502')) return 'proxy_gateway_iplock_502';
  if (evidence.includes('err_socks')) return 'proxy_gateway_socks';
  return null;
}

/**
 * Diagnostic (not part of the application): EVERY signature that would match, not just the
 * first. Lets tests prove a lane matches exactly one vendor, so ordering never hides a leak.
 */
export function allMatchingVendors({ response = null, networkEvents = [], frames = [] }) {
  const events = [...networkEvents, ...(response ? [response] : [])];
  const resourceUrls = [...events.map((e) => e.url), ...frames.map((f) => f.url)];
  return SIGNATURES.filter((sig) => matchesHeaders(sig, response ? response.headers : {})
    || events.some((e) => matchesHeaders(sig, e.headers))
    || sig.urls.some((m) => contains(resourceUrls, m))
    || frames.some((f) => sig.frames.some((m) => f.url.toLowerCase().includes(m)))).map((s) => s.vendor);
}
