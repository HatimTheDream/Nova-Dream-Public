// Deploy only this directory. No workspace records, AI credentials or application
// source are required on Vercel. Origin TLS and deployment protection are required.
const publicHost = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.vercel\.app$/;
function httpsOrigin(value) {
  const url = new URL(value);
  if (url.origin !== value || url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Invalid HTTPS origin.');
  return url;
}
const allowedHeaders = new Set([
  'accept', 'accept-language', 'content-type', 'content-length', 'content-encoding',
  'origin', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest',
  'x-edition3-client', 'x-edition3-candidate', 'x-edition3-epoch', 'x-edition3-transfer',
  'range', 'if-none-match', 'if-modified-since',
]);
export function gatewayRequest(request, env) {
  // Configure this flag only AFTER anonymously verifying All Deployments
  // protection. It is an operator enable switch, not a check of Vercel settings.
  if (env.NOVA_GATEWAY_ENABLED !== 'verified' || env.VERCEL_ENV !== 'production') throw new Error('Gateway is not enabled.');
  const canonical = httpsOrigin(env.NOVA_PUBLIC_ORIGIN), backend = httpsOrigin(env.NOVA_ORIGIN);
  if (!publicHost.test(canonical.hostname) || backend.hostname.endsWith('.vercel.app') || !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(backend.hostname) || /\.(localhost|local|internal|test|invalid)$/.test(backend.hostname)) throw new Error('Invalid gateway destination.');
  if (!/^[a-f0-9]{64}$/.test(env.NOVA_PROXY_KEY ?? '')) throw new Error('Missing proxy credential.');
  const incoming = new URL(request.url);
  if (incoming.origin !== canonical.origin || !['GET', 'HEAD', 'POST'].includes(request.method)) throw new Error('Use the canonical owner address.');
  const destination = new URL(backend.origin);
  destination.pathname = incoming.pathname;
  destination.search = incoming.search;
  const headers = new Headers();
  for (const [name, value] of request.headers) if (allowedHeaders.has(name)) headers.set(name, value);
  // Do not forward Vercel's login cookie, arbitrary authorization or spoofed
  // identity/proxy/middleware headers to the origin. Nova owns only this cookie.
  const cookies = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).filter(part => /^__Host-e3_session_[a-z0-9]+_web=[^;\s]+$/.test(part));
  if (cookies.length) headers.set('cookie', cookies.join('; '));
  headers.set('x-nova-proxy-key', env.NOVA_PROXY_KEY);
  headers.set('x-nova-public-origin', canonical.origin);
  return { destination, headers };
}
