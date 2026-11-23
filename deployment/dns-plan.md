# DNS record template (12 hostnames)

**Do not create any record until the hosting platform has given you its DNS target.**
Once you have it, run `npm run plan -- --root-domain <ROOT_DOMAIN> --platform <p> --target <TARGET>`. That writes a filled-in copy plus a BIND `zone.txt` to `deployment/generated/<ROOT_DOMAIN>/`.

| Hostname | Type | Name | Target | TTL | Cloudflare proxy* |
|---|---|---|---|---|---|
| northstar-control.<ROOT_DOMAIN> | CNAME | northstar-control | <HOSTING_PLATFORM_TARGET> | 300 | DNS only |
| northstar-01.<ROOT_DOMAIN> | CNAME | northstar-01 | <HOSTING_PLATFORM_TARGET> | 300 | **Proxied** (Cloudflare WAF lane) |
| northstar-02.<ROOT_DOMAIN> | CNAME | northstar-02 | <HOSTING_PLATFORM_TARGET> | 300 | DNS only |
| northstar-03.<ROOT_DOMAIN> | CNAME | northstar-03 | <HOSTING_PLATFORM_TARGET> | 300 | DNS only |
| northstar-04.<ROOT_DOMAIN> | CNAME | northstar-04 | <HOSTING_PLATFORM_TARGET> | 300 | DNS only |
| northstar-05.<ROOT_DOMAIN> | CNAME | northstar-05 | <HOSTING_PLATFORM_TARGET> | 300 | DNS only |
| northstar-06.<ROOT_DOMAIN> | CNAME | northstar-06 | <HOSTING_PLATFORM_TARGET> | 300 | DNS only |
| northstar-07.<ROOT_DOMAIN> | CNAME | northstar-07 | <HOSTING_PLATFORM_TARGET> | 300 | DNS only |
| northstar-08.<ROOT_DOMAIN> | CNAME | northstar-08 | <HOSTING_PLATFORM_TARGET> | 300 | DNS only |
| northstar-09.<ROOT_DOMAIN> | CNAME | northstar-09 | <HOSTING_PLATFORM_TARGET> | 300 | DNS only |
| northstar-10.<ROOT_DOMAIN> | CNAME | northstar-10 | <HOSTING_PLATFORM_TARGET> | 300 | DNS only |
| northstar-11.<ROOT_DOMAIN> | CNAME | northstar-11 | <HOSTING_PLATFORM_TARGET> | 300 | DNS only |

\* **Cloudflare Workers/Pages exception:** if you host *on* Cloudflare, you don't create these records by hand. Adding the 12 Worker Custom Domains creates them, and they are always proxied. The WAF rule stays scoped to `northstar-01` only.

Rules:
- Use a TTL of 300 seconds to start.
- Create one record per name. Never add both an A record and a CNAME for the same name.
- Don't use wildcard records.
- If the platform gives you an IP address instead of a hostname, use **A** records with that IP.
- Don't change the root domain or any existing subdomain.
- Cloudflare-specific configuration (WAF rule, SSL configuration rule) applies to `northstar-01` only.
- Keep Cloudflare **Bot Fight Mode OFF**. It is zone-wide and would affect your root domain.
