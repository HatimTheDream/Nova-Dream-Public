const { app, BrowserWindow, ipcMain, dialog, session, safeStorage, nativeImage, Tray, Menu } = require('electron');
const { join, basename } = require('node:path');
const { pathToFileURL } = require('node:url');
const { homedir, hostname } = require('node:os');
const { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, realpathSync, openSync, fsyncSync, closeSync, mkdtempSync, rmSync } = require('node:fs');
const { randomUUID, generateKeyPairSync, sign } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { CompanionClient } = require('./companion-client.cjs');
const { CompanionMcp } = require('./companion-mcp.cjs');
const { tools, requiredTools, active, selection, launchPolicy, remembered } = require('./companion-access.cjs');
app.setName('Nova Dream Desktop'); app.setAppUserModelId('org.novadream.companion');
const qa = process.env.NOVA_COMPANION_QA_PROFILE;
if (qa && !/^[a-z0-9-]{1,40}$/.test(qa)) throw new Error('Invalid companion test profile.');
app.setPath('userData', join(app.getPath('appData'), qa ? 'NovaDream-Companion-QA-' + qa : 'NovaDream-Companion'));
let controls, workspace, browser, client, daemon, mcp, timer, expiryTimer, tray, config = {}, selectedApps = [], toolCatalog = [], enabledUntil = 0, accessScope = 'apps', error = '', connectionError = '', quitting = false, stoppedForQuit = false, stopping = Promise.resolve(), sessionDirectory, accessGeneration = 0, startingAccess = false;
const storePath = join(app.getPath('userData'), 'connection.enc');
const stoppedPath = join(app.getPath('userData'), 'computer-access-stopped');
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
function stopAccess(forget = true) {
  accessGeneration++;
  enabledUntil = 0; toolCatalog = []; clearTimeout(expiryTimer);
  updateIndicator();
  if (forget && config.access) {
    // A non-secret stop marker prevents restart admission even if Keychain
    // refuses the following encrypted preference write.
    try {
      writeFileSync(stoppedPath, 'Stopped by local controls or remote revocation.\n', { mode: 0o600 });
      const fd = openSync(stoppedPath, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    } catch (e) { error = 'The stop preference could not be saved: ' + e.message; }
    delete config.access; try { persist(); } catch (e) { error = e.message; }
  }
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
  client = new CompanionClient({ connection: config.connection, request: send, readReceipt: () => config.receipt, saveReceipt: value => { config.receipt = value; persist(); }, status: () => ({ enabledUntil, scope: accessScope, apps: active(enabledUntil) && accessScope === 'apps' ? selectedApps.map(a => a.name) : [], tools: active(enabledUntil) ? toolCatalog : [] }), execute: async (call, expiresAt) => {
    if (!mcp || !active(enabledUntil) || expiresAt <= Date.now() || !toolCatalog.some(t => t.name === call.tool)) throw new Error('This computer access is not enabled.');
    const result = await mcp.request('tools/call', { name: call.tool, arguments: call.arguments }, Math.min(30000, expiresAt - Date.now()));
    // Keep the original pixel geometry. Refuse oversized output instead of
    // silently rescaling coordinates that the driver would interpret differently.
    if (Buffer.byteLength(JSON.stringify(result)) > 400000) throw new Error('The observation is too large. Request a smaller app/window observation.');
    return result;
  } });
}
function updateIndicator() {
  if(!tray)return;
  const enabled=active(enabledUntil), label=enabled?accessScope==='desktop'?'Full desktop access on':'Selected app access on':'Computer access off';
  tray.setToolTip('Nova Dream · '+label);tray.setTitle(enabled?'Nova • On':'');
  tray.setContextMenu(Menu.buildFromTemplate([{label,enabled:false},{label:'Desktop controls',click:()=>{controls.show();controls.focus();}},{label:'Stop computer access',click:()=>void stopAccess().then(()=>client?.disconnect()).then(()=>{client=undefined;runClient();}).catch(e=>{error=e.message;})},{type:'separator'},{label:'Quit Nova Dream Desktop',click:()=>app.quit()}]));
}
function appIdentity(root) {
  root = realpathSync(root); if (!root.endsWith('.app')) throw new Error('Choose application bundles.');
  const plist=join(root,'Contents/Info.plist'), read=k=>execFileSync('/usr/libexec/PlistBuddy',['-c','Print :'+k,plist],{encoding:'utf8',timeout:3000}).trim();
  const bundleId=read('CFBundleIdentifier'), executable=read('CFBundleExecutable');
  if(!/^[\w.-]+$/.test(bundleId)||!executable||executable.includes('/')||executable==='..')throw new Error('Unsupported application identity.');
  return {name:basename(root,'.app'),bundleId,executable:realpathSync(join(root,'Contents/MacOS',executable))};
}
async function startAccess(grant, resume = false) {
  if (startingAccess || active(enabledUntil) || !config.connection || quitting) throw new Error('Computer access is already starting, enabled, or disconnected.');
  const generation = ++accessGeneration, connection = config.connection; startingAccess = true;
  const current = () => generation === accessGeneration && config.connection === connection && !quitting;
  try {
    await stopping;
    if (!current()) return;
    if (resume && existsSync(stoppedPath)) return;
    for (const a of grant.apps) {
      const suffix = '/Contents/MacOS/', root = a.executable.slice(0,a.executable.lastIndexOf(suffix));
      const actual = appIdentity(root);
      if (actual.bundleId !== a.bundleId || actual.executable !== a.executable) throw new Error('An approved app changed identity. Choose it again before enabling access.');
    }
    const driver=join(homedir(),'.local/bin/cua-driver');
    if(!existsSync(driver))throw new Error('Install the supported CuaDriver helper before enabling computer access.');
    const policy=launchPolicy(grant), dir=mkdtempSync('/tmp/nova-cua-'); sessionDirectory=dir;
    const socket=join(dir,'driver.sock'), args=['serve','--socket',socket,'--permission-mode',policy.mode];
    if(policy.manifest){const manifest=join(dir,'capabilities.yaml');writeFileSync(manifest,policy.manifest,{mode:0o600});args.push('--capability-manifest',manifest,'--approve-capability-manifest');}
    const activeDaemon=spawn(driver,args,{stdio:'ignore',shell:false}); daemon=activeDaemon;
    activeDaemon.on('error',()=>{if(daemon===activeDaemon){error='The computer helper could not start.';void stopAccess();}});
    activeDaemon.on('exit',()=>{if(daemon===activeDaemon){error='Computer helper stopped. Enable access again when ready.';void stopAccess();}});
    const deadline=Date.now()+10000;
    while(current()&&!existsSync(socket)&&Date.now()<deadline&&activeDaemon.exitCode===null)await new Promise(r=>setTimeout(r,100));
    if(!current())return;
    if(!existsSync(socket))throw new Error('The computer helper did not become ready. Check its OS permissions.');
    const nextMcp=new CompanionMcp(driver,['mcp','--socket',socket]); mcp=nextMcp;
    const catalog=await nextMcp.ready(); if(!current())return;
    if(!requiredTools.every(name=>catalog.tools.some(t=>t.name===name)) || grant.scope==='desktop'&&!catalog.tools.some(t=>t.name==='get_desktop_state'))throw new Error('The computer helper lacks the required tools.');
    toolCatalog=catalog.tools.filter(t=>policy.tools.includes(t.name)).map(({name,description,inputSchema})=>({name,description:description?.slice(0,8000),inputSchema}));
    if(Buffer.byteLength(JSON.stringify(toolCatalog))>180000)throw new Error('The helper tool catalog exceeds the connection limit.');
    selectedApps=grant.apps;accessScope=grant.scope;
    if(grant.duration==='persistent'){
      config.access={...grant,origin:config.origin,deviceId:connection.deviceId,epoch:connection.epoch};persist();
      if(!resume)rmSync(stoppedPath,{force:true});
      enabledUntil=null;
    }else{delete config.access;persist();enabledUntil=Date.now()+grant.duration*60000;expiryTimer=setTimeout(()=>void stopAccess(),grant.duration*60000);}
    error='';updateIndicator();
  } catch(e) { await stopAccess(); throw e; }
  finally { startingAccess=false; }
}
async function tick() {
  if(!client||client.busy||quitting)return;
  const currentClient=client;
  try { await currentClient.tick(); connectionError=''; }
  catch(e) { connectionError=String(e.message).slice(0,300);return; }
  if(client!==currentClient||currentClient.stopped||quitting)return;
  try {
    // A remembered grant is resumed only after the same signed desktop link
    // has reached its host. Rejected/revoked links erase the preference.
    const grant=remembered(config);
    if(grant&&!active(enabledUntil)&&!startingAccess&&!existsSync(stoppedPath))await startAccess(grant,true);
  } catch(e) { error=String(e.message).slice(0,300); }
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
  tray=new Tray(icon.resize({width:18,height:18}));updateIndicator();
  ipcMain.handle('companion:status', event => { localSender(event); return { origin: config.origin, linked: !!config.connection, platform: process.platform, apps: selectedApps.map(a=>a.name), enabledUntil, scope: remembered(config)?.scope ?? accessScope, remembered: !!remembered(config) && !existsSync(stoppedPath), starting: startingAccess, error: connectionError || error }; });
  ipcMain.handle('companion:open', (event,url) => { localSender(event); return openWorkspace(url); });
  ipcMain.handle('companion:open-controls', event => { workspaceSender(event); controls.show(); controls.focus(); });
  ipcMain.handle('companion:prepare-link', async(event, challenge) => {
    workspaceSender(event); if (config.connection) throw new Error('This desktop is already linked. Use Disconnect and forget this link in Desktop controls before linking again.');
    if (!challenge || !/^[a-f0-9-]{36}$/.test(challenge.id) || !/^[a-f0-9-]{36}$/.test(challenge.epoch) || !/^[A-Za-z0-9_-]{43}$/.test(challenge.nonce) || challenge.expiresAt <= Date.now() || challenge.expiresAt > Date.now()+6*60000) throw new Error('The pairing challenge expired or is invalid.');
    const choice = await dialog.showMessageBox(controls, { type: 'question', message: 'Link this desktop to Nova?', detail: config.origin + '\nComputer access will stay off until you choose its scope and duration in Desktop controls.', buttons: ['Cancel','Link desktop'], defaultId: 0, cancelId: 0 });
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
    localSender(event); if (active(enabledUntil)||startingAccess) throw new Error('Stop computer access before changing apps.');
    if (process.platform !== 'darwin') throw new Error('This build supports bounded Mac app selection.');
    const selected = await dialog.showOpenDialog(controls,{title:'Choose apps Nova may control',defaultPath:'/Applications',properties:['openFile','multiSelections'],filters:[{name:'Mac applications',extensions:['app']}]});
    if (selected.canceled) return;
    selectedApps=selected.filePaths.slice(0,20).map(appIdentity);
  });
  ipcMain.handle('companion:enable', async(event,value)=>{
    localSender(event);if(!config.connection||active(enabledUntil)||startingAccess)throw new Error('Link this desktop and stop any current access first.');
    const grant=selection(value,selectedApps), connection=config.connection, generation=accessGeneration;
    const scope=grant.scope==='desktop'?'Full desktop access':grant.apps.map(a=>a.name).join(', ');
    const duration=grant.duration==='persistent'?'until you turn it off':`for ${grant.duration} minutes`;
    const detail=scope+'\nWorkspace: '+config.origin+'\nNova can observe and control '+(grant.scope==='desktop'?'all apps and the visible desktop, including logged-in services and files reachable through their interfaces':'these apps')+'. Visible content may be sent to your workspace’s connected AI. Each request still follows Nova’s review flow. '+(grant.duration==='persistent'?'This choice is remembered and resumes when you reopen this companion. Stop or revoke the link to clear it.':'Access ends automatically.');
    const choice=await dialog.showMessageBox(controls,{type:'warning',message:`Enable ${grant.scope==='desktop'?'full desktop':'selected app'} access ${duration}?`,detail,buttons:['Cancel','Enable access'],defaultId:0,cancelId:0});
    if(choice.response!==1)return;if(config.connection!==connection||generation!==accessGeneration||quitting)throw new Error('The connection changed. Review access again.');
    await startAccess(grant);
  });
  ipcMain.handle('companion:forget',async event=>{localSender(event);await stopAccess();await client?.disconnect();client=undefined;delete config.connection;delete config.pendingLink;delete config.receipt;persist();error='';});
  ipcMain.handle('companion:linked',event=>{workspaceSender(event);return config.connection ? { deviceId: config.connection.deviceId, epoch: config.connection.epoch } : null;});
  ipcMain.handle('companion:stop',async event=>{localSender(event);await stopAccess();await client?.disconnect();client=undefined;runClient();});
  await controls.loadFile(join(__dirname,'companion.html'));runClient();
  timer=setInterval(()=>void tick(),2000);
}).catch(e=>{dialog.showErrorBox('Nova desktop connection',e.message);app.quit();});
app.on('activate',()=>{controls?.show();controls?.focus();});
app.on('second-instance',()=>{controls?.show();controls?.focus();});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event=>{if(stoppedForQuit)return;event.preventDefault();if(quitting)return;quitting=true;clearInterval(timer);if(client)client.stopped=true;void Promise.all([stopAccess(false),client?.disconnect()]).finally(()=>{stoppedForQuit=true;app.quit();});});
