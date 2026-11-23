# Cloudflare WAF lane (northstar-01 only)

`northstar-01.<ROOT_DOMAIN>` serves an ordinary origin page. Cloudflare adds the challenge at the edge. For that to work, the hostname's DNS record must be **Proxied** (orange cloud), even if the site is hosted on Vercel or Netlify.

**Prerequisite:** the root domain's DNS must be on Cloudflare (nameservers pointed to Cloudflare; the free plan is fine).

## 1. Rule (create it as a DRAFT or disabled)

Go to **Cloudflare dashboard → your domain → Security → WAF → Custom rules → Create rule**.

- **Name:** `Northstar lane 01 (test infrastructure)`
- **Expression** (use *Edit expression*, then replace `<ROOT_DOMAIN>`):

```
(http.host eq "northstar-01.<ROOT_DOMAIN>" and not starts_with(http.request.uri.path, "/.well-known/acme-challenge/") and not http.request.uri.path in {"/healthz" "/readyz" "/fixture-manifest.json"})
```

- **Action:** `Managed Challenge`
- Click **Save as Draft**, not *Deploy*.

`npm run plan` writes this expression with your real domain already filled in, to `deployment/generated/<ROOT_DOMAIN>/cloudflare-waf-rule.txt`.

### Why it can't match anything else
- `http.host eq` is an **exact** match on one hostname. It cannot match `<ROOT_DOMAIN>`, `www.<ROOT_DOMAIN>`, or any other `northstar-*` host.
- Certificate renewal (`/.well-known/acme-challenge/`) and the health endpoints are excluded, so TLS and monitoring keep working.

## 2. SSL mode for this one hostname (Vercel/Netlify hosting only)
Go to **Rules → Configuration Rules → Create**, set *Hostname equals `northstar-01.<ROOT_DOMAIN>`*, then set **SSL → Full (strict)**. This scopes the setting to lane 01 instead of changing the zone-wide SSL mode.

## 3. Enable only after the host is confirmed
1. Check that `https://northstar-01.<ROOT_DOMAIN>/healthz` returns `200` through the proxy. The response should include a `cf-ray` header.
2. Turn the rule on.
3. Check that `https://northstar-01.<ROOT_DOMAIN>/` now returns **403** with `cf-mitigated: challenge`.
4. Check that `/healthz` still returns 200, and that `npm run verify-deployment -- --i-approve-external-requests` reports no `cf-mitigated` on any other host.

## Rollback (any one step is enough; fastest first)
1. Toggle the rule **off**, or delete it.
2. Switch the `northstar-01` DNS record to **DNS only** (grey cloud).
3. Delete the `northstar-01` DNS record.
