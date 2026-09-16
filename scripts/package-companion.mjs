import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, rmSync, copyFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { verifyCandidate } from './candidate.mjs';

// Local construction only. Public distribution requires Developer ID signing
// and notarization. No backend, workspace, secrets or CuaDriver is bundled.
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This recipe supports Apple Silicon Macs. Other platforms need verified runtime and driver recipes.');
const root = resolve('.'), candidate = verifyCandidate(root);
const pin = { name: 'electron-v44.2.0-darwin-arm64.zip', sha256: 'f906dff5d054b1b92e5711781b13cc206fd7139ce66467503b9d0a3e6fbc9b02', url: 'https://github.com/electron/electron/releases/download/v44.2.0/electron-v44.2.0-darwin-arm64.zip' };
const run = (cmd, args) => { const result = spawnSync(cmd, args, { stdio: 'inherit', shell: false }); if (result.error || result.status !== 0) throw result.error ?? new Error(`${cmd} failed.`); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const cache = join(root, '.packages/cache'); mkdirSync(cache, { recursive: true, mode: 0o700 });
const archive = join(cache, pin.name);
if (!existsSync(archive)) {
  const temporary = join(cache, '.download-' + randomUUID());
  try { run('/usr/bin/curl', ['--fail','--location','--proto','=https','--tlsv1.2','--silent','--show-error',pin.url,'-o',temporary]); if (sha(readFileSync(temporary)) !== pin.sha256) throw new Error('Electron checksum mismatch.'); renameSync(temporary, archive); }
  finally { rmSync(temporary, { force: true }); }
}
if (sha(readFileSync(archive)) !== pin.sha256) throw new Error('Electron archive does not match its pinned upstream checksum.');
const output = join(root, '.packages/companion', candidate.manifest.version + '-' + candidate.id.slice(0, 12));
if (existsSync(output)) throw new Error('This exact candidate is already packaged; it will not be overwritten.');
const staging = join(root, '.packages/companion', '.staging-' + randomUUID()); mkdirSync(staging, { recursive: true, mode: 0o700 });
run('/usr/bin/ditto', ['-x','-k',archive,staging]);
const app = join(staging, 'Nova Dream Desktop.app'); renameSync(join(staging, 'Electron.app'), app);
const resources = join(app, 'Contents/Resources'), payload = join(resources, 'app'); mkdirSync(payload);
rmSync(join(resources, 'default_app.asar'), { force: true });
for (const name of ['LICENSE', 'LICENSES.chromium.html']) copyFileSync(join(staging, name), join(resources, 'Electron-' + name));
for (const [name, bytes] of candidate.bytes) if (name.startsWith('dist/desktop/companion')) writeFileSync(join(payload, name.split('/').at(-1)), bytes);
writeFileSync(join(payload, 'package.json'), JSON.stringify({ name: 'nova-dream-desktop', productName: 'Nova Dream Desktop', version: candidate.manifest.version, private: true, main: 'companion-main.cjs' }, null, 2));
const license = existsSync(join(root, 'LICENSE')) ? join(root, 'LICENSE') : join(root, '../LICENSE');
if (existsSync(license)) copyFileSync(license, join(payload, 'LICENSE'));
writeFileSync(join(payload, 'provenance.json'), JSON.stringify({ electron: pin, candidateId: candidate.id, publishing: false, notarized: false }, null, 2));
const plist = join(app, 'Contents/Info.plist');
for (const [key, value] of Object.entries({ CFBundleDisplayName: 'Nova Dream Desktop', CFBundleName: 'Nova Dream Desktop', CFBundleIdentifier: 'org.novadream.companion', CFBundleShortVersionString: candidate.manifest.version, CFBundleVersion: candidate.manifest.buildVersion, NSMicrophoneUsageDescription: 'Use voice when you start a call in Nova Dream.' })) run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
for (const helper of readdirSync(join(app,'Contents/Frameworks')).filter(name=>name.endsWith('.app'))) run('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleIdentifier org.novadream.companion.${helper.replace(/[^a-zA-Z]/g,'').toLowerCase()}`, join(app,'Contents/Frameworks',helper,'Contents/Info.plist')]);
const iconset = join(staging,'nova.iconset'); mkdirSync(iconset);
for (const size of [16,32,128,256,512]) for (const scale of [1,2]) run('/usr/bin/sips', ['-z',String(size*scale),String(size*scale),join(payload,'companion-icon.png'),'--out',join(iconset,`icon_${size}x${size}${scale===2?'@2x':''}.png`)]);
run('/usr/bin/iconutil',['-c','icns',iconset,'-o',join(resources,'electron.icns')]); rmSync(iconset,{recursive:true});
run('/usr/bin/codesign',['--force','--deep','--sign','-',app]); run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
const name = `Nova-Dream-Desktop-${candidate.manifest.version}-darwin-arm64.zip`, file = join(staging,name);
run('/usr/bin/ditto',['-c','-k','--keepParent',app,file]);
const bytes = readFileSync(file), chunks = []; for(let offset=0;offset<bytes.length;offset+=2*1024*1024)chunks.push(sha(bytes.subarray(offset,offset+2*1024*1024)));
writeFileSync(join(staging,'downloads.json'),JSON.stringify({format:1,files:[{platform:'darwin',arch:'arm64',version:candidate.manifest.version,name,bytes:bytes.length,sha256:sha(bytes),chunks,signing:'local-ad-hoc'}]},null,2)+'\n');
renameSync(staging,output); console.log(`Verified private companion: ${output}\nThis local build is not notarized and must not be published as a public installer.`);
