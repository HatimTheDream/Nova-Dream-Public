import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function changelogEntries(source) {
  const sections = [...source.matchAll(/^## \[(\d+\.\d+\.\d+)\]([^\n]*)\n/gm)];
  const entries = new Map();
  for (let i = 0; i < sections.length; i++) {
    const [heading, version, suffix] = sections[i];
    if (entries.has(version)) throw Error(`Duplicate changelog version: ${version}`);
    entries.set(version, { suffix: suffix.trim(), body: source.slice(sections[i].index + heading.length, sections[i + 1]?.index ?? source.length).trim() });
  }
  return entries;
}

export function releaseNotes({ version, entry, audience, repository, sha }) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(sha)) throw Error('Invalid release identity');
  if (!['public', 'private'].includes(audience) || !entry?.body) throw Error('A release requires its own changelog entry and audience');
  return `${entry.body}\n\n${audience === 'public' ? 'Public source release. Run Nova Dream locally or on your own host; VPS hosting is optional. Configure your own accounts and credentials. Computer access requires the optional desktop companion.' : 'Private Nova Dream source release. Personal workspace data, credentials and recovery files are not included in the source archive.'}\n\n[Setup and documentation](https://github.com/${repository}/blob/${sha}/${audience === 'private' ? 'edition3/' : ''}README.md) · [Source commit](https://github.com/${repository}/commit/${sha})\n`;
}

function gh(args) { return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function optionalApi(path) {
  try { return JSON.parse(gh(['api', path])); }
  catch (error) { if (/HTTP 404/.test(String(error.stderr))) return undefined; throw error; }
}

export function publishCurrentRelease(audience) {
  if (!['public', 'private'].includes(audience)) throw Error('Choose --public or --private');
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw Error('Set GITHUB_REPOSITORY to the intended repository');
  const repo = JSON.parse(gh(['api', `repos/${repository}`]));
  if (repo.private !== (audience === 'private')) throw Error('Repository visibility does not match the release audience');
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const main = JSON.parse(gh(['api', `repos/${repository}/commits/main`])).sha;
  if (main !== sha && !['ahead', 'identical'].includes(JSON.parse(gh(['api', `repos/${repository}/compare/${sha}...${main}`])).status)) throw Error('Release source must belong to main');
  const tag = `${audience === 'private' ? 'nova-v' : 'v'}${version}`;
  const existing = optionalApi(`repos/${repository}/releases/tags/${tag}`);
  if (existing) { console.log(`Release already recorded: ${existing.html_url}`); return; }
  const ref = optionalApi(`repos/${repository}/git/ref/tags/${tag}`);
  if (ref && (ref.object.type !== 'commit' || ref.object.sha !== sha)) throw Error('Existing tag points elsewhere; it will not be moved');
  const notes = releaseNotes({ version, entry: changelogEntries(readFileSync('CHANGELOG.md', 'utf8')).get(version), audience, repository, sha });
  const directory = mkdtempSync(join(tmpdir(), 'nova-release-'));
  try {
    const file = join(directory, 'notes.md'); writeFileSync(file, notes);
    console.log(gh(['release', 'create', tag, '--repo', repository, '--target', sha, '--title', `Nova Dream ${version}`, '--notes-file', file, `--latest=${main === sha}`]));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) publishCurrentRelease(process.argv[2]?.replace(/^--/, ''));
