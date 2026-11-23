# Northstar Lab: your setup guide

Everything that can be done locally is built and tested (51/51 tests passing). This guide covers the parts only you can do, **in the order to do them**. Each step says **when** to do it and **what to send back**. Never paste a secret into chat.

---

## Step 0: Try it locally (now, 2 minutes)

```powershell
cd "C:\Users\tobio\Documents\Northstart lab\northstar-lab"
npm start
```

Open **http://northstar-control.localhost:8787/** in Chrome or Edge, then try `northstar-01` … `northstar-11`. You can also open `/healthz`, `/readyz` and `/fixture-manifest.json` on any of them. Stop the server with `Ctrl+C`.

Other commands: `npm test` (all tests), `npm run evidence` (regenerates `evidence/`), `npm run harness` (the 3 special fixtures).

> ⚠️ **Kaspersky is installed on this PC and injects a script** (`gc.kis.v2.scr.kaspersky-labs.com/.../main.js`) into every plain-HTTP page, including these local ones. The test harness blocks it and reports it separately, so results are unaffected. When you point **your own app** at the local lanes, though, that injected script is an extra third-party resource your detector will see. To get clean local runs, add `*.localhost` to Kaspersky's trusted addresses: **Settings → Network settings → Traffic processing → Trusted addresses** (exact menu names vary by version), or temporarily turn off "Inject script into web traffic". Deployed HTTPS pages are not affected the same way.

---

## Step 1: Choose the root domain (Part C #1)

**When:** whenever you're ready. Nothing else can happen until this is done.

- Use a domain you own. A **separate, cheap, throwaway domain** is strongly recommended, so the lab can never affect your main site.
- Lane 01 (Cloudflare WAF) only works if the domain's **DNS is hosted on Cloudflare** (free plan). If the domain is somewhere else, you'll move its nameservers in Step 3.

**Send me:** `ROOT_DOMAIN=yourdomain.tld`

---

## Step 2: Choose the hosting platform (Part C #2)

**When:** together with Step 1.

| Option | Good for | Notes |
|---|---|---|
| **Vercel + Cloudflare DNS** *(recommended: matches the spec exactly)* | Lanes 02–11 stay DNS-only and untouched by Cloudflare; only lane 01 is proxied | Free Hobby plan works. You add 12 domains in the Vercel project. |
| Netlify + Cloudflare DNS | Same as above | Free plan works. You add 12 domain aliases. |
| Cloudflare Workers | Fewest steps (DNS and TLS are created automatically, all in one dashboard) | All 12 hosts become proxied. This is harmless for detection, but it's a deviation from "proxy only lane 01". |
| Generic Node (container/VM) | You already run servers | You handle TLS and the reverse proxy yourself. |

**Send me:** `HOSTING_PLATFORM=vercel` (or netlify / cloudflare / node)

Once I have Steps 1 and 2, I'll run `npm run plan` and `npm run prepare-deploy`. Those generate your exact DNS table, `deploy.env`, the WAF rule with your domain filled in, and the platform commands. You can also run them yourself:

```powershell
npm run plan -- --root-domain yourdomain.tld --platform vercel --environment staging
npm run prepare-deploy -- vercel
```

---

## Step 3: Put the domain's DNS on Cloudflare (Part C #6, prerequisite)

**When:** after Step 1. Skip this if the domain is already on Cloudflare.

1. Sign up or log in at dash.cloudflare.com → **Add a domain** → choose the **Free** plan.
2. Cloudflare shows two nameservers. At your registrar, replace the existing nameservers with those two.
3. Wait for Cloudflare to report the domain as **Active** (minutes to a few hours).
4. Check **Security → Bots** and make sure **Bot Fight Mode is OFF**. It's zone-wide and would affect the root domain.

**Send me:** `CLOUDFLARE_ZONE_NAME`, and the `CLOUDFLARE_ZONE_ID` shown on the domain's Overview page. The zone ID is not a secret.

---

## Step 4: Create the hCaptcha site (Part C #7)

**When:** any time after Step 1.

1. Sign up at **dashboard.hcaptcha.com** (free tier).
2. **Sites → New Site**. Add the hostname `northstar-10.yourdomain.tld`, and nothing else.
3. Copy the **Site Key**. It looks like `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` and is public.
4. The account **Secret** (starts with `0x…`) is private. **Don't send it to me.** This build doesn't need it, because the page only renders the widget. If you want to keep it ready, store it only in the hosting platform's secret manager (Step 7) as `NORTHSTAR_HCAPTCHA_SECRET`.

**Send me:** `HCAPTCHA_PUBLIC_SITE_KEY=…` and, if you stored the secret, just its name: `HCAPTCHA_SECRET_REFERENCE=NORTHSTAR_HCAPTCHA_SECRET`.

---

## Step 5: Create the reCAPTCHA site (Part C #8)

**When:** any time after Step 1.

1. Go to **google.com/recaptcha/admin/create**. You may be asked to attach a Google Cloud project; a free project is fine.
2. Type: **reCAPTCHA v2 → "I'm not a robot" Checkbox**. The lane uses the v2 checkbox, which your registry's `recaptcha/api2` marker matches.
3. Domain: `northstar-11.yourdomain.tld`, and nothing else.
4. Copy the **Site key** (starts with `6L…`, public).
5. The **Secret key** is private: same rule as hCaptcha, platform secret manager only, as `NORTHSTAR_RECAPTCHA_SECRET`.

**Send me:** `RECAPTCHA_PUBLIC_SITE_KEY=…` (and optionally `RECAPTCHA_SECRET_REFERENCE=NORTHSTAR_RECAPTCHA_SECRET`).

---

## Step 6: Create the hosting project and get the DNS target (Part C #3, #4)

**When:** after I've generated `dist/<platform>/` (end of Step 2).

**Vercel**
1. Install the CLI once with `npm i -g vercel`, then run `vercel login`.
2. Run `cd dist/vercel` and `vercel link`, and create the project `northstar-lab`.
3. Add every variable from `configuration/deploy.env` (prepare-deploy prints each `vercel env add` command). Keep `NORTHSTAR_ENABLED=false` for now.
4. **Project → Settings → Domains**: add all 12 hostnames. Vercel shows the record to create for each, usually a CNAME target like `xxxx.vercel-dns-0xx.com`.

**Netlify**: `netlify link` (or `netlify sites:create`), then `netlify env:set …`. Under **Domain management → Add domain alias**, add all 12 hostnames. The target is `<site-name>.netlify.app`.

**Cloudflare Workers**: there's nothing to create by hand. `npx wrangler deploy` creates the Worker plus all 12 custom domains, with DNS and TLS. Skip Step 7.

**Send me:** `HOSTING_PROJECT_NAME`, `HOSTING_PROJECT_ID` (Vercel: Settings → General; Netlify: Site ID), and `HOSTING_DNS_TARGET`.

---

## Step 7: Create the 12 DNS records (Part C #5)

**When:** after you have the DNS target, and after I re-run `plan` with `--target`.

In **Cloudflare → DNS → Records**, create the 12 records from `deployment/generated/yourdomain.tld/dns-plan.md`:

- Type **CNAME**, name `northstar-control`, `northstar-01` … `northstar-11`, target = the platform's target, **TTL 300**.
- **Proxy status:** `northstar-01` → **Proxied** (orange cloud). All others → **DNS only** (grey cloud).
- Don't touch the root (`@`) or `www`. No wildcard records. Never add both an A record and a CNAME for one name.
- Shortcut: **DNS → Records → Import and Export** with `zone.txt`. Set the `northstar-01` proxy afterwards.

Then, for lane 01 on Vercel/Netlify only: **Rules → Configuration Rules**, Hostname equals `northstar-01.yourdomain.tld`, set **SSL: Full (strict)**.

---

## Step 8: Approve the external deployment (Part C #11, #12)

**When:** after Steps 4–7.

**Send me, in your own words:** "I approve the external deployment, and I confirm all 12 northstar hostnames are disposable test infrastructure." That sets `EXTERNAL_DEPLOYMENT_APPROVED=true`.

Then I'll run (or you can run):
1. The platform deploy command, e.g. `vercel deploy --prod`.
2. Set `NORTHSTAR_ENABLED=true` on the platform and redeploy.
3. `npm run verify-deployment -- --env-file configuration/deploy.env --i-approve-external-requests`, which checks TLS, health, readiness and the expected status for all 12 hosts.

---

## Step 9: Turn on the Cloudflare WAF lane (Part C #6)

**When:** only after Step 8 shows `northstar-01` `/healthz` = 200.

Follow [deployment/cloudflare-waf.md](deployment/cloudflare-waf.md):
1. Create the custom rule from `deployment/generated/yourdomain.tld/cloudflare-waf-rule.txt` → **Save as Draft**.
2. Enable it.
3. Check that `https://northstar-01.yourdomain.tld/` returns **403** with `cf-mitigated: challenge`, and that `verify-deployment` shows no other host affected.

**Rollback** (any one is enough): toggle the rule off, set `northstar-01` to DNS-only, or set `NORTHSTAR_ENABLED=false`. Full details are in [deployment/rollback.md](deployment/rollback.md).

---

## What I still need from you (summary)

| # | Value | Secret? |
|---|---|---|
| 1 | `ROOT_DOMAIN` | no |
| 2 | `HOSTING_PLATFORM` | no |
| 3 | `CLOUDFLARE_ZONE_NAME`, `CLOUDFLARE_ZONE_ID` | no |
| 4 | `HCAPTCHA_PUBLIC_SITE_KEY` | no (public) |
| 5 | `RECAPTCHA_PUBLIC_SITE_KEY` | no (public) |
| 6 | `HOSTING_PROJECT_NAME`, `HOSTING_PROJECT_ID`, `HOSTING_DNS_TARGET` | no |
| 7 | Deployment approval + disposable-hosts confirmation | — |
| ✗ | hCaptcha secret, reCAPTCHA secret, any API token | **YES: never send these. Platform secret manager only.** |
