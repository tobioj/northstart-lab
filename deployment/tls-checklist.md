# TLS checklist (three hostnames)

`npm run verify-deployment -- --i-approve-external-requests` checks the certificate on each host and saves the result to `evidence/deployment-verification.json`.

- [ ] `northstar-parent`, `northstar-widget` and `northstar-verify` each serve a valid certificate whose name matches the hostname (`tls=ok` in verify-deployment).
- [ ] All three origins are configured as `https://` in `NORTHSTAR_*_ORIGIN`. The app refuses plain `http` outside local development.
- [ ] Certificates are issued and auto-renewed by the platform: Vercel, Netlify, Cloudflare Universal SSL, or your proxy's ACME client.
- [ ] Proxied `northstar-parent`: the edge certificate comes from Cloudflare Universal SSL, which covers first-level subdomains.
- [ ] Proxied `northstar-parent` on Vercel/Netlify/Node: SSL is set to **Full (strict)** through the hostname-scoped Configuration Rule, and the origin certificate for that hostname is valid.
- [ ] The WAF rule matches only `/scenario/cloudflare…`, so `/.well-known/acme-challenge/` renewals are never challenged.
- [ ] HTTP redirects to HTTPS. This is the platform default; turn on "Always Use HTTPS" only through a hostname-scoped rule.
- [ ] **No HSTS preload** and no `includeSubDomains` HSTS set on the root domain because of this lab.
- [ ] No certificate or private key is stored in this repository.
- [ ] Expiry dates have been recorded (`validTo` in deployment-verification.json).
