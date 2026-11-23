# Deployment checklist

## Before anything external
- [ ] `npm test` passes locally (51 tests, including the real-browser run).
- [ ] `npm run evidence` has been run and `evidence/SUMMARY.md` has been reviewed.
- [ ] Root domain chosen. Every hostname is confirmed disposable test infrastructure.
- [ ] Hosting platform chosen.

## Plan (local only)
- [ ] `npm run plan -- --root-domain <ROOT_DOMAIN> --platform <p> --environment staging` has been run.
- [ ] `configuration/deploy.env` has been reviewed. It holds non-secret values only and has `NORTHSTAR_ENABLED=false`.
- [ ] Public site keys have been added (`--hcaptcha-site-key`, `--recaptcha-site-key`, or edit `deploy.env`).
- [ ] `npm run prepare-deploy -- <p>` has been run and `dist/<p>/` exists.

## Hosting project (you)
- [ ] The project has been created or linked (see the commands printed by prepare-deploy).
- [ ] Every `NORTHSTAR_*` variable from `deploy.env` has been added to the platform.
- [ ] Any private secrets have been added **only** in the platform's secret manager. They are optional; this build does not read them.
- [ ] The 12 hostnames have been added to the project as custom domains.
- [ ] The platform's DNS target (CNAME target or IP) has been noted.

## DNS (you)
- [ ] `npm run plan -- ... --target <DNS_TARGET>` has been re-run so the plan carries the real target.
- [ ] 12 records have been created exactly as listed in `deployment/generated/<ROOT_DOMAIN>/dns-plan.md`, all with TTL 300.
- [ ] `northstar-01` is **Proxied**; the others are DNS-only (unless the site is hosted on Cloudflare Workers).
- [ ] Cloudflare Bot Fight Mode is OFF.

## Deploy (only after approval)
- [ ] `EXTERNAL_DEPLOYMENT_APPROVED=true` has been confirmed in chat.
- [ ] The platform deploy command has been run.
- [ ] `NORTHSTAR_ENABLED=true` has been set on the platform and the site redeployed.
- [ ] `npm run verify-deployment -- --env-file configuration/deploy.env --i-approve-external-requests` passes: TLS ok, healthz 200, readyz 200, and `/` shows the expected status per lane.

## Cloudflare lane
- [ ] The WAF rule has been created as a draft ([cloudflare-waf.md](cloudflare-waf.md)).
- [ ] The rule is enabled only after `northstar-01` `/healthz` is confirmed through the proxy.
- [ ] Verified: lane 01 `/` returns 403 with `cf-mitigated: challenge`, and no other host has `cf-mitigated`.
