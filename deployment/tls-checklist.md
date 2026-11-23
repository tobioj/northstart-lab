# TLS checklist

`npm run verify-deployment -- --i-approve-external-requests` checks the certificate on every host and saves the result to `evidence/deployment-verification.json`.

- [ ] All 12 hostnames serve a valid certificate whose name matches the hostname (`tls=ok` in verify-deployment).
- [ ] Certificates are issued and auto-renewed by the platform: Vercel, Netlify, Cloudflare Universal SSL, or your proxy's ACME client.
- [ ] Cloudflare-proxied `northstar-01`: the edge certificate comes from Cloudflare Universal SSL, which covers first-level subdomains such as `northstar-01.<ROOT_DOMAIN>`.
- [ ] Cloudflare-proxied `northstar-01` on Vercel or Netlify: SSL is set to **Full (strict)** through a hostname-scoped Configuration Rule, and the origin certificate is valid.
- [ ] ACME challenge path `/.well-known/acme-challenge/` is excluded from the WAF rule, so renewals keep working.
- [ ] HTTP redirects to HTTPS. This is the platform default on Vercel, Netlify and Cloudflare; turn on "Always Use HTTPS" only through a hostname-scoped rule.
- [ ] **No HSTS preload** and no `includeSubDomains` HSTS set on the root domain because of this lab.
- [ ] No certificate or private key is stored in this repository.
- [ ] Expiry dates have been recorded (`validTo` in deployment-verification.json).
