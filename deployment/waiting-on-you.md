# Waiting on you (Phase 2 inputs)

Everything else is built and tested locally. These values are all that's left. **Send only non-secret values in chat.**

| Value | Status | Where it goes |
|---|---|---|
| `ROOT_DOMAIN` | ⏳ needed | `npm run plan -- --root-domain ...` → `northstar-parent/-widget/-verify.<ROOT_DOMAIN>` |
| `HOSTING_PLATFORM` (vercel / netlify / cloudflare / node) | ⏳ needed | `--platform` |
| `HOSTING_PROJECT` (name, and ID if the platform has one) | ⏳ after you create the one project | `prepare-deploy --name` |
| `DNS_TARGET` (CNAME target or IP) | ⏳ shown by the platform when you add the hostnames | `--target` (and `--record-type A` if it's an IP) |
| `DEPLOYMENT_METHOD` (CLI from your machine, Git integration, or CI) | ⏳ needed | Decides who runs the final deploy command |
| `CLOUDFLARE_ZONE_NAME` / `CLOUDFLARE_ZONE_ID` | ⏳ after the domain is on Cloudflare | Reference only; the zone ID is not secret |
| `EXTERNAL_DEPLOYMENT_APPROVED` | ❌ false | Say so explicitly in chat when you approve |

**Secrets (never in chat, files or Git):** `NORTHSTAR_TOKEN_SIGNING_KEY` (required) and `NORTHSTAR_MANAGEMENT_AUTHORITY` (optional). Generate them on your own machine and store them only in the platform's secret manager. Just tell me "the signing key is set".

**No longer needed:** hCaptcha/reCAPTCHA site keys. Those lanes are controlled fixtures by default. Keys are needed only if you later turn on `NORTHSTAR_REAL_WIDGETS=true`, which contacts those providers.
