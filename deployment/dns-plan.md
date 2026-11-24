# DNS record template (three hostnames)

**Do not create any record until the hosting platform has given you its DNS target.**
Once you have it, run `npm run plan -- --root-domain <ROOT_DOMAIN> --platform <p> --target <TARGET>`. That writes a filled-in copy plus a BIND `zone.txt` to `deployment/generated/<ROOT_DOMAIN>/`.

| Role | Hostname | Type | Name | Target | TTL | Cloudflare proxy* |
|---|---|---|---|---|---|---|
| parent | northstar-parent.<ROOT_DOMAIN> | CNAME | northstar-parent | <HOSTING_PLATFORM_TARGET> | 300 | **DNS only at first**, then Proxied in the Cloudflare-lane step |
| widget | northstar-widget.<ROOT_DOMAIN> | CNAME | northstar-widget | <HOSTING_PLATFORM_TARGET> | 300 | DNS only |
| verify | northstar-verify.<ROOT_DOMAIN> | CNAME | northstar-verify | <HOSTING_PLATFORM_TARGET> | 300 | DNS only |

All three records point at the **same** hosting project. The app decides the role from the `Host` header.

**Order matters:** create all three as **DNS only**. Vercel/Netlify can only issue each hostname's HTTPS certificate while Cloudflare is not proxying it. Switch `northstar-parent` to **Proxied** only after the platform shows its certificate as issued and `https://northstar-parent.<ROOT_DOMAIN>/healthz` works ([cloudflare-waf.md](cloudflare-waf.md) §3).

\* **Cloudflare Workers exception:** if you host *on* Cloudflare, you don't create these records by hand. Adding the three Worker Custom Domains creates them, and they are always proxied. The WAF rule stays scoped to the parent host and the `/scenario/cloudflare` path.

Rules:
- Use a TTL of 300 seconds to start.
- Create one record per name. Never add both an A record and a CNAME for the same name.
- Don't use wildcard records.
- If the platform gives you an IP address instead of a hostname, use **A** records with that IP for all three names.
- Don't change the root domain or any existing subdomain.
- Cloudflare-specific configuration (the WAF rule and the configuration rule) applies to `northstar-parent` only.
- Keep Cloudflare **Bot Fight Mode OFF**. It is zone-wide and would inject challenge scripts into the other scenario pages.
