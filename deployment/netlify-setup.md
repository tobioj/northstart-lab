# Netlify setup (Git deploy, no command line)

One Netlify site serves all three hostnames. The repository root is deployable as-is: [netlify.toml](../netlify.toml), [netlify/functions/northstar.mjs](../netlify/functions/northstar.mjs) and `public/`.

Replace `<ROOT_DOMAIN>` with your domain throughout. **Nothing is public until you set `NORTHSTAR_ENABLED=true`.** Until then every route returns `503`.

## 1. Create the site from Git
1. Netlify → **Add new project → Import an existing project → GitHub** → choose the `northstart-lab` repository.
2. **Branch to deploy:** the repository's default branch. Leave the **base directory** empty.
3. Netlify reads `netlify.toml`, so the build command (`node scripts/build.js`), publish directory (`public`) and Node 22 are already set. Don't change them.
4. Name the site anything unique, e.g. `northstar-lab-yourname`. It gets a `*.netlify.app` URL, which is your **DNS target**.
5. **Before the first deploy** (or immediately after), add the environment variables in step 2. A deploy without them is harmless: it serves `503`.

## 2. Environment variables
Site configuration → **Environment variables → Add a variable**. Use the same value for all scopes/contexts.

| Variable | Value | Secret? |
|---|---|---|
| `NORTHSTAR_ENABLED` | `false` for now | no |
| `NORTHSTAR_ENVIRONMENT` | `staging` | no |
| `NORTHSTAR_ROOT_DOMAIN` | `<ROOT_DOMAIN>` | no |
| `NORTHSTAR_PARENT_ORIGIN` | `https://northstar-parent.<ROOT_DOMAIN>` | no |
| `NORTHSTAR_WIDGET_ORIGIN` | `https://northstar-widget.<ROOT_DOMAIN>` | no |
| `NORTHSTAR_VERIFY_ORIGIN` | `https://northstar-verify.<ROOT_DOMAIN>` | no |
| `NORTHSTAR_TOKEN_TTL` | `900` | no |
| `NORTHSTAR_REAL_WIDGETS` | `false` | no |
| `NORTHSTAR_TOKEN_SIGNING_KEY` | a random value you generate (below, ≥ 32 chars) | **YES** |
| `NORTHSTAR_MANAGEMENT_AUTHORITY` | a separate random value you generate (below, ≥ 32 chars) — **required** for `RemoteFixtureServer` (`POST /api/runs`, `GET /api/evidence/{token}`, `POST /api/reset/{token}`) | **YES** |

**Generate both keys on your own PC** (PowerShell, run twice for two distinct secrets) and paste each straight into Netlify. Mark both **"Contains secret values"**. Don't send them to anyone, and don't put them in a file or in Git:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Leave `NORTHSTAR_MANAGEMENT_AUTHORITY` unset only if you want management and `RemoteFixtureServer` endpoints disabled (`404`).

## 3. Add the three custom domains
Site configuration → **Domain management → Add a domain alias** (or *Add custom domain*), one at a time:

```
northstar-parent.<ROOT_DOMAIN>
northstar-widget.<ROOT_DOMAIN>
northstar-verify.<ROOT_DOMAIN>
```

Netlify says each one is not yet pointing to it. That's expected. If it offers "Netlify DNS", **decline**: your DNS stays on Cloudflare.

## 4. Create the DNS records in Cloudflare
Cloudflare → your domain → **DNS → Records → Add record**, three times:

| Type | Name | Target | Proxy status | TTL |
|---|---|---|---|---|
| CNAME | `northstar-parent` | `<your-site>.netlify.app` | **DNS only** (grey cloud) | 300 |
| CNAME | `northstar-widget` | `<your-site>.netlify.app` | **DNS only** (grey cloud) | 300 |
| CNAME | `northstar-verify` | `<your-site>.netlify.app` | **DNS only** (grey cloud) | 300 |

Leave your other records alone, add no wildcard, and don't use an A record for these names. They must start as DNS only so Netlify can issue the HTTPS certificates.

## 5. HTTPS certificates
Netlify → **Domain management → HTTPS → Verify DNS configuration → Provision certificate**. Wait until all three hostnames show a certificate. This usually takes a few minutes. Then check, in a browser:

```
https://northstar-parent.<ROOT_DOMAIN>/healthz     →  {"status":"unavailable"}  (503, expected while disabled)
```

## 6. Switch it on
1. Change `NORTHSTAR_ENABLED` to `true`.
2. **Deploys → Trigger deploy → Deploy site** (environment variable changes need a new deploy).
3. Check these URLs:

```
https://northstar-parent.<ROOT_DOMAIN>/healthz   →  {"status":"ok","role":"parent"}
https://northstar-widget.<ROOT_DOMAIN>/healthz   →  {"status":"ok","role":"widget"}
https://northstar-verify.<ROOT_DOMAIN>/healthz   →  {"status":"ok","role":"verify"}
https://northstar-parent.<ROOT_DOMAIN>/scenario/clean-control   →  the clean control page
https://northstar-parent.<ROOT_DOMAIN>/scenario/datadome        →  a 403 page with a frame
```

Then click **Complete scenario** on any lane. It should end on "Scenario complete".

## 7. Cloudflare lane (last)
Follow [cloudflare-waf.md](cloudflare-waf.md): switch `northstar-parent` to **Proxied**, add the Configuration Rule, then add the WAF rule as a draft and enable it after `healthz` works through the proxy.

## Notes
- **Strong-consistency serverless state (Netlify Blobs).** Netlify may run consecutive requests (`POST /api/runs`, multi-step Vision `POST /api/input|verify|settle`, `GET /complete/{token}`, and `GET /api/evidence/{token}`) on different function instances. The Netlify adapter automatically uses `@netlify/blobs` (`getStore({ name: 'northstar-state', consistency: 'strong' })`) in Netlify's runtime so oracle state and revocation are read-after-write consistent across instances, while falling back cleanly to `MemoryStore` locally. Legacy 14-lane flows also continue to carry signed stateless progress proofs (`x-northstar-proof` / `?p=...`). To invalidate all active tokens immediately, rotate `NORTHSTAR_TOKEN_SIGNING_KEY` and redeploy.
- **Rollback.** Set `NORTHSTAR_ENABLED=false` and redeploy (about a minute), or use Netlify's *Deploys → Publish deploy* on an earlier build. Full details are in [rollback.md](rollback.md).
