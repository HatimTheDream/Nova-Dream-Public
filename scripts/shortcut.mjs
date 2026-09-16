import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync, renameSync, cpSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import policy from '../apps/desktop/launch-policy.cjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const name = 'Nova Dream';
const launchArgs = process.argv.slice(2);
const selected = policy.launchOptions(launchArgs, root);
if (selected.qa) throw new Error('A normal desktop shortcut must use the default or a saved workspace.');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (pkg.name !== 'nova-dream-edition-3') throw new Error('Unexpected workspace.');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const desktop = join(homedir(), 'Desktop');
if (process.platform === 'darwin') {
  const bundle = join(desktop, `${name}.app`), marker = join(bundle, 'Contents', 'edition3-shortcut');
  const legacy = join(desktop, 'Nova Dream — Edition 3.app');
  const owned = path => existsSync(join(path, 'Contents', 'edition3-shortcut')) && readFileSync(join(path, 'Contents', 'edition3-shortcut'), 'utf8') === root;
  if (!existsSync(bundle) && existsSync(legacy)) {
    if (!owned(legacy)) throw new Error('The older shortcut belongs to another workspace. It was left unchanged.');
    const backup = join(root, '.launcher', 'shortcut-backups', pkg.version);
    mkdirSync(backup, { recursive: true });
    cpSync(legacy, join(backup, 'previous.app'), { recursive: true, errorOnExist: true, force: false });
    renameSync(legacy, bundle);
  }
  if (existsSync(bundle) && (!existsSync(marker) || readFileSync(marker, 'utf8') !== root)) throw new Error('A different desktop item already uses this name. It was left unchanged.');
  mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true });
  const executable = join(bundle, 'Contents', 'MacOS', 'NovaDream');
  writeFileSync(marker, root);
  writeFileSync(join(bundle, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleName</key><string>${name}</string><key>CFBundleDisplayName</key><string>${name}</string><key>CFBundleIdentifier</key><string>private.novadream.edition3.shortcut</string><key>CFBundleVersion</key><string>${pkg.edition3.buildVersion}</string><key>CFBundleShortVersionString</key><string>${pkg.version}</string><key>CFBundleExecutable</key><string>NovaDream</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`);
  writeFileSync(executable, `#!/bin/zsh\nexec ${quote(process.execPath)} ${quote(join(root, 'scripts', 'launch.mjs'))}${launchArgs.map(arg => ' ' + quote(arg)).join('')}\n`); chmodSync(executable, 0o755);
  const resources = join(bundle, 'Contents', 'Resources');
  const iconset = join(root, '.launcher', 'shortcut.iconset');
  mkdirSync(resources, { recursive: true }); mkdirSync(iconset, { recursive: true });
  const source = join(root, 'apps/desktop/lynx-mark.png');
  for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
    const result = spawnSync('/usr/bin/sips', ['-s', 'format', 'png', '-z', String(size * scale), String(size * scale), source, '--out', join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)], { shell: false, stdio: 'ignore' });
    if (result.status !== 0) throw new Error('Could not prepare the Nova Dream shortcut icon.');
  }
  const icon = spawnSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', join(resources, 'NovaDream.icns')], { shell: false, stdio: 'ignore' });
  if (icon.status !== 0) throw new Error('Could not create the Nova Dream shortcut icon.');
  const plist = join(bundle, 'Contents', 'Info.plist');
  writeFileSync(plist, readFileSync(plist, 'utf8').replace('</dict>', '<key>CFBundleIconFile</key><string>NovaDream.icns</string></dict>'));
  console.log(`Desktop shortcut created: ${bundle}`);
} else if (process.platform === 'win32') {
  const target = join(desktop, `${name}.lnk`);
  if (existsSync(target)) throw new Error('A desktop shortcut with this name already exists. It was left unchanged.');
  const ps = value => `'${value.replaceAll("'", "''")}'`;
  const program = `$link = (New-Object -ComObject WScript.Shell).CreateShortcut(${ps(target)}); $link.TargetPath = ${ps(process.execPath)}; $link.Arguments = ${ps('"' + join(root, 'scripts', 'launch.mjs') + '"' + launchArgs.map(arg => ' ' + arg).join(''))}; $link.WorkingDirectory = ${ps(root)}; $link.Description = 'Nova Dream'; $link.IconLocation = ${ps(join(root, 'apps/desktop/nova-dream.ico'))}; $link.Save()`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(program, 'utf16le').toString('base64')], { shell: false, windowsHide: true, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Windows did not confirm creation of the desktop shortcut.');
  console.log(`Desktop shortcut created: ${target}`);
} else throw new Error('Desktop shortcuts are currently supported on macOS and Windows.');
