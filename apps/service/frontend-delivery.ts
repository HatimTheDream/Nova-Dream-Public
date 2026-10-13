import { constants, lstatSync, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash, verify } from 'node:crypto';
import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const relativeFile = z.string().max(100).refine(path => (path === '.vite/manifest.json' || /^[A-Za-z0-9_/-][A-Za-z0-9_.\/-]*$/.test(path) && path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !part.startsWith('.'))) &&
  (['index.html', '.vite/manifest.json', 'icons/provenance.json'].includes(path) || /\.(?:js|css|png|jpg|jpeg|gif|webp|avif|ico|svg|woff|woff2|ttf|otf|webmanifest)$/.test(path)));
const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value, 'Use an exact ISO timestamp with milliseconds.');
export const frontendManifestSchema = z.object({
  format: z.literal(1), kind: z.literal('frontend'), channel: z.literal('frontend-stable'), sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdAt: timestamp, expiresAt: timestamp, frontendId: hash,
  frontendVersion: version, frontendBuildVersion: version, sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
  base: z.object({ candidateId: hash, serviceInputsSha256: hash, apiVersion: z.literal(1), schemaVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
  artifact: z.object({ url: z.string().url().max(2048).refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search; }), bytes: z.number().int().positive().max(128 * 1024 * 1024), sha256: hash }).strict(),
  files: z.array(z.object({ path: relativeFile, bytes: z.number().int().nonnegative().max(32 * 1024 * 1024), sha256: hash }).strict()).min(1).max(1024),
}).strict().superRefine((value, context) => {
  const created = Date.parse(value.createdAt), expires = Date.parse(value.expiresAt), names = value.files.map(file => file.path);
  if (expires <= created || expires - created > 31 * 86400000 || value.files.reduce((sum, file) => sum + file.bytes, 0) > 128 * 1024 * 1024 ||
    names.some((name, index) => index > 0 && names[index - 1] >= name) || !names.includes('index.html') || !names.includes('.vite/manifest.json') || digest(JSON.stringify(value.files)) !== value.frontendId || Buffer.byteLength(JSON.stringify(value) + '\n') > 128 * 1024)
    context.addIssue({ code: 'custom', message: 'Invalid frontend validity, complete inventory or identity.' });
});
const selectorSchema = z.object({ format: z.literal(1), frontendId: hash, manifestSha256: hash, manifestPath: z.string().max(1000), signaturePath: z.string().max(1000), operationId: z.string().uuid() }).strict();
type Manifest = z.infer<typeof frontendManifestSchema>;
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** Public assets remain root-owned. No workspace record or private key is read. */
function protectedFile(path: string, limit: number, uid: number): Buffer {
  if (!isAbsolute(path)) throw Error('Frontend paths must be absolute.');
  for (let folder = dirname(path);; folder = dirname(folder)) {
    const info = lstatSync(folder);
    if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== 'win32' && (info.uid !== uid || (info.mode & 0o022))) throw Error('Frontend directories are not protected.');
    if (folder === dirname(folder)) break;
  }
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > limit || process.platform !== 'win32' && (entry.uid !== uid || (entry.mode & 0o022))) throw Error('Frontend file is not protected.');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd), bytes = readFileSync(fd), after = fstatSync(fd);
    if (bytes.length > limit || before.dev !== entry.dev || before.ino !== entry.ino || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== after.size) throw Error('Frontend file changed during its read.');
    return bytes;
  } finally { closeSync(fd); }
}

export interface FrontendIdentity { id: string; version: string; buildVersion: string; source: 'bundled' | 'frontend'; }
export interface FrontendDeliveryOptions {
  directory: string; publicKeyFile: string; publicKeySha256: string;
  candidateId: string; serviceInputsSha256: string; apiVersion: 1; schemaVersion: number;
  version: string; buildVersion: string;
}
export class FrontendDelivery {
  constructor(private readonly options: FrontendDeliveryOptions, private readonly trustedUid = 0, private readonly readProtected: typeof protectedFile = protectedFile) {
    hash.parse(options.candidateId); hash.parse(options.serviceInputsSha256); hash.parse(options.publicKeySha256);
    if (!isAbsolute(options.directory) || resolve(options.directory) !== options.directory || !isAbsolute(options.publicKeyFile)) throw Error('Use canonical frontend configuration paths.');
  }
  private manifest(id: string): Manifest {
    hash.parse(id);
    const root = join(this.options.directory, 'releases', id);
    const raw = this.readProtected(join(root, '.frontend-manifest.json'), 128 * 1024, this.trustedUid);
    const signature = this.readProtected(join(root, '.frontend-manifest.sig'), 64, this.trustedUid);
    const key = this.readProtected(this.options.publicKeyFile, 16384, this.trustedUid);
    if (signature.length !== 64 || digest(key) !== this.options.publicKeySha256 || !verify(null, raw, key, signature)) throw Error('Frontend signature is invalid.');
    const value = frontendManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
    if (value.frontendId !== id || value.base.candidateId !== this.options.candidateId || value.base.serviceInputsSha256 !== this.options.serviceInputsSha256 || value.base.apiVersion !== this.options.apiVersion || value.base.schemaVersion !== this.options.schemaVersion) throw Error('Frontend compatibility changed.');
    const names = value.files.map(file => file.path);
    if (names.some((name, i) => i > 0 && names[i - 1] >= name) || !names.includes('index.html') || names.some(name => name.split('/').some(part => part.startsWith('.')) && name !== '.vite/manifest.json') || digest(JSON.stringify(value.files)) !== id) throw Error('Frontend file identity is invalid.');
    // Expiry controls admission, not already installed assets or old windows.
    return value;
  }
  selected(): { identity: FrontendIdentity; manifest?: Manifest; error?: true } {
    const bundled: FrontendIdentity = { id: this.options.candidateId, version: this.options.version, buildVersion: this.options.buildVersion, source: 'bundled' };
    let selectorBytes: Buffer;
    try { selectorBytes = this.readProtected(join(this.options.directory, 'selector.json'), 8192, this.trustedUid); }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { identity: bundled } : { identity: bundled, error: true }; }
    try {
      const selector = selectorSchema.parse(JSON.parse(selectorBytes.toString('utf8')));
      const manifestPath = join(this.options.directory, 'manifests', selector.manifestSha256 + '.json');
      const signaturePath = join(this.options.directory, 'manifests', selector.manifestSha256 + '.sig');
      if (selector.manifestPath !== manifestPath || selector.signaturePath !== signaturePath) throw Error('Invalid frontend selector paths.');
      const raw = this.readProtected(manifestPath, 128 * 1024, this.trustedUid);
      if (digest(raw) !== selector.manifestSha256 || !this.readProtected(signaturePath, 64, this.trustedUid).equals(this.readProtected(join(this.options.directory, 'releases', selector.frontendId, '.frontend-manifest.sig'), 64, this.trustedUid)) || !raw.equals(this.readProtected(join(this.options.directory, 'releases', selector.frontendId, '.frontend-manifest.json'), 128 * 1024, this.trustedUid))) throw Error('Frontend selector identity changed.');
      const manifest = this.manifest(selector.frontendId);
      return { manifest, identity: { id: manifest.frontendId, version: manifest.frontendVersion, buildVersion: manifest.frontendBuildVersion, source: 'frontend' } };
    } catch (error) {
      return { identity: bundled, error: true };
    }
  }
  read(id: string, path: string): Buffer {
    const manifest = this.manifest(id);
    relativeFile.parse(path);
    if (path.split('/').some(part => part.startsWith('.')) || path === 'icons/provenance.json' || path.endsWith('.html') && path !== 'index.html') throw Error('Frontend path is unavailable.');
    const entry = manifest.files.find(file => file.path === path);
    if (!entry) throw Error('Frontend path is unavailable.');
    const bytes = this.readProtected(join(this.options.directory, 'releases', id, path), entry.bytes, this.trustedUid);
    if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) throw Error('Frontend asset changed.');
    return bytes;
  }
}

export function frontendHtml(bytes: Buffer, candidateId: string, identity: FrontendIdentity, base: string): string {
  hash.parse(candidateId); hash.parse(identity.id); version.parse(identity.version); version.parse(identity.buildVersion);
  if (!/^\/__(?:frontend|bundled)\/[a-f0-9]{64}\/$/.test(base)) throw Error('Invalid frontend namespace.');
  const html = bytes.toString('utf8');
  if (!html.includes('<head>') || /<base\b/i.test(html)) throw Error('Invalid frontend document template.');
  const assets = html.replace(/\b(src|href)="\.\/([^"<>]+)"/g, (_match, attribute: string, path: string) => {
    relativeFile.parse(path); return `${attribute}="${base}${path}"`;
  });
  return assets.replace('<head>', `<head><meta name="e3-assets" content="${base}"><meta name="e3-candidate" content="${candidateId}"><meta name="e3-frontend" content="${identity.id}"><meta name="e3-frontend-version" content="${identity.version}"><meta name="e3-frontend-build" content="${identity.buildVersion}">`);
}
