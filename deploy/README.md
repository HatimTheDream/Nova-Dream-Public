# Nova Dream web host

The web application and its agent runtime run on one durable host. Browsers are clients. A future optional Mac companion connects local tools to that same workspace; it must not create a second database or dispatcher. Closing the Mac will not stop VPS work. Mac-specific tools are available only while that companion is connected.

This directory contains templates for your own private Linux deployment. Configure your own accounts, hostnames and protected credentials; the templates do not provision infrastructure. The reference architecture has been exercised on Ubuntu 26.04, but you must verify your own host, TLS, authentication, backups and connected services. Use either [the protected Vercel gateway](vercel/README.md) or the Tailscale recipe below.

## Host layout

- `/opt/nova/releases/<version-and-candidate>/`: immutable built app, lockfile and matching production dependencies. `/opt/nova/current` selects one release.
- `/opt/nova/runtime/node/`: verified Node **22.23.2** distribution for the VPS architecture. The service requires Node ≥22.19; this recipe retains the tested 22.23.2 runtime.
- `/opt/nova/runtime/openclaw/`: pinned **OpenClaw 2026.9.2** with its dependencies. Native plugins and their owned history remain under the workspace. Do not replace the pinned runtime with a floating latest version.
- `/var/lib/nova/workspace/`: persistent database, attachments, backups and owned agent runtime. Updates must keep this exact path, including native history.
- `/etc/nova/server.key`: separately backed-up, private 32-byte server credential. `LoadCredential` delivers it to the service without placing secret bytes in environment variables. It must not be stored inside the workspace, source tree or app archive.
- `/etc/nova/host.env`: the exact private HTTPS origin and owner Tailscale login. No passwords or account tokens belong here.

Prepare the `nova` service account and these paths on the selected host. Install matching locked production dependencies using `npm ci --omit=dev` inside the release. `postinstall` prepares the pinned PTY helper only on macOS; Linux uses its platform dependency. The release must contain `dist`, `package.json`, `package-lock.json`, `scripts/host.mjs`, `scripts/candidate.mjs` and `scripts/prepare-pty.mjs`.

Run `npm run server:key:init -- --file=/etc/nova/server.key` once with the appropriate host permissions, then preserve an independent protected copy. The command refuses to overwrite any existing credential. Do not regenerate it during an update or restart. A missing, changed or unreadable credential stops startup without replacing saved material. Server credential protection is distinct from an OS keychain or managed KMS; an administrator who can access the credential can unlock the workspace.

## Private browser entry

`host.mjs` validates every built artifact, selects its exact candidate identity and requires an absolute data directory outside the app release. Local administration stays on loopback port 4383. The private web listener stays on loopback port 4386 and rejects every request without the exact configured Tailscale owner identity, HTTPS host and normal request guards. It uses independent Secure/HttpOnly/SameSite cookies. Ordinary paired-phone access keeps its existing restrictions.

On the chosen VPS, inspect the existing Tailscale Serve configuration before adding a route. With port 443 unoccupied, route private HTTPS to `http://127.0.0.1:4386`. Keep Funnel off; never expose ports 4383/4386 directly or trust caller-supplied identity headers through a public proxy. Tailscale's authenticated Serve proxy is the authority that supplies `Tailscale-User-Login`; a matching header from the public internet is not authentication.

Copy `host.env.example` with the VPS's actual values. The systemd unit runs under the dedicated account, keeps data writable, code read-only, restarts failed processes and drains the owned process group on stop. Its `LoadCredential` directive requires a compatible Linux/systemd host. The template copies systemd-delivered credentials into a service-private runtime directory with mode 0400. This preserves the application check that rejects group-readable keys; do not relax that check if your systemd version exposes its delivered credentials as 0440. The runtime copy is recreated from the root-protected credential on each service start.

## Account setup

Google/Microsoft server OAuth uses the exact web callback shown in Settings, `https://<private-host>/oauth/callback`. Register it as a **Web application** redirect. Client secrets stay in encrypted host storage and are used only by the server token exchange. A Desktop OAuth registration may need a separate Web registration; do not overwrite the working Mac registration casually. Callback state and PKCE remain bound to one active attempt, and cancelled/expired/replayed responses cannot exchange another code.

ChatGPT server setup offers the supported device-code flow. Accounts that disable device-code sign-in still need a separately prepared temporary host connection for OpenAI's localhost browser callback. Do not rewrite that provider callback, copy browser cookies or treat that limitation as solved. Signing in does not activate a microphone.

## Optional Assistant web search

The pinned **OpenClaw 2026.9.2** runtime supports Codex Hosted Search through an existing OpenAI/Codex sign-in. A separate search API key or account is not required for this route. It is an explicit operator choice: key-free managed providers are not selected automatically, and signing in for model replies alone does not prove that managed web search is configured.

For a host that should use that route, merge this patch into its existing owned runtime configuration:

```json
{
  "tools": {
    "web": {
      "search": {
        "enabled": true,
        "provider": "codex",
        "openaiCodex": {
          "enabled": true,
          "mode": "live"
        }
      }
    }
  }
}
```

Keep any existing domain restrictions and other settings. The Codex plugin must already be enabled and permitted, and the selected agent must have supported OpenAI authentication. Do not replace credentials or import an unrelated desktop account to make a search test pass.

Back up the configuration, then use the service account and the **same isolated runtime environment/configuration path** as the running Assistant. Save the patch as a local JSON file and validate it with `openclaw config patch --file <patch-file> --dry-run --json`. Apply the reviewed patch with `openclaw config patch --file <patch-file>`; authenticated native `config.patch` is also supported and accepts the fresh revision from `config.get`. Do not point an ambient personal OpenClaw profile at this operation.

Under the runtime's normal `hybrid` reload mode, these tool settings apply without restarting the Gateway. Confirm the accepted configuration and actual running state; a saved file or a successful validation alone is not acceptance. Run a fresh Research task that discovers a source through `web_search`, reads a returned page and produces usable citations. A successful direct page fetch does not establish that search works.

See the [version-pinned web search guidance](https://github.com/openclaw/openclaw/blob/v2026.9.2/docs/tools/web.md#native-codex-web-search). This configures Nova's existing Research workflow; it does not provide or certify ChatGPT's proprietary Deep research engine.

## Backup, update and return

Keep an encrypted app export, a closed database/attachment snapshot, the separate server credential and the previous verified release before changing the selected release. Preserve the absolute workspace/native-history paths. Stop one dispatcher before starting its replacement. Verify candidate health, saved record/link/blob identity, account state and one browser/phone journey after restart. Return to the previous release only with a schema-compatible paired snapshot; never run older code against a newer migrated database by assumption.

Restored local records can be reviewed and activated through the existing recovery switch. Extra loopback review windows require a temporary host connection. Independent relocation of the existing Mac's paginated native AI history remains an upstream limitation and must not be hidden by a raw database edit. Any transfer of an existing workspace requires a separate backup/recovery review and fresh supported account sign-in.

## References

- [OpenClaw Linux/VPS architecture](https://github.com/openclaw/openclaw/blob/main/docs/vps.md)
- [Google Web application OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Microsoft authorization-code flow and confidential clients](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
- [systemd service credentials](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#LoadCredential=ID:PATH)
- [Tailscale Serve identity headers](https://tailscale.com/kb/1312/serve)
