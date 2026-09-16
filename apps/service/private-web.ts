import type { IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readServerCredential } from './server-key.js';
import { Fault } from './store.js';

export type PrivateWebOptions = { origin: string; port: number } & (
  { auth?: 'tailscale'; ownerLogin: string } |
  { auth: 'vercel'; proxyKeyFile: string; directory: string }
);
export function privateWebOptions(env: NodeJS.ProcessEnv = process.env): PrivateWebOptions | undefined {
  const values = [env.E3_WEB_ORIGIN, env.E3_WEB_OWNER_LOGIN, env.E3_WEB_PORT, env.E3_WEB_AUTH, env.E3_WEB_PROXY_KEY_FILE];
  if (!values.some(value => value !== undefined)) return undefined;
  const origin = env.E3_WEB_ORIGIN ?? '', ownerLogin = env.E3_WEB_OWNER_LOGIN ?? '', rawPort = env.E3_WEB_PORT ?? '4386';
  if (env.E3_WEB_AUTH !== undefined && !['tailscale', 'vercel'].includes(env.E3_WEB_AUTH)) throw new Error('Select tailscale or vercel web authentication.');
  if (env.E3_WEB_AUTH === 'vercel' ? env.E3_WEB_OWNER_LOGIN !== undefined : env.E3_WEB_PROXY_KEY_FILE !== undefined) throw new Error('Do not mix private network identity and Vercel proxy credentials.');
  const result: PrivateWebOptions = env.E3_WEB_AUTH === 'vercel'
    ? { origin, port: Number(rawPort), auth: 'vercel', proxyKeyFile: env.E3_WEB_PROXY_KEY_FILE ?? '', directory: env.E3_DATA_DIR ?? '' }
    : { origin, ownerLogin, port: Number(rawPort) };
  validatePrivateWeb(result);
  if (result.auth === 'vercel') {
    // The gateway credential is disposable. It must never be the encryption key.
    if (!env.E3_SERVER_KEY_FILE) throw new Error('Vercel hosting requires a separate workspace credential.');
    const gateway = readServerCredential(result.proxyKeyFile, result.directory), workspace = readServerCredential(env.E3_SERVER_KEY_FILE, result.directory);
    try { if (timingSafeEqual(gateway, workspace)) throw new Error('Use independent proxy and workspace credentials.'); }
    finally { gateway.fill(0); workspace.fill(0); }
  }
  if (!/^[1-9][0-9]{3,4}$/.test(rawPort)) throw new Error('Use a dedicated unprivileged private web port.');
  return result;
}
export function validatePrivateWeb(value: PrivateWebOptions) {
  let url: URL; try { url = new URL(value.origin); } catch { throw new Error('Use the exact private HTTPS origin for this server.'); }
  if (url.origin !== value.origin || url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Use the exact private HTTPS origin on port 443.');
  if (value.auth === 'vercel') {
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.vercel\.app$/.test(url.hostname)) throw new Error('Use the exact production vercel.app HTTPS origin.');
    readServerCredential(value.proxyKeyFile, value.directory).fill(0);
  } else {
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/.test(url.hostname)) throw new Error('Use the exact private Tailscale HTTPS origin on port 443.');
    if (!value.ownerLogin || value.ownerLogin !== value.ownerLogin.trim() || value.ownerLogin.length > 200 || /[\s,\x00-\x1f\x7f]/.test(value.ownerLogin)) throw new Error('Set the exact Tailscale owner login for private web access.');
  }
  if (!Number.isInteger(value.port) || value.port < 0 || value.port > 65535 || value.port > 0 && value.port < 1024) throw new Error('Use a dedicated unprivileged private web port.');
  return value;
}
export function authorizePrivateWeb(request: IncomingMessage, value: PrivateWebOptions) {
  const denied = () => new Fault(403, 'web_owner_required', 'Connect through this workspace’s protected owner address.');
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) throw denied();
  if (value.auth !== 'vercel') { if (request.headers['tailscale-user-login'] !== value.ownerLogin) throw denied(); return; }
  // Vercel Authentication gates the configured production project. Its routing
  // middleware replaces this header using a server-only independent credential.
  // Caddy terminates origin TLS and forwards to this loopback listener; neither
  // public caller identity headers nor a leaked browser cookie grants access.
  const supplied = request.headers['x-nova-proxy-key'];
  if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || request.headers['x-nova-public-origin'] !== value.origin) throw denied();
  let expected: Buffer;
  try { expected = readServerCredential(value.proxyKeyFile, value.directory); } catch { throw denied(); }
  try { if (!timingSafeEqual(Buffer.from(supplied, 'hex'), expected)) throw denied(); }
  finally { expected.fill(0); }
}
