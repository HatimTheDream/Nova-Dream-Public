import { createPrivateKey, createPublicKey, sign, verify, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function regular(path, maximum) {
  const absolute = resolve(path), info = lstatSync(absolute);
  if (!info.isFile() || info.isSymbolicLink() || realpathSync(absolute) !== absolute || info.size > maximum || info.nlink !== 1) throw Error('Use an independent regular signing input file.');
  return readFileSync(absolute);
}

/** Sign a reviewed manifest with an existing external key. This command never creates keys or publishes. */
export async function signUpdateManifest({ input, privateKeyFile, publicKeyFile, output, previous }, contract) {
  const keyPath = resolve(privateKeyFile);
  if (keyPath === root || keyPath.startsWith(root + sep)) throw Error('Keep release signing material outside the source and updater installation.');
  if (process.platform !== 'win32' && (lstatSync(keyPath).mode & 0o077)) throw Error('The signing key must be readable only by its owner.');
  const privateKey = createPrivateKey(regular(keyPath, 16 * 1024)), publicKey = createPublicKey(regular(publicKeyFile, 16 * 1024));
  if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519') throw Error('Release metadata requires an existing Ed25519 key pair.');
  const derived = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }), trusted = publicKey.export({ format: 'der', type: 'spki' });
  if (derived.length !== trusted.length || !timingSafeEqual(derived, trusted)) throw Error('The release key does not match the provisioned public key.');
  const { updateManifestSchema, updateFeedLimits } = contract ?? await import('../dist/service/apps/service/update-feed.js');
  const manifest = updateManifestSchema.parse(JSON.parse(regular(input, updateFeedLimits.maxBytes).toString('utf8')));
  const now = Date.now(), created = Date.parse(manifest.createdAt), expires = Date.parse(manifest.expiresAt);
  if (created > now + 300_000 || expires <= now || expires <= created || expires - created > 31 * 86400000) throw Error('Use a current bounded release validity period.');
  for (const release of manifest.releases) {
    const url = new URL(release.bundle.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw Error('Use HTTPS artifact locations without embedded credentials or fragments.');
  }
  if (previous !== 'initial') {
    const old = JSON.parse(regular(previous, updateFeedLimits.maxBytes).toString('utf8'));
    if (typeof old.payload !== 'string' || typeof old.signature !== 'string') throw Error('Invalid previous signed feed.');
    const payload = Buffer.from(old.payload, 'base64');
    if (payload.toString('base64') !== old.payload || !verify(null, payload, publicKey, Buffer.from(old.signature, 'base64'))) throw Error('The previous feed signature did not verify.');
    const prior = updateManifestSchema.parse(JSON.parse(payload.toString('utf8')));
    if (prior.channel !== manifest.channel || manifest.sequence <= prior.sequence) throw Error('Advance the existing channel sequence before signing changed metadata.');
  } else if (manifest.sequence !== 1) throw Error('An initial feed must begin with sequence 1.');
  const payload = Buffer.from(JSON.stringify(manifest));
  const envelope = Buffer.from(JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') }) + '\n');
  if (envelope.length > updateFeedLimits.maxBytes) throw Error('The signed feed exceeds the host limit.');
  const fd = openSync(resolve(output), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, envelope); fsyncSync(fd); } finally { closeSync(fd); }
  return { channel: manifest.channel, sequence: manifest.sequence, releases: manifest.releases.length, bytes: envelope.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 7) throw Error('Usage: node scripts/update-manifest.mjs MANIFEST_JSON EXTERNAL_PRIVATE_KEY TRUSTED_PUBLIC_KEY OUTPUT_FEED_JSON PREVIOUS_FEED_JSON_OR_initial');
  console.log(JSON.stringify(await signUpdateManifest({ input: process.argv[2], privateKeyFile: process.argv[3], publicKeyFile: process.argv[4], output: process.argv[5], previous: process.argv[6] })));
}
