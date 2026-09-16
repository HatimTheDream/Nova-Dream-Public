const { app, safeStorage } = require('electron');
const path = require('node:path');
// Legacy OS key-protection identity, with a separate helper profile. Keep this
// private service name stable so renaming the visible app cannot orphan keys.
// No window, renderer, networking, or command-line secret input.
app.setName('Nova Dream — Edition 3 Preview');
app.setPath('userData', path.join(app.getPath('appData'), 'NovaDream-Edition3-KeyVault'));
let size = 0, parts = [], done = false;
const finish = (value, status = 0) => { if (done) return; done = true; process.stdout.write(JSON.stringify(value) + '\n', () => app.exit(status)); };
const fail = () => finish({ error: 'os_key_unavailable' }, 1);
const timer = setTimeout(fail, 15000);
process.stdin.on('data', part => { size += part.length; if (size > 16384) fail(); else parts.push(part); });
process.stdin.on('error', fail);
process.stdin.on('end', async () => {
  try {
    await app.whenReady(); app.dock?.hide();
    if (!['darwin', 'win32'].includes(process.platform) || !await safeStorage.isAsyncEncryptionAvailable()) return fail();
    const input = JSON.parse(Buffer.concat(parts).toString()); parts = [];
    if (!input || !['wrap', 'unwrap'].includes(input.operation) || typeof input.value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.value)) return fail();
    const bytes = Buffer.from(input.value, 'base64');
    if (input.operation === 'wrap') {
      if (bytes.length !== 32) return fail();
      const wrapped = await safeStorage.encryptStringAsync(input.value);
      return finish({ value: wrapped.toString('base64') });
    }
    if (!bytes.length || bytes.length > 8192) return fail();
    const unwrapped = await safeStorage.decryptStringAsync(bytes);
    if (typeof unwrapped.result !== 'string' || Buffer.from(unwrapped.result, 'base64').length !== 32) return fail();
    finish({ value: unwrapped.result, rotate: unwrapped.shouldReEncrypt === true });
  } catch { fail(); }
});
process.on('uncaughtException', fail); process.on('unhandledRejection', fail);
