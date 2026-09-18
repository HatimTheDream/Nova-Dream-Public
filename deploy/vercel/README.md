# Nova Dream private Vercel gateway

Deploy **only this directory** as a separate Vercel project, using the Other framework preset. It contains routing code and a holding page, never the owner's database, attachments, OAuth/AI credentials or application source. The frozen client and durable service both remain on the VPS; Vercel gives them one browser-visible `https://<project>.vercel.app` address through native external rewrites.

This is a template for your deployment. Verify your project, origin DNS/TLS, real forwarding and Linux host before enabling access. The gateway starts disabled. `NOVA_GATEWAY_ENABLED=verified` is an operator switch; it does **not** query or prove the project's security settings.

## Required setup order

1. Create a personal Hobby project with only the owner as a permitted user. Keep the gateway disabled, with no production origin credential configured. Select **Security → Deployment Protection → Vercel Authentication → All Deployments**. No protection exceptions, shared links, bypass tokens, extra collaborators or production aliases are part of this recipe. Review existing project access before attaching Nova.
2. Verify anonymously that both `/` and `/api/health` on the production address and each deployment alias are blocked by Vercel. A public holding page or this middleware's 503 does not prove deployment protection. Review the actual setting as well as anonymous responses. Record this evidence before enabling anything.
3. Prepare the VPS using `../README.md`, `../vercel-host.env.example`, the dedicated systemd credential drop-in `../vercel-proxy.conf`, and `../Caddyfile.vercel.example`. Leave the ordinary owner administration and web ports on loopback. Do not use the Tailscale identity mode behind Caddy.
4. Generate a new independent 32-byte credential at `/etc/nova/vercel-proxy.key`, mode 0600, outside the workspace and release. The existing `server:key:init` command can provision this path without overwriting it. This must differ from the workspace encryption credential. Configure its **hex encoding** as `NOVA_PROXY_KEY` in Vercel's **Production-only**, server-side environment. Do not print it into logs, embed it in `vercel.json`, prefix it with `VITE_`, or give Preview/Development access.
5. Configure `NOVA_PUBLIC_ORIGIN` as the exact production origin, and `NOVA_ORIGIN` as the VPS's exact, verified public HTTPS origin. Both require port 443 with no path. Confirm its public certificate and renewal; never disable TLS verification. The provider-assigned hostname is the first candidate for the backend; DNS and certificate issuance remain an actual-host check. If it is unsuitable, select a free DNS hostname before enabling the gateway rather than buying a domain implicitly.
6. Only after protection is verified, set `NOVA_GATEWAY_ENABLED=verified`, deploy the gateway, and repeat anonymous checks. Use a disposable server workspace for the first signed-in test. All noncanonical aliases and nonproduction environments are denied by middleware even after sign-in.
7. Test the actual signed-in journey: return from login, open Nova, save/reload a task, restart the VPS and retain that task, reconnect OAuth, voice, large attachment/backup transfers, and a background assignment. Verify that no proxy credential or Vercel authentication cookie appears in browser responses or origin logs. Direct-origin requests, even with a Nova browser cookie and spoofed Tailscale headers, must return 403.
8. Measure request counts, origin transfer, CPU/memory and latency before moving the owner's workspace. Close idle test clients. Keep the current Mac workspace and its rollback snapshot until real migration and phone acceptance pass.

The gateway forwards only the existing Nova cookie and request-guard headers. Large uploads use the app's authenticated piece transport to remain below Vercel's per-request limit. It replaces caller-supplied proxy identity; it does not buffer request bodies. Vercel's router handles the external transfer. Its SDK's internal `x-middleware-request-*` response is a routing instruction, not a browser response; verifying that Vercel consumes these headers is part of real acceptance.

## Operation and revocation

Vercel Authentication is the **owner authentication authority**. A shared secret authenticates the gateway to Nova, not the human user. Turning off project protection or adding project users would widen access to the whole Nova workspace. Never use a publicly accessible project with this recipe.

To disconnect the gateway, disable its enable switch and stop the VPS web route. To revoke a leaked origin credential immediately, remove/replace the active credential and restart the systemd unit, which refreshes `LoadCredential`; then update the Production secret and redeploy Vercel. Do not change `/etc/nova/server.key`. Nova rereads its delivered proxy credential on each authenticated request, including reauthorization before writes.

Hobby is for personal/non-commercial usage. Its current allowances include one million edge requests/month and 10 GB origin transfer; API polling and downloads consume these. Exceeding a limit can pause service. Review current provider terms and limits before choosing a plan. Background agents execute on the VPS independently of browser requests; the browser needs to be open only for interaction.

See [the host recipe](../README.md) for deployment and recovery. Official references: [external rewrites](https://vercel.com/docs/routing/rewrites), [request-header replacement](https://vercel.com/kb/guide/modify-request-headers), [production authentication](https://vercel.com/changelog/protect-production-deployments-for-free-on-every-plan), [Hobby limits](https://vercel.com/docs/plans/hobby), [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

## Changing the hosted address

Back up the host configuration and persistent databases before changing the canonical origin. Keep Vercel Authentication required for All Deployments throughout the change.

1. Attach the new production domain to the existing protected project.
2. Replace the web callback URL in each configured OAuth provider with the new origin plus `/oauth/callback`. Preserve desktop callbacks and existing credentials.
3. Update Production `NOVA_PUBLIC_ORIGIN` and redeploy the gateway. Update host `E3_WEB_ORIGIN` and Caddy's upstream `Host` to the same origin/hostname, validate and reload Caddy, then restart the service. Expect a short access interruption while these settings differ.
4. Verify the signed-in app and saved workspace at the new address, API health, anonymous authentication requirements and direct-origin rejection before removing the old domain.
5. Update current links and local deployment metadata. Historical deployment URLs and Git history remain historical records. Browser-local drafts/settings belong to the original browser origin and do not automatically migrate.

A hosting configuration/documentation change alone does not change the application version or require rebuilding its installer.
