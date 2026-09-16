const guides = new Set(['https://tailscale.com/download', 'https://auth.openai.com/codex/device', 'https://developers.google.com/identity/protocols/oauth2/native-app', 'https://learn.microsoft.com/en-us/entra/identity-platform/reply-url']);
function canOpenExternal(value) {
  if (guides.has(value)) return true;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.hash || u.port) return false;
    if (u.hostname === 'auth.openai.com' && u.pathname === '/oauth/authorize') {
      const q = u.searchParams;
      return value.length <= 8192 && ![...q.keys()].some(k => q.getAll(k).length !== 1) && !['access_token', 'refresh_token', 'id_token', 'code'].some(k => q.has(k)) &&
        q.get('redirect_uri') === 'http://localhost:1455/auth/callback' && q.get('response_type') === 'code' && !!q.get('client_id') && q.get('code_challenge_method') === 'S256' &&
        /^[A-Za-z0-9_-]{43,128}$/.test(q.get('code_challenge') ?? '') && /^[A-Za-z0-9_-]{16,256}$/.test(q.get('state') ?? '');
    }
    const google = u.hostname === 'accounts.google.com' && u.pathname === '/o/oauth2/v2/auth';
    const microsoft = u.hostname === 'login.microsoftonline.com' && /^\/(common|organizations|consumers|[0-9a-f-]{36})\/oauth2\/v2\.0\/authorize$/.test(u.pathname);
    if (!google && !microsoft) return false;
    for (const field of ['redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'response_type', 'client_id']) if (u.searchParams.getAll(field).length !== 1) return false;
    const redirect = new URL(u.searchParams.get('redirect_uri'));
    return redirect.protocol === 'http:' && redirect.hostname === '127.0.0.1' && Number(redirect.port) >= 1024 && Number(redirect.port) <= 65535 && redirect.pathname === '/oauth/callback' && !redirect.username && !redirect.password && !redirect.search && !redirect.hash &&
      u.searchParams.get('response_type') === 'code' && u.searchParams.get('code_challenge_method') === 'S256' && /^[A-Za-z0-9_-]{43,128}$/.test(u.searchParams.get('code_challenge')) && /^[A-Za-z0-9_-]{43,128}$/.test(u.searchParams.get('state'));
  } catch { return false; }
}
function privatePhoneOrigin(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.port === '8443' && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/' &&
      /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/.test(u.hostname) && (value === u.origin || value === u.origin + '/') ? u.origin : undefined;
  } catch { return undefined; }
}
// The renderer cannot authorize an arbitrary tailnet destination. Resolve the
// active route from this exact paired service again for each requested opening.
async function openPhoneExternal(value, { readHealth, readPhoneState, isCurrentPage, expected, openExternal }) {
  const origin = privatePhoneOrigin(value);
  if (!origin || !isCurrentPage()) return false;
  const { matchesCandidate } = require('./launch-policy.cjs');
  if (!matchesCandidate(await readHealth(), expected)) return false;
  const state = await readPhoneState();
  if (state?.enabled !== true || state.route?.state !== 'ready' || state.route.origin !== origin) return false;
  if (!matchesCandidate(await readHealth(), expected) || !isCurrentPage()) return false;
  await openExternal(origin);
  return true;
}
module.exports = { canOpenExternal, privatePhoneOrigin, openPhoneExternal };
