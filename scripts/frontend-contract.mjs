import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

export const frontendLimits = Object.freeze({ manifestBytes: 128 * 1024, archiveBytes: 128 * 1024 * 1024, fileBytes: 32 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, files: 1024 });
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const need = (condition, reason) => { if (!condition) throw Error(reason); };
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const keys = (value, names) => need(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...names].sort().join(','), 'Unexpected frontend contract fields.');
const semanticVersion = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);

export function frontendAssetPath(path) {
  return typeof path === 'string' && path.length <= 100 && (path === '.vite/manifest.json' || (/^[a-zA-Z0-9_/-][a-zA-Z0-9_./-]*$/.test(path) && !path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')))) &&
    (['index.html', '.vite/manifest.json', 'icons/provenance.json'].includes(path) || /\.(?:js|css|png|jpg|jpeg|gif|webp|avif|ico|svg|woff|woff2|ttf|otf|webmanifest)$/.test(path));
}

/** Bounded, stable independent file read without following links in any component. */
export function frontendRegular(path, maximum = frontendLimits.fileBytes) {
  const absolute = resolve(path);
  for (let cursor = absolute; ; cursor = dirname(cursor)) {
    need(!lstatSync(cursor).isSymbolicLink(), 'Frontend inputs cannot traverse symlinks.');
    if (dirname(cursor) === cursor) break;
  }
  need(realpathSync(absolute) === absolute, 'Frontend input path changed.');
  const fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    need(before.isFile() && before.nlink === 1 && before.size <= maximum, 'Frontend inputs must be bounded independent regular files.');
    const bytes = readFileSync(fd), after = fstatSync(fd), current = lstatSync(absolute);
    need(bytes.length === before.size && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => before[key] === after[key] && after[key] === current[key]) && !current.isSymbolicLink(), 'Frontend input changed while being read.');
    return bytes;
  } finally { closeSync(fd); }
}

export function validateFrontendFiles(files) {
  need(Array.isArray(files) && files.length > 0 && files.length <= frontendLimits.files, 'Invalid frontend file inventory.');
  let previous = '', total = 0;
  for (const file of files) {
    keys(file, ['path', 'bytes', 'sha256']);
    need(frontendAssetPath(file.path) && file.path > previous && integer(file.bytes) && file.bytes <= frontendLimits.fileBytes && hash(file.sha256), 'Invalid or unordered frontend asset.');
    previous = file.path; total += file.bytes;
  }
  need(total <= frontendLimits.totalBytes && files.some(file => file.path === 'index.html') && files.some(file => file.path === '.vite/manifest.json'), 'The complete frontend exceeds its limit or has no entry/closure.');
  return files;
}

export const frontendIdentity = files => sha256(Buffer.from(JSON.stringify(validateFrontendFiles(files).map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })))));

/** Source packaging requires an exact committed application and its CI workflow inputs. */
export function assertFrontendSourceClean(workspace, { gitBinary = process.env.GIT_BINARY ?? 'git' } = {}) {
  const root = resolve(workspace), run = (directory, args) => execFileSync(gitBinary, ['-C', directory, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  const repository = resolve(run(root, ['rev-parse', '--show-toplevel']).trim()), prefix = relative(repository, root).split(sep).join('/');
  need(prefix !== '..' && !prefix.startsWith('../'), 'The frontend source escaped its Git repository.');
  const sourceRevision = run(root, ['rev-parse', 'HEAD']).trim();
  const status = run(repository, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...(prefix ? [prefix, '.github'] : ['.'])]);
  need(status.length === 0 && /^[a-f0-9]{40}$/.test(sourceRevision) && run(root, ['rev-parse', 'HEAD']).trim() === sourceRevision, 'Source packaging requires clean committed application and CI workflow inputs.');
  return { sourceRevision };
}

export function validateFrontendValidityPeriod(createdAt, expiresAt) {
  const created = Date.parse(createdAt), expires = Date.parse(expiresAt);
  need(typeof createdAt === 'string' && typeof expiresAt === 'string' && Number.isFinite(created) && Number.isFinite(expires) && new Date(created).toISOString() === createdAt && new Date(expires).toISOString() === expiresAt && expires > created && expires - created <= 31 * 86400000, 'Invalid frontend validity period.');
  return { created, expires };
}
/** Expiry is an admission rule; serving an already admitted immutable UI does not expire it. */
export function validateFrontendManifest(value, { now = Date.now(), admission = true } = {}) {
  keys(value, ['format', 'kind', 'channel', 'sequence', 'createdAt', 'expiresAt', 'frontendId', 'frontendVersion', 'frontendBuildVersion', 'sourceRevision', 'base', 'artifact', 'files']);
  need(value.format === 1 && value.kind === 'frontend' && value.channel === 'frontend-stable' && Number.isSafeInteger(value.sequence) && value.sequence > 0, 'Unsupported frontend channel or sequence.');
  need(semanticVersion(value.frontendVersion) && semanticVersion(value.frontendBuildVersion) && /^[a-f0-9]{40}$/.test(value.sourceRevision ?? ''), 'Invalid frontend source/version identity.');
  const { created, expires } = validateFrontendValidityPeriod(value.createdAt, value.expiresAt);
  if (admission) need(created <= now + 300000 && expires > now, 'The frontend admission is not current.');
  keys(value.base, ['candidateId', 'serviceInputsSha256', 'apiVersion', 'schemaVersion']);
  need(hash(value.base.candidateId) && hash(value.base.serviceInputsSha256) && value.base.apiVersion === 1 && Number.isSafeInteger(value.base.schemaVersion) && value.base.schemaVersion > 0, 'Invalid frontend service compatibility binding.');
  keys(value.artifact, ['url', 'bytes', 'sha256']);
  let url; try { url = new URL(value.artifact.url); } catch { throw Error('Invalid frontend artifact URL.'); }
  need(typeof value.artifact.url === 'string' && value.artifact.url.length <= 2048 && url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search && integer(value.artifact.bytes) && value.artifact.bytes > 0 && value.artifact.bytes <= frontendLimits.archiveBytes && hash(value.artifact.sha256), 'Use a bounded HTTPS frontend artifact without credentials, queries or fragments.');
  need(hash(value.frontendId) && frontendIdentity(value.files) === value.frontendId, 'Frontend identity does not match the complete asset inventory.');
  need(Buffer.byteLength(JSON.stringify(value) + '\n') <= frontendLimits.manifestBytes, 'Frontend manifest exceeds its limit.');
  return value;
}

// Only browser-owned source may vary. Shared contracts, tools and unknown inputs
// remain bound; the complete service/desktop output is independently bound below.
const clientCore = new Set(['api.ts', 'client-identity.ts', 'upload-body.ts', 'conditional-reads.ts'].map(name => 'apps/client/src/' + name));
const clientInput = path => !clientCore.has(path) && (path === 'apps/client/index.html'
  || /^apps\/client\/src\/.+\.(?:ts|tsx|js|jsx|mjs)$/.test(path)
  || (/^apps\/client\//.test(path) && /\.(?:css|png|jpg|jpeg|gif|webp|avif|ico|woff|woff2|ttf|otf)$/.test(path)));
const documentation = path => /^(?:docs|tests)\//.test(path) || ['README.md', 'CHANGELOG.md'].includes(path);
// This signed publication output is read by the update client, never by the build.
// The provisioned updates/release-public.pem and unknown update files remain inputs.
const publicationOutput = path => path === 'updates/stable.json';
const normalized = (path, bytes, pkg) => {
  if (!['package.json', 'package-lock.json', 'release.json'].includes(path)) return bytes;
  const value = JSON.parse(bytes.toString('utf8'));
  need(value.version === pkg.version, `Official version metadata differs: ${path}`);
  value.version = '<application-version>';
  if (path === 'package.json') { need(value.edition3?.buildVersion === pkg.edition3.buildVersion, 'Official build metadata differs.'); value.edition3.buildVersion = '<application-build>'; }
  if (path === 'package-lock.json') { need(value.packages?.['']?.version === pkg.version && value.packages[''].name === pkg.name, 'The dependency root version/name differs.'); value.packages[''].version = '<application-version>'; }
  if (path === 'release.json') { need(value.buildVersion === pkg.edition3.buildVersion && ['schemaVersion', 'apiVersion', 'appId'].every(key => value[key] === pkg.edition3[key]), 'Official release compatibility metadata differs.'); value.buildVersion = '<application-build>'; }
  return Buffer.from(JSON.stringify(value));
};

export function walkFrontendFiles(root) {
  const absolute = resolve(root), paths = [];
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      need(!entry.isSymbolicLink(), 'Frontend asset trees cannot contain symlinks.');
      if (entry.isDirectory()) walk(path);
      else { need(entry.isFile(), 'Frontend asset trees contain only regular files.'); paths.push(relative(absolute, path).split(sep).join('/')); }
    }
  };
  walk(absolute); return paths.sort();
}

/** Bind every application build/source input, including unknown new files, to backend and desktop output. */
export function computeFrontendCompatibility(workspace, { gitBinary = process.env.GIT_BINARY ?? 'git' } = {}) {
  const root = resolve(workspace), git = args => execFileSync(gitBinary, ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true }).trim();
  const repository = resolve(git(['rev-parse', '--show-toplevel'])), prefix = relative(repository, root).split(sep).join('/');
  const listed = execFileSync(gitBinary, ['-C', repository, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true }).split('\0').filter(Boolean);
  const sourceRevision = git(['rev-parse', 'HEAD']);
  need(/^[a-f0-9]{40}$/.test(sourceRevision), 'Frontend compatibility needs a committed Git source identity.');
  const pkg = JSON.parse(frontendRegular(join(root, 'package.json')).toString('utf8'));
  need(pkg.name === 'nova-dream-edition-3' && semanticVersion(pkg.version) && semanticVersion(pkg.edition3?.buildVersion), 'Unsupported application metadata.');
  const sources = [];
  for (const repoPath of [...new Set(listed)].sort()) {
    let path = prefix ? repoPath.startsWith(prefix + '/') ? repoPath.slice(prefix.length + 1) : null : repoPath;
    if (path === null) {
      if (repoPath.startsWith('.github/')) sources.push({ path: '@repository/' + repoPath, sha256: sha256(frontendRegular(join(repository, repoPath))) });
      continue;
    }
    if (documentation(path) || clientInput(path) || publicationOutput(path)) continue;
    need(!path.startsWith('dist/') && !path.startsWith('node_modules/'), 'Tracked generated/dependency contents require a full delivery route.');
    sources.push({ path, sha256: sha256(normalized(path, frontendRegular(join(root, path)), pkg)) });
  }
  for (const required of ['package.json', 'package-lock.json', 'release.json', 'vite.config.ts', 'scripts/budget.mjs']) need(sources.some(file => file.path === required), `Missing frontend compatibility input: ${required}`);
  const compiled = [];
  for (const tree of ['dist/service', 'dist/desktop']) for (const path of walkFrontendFiles(join(root, tree))) compiled.push({ path: `${tree}/${path}`, sha256: sha256(frontendRegular(join(root, tree, path))) });
  need(compiled.some(file => file.path === 'dist/service/apps/service/main.js') && compiled.some(file => file.path === 'dist/desktop/main.cjs'), 'Build both service and desktop before frontend compatibility admission.');
  sources.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); compiled.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { format: 2, eligibility: 'client-behavior', serviceInputsSha256: sha256(Buffer.from(JSON.stringify({ format: 2, eligibility: 'client-behavior', sources, compiled }))), sourceRevision, sourceFiles: sources.length, compiledFiles: compiled.length };
}
