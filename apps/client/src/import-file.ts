import { importMaxBytes, importSourceSchema, novaImportSnapshotSchema, type ImportSource } from '../../../packages/domain/workspace-import';

/** Decrypt the predecessor's authenticated backup locally. The recovery key
 * stays in browser memory and is never sent to the service or persisted. */
export async function readImportFile(bytes: ArrayBuffer, keyFile: File | undefined, storeId: string, timezone: string): Promise<ImportSource> {
  if (bytes.byteLength > importMaxBytes) throw new Error('Choose a backup smaller than 32 MB.');
  const text = new TextDecoder().decode(bytes);
  if (!text.startsWith('nova:v1:')) return importSourceSchema.parse(JSON.parse(text));
  if (!keyFile || keyFile.size !== 32) throw new Error('Select the matching 32-byte Nova backup recovery key.');
  const parts = text.split(':');
  if (parts.length !== 5) throw new Error('This Nova backup is incomplete.');
  const decode = (value: string) => {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid backup encoding.');
    return Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
  };
  const keyBytes = new Uint8Array(await keyFile.arrayBuffer());
  let plain: Uint8Array | undefined;
  try {
    const iv = decode(parts[2]), tag = decode(parts[3]), body = decode(parts[4]);
    if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid backup envelope.');
    const key = await crypto.subtle.importKey('raw',keyBytes,{name:'AES-GCM'},false,['decrypt']);
    const cipher = new Uint8Array(body.length+tag.length); cipher.set(body); cipher.set(tag,body.length);
    plain = new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv,tagLength:128},key,cipher));
    const snapshot = novaImportSnapshotSchema.parse(JSON.parse(new TextDecoder().decode(plain)));
    return importSourceSchema.parse({format:'nova-dream-backup-15',storeId,timezone,snapshot});
  } catch { throw new Error('The key does not match, or the backup is damaged or uses an unsupported schema. Nothing was imported.'); }
  finally { keyBytes.fill(0); plain?.fill(0); }
}
