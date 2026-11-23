# Rollback and removal

The lab touches nothing on the root domain, so every step below leaves the main domain unaffected.

| Severity | Action | Effect | Time |
|---|---|---|---|
| 1. Cloudflare lane misbehaving | Turn the `Northstar Cloudflare lane` WAF rule **off** | `/scenario/cloudflare` serves the plain origin page | Seconds |
| 2. Revoke one scenario instance | `POST https://northstar-verify.<ROOT_DOMAIN>/api/manage/revoke/{token}` with the management bearer | That instance's page, widget resources and verification return 410 | Seconds |
| 3. Invalidate every outstanding token | Rotate `NORTHSTAR_TOKEN_SIGNING_KEY` in the platform secret manager and redeploy | All earlier tokens stop validating | About 1 minute |
| 4. Need everything dark, keep setup | Set `NORTHSTAR_ENABLED=false` on the platform (redeploy if needed) | Every route on all three hosts returns `503 {"status":"unavailable"}` | About 1 minute |
| 5. Remove proxying | Set the `northstar-parent` DNS record to DNS-only | Cloudflare no longer sits in front of the parent host | Up to TTL (300s) |
| 6. Remove public exposure | Delete the three `northstar-*` DNS records (or the Worker custom domains) | Hostnames stop resolving | Up to TTL (300s) |
| 7. Full removal | Delete the hosting project/Worker, the WAF rule, the Configuration Rule, and the platform secrets | Nothing remains | Minutes |

**Previous version:** redeploy the previous build from the platform's deployment history (Vercel/Netlify "Promote/Publish previous deploy", `wrangler rollback`). Each page displays its build ID, so you can confirm which build is live.

**Back to the 12-hostname design:** check out `main` at commit `5db1015` (the preserved baseline). That design needs one DNS record per lane instead of three. It is kept for reference only.

**Local removal:** delete the `northstar-lab/` folder. Nothing outside it is written. The browser harness uses a temporary profile that it deletes after each run.
