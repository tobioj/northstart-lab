# Northstar Lab: your setup guide

Everything that can be done locally is built and tested. This guide covers the parts only you can do, **in the order to do them**. Each step says **when** to do it and **what to send back**. Never paste a secret into chat.

The lab now needs **three DNS hostnames**, one per role:

```
northstar-parent.<ROOT_DOMAIN>   scenario pages and continuation pages
northstar-widget.<ROOT_DOMAIN>   cross-origin frames, scripts, images
northstar-verify.<ROOT_DOMAIN>   input, verification, receipts, management
```

All 14 lanes are routes on these three hosts. Details are in [deployment/architecture.md](deployment/architecture.md).

---

## Step 0: Try it locally (now, 2 minutes)

```powershell
cd "C:\Users\tobio\Documents\Northstart lab\northstar-lab"
npm start
```

Open **http://parent.challenge.localhost:8787/scenario/datadome** in Chrome or Edge. It issues a fresh token and opens the lane. Try any lane name from `npm start`'s list, then click **Complete scenario** to run input → verify → settle and land on the clean continuation page. Each host also serves `/healthz`, `/readyz` and `/fixture-manifest.json`. Stop the server with `Ctrl+C`.

Other commands: `npm test` runs all tests, `npm run evidence` regenerates `evidence/`, and `npm run harness` starts the 407/502 proxy gateways.

> ⚠️ **Kaspersky is installed on this PC and injects a script** (`gc.kis.v2.scr.kaspersky-labs.com/.../main.js`) into every plain-HTTP page, including these local ones. The test harness blocks it and reports it separately, so results are unaffected. When you point **your own app** at the local lanes, though, that injected script is an extra third-party resource your detector will see. To get clean local runs, add `*.challenge.localhost` to Kaspersky's trusted addresses: **Settings → Network settings → Traffic processing → Trusted addresses** (exact menu names vary by version). Deployed HTTPS pages are not affected the same way.

---

## Step 1: Choose the root domain

**When:** whenever you're ready. Nothing else can happen until this is done.

- Use a domain you own. A **separate, cheap, throwaway domain** is strongly recommended, so the lab can never affect your main site.
- The Cloudflare lane only works if the domain's **DNS is hosted on Cloudflare** (free plan). If it's somewhere else, you'll move its nameservers in Step 3.

**Send me:** `ROOT_DOMAIN=yourdomain.tld`

---

## Step 2: Choose the hosting platform and deployment method

**When:** together with Step 1.

| Option | Good for | Notes |
|---|---|---|
| **Vercel + Cloudflare DNS** *(recommended)* | Only the parent host is proxied by Cloudflare; widget and verify stay DNS-only | Free Hobby plan works. You add three domains to one project. |
| Netlify + Cloudflare DNS | Same as above | Free plan works. You add three domain aliases. |
| Cloudflare Workers | Fewest steps (DNS and TLS are created automatically) | All three hosts become proxied. This is harmless for detection; the WAF rule is still path-scoped. |
| Generic Node (container/VM) | You already run servers; scenario state is exact on one process | You handle TLS and the reverse proxy yourself. |

**Deployment method:** choose whether the final deploy runs from your machine with the platform CLI, through the platform's Git integration, or from CI.

**Send me:** `HOSTING_PLATFORM=vercel` (or netlify / cloudflare / node) and `DEPLOYMENT_METHOD=cli` (or git / ci).

Once I have Steps 1 and 2, I'll run:

```powershell
npm run plan -- --root-domain yourdomain.tld --platform vercel --environment staging
npm run prepare-deploy -- vercel
```

These generate the three-record DNS table, `deploy.env`, the Cloudflare rules with your domain filled in, and the platform commands.

---

## Step 3: Put the domain's DNS on Cloudflare

**When:** after Step 1. Skip this if the domain is already on Cloudflare.

1. Sign up or log in at dash.cloudflare.com → **Add a domain** → choose the **Free** plan.
2. Cloudflare shows two nameservers. At your registrar, replace the existing nameservers with those two.
3. Wait for Cloudflare to report the domain as **Active** (minutes to a few hours).
4. Check **Security → Bots** and make sure **Bot Fight Mode is OFF**. It's zone-wide and would inject challenge scripts into the other lanes.

**Send me:** `CLOUDFLARE_ZONE_NAME`, and the `CLOUDFLARE_ZONE_ID` from the Overview page. The zone ID is not secret.

---

## Step 4: Create the hosting project and the signing key

**When:** after I've generated `dist/<platform>/` (end of Step 2).

1. Create or link **one** project (prepare-deploy prints the exact commands). Add every variable from `configuration/deploy.env`, and keep `NORTHSTAR_ENABLED=false` for now.
2. **Signing key (secret):** generate it on your own machine:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

   Paste the output **only** into the platform's secret manager as `NORTHSTAR_TOKEN_SIGNING_KEY`. Vercel: `vercel env add NORTHSTAR_TOKEN_SIGNING_KEY production --sensitive`. Netlify: mark it *Contains secret values*. Workers: `npx wrangler secret put NORTHSTAR_TOKEN_SIGNING_KEY`.
3. *(Optional)* For the management endpoints, do the same with `NORTHSTAR_MANAGEMENT_AUTHORITY`. Leaving it unset keeps management disabled.
4. Add the three hostnames to the project: `northstar-parent`, `northstar-widget` and `northstar-verify` `.yourdomain.tld`. The platform shows the DNS target, usually a CNAME like `xxxx.vercel-dns-0xx.com`. **Cloudflare Workers:** `npx wrangler deploy` creates the three custom domains with DNS and TLS, so skip Step 5.

**Send me:** `HOSTING_PROJECT` (name, plus its ID if shown), `DNS_TARGET`, and the words "the signing key is set". **Never** send the key itself.

---

## Step 5: Create the three DNS records

**When:** after you have the DNS target, and after I re-run `plan` with `--target`.

In **Cloudflare → DNS → Records**, create the three records from `deployment/generated/yourdomain.tld/dns-plan.md`:

| Name | Type | Target | TTL | Proxy |
|---|---|---|---|---|
| `northstar-parent` | CNAME | the platform target | 300 | **Proxied** (orange) |
| `northstar-widget` | CNAME | the platform target | 300 | DNS only (grey) |
| `northstar-verify` | CNAME | the platform target | 300 | DNS only (grey) |

- Don't touch the root (`@`) or `www`. No wildcard records. Never add both an A record and a CNAME for one name.
- Then add the parent-host **Configuration Rule** from `cloudflare-config-rule.txt`: SSL Full (strict), Email Obfuscation off, Rocket Loader off. See [deployment/cloudflare-waf.md](deployment/cloudflare-waf.md) §1.

---

## Step 6: Approve the external deployment

**When:** after Steps 3–5.

**Send me, in your own words:** "I approve the external deployment, and I confirm the three northstar hostnames are disposable test infrastructure."

Then I'll run (or you can run):
1. The platform deploy command, e.g. `vercel deploy --prod`.
2. Set `NORTHSTAR_ENABLED=true` on the platform and redeploy.
3. `npm run verify-deployment -- --env-file configuration/deploy.env --i-approve-external-requests`. It checks TLS on all three hosts, health, readiness, unknown-path rejection, and the expected status for all 14 lanes.

---

## Step 7: Turn on the Cloudflare lane

**When:** only after Step 6 shows the parent host's `/healthz` = 200.

Follow [deployment/cloudflare-waf.md](deployment/cloudflare-waf.md):
1. Create the custom rule from `cloudflare-waf-rule.txt`. It matches the parent host **and** `/scenario/cloudflare` only. Choose **Save as Draft**.
2. Enable it.
3. Check that `/scenario/cloudflare` returns **403** with `cf-mitigated: challenge`, and that `verify-deployment` shows no other lane affected.

**Rollback** (any one is enough): toggle the rule off, set `northstar-parent` to DNS-only, or set `NORTHSTAR_ENABLED=false`. Full details are in [deployment/rollback.md](deployment/rollback.md).

---

## What I still need from you (summary)

| # | Value | Secret? |
|---|---|---|
| 1 | `ROOT_DOMAIN` | no |
| 2 | `HOSTING_PLATFORM`, `DEPLOYMENT_METHOD` | no |
| 3 | `CLOUDFLARE_ZONE_NAME`, `CLOUDFLARE_ZONE_ID` | no |
| 4 | `HOSTING_PROJECT`, `DNS_TARGET` | no |
| 5 | "The signing key is set" (confirmation only) | — |
| 6 | Deployment approval + disposable-hosts confirmation | — |
| ✗ | `NORTHSTAR_TOKEN_SIGNING_KEY`, `NORTHSTAR_MANAGEMENT_AUTHORITY`, any API token | **YES: never send these. Platform secret manager only.** |

hCaptcha and reCAPTCHA site keys are **no longer required**. Those lanes are controlled fixtures on the widget origin unless you later opt into `NORTHSTAR_REAL_WIDGETS=true`.
