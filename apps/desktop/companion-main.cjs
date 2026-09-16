const { app, BrowserWindow, ipcMain, dialog, session, safeStorage, nativeImage } = require('electron');
const { join, basename } = require('node:path');
const { pathToFileURL } = require('node:url');
const { homedir, hostname } = require('node:os');
const { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, realpathSync, openSync, fsyncSync, closeSync, mkdtempSync, rmSync } = require('node:fs');
const { randomUUID, generateKeyPairSync, sign } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { CompanionClient } = require('./companion-client.cjs');
const { CompanionMcp } = require('./companion-mcp.cjs');
const tools = ['start_session','end_session','launch_app','bring_to_front','list_windows','get_window_state','click','press_key'];
app.setName('Nova Dream Desktop'); app.setAppUserModelId('org.novadream.companion');
const qa = process.env.NOVA_COMPANION_QA_PROFILE;
if (qa && !/^[a-z0-9-]{1,40}$/.test(qa)) throw new Error('Invalid companion test profile.');
app.setPath('userData', join(app.getPath('appData'), qa ? 'NovaDream-Companion-QA-' + qa : 'NovaDream-Companion'));
let controls, workspace, browser, client, daemon, mcp, timer, expiryTimer, config = {}, selectedApps = [], toolCatalog = [], enabledUntil = 0, error = '', quitting = false, stoppedForQuit = false, stopping = Promise.resolve(), sessionDirectory;
const storePath = join(app.getPath('userData'), 'connection.enc');
const controlsUrl = pathToFileURL(join(__dirname, 'companion.html')).href;
function persist() {
  if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('Set up your operating system’s credential storage before linking this desktop.');
  mkdirSync(app.getPath('userData'), { recursive: true, mode: 0o700 });
  const temporary = storePath + '.new'; writeFileSync(temporary, safeStorage.encryptString(JSON.stringify(config)), { mode: 0o600 });
  const fd = openSync(temporary, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } renameSync(temporary, storePath);
}
function checkedOrigin(value) { const url = new URL(value); if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname))) throw new Error('Use the HTTPS address of your Nova host, or a local loopback address.'); return url.origin; }
function localSender(event) { if (!controls || event.sender !== controls.webContents || event.senderFrame !== controls.webContents.mainFrame || event.sender.getURL() !== controlsUrl) throw new Error('Use the local Desktop controls window.'); }
function workspaceSender(event) { if (!workspace || event.sender !== workspace.webContents || event.senderFrame !== workspace.webContents.mainFrame || new URL(event.sender.getURL()).origin !== config.origin) throw new Error('Use your selected Nova workspace.'); }
async function endChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => { let timeout; const done = () => { clearTimeout(timeout); resolve(); }; child.once('exit', done); child.once('error', done); child.kill('SIGTERM'); timeout = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000); });
}
function stopAccess() {
  enabledUntil = 0; toolCatalog = []; clearTimeout(expiryTimer);
  const oldMcp = mcp, oldDaemon = daemon, oldDirectory = sessionDirectory; mcp = undefined; daemon = undefined; sessionDirectory = undefined;
  stopping = stopping.then(async () => { oldMcp?.close(); await Promise.all([endChild(oldMcp?.child), endChild(oldDaemon)]); if (oldDirectory) rmSync(oldDirectory, { recursive: true, force: true }); }); return stopping;
}
async function send(packet) {
  const response = await browser.fetch(config.origin + '/api/companions/transport', { method: 'POST', credentials: 'include', redirect: 'error', headers: { 'Content-Type': 'application/json', 'X-Edition3-Client': '1', Origin: config.origin }, body: JSON.stringify(packet), signal: AbortSignal.timeout(10000) });
  if (!response.ok) { if ([401,403].includes(response.status)) await stopAccess(); throw new Error('Desktop connection unavailable. Open Nova and check its sign-in and device link.'); }
  const value = await response.text(); if (Buffer.byteLength(value) > 450000) throw new Error('Desktop response exceeded its limit.'); return JSON.parse(value);
}
function runClient() {
  if (!config.connection) return;
  client = new CompanionClient({ connection: config.connection, request: send, readReceipt: () => config.receipt, saveReceipt: value => { config.receipt = value; persist(); }, status: () => ({ enabledUntil, apps: enabledUntil ? selectedApps.map(a => a.name) : [], tools: enabledUntil ? toolCatalog : [] }), execute: async (call, expiresAt) => {
    if (!mcp || enabledUntil <= Date.now() || expiresAt <= Date.now() || !tools.includes(call.tool)) throw new Error('This app session is not enabled.');
    const result = await mcp.request('tools/call', { name: call.tool, arguments: call.arguments }, Math.min(30000, expiresAt - Date.now()));
    // Keep the original pixel geometry. Refuse oversized output instead of
    // silently rescaling coordinates that the driver would interpret differently.
    if (Buffer.byteLength(JSON.stringify(result)) > 400000) throw new Error('The observation is too large. Request a smaller app/window observation.');
    return result;
  } });
}
async function openWorkspace(origin) {
  const next = checkedOrigin(origin);
  if (config.origin && next !== config.origin) {
    const choice = await dialog.showMessageBox(controls, { type: 'question', message: 'Switch workspace and disconnect this desktop?', detail: 'The previous workspace’s saved work is unchanged.', buttons: ['Cancel','Switch'], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return;
    await stopAccess(); await client?.disconnect(); client = undefined; config = {};
  }
  config.origin = next; persist();
  if (!workspace || workspace.isDestroyed()) {
    workspace = new BrowserWindow({ width: 1280, height: 880, minWidth: 360, minHeight: 420, title: 'Nova Dream', webPreferences: { partition: 'persist:nova-workspace', preload: join(__dirname, 'companion-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
    workspace.webContents.setWindowOpenHandler(({ url }) => { try { const value = new URL(url); if (value.protocol !== 'https:') return { action: 'deny' }; return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { partition: 'persist:nova-workspace', nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, preload: undefined } } }; } catch { return { action: 'deny' }; } });
    workspace.webContents.on('will-navigate', (event, url) => { try { if (!['https:', 'http:'].includes(new URL(url).protocol) || new URL(url).protocol === 'http:' && new URL(url).origin !== config.origin) event.preventDefault(); } catch { event.preventDefault(); } });
  }
  await workspace.loadURL(next); workspace.show();
}
if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(async () => {
  if (existsSync(storePath)) { try { config = JSON.parse(safeStorage.decryptString(readFileSync(storePath))); } catch { throw new Error('The saved desktop connection could not be unlocked. Its file was preserved.'); } }
  browser = session.fromPartition('persist:nova-workspace');
  const permitted = new Set();
  browser.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    const sameWorkspace = contents === workspace?.webContents && details.isMainFrame !== false && (() => { try { return new URL(details.requestingUrl || contents.getURL()).origin === config.origin; } catch { return false; } })();
    if (!sameWorkspace || !['media','notifications'].includes(permission) || permission === 'media' && (!details.mediaTypes?.length || details.mediaTypes.some(type => type !== 'audio'))) return callback(false);
    const choice = await dialog.showMessageBox(controls, { type: 'question', message: permission === 'media' ? 'Allow Nova to use this microphone?' : 'Allow Nova notifications?', detail: config.origin, buttons: ['Deny','Allow'], defaultId: 0, cancelId: 0 });
    const allowed = choice.response === 1 && contents === workspace?.webContents && new URL(contents.getURL()).origin === config.origin;
    if (allowed) permitted.add(config.origin + ':' + permission); callback(allowed);
  });
  browser.setPermissionCheckHandler((contents, permission, origin, details) => contents === workspace?.webContents && origin === config.origin && permitted.has(origin + ':' + permission) && (permission !== 'media' || details.mediaType === 'audio'));
  controls = new BrowserWindow({ width: 780, height: 850, minWidth: 400, title: 'Nova Dream · Desktop connection', webPreferences: { preload: join(__dirname,'companion-controls-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  controls.on('close', event => { if (!quitting) { event.preventDefault(); controls.hide(); } });
  controls.webContents.on('will-navigate', event => event.preventDefault()); controls.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const icon = nativeImage.createFromPath(join(__dirname,'companion-icon.png')); if (process.platform === 'darwin') app.dock.setIcon(icon);
  ipcMain.handle('companion:status', event => { localSender(event); return { origin: config.origin, linked: !!config.connection, platform: process.platform, apps: selectedApps.map(a=>a.name), enabledUntil, error }; });
  ipcMain.handle('companion:open', (event,url) => { localSender(event); return openWorkspace(url); });
  ipcMain.handle('companion:open-controls', event => { workspaceSender(event); controls.show(); controls.focus(); });
  ipcMain.handle('companion:prepare-link', async(event, challenge) => {
    workspaceSender(event); if (config.connection) throw new Error('This desktop is already linked. Use Disconnect and forget this link in Desktop controls before linking again.');
    if (!challenge || !/^[a-f0-9-]{36}$/.test(challenge.id) || !/^[a-f0-9-]{36}$/.test(challenge.epoch) || !/^[A-Za-z0-9_-]{43}$/.test(challenge.nonce) || challenge.expiresAt <= Date.now() || challenge.expiresAt > Date.now()+6*60000) throw new Error('The pairing challenge expired or is invalid.');
    const choice = await dialog.showMessageBox(controls, { type: 'question', message: 'Link this desktop to Nova?', detail: config.origin + '\nComputer access will stay off until you choose apps and enable a timed session.', buttons: ['Cancel','Link desktop'], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) throw new Error('Desktop linking cancelled.');
    if (challenge.expiresAt <= Date.now()) throw new Error('The pairing request expired. Click Link this desktop to prepare a fresh one.');
    const keys = generateKeyPairSync('ed25519'), deviceId = randomUUID();
    config.pendingLink = { deviceId, epoch: challenge.epoch, privateKey: keys.privateKey.export({ format:'pem',type:'pkcs8' }).toString() };
    persist();
    const data = JSON.stringify(['nova-desktop-link',1,challenge.id,challenge.epoch,challenge.nonce,challenge.expiresAt,deviceId]);
    return { deviceId, name: hostname().slice(0,80), platform: process.platform, publicKey: keys.publicKey.export({format:'pem',type:'spki'}).toString(), signature: sign(null,Buffer.from(data),keys.privateKey).toString('base64url') };
  });
  ipcMain.handle('companion:finish-link', async(event,value) => { workspaceSender(event); if (config.connection?.deviceId === value.deviceId && config.connection?.epoch === value.epoch) { persist(); if(!client)runClient(); return; } if (!config.pendingLink || value.epoch !== config.pendingLink.epoch || value.deviceId !== config.pendingLink.deviceId) throw new Error('This is not the prepared desktop link.'); config.connection=config.pendingLink; delete config.pendingLink; persist(); runClient(); await client.tick(); });
  ipcMain.handle('companion:choose-apps', async event => {
    localSender(event); if (enabledUntil) throw new Error('Stop the current app session before changing access.');
    if (process.platform !== 'darwin') throw new Error('This build supports bounded Mac app selection.');
    const selected = await dialog.showOpenDialog(controls,{title:'Choose apps Nova may control',defaultPath:'/Applications',properties:['openFile','multiSelections'],filters:[{name:'Mac applications',extensions:['app']}]});
    if (selected.canceled) return;
    selectedApps=selected.filePaths.slice(0,20).map(file=>{ const root=realpathSync(file); if(!root.endsWith('.app'))throw new Error('Choose application bundles.'); const plist=join(root,'Contents/Info.plist'); const read=k=>execFileSync('/usr/libexec/PlistBuddy',['-c','Print :'+k,plist],{encoding:'utf8',timeout:3000}).trim(); const bundleId=read('CFBundleIdentifier'), executable=read('CFBundleExecutable'); if(!/^[\w.-]+$/.test(bundleId)||!executable||executable.includes('/')||executable==='..')throw new Error('Unsupported application identity.'); return {name:basename(root,'.app'),bundleId,executable:realpathSync(join(root,'Contents/MacOS',executable))}; });
  });
  ipcMain.handle('companion:enable', async(event,minutes)=>{
    localSender(event); if(!config.connection||!selectedApps.length||![15,30,60].includes(minutes)||enabledUntil)throw new Error('Link the desktop and select apps before enabling a new session.');
    const driver=join(homedir(),'.local/bin/cua-driver'); if(!existsSync(driver))throw new Error('Install the supported CuaDriver helper before enabling computer access.');
    const choice=await dialog.showMessageBox(controls,{type:'question',message:`Enable selected apps for ${minutes} minutes?`,detail:selectedApps.map(a=>a.name).join(', ')+'\nNova may observe and control these apps, sending their visible content to your connected AI. Approved requests from your Nova workspace can run during this session while you are away. Whole-desktop capture is off.',buttons:['Cancel','Enable apps'],defaultId:0,cancelId:0});if(choice.response!==1)return;
    await stopping; const dir=mkdtempSync('/tmp/nova-cua-'); sessionDirectory=dir;
    const manifest=join(dir,'capabilities.yaml'),socket=join(dir,'driver.sock');
    const yaml=`version: 3\nexpires_after: ${minutes}m\nidle_timeout: 10m\nallow:\n  tools:\n${tools.map(t=>'    - '+t).join('\n')}\nresources:\n  apps:\n${selectedApps.map(a=>'    - executable: '+JSON.stringify(a.executable)+'\n      windows: all\n    - bundle_id: '+JSON.stringify(a.bundleId)+'\n      launch: true').join('\n')}\n  desktop:\n    display: false\n`;
    writeFileSync(manifest,yaml,{mode:0o600}); const activeDaemon=spawn(driver,['serve','--socket',socket,'--permission-mode','bounded','--capability-manifest',manifest,'--approve-capability-manifest'],{stdio:'ignore',shell:false}); daemon=activeDaemon; activeDaemon.on('error',()=>{if(daemon===activeDaemon){error='The computer helper could not start.';void stopAccess();}}); activeDaemon.on('exit',()=>{if(daemon===activeDaemon)void stopAccess();});
    const deadline=Date.now()+10000;while(!existsSync(socket)&&Date.now()<deadline&&daemon?.exitCode===null)await new Promise(r=>setTimeout(r,100));
    if(!existsSync(socket)){await stopAccess();throw new Error('The computer helper did not become ready. Check its OS permissions.');}
    mcp=new CompanionMcp(driver,['mcp','--socket',socket]);try{const catalog=await mcp.ready();if(!tools.every(name=>catalog.tools.some(t=>t.name===name)))throw new Error('The computer helper lacks the required bounded tools.');toolCatalog=catalog.tools.filter(t=>tools.includes(t.name)).map(({name,description,inputSchema})=>({name,description,inputSchema}));}catch(e){await stopAccess();throw e;}
    enabledUntil=Date.now()+minutes*60000;expiryTimer=setTimeout(()=>void stopAccess(),minutes*60000);error='';
  });
  ipcMain.handle('companion:forget',async event=>{localSender(event);await stopAccess();await client?.disconnect();client=undefined;delete config.connection;delete config.pendingLink;delete config.receipt;persist();error='';});
  ipcMain.handle('companion:linked',event=>{workspaceSender(event);return config.connection ? { deviceId: config.connection.deviceId, epoch: config.connection.epoch } : null;});
  ipcMain.handle('companion:stop',async event=>{localSender(event);await stopAccess();await client?.disconnect();client=undefined;runClient();});
  await controls.loadFile(join(__dirname,'companion.html'));runClient();
  timer=setInterval(()=>{if(client)void client.tick().then(()=>{error='';},e=>{error=String(e.message).slice(0,300);});},2000);
}).catch(e=>{dialog.showErrorBox('Nova desktop connection',e.message);app.quit();});
app.on('activate',()=>{controls?.show();controls?.focus();});
app.on('second-instance',()=>{controls?.show();controls?.focus();});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event=>{if(stoppedForQuit)return;event.preventDefault();if(quitting)return;quitting=true;clearInterval(timer);if(client)client.stopped=true;void Promise.all([stopAccess(),client?.disconnect()]).finally(()=>{stoppedForQuit=true;app.quit();});});
