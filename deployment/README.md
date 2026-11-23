# Deployment adapters

The pages, handler, configuration and tests are shared. Only this thin layer differs per platform:

| Concern | Vercel | Netlify | Cloudflare Workers / Pages | Generic Node |
|---|---|---|---|---|
| Routing | `vercel.json` rewrite of every path to `api/northstar` | Function `config.path = "/*"` | Worker receives every request on its custom domains | `scripts/serve.js` (Node http) |
| Function format | Web `GET/HEAD/...` exports (`adapters/vercel/api/northstar.js`) | Functions v2 default export (`adapters/netlify/...northstar.mjs`) | `export default { fetch }` (`adapters/cloudflare/worker.js`); Pages: same file as `_worker.js` | `functions/node-adapter.js` |
| Env / secrets | Project env vars; secrets as *Sensitive* | Site env vars; secrets marked *Contains secret values* | `[vars]` in `wrangler.toml`; secrets via `wrangler secret put` | Container/VM env vars |
| Custom domains | Project → Settings → Domains (12 entries) | Domain management → domain aliases (12) | `routes = [{ pattern, custom_domain = true }]` (auto DNS + TLS) | Your reverse proxy / load balancer |
| Build / deploy | `vercel deploy --prod` | `netlify deploy --prod` | `npx wrangler deploy` | `docker build` / `docker run` |

Prepare a platform folder (nothing is uploaded):

```
npm run plan -- --root-domain <ROOT_DOMAIN> --platform <vercel|netlify|cloudflare|node> --target <DNS_TARGET>
npm run prepare-deploy -- <vercel|netlify|cloudflare|node>
```

`prepare-deploy` writes `dist/<platform>/` and prints the exact commands for that platform.
**No deployment happens until you run the final deploy command yourself (or approve me running it).**

## Platform notes that affect fixtures

- **Server header.** Vercel, Netlify and Cloudflare overwrite the `Server` response header. On those platforms lane 05 is still recognized through `akamai-grn` and `/_sec/cp_challenge`, which is enough for the registry. Only generic Node hosting keeps `server: akamaighost` too.
- **Cloudflare proxy headers.** Any proxied hostname gets `cf-ray` and `server: cloudflare`. The registry only treats `cf-mitigated: challenge` as Cloudflare, so proxied lanes do not falsely look like Cloudflare. Even so, the spec keeps every lane except 01 **DNS-only** when hosting on Vercel, Netlify or Node.
- **Vercel rewrites.** The adapter recovers the original path from `__ns_path`. After the first preview deploy, run `npm run verify-deployment` to confirm that every path routes correctly.

Files: [dns-plan.md](dns-plan.md) · [cloudflare-waf.md](cloudflare-waf.md) · [deployment-checklist.md](deployment-checklist.md) · [tls-checklist.md](tls-checklist.md) · [rollback.md](rollback.md) · [waiting-on-you.md](waiting-on-you.md)
