# Northstar Lab

An isolated, portable web-testing environment with **three neutral role hostnames** (parent, widget, verify) and **14 browser lanes** served as routes on them:

- the 11 registered providers,
- the AWS WAF CAPTCHA variant,
- a clean control,
- the YouTube account gate.

Each lane's headers, status, resource paths and frames match the application's challenge-signature registry. Every provider-looking string lives in paths on the owned widget origin, so no request ever reaches a provider. The project has no dependencies, runs on Node 22+, and ports to Vercel, Netlify, Cloudflare Workers or any Node host.

**Start here → [SETUP-GUIDE.md](SETUP-GUIDE.md)** (your manual steps, in order). The architecture and the full hostname / route / evidence matrix are in **[deployment/architecture.md](deployment/architecture.md)**.

```
npm start            # local: http://parent.challenge.localhost:8787/scenario/<lane> (widget./verify. alongside)
npm test             # setup tests: config, routing, tokens, verification, signal isolation, secrets, special fixtures, deploy plan, real browser
npm run evidence     # regenerate evidence/ (screenshots, request capture, route + signal isolation, receipts, test results, build SHA)
npm run harness      # local proxy gateways (407 / 502) for transport-error fixtures
npm run plan -- --root-domain <d> [--platform p] [--target t]   # 3-record DNS plan + deploy.env + Cloudflare rules
npm run prepare-deploy -- <vercel|netlify|cloudflare|node>        # builds dist/<p>/ (does NOT deploy)
npm run verify-deployment -- --i-approve-external-requests        # post-deploy checks of your 3 hosts and 14 lanes
```

## Hostnames

| Role | Deployed | Local | Serves |
|---|---|---|---|
| Parent | `northstar-parent.<ROOT_DOMAIN>` | `parent.challenge.localhost` | `/scenario/{lane}/{token}`, `/continue/{token}` |
| Widget | `northstar-widget.<ROOT_DOMAIN>` | `widget.challenge.localhost` | `/widget/…`, `/resources/…`, `/images/…` (`/{lane}/{token}/{path}`) |
| Verify | `northstar-verify.<ROOT_DOMAIN>` | `verify.challenge.localhost` | `/api/input|verify|settle|status/{token}`, protected `/api/manage/*` |

Lanes: `clean-control`, `cloudflare`, `datadome`, `aws-waf`, `aws-waf-captcha`, `perimeterx`, `akamai`, `kasada`, `imperva`, `arkose`, `geetest`, `hcaptcha`, `recaptcha`, `youtube-account-gate`.

Special conditions without a hostname of their own:
- **Google `/sorry/`** is a protocol-level fixture only.
- **Proxy 407 / 502** are Chromium transport errors at `chrome-error://chromewebdata/`, produced by a local gateway.

## Layout

| Path | Purpose |
|---|---|
| `configuration/lanes.internal.json` | **Internal** source of truth: lane → route, code, assignment and fixture markers |
| `configuration/config.js` | Env validation. Disabled by default; three origins are the only hostname authority. Refuses unknown, duplicate, apex/www/production or non-neutral hosts |
| `configuration/local.env`, `northstar.env.example` | Local values (no secrets); sanitized template |
| `functions/handler.js` | Platform-neutral `handleRequest(Request, env, ctx) → Response` for the three roles |
| `functions/tokens.js`, `functions/state.js` | Lane-bound HMAC tokens; per-instance scenario state |
| `functions/generated/data.js` | Built bundle (no internal assignment table) |
| `pages/` | Neutral page titles, shared layout, frame, CSS and the page script |
| `deployment/adapters/*` | Thin Vercel / Netlify / Cloudflare / Node layers |
| `deployment/*.md` | Architecture + matrix, DNS (3 records), Cloudflare rule, deployment/TLS checklists, rollback, inputs waiting on you |
| `tests/` | Setup tests, the port of the application's classifier (`reference-classifier.js`), the browser harness |
| `evidence/` | Generated setup evidence (git-ignored; contains the PROTECTED matrix) |

**Checked against the application's classifier.** `tests/reference-classifier.js` is a line-by-line JavaScript port of `src/challenges/signatures.py`, `classifier.py` and `network_tap.proxy_transport_marker`. Every lane is asserted to produce its exact `(vendor, surface)` verdict, both over HTTP and in a real browser. If the application's classifier changes, update that file and `EXPECTED_VERDICTS` in `tests/harness/suite.js`. To change a marker, edit `configuration/lanes.internal.json`.
