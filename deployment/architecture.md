# Northstar Lab: three-origin architecture

Only **three DNS hostnames** exist. Each one is a *role*, not a provider:

| Role | Deployed hostname | Local equivalent | Responsibility |
|---|---|---|---|
| Parent | `northstar-parent.<ROOT_DOMAIN>` | `parent.challenge.localhost` | Top-level scenario pages and continuation pages |
| Widget | `northstar-widget.<ROOT_DOMAIN>` | `widget.challenge.localhost` | Cross-origin frames, scripts, images and synthetic resources |
| Verification | `northstar-verify.<ROOT_DOMAIN>` | `verify.challenge.localhost` | Input, verification, state, completion receipts, protected management |

All three point at the **same** hosting project. The handler routes by the incoming `Host` and keeps the full path and query. An unknown `Host` gets `421`, with no fallback. The hostnames stay neutral; provider identity lives only in routes and internal configuration.

## Request flow

1. `GET parent/scenario/{lane}` issues a fresh, random token bound to that lane and redirects (`303`) to `/scenario/{lane}/{token}`.
2. The scenario page returns the lane's status and headers and loads its fixture scripts, frames and images **from the widget origin**.
3. **Complete scenario** calls the verification origin (`input` → `verify` → `settle`). The settle step produces a signed receipt.
4. The browser continues to `parent/continue/{token}`, which is always signal-free.

## Hostname / route / evidence matrix

Every lane uses the same verification routes (`/api/input|verify|settle|status/{token}` on the verify origin) and the same continuation page (`/continue/{token}` on the parent origin). Evidence paths are relative to `evidence/`.

| Code | Lane | Parent route | Widget routes (resource / frame / image) | `/` status | Classifier verdict at origin | Evidence |
|---|---|---|---|---|---|---|
| 00 | Clean control | `/scenario/clean-control/{token}` | none | 200 | none | `screenshots/control.png` |
| 01 | Cloudflare | `/scenario/cloudflare/{token}` | none | 200, or 403 + `cf-mitigated` at the edge | none at origin; `CLOUDFLARE / JS_POW_AUTO` once the WAF adds `cf-mitigated` | `screenshots/lane-01.png`, `deployment-verification.json` |
| 02 | DataDome | `/scenario/datadome/{token}` | `fx/captcha-delivery.com/c.js` · `fx/captcha-delivery.com/captcha/?initialcid=…` | 403 | `DATADOME / VISUAL_PUZZLE` (header, url, frame) | `screenshots/lane-02.png` |
| 03 | AWS WAF (challenge) | `/scenario/aws-waf/{token}` | `fx/awswaf.com/challenge.js` · `fx/awswaf.com/captcha/` | 202 | `AWS_WAF / JS_POW_AUTO` (header, url, frame) | `screenshots/lane-03.png` |
| 12 | AWS WAF (CAPTCHA) | `/scenario/aws-waf-captcha/{token}` | `fx/captcha.awswaf.com/jsapi.js` · `fx/awswaf.com/captcha/puzzle/` | 405 | `AWS_WAF / VISUAL_PUZZLE` (`x-amzn-waf-action: captcha`) | `screenshots/lane-12.png` |
| 04 | PerimeterX | `/scenario/perimeterx/{token}` | `fx/captcha.px-cloud.net/captcha.js` · `fx/px-cloud.net/challenge/` | 403 | `PERIMETERX / PRESS_AND_HOLD` (url, frame) | `screenshots/lane-04.png` |
| 05 | Akamai | `/scenario/akamai/{token}` | `_sec/cp_challenge/fixture.js` | 403 | `AKAMAI / HARD_BLOCK` (header, url) | `screenshots/lane-05.png` |
| 06 | Kasada | `/scenario/kasada/{token}` | `fx/kpsdk/ips.js` | 429 | `KASADA / JS_POW_AUTO` (header, url) | `screenshots/lane-06.png` |
| 07 | Imperva | `/scenario/imperva/{token}` | `_incapsula_resource?swjiylwa=northstar` · `_incapsula_resource/frame/` | 403 | `IMPERVA / JS_POW_AUTO` (header, url, frame) | `screenshots/lane-07.png` |
| 08 | Arkose | `/scenario/arkose/{token}` | `fx/arkoselabs.com/v2/api.js` · `fx/arkoselabs.com/fc/gc/` | 200 | `ARKOSE / VISUAL_PUZZLE` (url, frame) | `screenshots/lane-08.png` |
| 09 | GeeTest | `/scenario/geetest/{token}` | `fx/gcaptcha4.geetest.com/load.js` · `fx/geetest.com/captcha/` · image `fx/geetest.com/bg.svg` | 200 | `GEETEST / VISUAL_PUZZLE` (url, frame) | `screenshots/lane-09.png` |
| 10 | hCaptcha | `/scenario/hcaptcha/{token}` | `fx/hcaptcha.com/1/api.js` · `fx/hcaptcha.com/captcha/checkbox/` | 200 | `HCAPTCHA / WIDGET_CHECKBOX` (url, frame; 303×78 frame) | `screenshots/lane-10.png` |
| 11 | reCAPTCHA | `/scenario/recaptcha/{token}` | `fx/recaptcha/api.js` · `fx/recaptcha/api2/anchor` | 200 | `RECAPTCHA / WIDGET_CHECKBOX` (url, frame; 304×78 anchor, so not the passive badge) | `screenshots/lane-11.png` |
| 13 | YouTube account gate | `/scenario/youtube-account-gate/{token}` | none | 200 | `YOUTUBE_BOT_GATE / ACCOUNT_MATURATION_GATE` (page text) | `screenshots/lane-13.png` |

Widget paths are served as `/resources/{lane}/{token}/{path}`, `/widget/{lane}/{token}/{path}` and `/images/{lane}/{token}/{path}` on the widget origin. The provider-looking strings appear **only** in those owned paths. No request ever goes to a provider domain.

Per-run evidence: `route-isolation.json`, `signal-isolation.json`, `request-capture.json`, and `scenarios/<lane>/<instance>/receipt.json` (one directory per scenario instance).

### Special conditions (no hostname of their own)

| Condition | Kind | Where |
|---|---|---|
| Google `/sorry/` | Protocol-level fixture only: the URL `https://www.google.com/sorry/index?…`, status 429 and body text. The classifier returns `GOOGLE_SORRY / RATE_LIMIT`. No owned page imitates it, and no browser visits it. | `tests/harness/special-fixtures.json` |
| Proxy gateway (4 variants) | Browser-transport fixtures: a loopback gateway fails the request and Chromium shows its own error document at `chrome-error://chromewebdata/`. Never a hosted HTTP error page. **407** (HTTPS CONNECT): page text "HTTP ERROR 407", so `PROXY_GATEWAY / PROXY_GATEWAY_ERROR`. **http_502** (plain HTTP, empty-body 502): "HTTP ERROR 502", same verdict. **tunnel_502** (HTTPS CONNECT 502): `ERR_TUNNEL_CONNECTION_FAILED`, so no `classify()` verdict, only `proxy_transport_marker`. **Unreachable**: `ERR_PROXY_CONNECTION_FAILED`, likewise marker only. | `tests/harness/special-fixtures.json`, evidence `request-capture.json` |
| YouTube account gate | Controlled browser route | `/scenario/youtube-account-gate/{token}` |

## Classifier alignment

Verdicts above come from `tests/reference-classifier.js`, a port of the application's `classifier.py`, `signatures.py` and `proxy_transport_marker`. Inputs are built the way the app sees a page:
- every response of the navigation (redirects included), with header names and values lowercased;
- the document response;
- child frames with their CSS boxes;
- the visible page text.

Every lane also matches **exactly one** signature, checked by a diagnostic that ignores the classifier's first-match-wins order, so a leak cannot hide behind ordering.

## Isolation: paths are not origins

Two lanes on the same parent origin share a browser security origin, so isolation is enforced by the app:

- **Tokens.** Each token is `code.instance.expiry.mac`, signed with HMAC-SHA256. It is random per instance, bound to one lane code, and expires after `NORTHSTAR_TOKEN_TTL` (default 900 s). A token for one lane is rejected on every other lane, on every origin.
- **Exact routes.** Only declared paths, with exact query strings, are served. Dot segments and encoded slashes are refused, and unknown paths return 404.
- **Widget checks.** Every widget request must carry a valid token for that lane, use a path declared for that lane, come from the configured parent origin (`Origin`/`Referer`), and find the fixture still open. After settle or revoke it gets `410`.
- **Separate state and receipts.** Each instance has its own state and receipts: `issued → input → verified → settled`, with separate evidence directories.
- **Clean surroundings.** Sibling pages and the continuation page carry no marker from any other lane. The clean control references no widget origin at all.

## Browser security rules

| Origin | Rules |
|---|---|
| Parent | `frame-src` = widget origin only. `connect-src` = verify origin only. `script-src`/`img-src` = self + widget origin. `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin`. Unknown scenario routes → 404. |
| Widget | Frames: `frame-ancestors <parent origin>` (nothing else may frame them). Every request needs the parent origin as `Origin`/`Referer` (otherwise 403). No management routes exist here. |
| Verify | Scenario endpoints require `Origin` = parent origin exactly. CORS is explicit (`Access-Control-Allow-Origin: <parent>`, never `*`, never credentials). Management (`/api/manage/*`) needs `Authorization: Bearer <NORTHSTAR_MANAGEMENT_AUTHORITY>`, refuses any browser `Origin`, and is disabled (404) when unset. |
| All | Unknown `Host` → 421. `NORTHSTAR_ENABLED` must equal `true`, or every route returns 503. No cookies or storage. Logs never contain secrets, query strings or tokens. |

## State on serverless platforms

Token validation is stateless, so it works on every platform and instance. So does scenario progress: each step returns a **signed progress proof** (HMAC over the instance id and its state, steps and receipt), and the page sends the latest proof with the next step (`x-northstar-proof`) and on the continuation URL (`?p=`). Any instance holding the signing key can therefore serve any step. A proof is valid only for its own token instance and can't be forged, replayed on another instance, or used to skip steps.

The handler's state store is still used on top of that. The default is in-memory and exact on a single Node process; it is what makes receipts, evidence files and revocation work there. On multi-instance serverless hosts (Vercel, Netlify, Workers) only **revocation** and the "widget closed after settle" check are best-effort, because they need shared storage. To invalidate everything, rotate `NORTHSTAR_TOKEN_SIGNING_KEY`. An adapter can pass a shared store (Workers KV, Vercel KV, Netlify Blobs) with the same async `get/put/list` interface if exact revocation is needed.

<!-- migration-note -->
## Migration note: from 12 hostnames to 3

The first version of the lab used **12 hostnames**: `northstar-control` plus `northstar-01` … `northstar-11`, one per provider. Each was configured by `NORTHSTAR_CONTROL_HOST` / `NORTHSTAR_LANE_01_HOST` … `NORTHSTAR_LANE_11_HOST`. That design is preserved in Git history: commit `5db1015` on `main`.

It was consolidated into the three role origins above:

- Each former hostname became a route on the parent origin (`northstar-02` → `/scenario/datadome/{token}`, and so on).
- Its same-origin fixture paths moved, unchanged, to the widget origin.
- New lanes: **AWS WAF CAPTCHA** (`12`), the **YouTube account gate** (`13`, formerly a local harness page), and an explicit **clean control** route (`00`, formerly `northstar-control`).
- hCaptcha/reCAPTCHA lanes are controlled widget-origin fixtures by default. The official widgets remain available behind `NORTHSTAR_REAL_WIDGETS=true`.
- `NORTHSTAR_CONTROL_HOST`, `NORTHSTAR_LANE_01_HOST` … `NORTHSTAR_LANE_11_HOST` and `NORTHSTAR_ALLOWED_ORIGINS` were **removed**. If still set, they are ignored (a warning is logged) and never route anything.
- DNS needs 3 records instead of 12. The Cloudflare WAF rule moved from "host northstar-01" to "parent host + path `/scenario/cloudflare`".
<!-- /migration-note -->
