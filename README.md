# Northstar Lab

An isolated, portable web-testing environment: 12 neutral hostnames (1 control + 11 lanes), each serving a lightweight page whose headers, status, resource paths and frames match the application's challenge-signature registry. It has no dependencies, runs on Node 22+, and is portable to Vercel, Netlify, Cloudflare Workers/Pages or any Node host.

**Start here → [SETUP-GUIDE.md](SETUP-GUIDE.md)** (your manual steps, in order).

```
npm start            # local server: http://northstar-control.localhost:8787/ … northstar-11
npm test             # 51 setup tests (config, routes, characteristics, secrets, isolation, real browser)
npm run evidence     # regenerate evidence/ (screenshots, captures, health, test results, build SHA)
npm run harness      # local-only special fixtures (Google /sorry/, YouTube gate, failing proxy)
npm run plan -- --root-domain <d> [--platform p] [--target t]   # DNS plan + deploy.env + WAF rule
npm run prepare-deploy -- <vercel|netlify|cloudflare|node>        # builds dist/<p>/ (does NOT deploy)
npm run verify-deployment -- --i-approve-external-requests        # post-deploy checks of your 12 hosts
```

## Layout

| Path | Purpose |
|---|---|
| `pages/<lane>/page.json`, `pages/shared/` | Neutral page title and summary; shared layout, frame, CSS, and the page script (reload button + "Page loaded") |
| `configuration/lanes.internal.json` | **Internal** lane → provider mapping and fixture markers (single source of truth) |
| `configuration/config.js` | Env validation. Disabled by default; refuses unknown, duplicate, apex/www/production or non-neutral hosts, and secret-looking site keys |
| `configuration/local.env`, `northstar.env.example` | Local values (published provider *test* keys only); sanitized template |
| `functions/handler.js` | Platform-neutral `handleRequest(Request, env) → Response` |
| `functions/generated/data.js` | Built bundle. Contains **no** provider names; the mapping stays internal |
| `deployment/adapters/*` | Thin Vercel / Netlify / Cloudflare / Node layers |
| `deployment/*.md` | DNS template, WAF rule, deployment/TLS checklists, rollback, items waiting on you |
| `tests/` | Setup tests, the reference copy of the signature registry, and the browser + special-fixture harness |
| `evidence/` | Generated setup evidence (git-ignored; contains the PROTECTED mapping) |

## Lane fixtures (internal)

| Lane | `/` status | Markers served from the lane's own origin |
|---|---|---|
| control | 200 | none |
| 01 | 200 at origin | none at origin; Cloudflare adds `cf-mitigated` + 403 at the edge once the WAF rule is on |
| 02 | 403 | `x-datadome`, `x-dd-b`; script and frame under `/fx/captcha-delivery.com/…` |
| 03 | 202 | `x-amzn-waf-action`; script and frame under `/fx/awswaf.com/…` |
| 04 | 403 | script `/fx/captcha.px-cloud.net/…`, frame `/fx/px-cloud.net/…` |
| 05 | 403 | `server: akamaighost`, `akamai-grn`; script `/_sec/cp_challenge/…` |
| 06 | 429 | `x-kpsdk-ct`, `x-kpsdk-cd`; script `/fx/kpsdk/ips.js` |
| 07 | 403 | `x-iinfo`; script `/_incapsula_resource?…`, frame `/_incapsula_resource/frame/` |
| 08 | 200 | script and frame under `/fx/arkoselabs.com/…` |
| 09 | 200 | script `/fx/gcaptcha4.geetest.com/…`, frame `/fx/geetest.com/…` |
| 10 | 200 | official hCaptcha widget (`js.hcaptcha.com/1/api.js`), public site key from config |
| 11 | 200 | official reCAPTCHA v2 widget (`google.com/recaptcha/api.js`), public site key from config |

Fixture URLs put the registry's marker text in **owned paths** (for example `/fx/captcha-delivery.com/…`). The registry matches by substring, so these trigger detection without contacting any provider.

**Assumptions to confirm** against the application's detector: header names and values compared lowercased, and URL markers checked against sub-resource URLs, not only the top-level URL. Fixture frames are also directly navigable pages if your detector only inspects the page URL. To change any marker, edit `configuration/lanes.internal.json` and `tests/reference-matcher.js`.
