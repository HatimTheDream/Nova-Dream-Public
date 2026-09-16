const { app, BrowserWindow, nativeImage, session, shell, ipcMain, dialog } = require('electron');
const path = require('node:path');
const { readFileSync, realpathSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { canOpenExternal, privatePhoneOrigin, openPhoneExternal } = require('./external.cjs');
const { launchOptions, profileDirectory, prepareQaDirectory, matchesCandidate, expectedCandidate } = require('./launch-policy.cjs');
const workspace = realpathSync(process.env.E3_DESKTOP_WORKSPACE || '.');
const options = launchOptions(process.argv.slice(2), workspace);
const root = path.resolve(__dirname, '../..');
const pkgBytes = readFileSync(path.join(root, 'package.json')), manifestBytes = readFileSync(path.join(root, 'dist/candidate.json'));
const expected = expectedCandidate(JSON.parse(manifestBytes), createHash('sha256').update(Buffer.concat([pkgBytes, manifestBytes])).digest('hex'));
if (process.env.E3_DESKTOP_CANDIDATE !== expected.candidateId || realpathSync(root) !== realpathSync(path.join(workspace, '.launcher/candidates', expected.candidateId))) throw new Error('Use the Nova Dream launcher to open the verified desktop candidate.');
// Dedicated preview identity; never opens either predecessor's profile.
app.setName('Nova Dream — Edition 3 Preview');
app.setAppUserModelId('private.novadream.edition3.preview');
// The default profile remains NovaDream-Edition3-Preview; QA uses only short,
// validated names inside the workspace's .tmp-qa directory.
const profile = profileDirectory(options, workspace, app.getPath('appData'));
if (options.qa) prepareQaDirectory(profile, workspace);
app.setPath('userData', profile);
const address = options.address;
let window;
if (!app.requestSingleInstanceLock({ candidateId: expected.candidateId, port: options.port })) app.quit();
else app.whenReady().then(async () => {
  const response = await fetch(address + '/api/health', { signal: AbortSignal.timeout(3000), redirect: 'error' });
  if (!response.ok || !matchesCandidate(await response.json(), expected)) throw new Error('The running service does not match this desktop build. It was left running.');
  const icon = nativeImage.createFromPath(path.join(__dirname, 'lynx-mark.png'));
  if (!icon.isEmpty() && process.platform === 'darwin') app.dock.setIcon(icon);
  const ownsPage = contents => { try { return contents && new URL(contents.getURL()).origin === address; } catch { return false; } };
  const ownsUrl = url => { try { return new URL(url).origin === address; } catch { return false; } };
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(
    ownsPage(contents) && details.isMainFrame === true && ownsUrl(details.requestingUrl) &&
    (permission === 'notifications' || (permission === 'media' && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio'))
  ));
  session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) =>
    ownsPage(contents) && origin === address && details.isMainFrame === true && ownsUrl(details.requestingUrl) && (permission === 'notifications' || (permission === 'media' && details.mediaType === 'audio'))
  );
  window = new BrowserWindow({ width: 1440, height: 960, minWidth: 360, minHeight: 420, icon, backgroundColor: '#f7f6f2', title: `Nova Dream · ${expected.version}`, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  window.webContents.on('page-title-updated', event => event.preventDefault());
  // A renderer reload cannot update this process or its preload. Send the
  // shell identity separately so both halves must match the serving candidate.
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [address + '/api/*'] }, (details, callback) => {
    const headers = { ...details.requestHeaders };
    for (const key of Object.keys(headers)) if (key.toLowerCase() === 'x-edition3-desktop') delete headers[key];
    headers['X-Edition3-Desktop'] = expected.candidateId;
    callback({ requestHeaders: headers });
  });
  ipcMain.handle('edition3:choose-working-folder', async event => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !ownsPage(event.sender)) throw new Error('Working folders can only be chosen from Nova Dream.');
    const result = await dialog.showOpenDialog(window, { title: 'Choose a working folder', properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  const readLocalState = async pathname => {
    const response = await session.defaultSession.fetch(address + pathname, { credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error('The workspace connection is unavailable.');
    return response.json();
  };
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!ownsPage(window.webContents)) return { action: 'deny' };
    if (canOpenExternal(url)) void shell.openExternal(url);
    else if (privatePhoneOrigin(url)) void openPhoneExternal(url, {
      readHealth: () => readLocalState('/api/health'), readPhoneState: () => readLocalState('/api/phone/state'),
      isCurrentPage: () => !window.isDestroyed() && ownsPage(window.webContents), expected, openExternal: value => shell.openExternal(value)
    }).then(opened => { if (!opened) throw new Error('phone-address-unavailable'); }).catch(() => {
      if (!window.isDestroyed()) void dialog.showMessageBox(window, { type: 'info', title: 'Phone address unavailable', message: 'Refresh Settings and check that private phone access is ready before opening its address.', buttons: ['OK'] });
    });
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== address) event.preventDefault(); });
  await window.loadURL(address);
}).catch(error => { dialog.showErrorBox('Nova Dream could not open', error.message); app.quit(); });
app.on('second-instance', (_event, _args, _cwd, data) => {
  if (data.candidateId !== expected.candidateId || data.port !== options.port) { dialog.showErrorBox('A different preview is already open', 'Close this desktop preview before opening a different candidate with the same profile.'); return; }
  if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
});
app.on('window-all-closed', () => app.quit());
