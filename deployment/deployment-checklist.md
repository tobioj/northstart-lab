# Deployment checklist (three hostnames)

## Before anything external
- [ ] `npm test` passes locally, including the real-browser run.
- [ ] `npm run evidence` has been run and `evidence/SUMMARY.md` has been reviewed.
- [ ] Root domain chosen. The three `northstar-*` hostnames are confirmed disposable test infrastructure.
- [ ] Hosting platform chosen.

## Plan (local only)
- [ ] `npm run plan -- --root-domain <ROOT_DOMAIN> --platform <p> --environment staging` has been run.
- [ ] `configuration/deploy.env` has been reviewed. It holds non-secret values only and has `NORTHSTAR_ENABLED=false`.
- [ ] `npm run prepare-deploy -- <p>` has been run and `dist/<p>/` exists.

## Hosting project (you)
- [ ] **One** project has been created or linked (see the commands printed by prepare-deploy).
- [ ] Every `NORTHSTAR_*` variable from `deploy.env` has been added to the platform.
- [ ] `NORTHSTAR_TOKEN_SIGNING_KEY` has been generated **on your machine** and stored **only** in the platform's secret manager. Optionally, `NORTHSTAR_MANAGEMENT_AUTHORITY` too.
- [ ] The three hostnames have been added to that project: `northstar-parent`, `northstar-widget`, `northstar-verify`.
- [ ] The platform's DNS target (CNAME target or IP) has been noted.

## DNS (you)
- [ ] `npm run plan -- ... --target <DNS_TARGET>` has been re-run so the plan carries the real target.
- [ ] Three records have been created exactly as listed in `deployment/generated/<ROOT_DOMAIN>/dns-plan.md`, all with TTL 300.
- [ ] All three records start **DNS only** so the platform can issue certificates (Cloudflare Workers: automatic, skip).
- [ ] Cloudflare Bot Fight Mode is OFF, and the parent-host Configuration Rule is in place ([cloudflare-waf.md](cloudflare-waf.md) §1).

## Deploy (only after approval)
- [ ] External deployment has been explicitly approved in chat.
- [ ] The platform deploy command has been run.
- [ ] `NORTHSTAR_ENABLED=true` has been set on the platform and the site redeployed.
- [ ] `npm run verify-deployment -- --env-file configuration/deploy.env --i-approve-external-requests` passes. It checks TLS on all three hosts, healthz/readyz, 404 for unknown paths, and the expected status for all 14 lanes.

## Cloudflare lane
- [ ] After the platform shows the `northstar-parent` certificate as issued, that record is switched to **Proxied**.
- [ ] The WAF rule has been created as a draft ([cloudflare-waf.md](cloudflare-waf.md)).
- [ ] The rule is enabled only after the parent host's `/healthz` is confirmed through the proxy.
- [ ] Verified: `/scenario/cloudflare` returns 403 with `cf-mitigated: challenge`, and no other lane is affected.
