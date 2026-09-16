import policy from '../apps/desktop/launch-policy.cjs';

/** Only a refused connection means there is no listener. Never replace an
 * unknown, unresponsive, or different build's process. */
export async function desktopHealth(address, expected, timeout = 1000) {
  let response;
  try { response = await fetch(`${address}/api/health`, { signal: AbortSignal.timeout(timeout), redirect: 'error' }); }
  catch (error) {
    if (error?.cause?.code === 'ECONNREFUSED') return false;
    throw new Error('The preview address is occupied or unresponsive. Its process was left running.', { cause: error });
  }
  let data;
  try { data = await response.json(); } catch { throw new Error('Another service is using the preview address. Its process was left running.'); }
  if (!response.ok || !policy.matchesCandidate(data, expected)) throw new Error('A different build is using the preview address. Close that preview deliberately or choose another QA port; it was left running.');
  return true;
}
