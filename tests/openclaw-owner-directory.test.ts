import test from 'node:test';
import assert from 'node:assert/strict';
import { win32 } from 'node:path';
import { prepareWindowsStateOwnerDirectory } from '../apps/service/openclaw-owner-directory';

const entry = 'C:/runtime/node_modules/openclaw/openclaw.mjs';
const directory = win32.join('C:/Users/example', 'AppData/Local/OpenClaw/locks/openclaw-state-owners');
const redirected = win32.join('C:/Users/example', 'AppData/Local/Packages/Example/LocalCache/Local/OpenClaw/locks/openclaw-state-owners');
type Ports = NonNullable<Parameters<typeof prepareWindowsStateOwnerDirectory>[1]>;
function fixture() {
  let created = false;
  const calls: string[] = [];
  const ports: Ports = {
    platform: 'win32', home: () => 'C:/Users/example', uid: () => undefined,
    readPackage: () => JSON.stringify({ name: 'openclaw', version: '2026.9.8' }),
    mkdir: (path, options) => { assert.equal(path, directory); assert.deepEqual(options, { recursive: true, mode: 0o700 }); calls.push('mkdir'); created = true; },
    stat: path => { assert.equal(path, directory); calls.push('stat'); return { isDirectory: () => true, isSymbolicLink: () => false }; },
    realpath: path => { assert.equal(path, directory); calls.push('realpath'); return created ? redirected : directory; },
  };
  return { ports, calls };
}

test('Windows establishes redirected ownership identity before native lease acquisition and lookup', () => {
  const { ports, calls } = fixture();
  assert.equal(ports.realpath(directory), directory, 'missing directory initially resolves through its logical ancestor');
  calls.length = 0;
  assert.equal(prepareWindowsStateOwnerDirectory(entry, ports), redirected);
  assert.deepEqual(calls, ['mkdir', 'stat', 'realpath', 'realpath']);
  const owners = new Map([[ports.realpath(directory), 'held schema lease']]);
  assert.equal(owners.get(ports.realpath(directory)), 'held schema lease', 'later native lookup retains the acquisition key');
  assert.equal(prepareWindowsStateOwnerDirectory(entry, ports), redirected, 'existing directory remains stable on restart');
});

test('non-Windows and other native versions do not prepare a shared Windows directory', () => {
  const { ports } = fixture();
  const forbidden = () => { throw new Error('unexpected filesystem operation'); };
  assert.equal(prepareWindowsStateOwnerDirectory(entry, { ...ports, platform: 'linux', readPackage: forbidden, mkdir: forbidden }), undefined);
  for (const version of ['2026.9.2', '2026.9.6']) {
    assert.equal(prepareWindowsStateOwnerDirectory(entry, { ...ports, readPackage: () => JSON.stringify({ name: 'openclaw', version }), mkdir: forbidden }), undefined);
  }
});

test('non-directory, symbolic-link and unstable ownership paths refuse setup', () => {
  for (const [isDirectory, isSymbolicLink] of [[false, false], [true, true]]) {
    const { ports } = fixture();
    assert.throws(() => prepareWindowsStateOwnerDirectory(entry, { ...ports, stat: () => ({ isDirectory: () => isDirectory, isSymbolicLink: () => isSymbolicLink }) }), /real directory/);
  }
  const { ports } = fixture(); let observations = 0;
  assert.throws(() => prepareWindowsStateOwnerDirectory(entry, { ...ports, realpath: () => observations++ ? directory : redirected }), /changed during setup/);
});

test('directory creation and canonicalization errors propagate without fallback or retry', () => {
  for (const stage of ['mkdir', 'realpath'] as const) {
    const { ports } = fixture(); const denied = Object.assign(new Error('denied'), { code: 'EACCES' }); let attempts = 0;
    assert.throws(() => prepareWindowsStateOwnerDirectory(entry, { ...ports, [stage]: () => { attempts++; throw denied; } }), error => error === denied);
    assert.equal(attempts, 1);
  }
});
