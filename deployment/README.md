# Deployment (platform-neutral)

Start with [architecture.md](architecture.md) for the three hostnames, the route matrix and the security rules.

One hosting project serves all three hostnames. The pages, handler, configuration and tests are shared; only this thin layer differs per platform:

| Concern | Vercel | Netlify | Cloudflare Workers / Pages | Generic Node |
|---|---|---|---|---|
| Routing | `vercel.json` rewrites every path to `api/northstar` (path, query and `Host` preserved) | Function `config.path = "/*"` | Worker receives every request on its custom domains | `scripts/serve.js` (Node http) |
| Function format | Web `GET/POST/...` exports (`adapters/vercel/api/northstar.js`) | Functions v2 default export (`adapters/netlify/...northstar.mjs`) | `export default { fetch }` (`adapters/cloudflare/worker.js`) | `functions/node-adapter.js` |
| Non-secret config | Project env vars | Site env vars | `[vars]` in `wrangler.toml` | Container/VM env vars |
| Secrets (`NORTHSTAR_TOKEN_SIGNING_KEY`, optional `NORTHSTAR_MANAGEMENT_AUTHORITY`) | `vercel env add … --sensitive` | Env var marked *Contains secret values* | `wrangler secret put` | Your platform's secret store |
| Custom domains | Project → Settings → Domains (3 entries) | Domain management → domain aliases (3) | `routes = [{ pattern, custom_domain = true }]` (auto DNS + TLS) | Your reverse proxy / load balancer (forward `Host` unchanged) |
| Build / deploy | `vercel deploy --prod` | `netlify deploy --prod` | `npx wrangler deploy` | `docker build` / `docker run` |

Prepare a platform folder (nothing is uploaded):

```
npm run plan -- --root-domain <ROOT_DOMAIN> --platform <vercel|netlify|cloudflare|node> --target <DNS_TARGET>
npm run prepare-deploy -- <vercel|netlify|cloudflare|node>
```

`prepare-deploy` writes `dist/<platform>/` and prints the exact commands for that platform.
**No deployment happens until you run the final deploy command yourself (or explicitly approve me running it).**

## Platform notes that affect fixtures

- **Server header.** Vercel, Netlify and Cloudflare overwrite the `Server` response header. On those platforms the Akamai lane is still recognized through `akamai-grn` and `/_sec/cp_challenge`. Only generic Node hosting also keeps `server: akamaighost`.
- **Cloudflare proxy.** The parent host is proxied for the Cloudflare lane, so every parent response gets `cf-ray` and `server: cloudflare`. The registry treats only `cf-mitigated: challenge` as Cloudflare. Keep Bot Fight Mode, Email Obfuscation and Rocket Loader off for the parent host ([cloudflare-waf.md](cloudflare-waf.md)). `verify-deployment` fails if Cloudflare injects anything into another lane.
- **Scenario state on serverless.** Tokens validate on any instance, and completion progress travels between steps in signed proofs, so steps may land on different instances. Only revocation is instance-local. See [architecture.md](architecture.md#state-on-serverless-platforms).

**Netlify from Git (no CLI):** follow [netlify-setup.md](netlify-setup.md). The repository root is deployable as-is.

Files: [architecture.md](architecture.md) · [dns-plan.md](dns-plan.md) · [cloudflare-waf.md](cloudflare-waf.md) · [deployment-checklist.md](deployment-checklist.md) · [tls-checklist.md](tls-checklist.md) · [rollback.md](rollback.md) · [waiting-on-you.md](waiting-on-you.md)
