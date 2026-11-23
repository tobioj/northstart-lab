// JavaScript mirror of the application's special-condition checks, as ASSUMED by this lab
// (the application code was not available here). Used ONLY by setup tests to prove the
// fixtures carry the inputs those checks need. Confirm against the real classifier.
//   google_sorry      host is a Google domain AND path starts with /sorry/ (status 429 supports)
//   proxy_transport   Chromium error document chrome-error://chromewebdata/ with a proxy/tunnel net error
//   youtube_gate      page text contains the account-confirmation sentence
const PROXY_ERRORS = new Set([
  'net::ERR_TUNNEL_CONNECTION_FAILED', 'net::ERR_PROXY_CONNECTION_FAILED',
  'net::ERR_HTTP_RESPONSE_CODE_FAILURE', 'net::ERR_INVALID_AUTH_CREDENTIALS', 'net::ERR_PROXY_AUTH_UNSUPPORTED',
]);

export function classifySpecial({ url = '', status = null, text = '', errorPageUrl = null, netError = null } = {}) {
  const hits = [];
  let u = null;
  try { u = new URL(url); } catch { /* not a URL */ }
  if (u && /(^|\.)google\.[a-z.]+$/i.test(u.hostname) && u.pathname.startsWith('/sorry/')) hits.push({ kind: 'google_sorry', statusMatch: status === 429 });
  if (errorPageUrl === 'chrome-error://chromewebdata/' && PROXY_ERRORS.has(netError)) hits.push({ kind: 'proxy_transport' });
  if (/confirm you(?:'|’)re not a bot/i.test(text)) hits.push({ kind: 'youtube_gate' });
  return hits;
}
