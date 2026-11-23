// JavaScript mirror of the application's ChallengeSignature registry
// (src/challenges/signatures). Used ONLY by setup tests to prove each lane exposes
// exactly its own characteristics. If the application registry changes, update this.
//
// Assumptions (to confirm against the application's detector):
//  - header names are compared lowercased; header values are compared lowercased;
//  - URL markers are checked against every request URL seen by the page (document + sub-resources);
//  - frame markers are checked against every frame URL;
//  - statuses are a supporting signal (recorded, not required for a marker hit).
export const SIGNATURES = [
  { vendor: 'cloudflare', headers: [['cf-mitigated', 'challenge']], urls: ['/cdn-cgi/challenge-platform'], frames: ['challenges.cloudflare.com'], statuses: [403, 503] },
  { vendor: 'datadome', headers: [['x-datadome', ''], ['x-dd-b', '']], urls: ['captcha-delivery.com'], frames: ['captcha-delivery.com'], statuses: [403] },
  { vendor: 'aws_waf', headers: [['x-amzn-waf-action', '']], urls: ['awswaf.com'], frames: ['awswaf.com'], statuses: [202, 405] },
  { vendor: 'perimeterx', headers: [], urls: ['captcha.px-cloud.net'], frames: ['perimeterx', 'px-cloud.net'], statuses: [403] },
  { vendor: 'akamai', headers: [['server', 'akamaighost'], ['akamai-grn', '']], urls: ['/_sec/cp_challenge'], frames: [], statuses: [403] },
  { vendor: 'kasada', headers: [['x-kpsdk-ct', ''], ['x-kpsdk-cd', '']], urls: ['ips.js'], frames: [], statuses: [429] },
  { vendor: 'imperva', headers: [['x-iinfo', '']], urls: ['/_incapsula_resource'], frames: ['_incapsula_resource'], statuses: [200, 403] },
  { vendor: 'arkose', headers: [], urls: ['arkoselabs.com', 'funcaptcha.com'], frames: ['arkoselabs.com', 'funcaptcha.com'], statuses: [] },
  { vendor: 'geetest', headers: [], urls: ['gcaptcha4.geetest.com', 'api.geetest.com'], frames: ['geetest.com'], statuses: [] },
  { vendor: 'hcaptcha', headers: [], urls: ['hcaptcha.com/1/api.js'], frames: ['hcaptcha.com'], statuses: [] },
  { vendor: 'recaptcha', headers: [], urls: ['/recaptcha/'], frames: ['recaptcha/api2', 'recaptcha/enterprise'], statuses: [] },
];

/**
 * @param {{status?: number, headers?: Record<string,string>, urls?: string[], frames?: string[]}} obs
 * @returns {{vendor: string, via: string[], statusMatch: boolean|null}[]}
 */
export function matchObservation(obs) {
  const headers = Object.fromEntries(Object.entries(obs.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v).toLowerCase()]));
  const urls = (obs.urls || []).map((u) => u.toLowerCase());
  const frames = (obs.frames || []).map((u) => u.toLowerCase());
  const hits = [];
  for (const sig of SIGNATURES) {
    const via = [];
    for (const [name, value] of sig.headers) if (name in headers && headers[name].includes(value)) via.push(`header:${name}`);
    for (const m of sig.urls) if (urls.some((u) => u.includes(m))) via.push(`url:${m}`);
    for (const m of sig.frames) if (frames.some((u) => u.includes(m))) via.push(`frame:${m}`);
    if (via.length) hits.push({ vendor: sig.vendor, via, statusMatch: sig.statuses.length ? sig.statuses.includes(obs.status) : null });
  }
  return hits;
}
