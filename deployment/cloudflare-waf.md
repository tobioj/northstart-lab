# Cloudflare lane (parent host, `/scenario/cloudflare` only)

`/scenario/cloudflare/{token}` serves an ordinary origin page. Cloudflare adds the challenge at the edge. For that to work, the `northstar-parent` DNS record must be **Proxied** (orange cloud), even when the site is hosted on Vercel, Netlify or Node.

**Prerequisite:** the root domain's DNS must be on Cloudflare (nameservers pointed to Cloudflare; the free plan is fine).

## 1. Keep Cloudflare from touching the other scenario pages
Because the whole parent host is proxied, make sure Cloudflare injects nothing into the other lanes:

- **Security → Bots:** Bot Fight Mode **OFF**. It is zone-wide and injects `/cdn-cgi/challenge-platform/…` scripts.
- **Rules → Configuration Rules → Create:** *Hostname equals `northstar-parent.<ROOT_DOMAIN>`*. Set **SSL: Full (strict)** (Vercel/Netlify/Node hosting), **Email Obfuscation: Off** and **Rocket Loader: Off**.

`npm run plan` writes this rule with your domain filled in, to `deployment/generated/<ROOT_DOMAIN>/cloudflare-config-rule.txt`.

## 2. WAF rule (create it as a DRAFT or disabled)
Go to **Security → WAF → Custom rules → Create rule**.

- **Name:** `Northstar Cloudflare lane (test infrastructure)`
- **Expression** (use *Edit expression*, then replace `<ROOT_DOMAIN>`):

```
(http.host eq "northstar-parent.<ROOT_DOMAIN>" and (http.request.uri.path eq "/scenario/cloudflare" or starts_with(http.request.uri.path, "/scenario/cloudflare/")))
```

- **Action:** `Managed Challenge`
- Click **Save as Draft**, not *Deploy*.

The filled-in version is in `deployment/generated/<ROOT_DOMAIN>/cloudflare-waf-rule.txt`.

### Why it can't match anything else
- `http.host eq` is an **exact** match on the parent hostname. It cannot match `<ROOT_DOMAIN>`, `www.<ROOT_DOMAIN>`, `northstar-widget` or `northstar-verify`.
- The path test matches only `/scenario/cloudflare` and below. Every other scenario route, `/continue/…`, `/healthz`, `/.well-known/acme-challenge/…` and the assets are untouched.

## 3. Enable only after the host is confirmed
1. Check that `https://northstar-parent.<ROOT_DOMAIN>/healthz` returns `200` through the proxy. The response should include a `cf-ray` header.
2. Turn the rule on.
3. Open `https://northstar-parent.<ROOT_DOMAIN>/scenario/cloudflare`. It should now return **403** with `cf-mitigated: challenge`.
4. Run `npm run verify-deployment -- --i-approve-external-requests`. It fails if any other lane shows `cf-mitigated` or an injected `/cdn-cgi/challenge-platform` script.

## Rollback (any one step is enough; fastest first)
1. Toggle the rule **off**, or delete it.
2. Switch the `northstar-parent` DNS record to **DNS only** (grey cloud). Every other lane keeps working; only the Cloudflare lane loses its edge challenge.
