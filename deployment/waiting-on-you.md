# Waiting on you

Everything else is built and tested locally. These values are all that's left. **Send only non-secret values in chat.**

| Value | Status | Where it goes |
|---|---|---|
| `ROOT_DOMAIN` | ⏳ needed | `npm run plan -- --root-domain ...` |
| `HOSTING_PLATFORM` (vercel / netlify / cloudflare / node) | ⏳ needed | `--platform` |
| `HOSTING_PROJECT_NAME` / `HOSTING_PROJECT_ID` | ⏳ after you create the project | `prepare-deploy --name` |
| `HOSTING_DNS_TARGET` (CNAME target or IP) | ⏳ shown by the platform when you add a domain | `--target` (and `--record-type A` if it's an IP) |
| `HOSTING_DEPLOYMENT_COMMAND` | ✅ printed by `prepare-deploy` | |
| `CLOUDFLARE_ZONE_NAME` / `CLOUDFLARE_ZONE_ID` | ⏳ after the domain is on Cloudflare | Reference only; the zone ID is not secret |
| `CLOUDFLARE_PROXY_ENABLED` | ✅ planned: `northstar-01` only | dns-plan.md |
| `HCAPTCHA_PUBLIC_SITE_KEY` | ⏳ from the hCaptcha dashboard | `NORTHSTAR_HCAPTCHA_SITE_KEY` |
| `HCAPTCHA_SECRET_REFERENCE` | optional | Only the *name* of the platform secret, e.g. `NORTHSTAR_HCAPTCHA_SECRET` |
| `RECAPTCHA_PUBLIC_SITE_KEY` | ⏳ from the reCAPTCHA admin console | `NORTHSTAR_RECAPTCHA_SITE_KEY` |
| `RECAPTCHA_SECRET_REFERENCE` | optional | Only the *name*, e.g. `NORTHSTAR_RECAPTCHA_SECRET` |
| `EXTERNAL_DEPLOYMENT_APPROVED` | ❌ false | Say so explicitly in chat when you approve |

Until then, local development uses the providers' published **test** site keys (see `configuration/local.env`).
