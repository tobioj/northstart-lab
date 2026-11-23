# Rollback and removal

The lab touches nothing on the root domain, so every step below leaves the main domain unaffected.

| Severity | Action | Effect | Time |
|---|---|---|---|
| 1. Cloudflare lane misbehaving | Turn the `Northstar lane 01` WAF rule **off** | Lane 01 serves the plain origin page | Seconds |
| 2. Need everything dark, keep setup | Set `NORTHSTAR_ENABLED=false` on the platform (redeploy if needed) | Every route on all 12 hosts returns `503 {"status":"unavailable"}` | About 1 minute |
| 3. Remove proxying | Set the `northstar-01` DNS record to DNS-only | Cloudflare no longer sits in front of lane 01 | Up to TTL (300s) |
| 4. Remove public exposure | Delete the 12 `northstar-*` DNS records (or the Worker custom domains) | Hostnames stop resolving | Up to TTL (300s) |
| 5. Full removal | Delete the hosting project/Worker, the WAF rule, the Configuration Rule, and the hCaptcha/reCAPTCHA site entries | Nothing remains | Minutes |

Local removal: delete the `northstar-lab/` folder. Nothing outside it is written. The browser harness uses a temporary profile that it deletes after each run.

Previous version: redeploy the previous build from the platform's deployment history (Vercel/Netlify "Promote/Publish previous deploy", `wrangler rollback`). Each page displays its build ID, so you can confirm which build is live.
