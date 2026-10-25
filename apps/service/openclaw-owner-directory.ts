import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, win32 } from 'node:path';

interface OwnerDirectoryPorts {
  platform: NodeJS.Platform;
  home(): string;
  uid(): number | undefined;
  readPackage(path: string): string;
  mkdir(path: string, options: { recursive: true; mode: number }): unknown;
  stat(path: string): { isDirectory(): boolean; isSymbolicLink(): boolean };
  realpath(path: string): string;
}

const nativePorts: OwnerDirectoryPorts = {
  platform: process.platform,
  home: homedir,
  uid: () => process.getuid?.(),
  readPackage: path => readFileSync(path, 'utf8'),
  mkdir: mkdirSync,
  stat: lstatSync,
  realpath: realpathSync.native,
};

/** Establish the native owner's directory before its first canonical key is computed.
 * Packaged Windows hosts may redirect this location only after it exists. Keep
 * the directory in place; native leases still own and verify their lock files. */
export function prepareWindowsStateOwnerDirectory(entry: string, ports: OwnerDirectoryPorts = nativePorts): string | undefined {
  if (ports.platform !== 'win32') return;
  const metadata = JSON.parse(ports.readPackage(join(dirname(entry), 'package.json'))) as { name?: string; version?: string };
  if (metadata.name !== 'openclaw' || metadata.version !== '2026.9.8') return;
  const uid = ports.uid();
  const directory = win32.join(ports.home(), 'AppData', 'Local', 'OpenClaw', 'locks', uid === undefined ? 'openclaw-state-owners' : `openclaw-state-owners-${uid}`);
  ports.mkdir(directory, { recursive: true, mode: 0o700 });
  const observed = ports.stat(directory);
  if (!observed.isDirectory() || observed.isSymbolicLink()) throw new Error('The native state ownership path must be a real directory.');
  const canonical = ports.realpath(directory);
  if (!win32.isAbsolute(canonical) || ports.realpath(directory) !== canonical) throw new Error('The native state ownership directory changed during setup.');
  return canonical;
}
