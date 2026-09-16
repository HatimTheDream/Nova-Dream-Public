const path = require('node:path');
const { createHash } = require('node:crypto');
const { lstatSync, mkdirSync, readFileSync } = require('node:fs');

function launchOptions(args, workspace) {
  const saved = args.length === 1 && /^--workspace=([a-z0-9][a-z0-9-]{0,39})$/.exec(args[0]);
  if (saved) {
    if (!workspace || !path.isAbsolute(workspace)) throw new Error('Use the workspace launcher.');
    const name = saved[1];
    const localPath = relative => {
      const parts = relative.split('/');
      if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\\')) || path.isAbsolute(relative)) throw new Error('Saved workspace paths must remain inside this checkout.');
      let current = workspace;
      for (const part of parts) { current = path.join(current, part); if (lstatSync(current).isSymbolicLink()) throw new Error('Saved workspace paths cannot use symlinks.'); }
      return current;
    };
    const file = localPath(`.launcher/workspaces/${name}.json`);
    if (!lstatSync(file).isFile()) throw new Error('The saved workspace selection must be a file.');
    const savedConfig = JSON.parse(readFileSync(file, 'utf8'));
    if (savedConfig.version !== 1 || Object.keys(savedConfig).sort().join(',') !== 'dataDirectory,port,version' || !Number.isInteger(savedConfig.port) || savedConfig.port < 1024 || savedConfig.port > 65535 || typeof savedConfig.dataDirectory !== 'string') throw new Error('Review the saved workspace selection before opening Nova.');
    const dataDirectory = localPath(savedConfig.dataDirectory);
    if (!lstatSync(dataDirectory).isDirectory() || !lstatSync(path.join(dataDirectory, 'workspace.sqlite')).isFile() || lstatSync(path.join(dataDirectory, 'workspace.sqlite')).isSymbolicLink()) throw new Error('The selected saved workspace is unavailable. No empty workspace was created.');
    return { qa: false, workspaceName: name, dataDirectory, port: savedConfig.port, address: `http://127.0.0.1:${savedConfig.port}` };
  }
  const values = new Map();
  for (const arg of args) {
    const match = /^(--qa)$|^--(profile|port)=(.+)$/.exec(arg);
    if (!match) throw new Error('Use --qa --profile=<short-name> --port=<port> for an isolated desktop review.');
    const key = match[1] ? 'qa' : match[2];
    if (values.has(key)) throw new Error(`Duplicate desktop option: ${key}`);
    values.set(key, match[3] ?? true);
  }
  if (!values.size) return { qa: false, port: 4383, address: 'http://127.0.0.1:4383' };
  const profile = values.get('profile'), rawPort = values.get('port');
  if (!values.get('qa') || typeof profile !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(profile) || typeof rawPort !== 'string' || !/^[1-9][0-9]{3,4}$/.test(rawPort)) throw new Error('QA needs a short lowercase profile name and an explicit unprivileged port.');
  const port = Number(rawPort);
  if (port < 1024 || port > 65535 || port === 4383) throw new Error('QA must use an unprivileged port other than the primary preview port 4383.');
  return { qa: true, profile, port, address: `http://127.0.0.1:${port}` };
}
function profileDirectory(options, workspace, appData, platform = process.platform) {
  return options.qa ? path.join(workspace, '.tmp-qa', platform === 'win32' ? 'windows-profiles' : 'desktop-profiles', options.profile) : path.join(appData, options.workspaceName ? `NovaDream-Edition3-Workspace-${options.workspaceName}-${createHash('sha256').update(path.resolve(workspace)).digest('hex').slice(0, 12)}` : 'NovaDream-Edition3-Preview');
}
function prepareQaDirectory(directory, workspace) {
  const parts = path.relative(workspace, directory).split(path.sep);
  if (parts[0] !== '.tmp-qa' || parts.some(part => !part || part === '..' || part === '.')) throw new Error('QA data must stay inside the workspace.');
  let current = workspace;
  for (const part of parts) {
    current = path.join(current, part);
    try { mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('QA directories cannot use symlinks or files.');
  }
  return directory;
}
function matchesCandidate(data, expected) {
  return !!data && data.application === 'nova-dream-edition-3' && data.status === 'ready' &&
    data.apiVersion === expected.apiVersion && data.version === expected.version && data.buildVersion === expected.buildVersion &&
    data.schemaVersion === expected.schemaVersion && data.candidateId === expected.candidateId;
}
function expectedCandidate(manifest, id) {
  if (!/^[a-f0-9]{64}$/.test(id) || manifest.desktopFormat !== 1) throw new Error('Build the paired desktop candidate before launching.');
  return { version: manifest.version, buildVersion: manifest.buildVersion, schemaVersion: manifest.schemaVersion, apiVersion: manifest.apiVersion, candidateId: id };
}
module.exports = { launchOptions, profileDirectory, prepareQaDirectory, matchesCandidate, expectedCandidate };
