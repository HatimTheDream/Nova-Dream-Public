// Field checks shared by the host contracts and lightweight client input guards.
export function validBrowserUrl(value: string): boolean {
  if (value.length > 4000) return false;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}
export const githubNamePattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const validGitHubName = (value: string) => value.length <= 220 && githubNamePattern.test(value);
export const validGitBranch = (value: string) => value.length > 0 && value.length <= 200 &&
  !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) && !value.startsWith('-') && !value.startsWith('/') &&
  !value.endsWith('/') && !value.endsWith('.') && !value.endsWith('.lock') && !value.includes('..') &&
  !value.includes('@{') && !value.includes('//') && value.split('/').every(part => !part.startsWith('.'));
