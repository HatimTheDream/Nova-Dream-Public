import sharp from 'sharp';
import { Fault, type Store } from './store.js';
import { imagePreviewType } from './image-preview.js';

/** Normalize user-selected portraits before they enter the encrypted blob store. */
export async function uploadContactPhoto(store: Store, device: string, data: { requestId: string; epoch: string; name: string; base64: string }) {
  if (data.epoch !== store.epoch) throw new Fault(409, 'epoch_changed', 'Review this photo after host recovery.');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data.base64)) throw new Fault(400, 'invalid_photo', 'Choose a JPEG, PNG or WebP photo.');
  const bytes = Buffer.from(data.base64, 'base64');
  if (bytes.length > 8 * 1024 * 1024) throw new Fault(413, 'file_too_large', 'Choose a photo smaller than 8 MB.');
  if (!imagePreviewType(bytes)) throw new Fault(400, 'invalid_photo', 'Choose a still JPEG, PNG or WebP photo, up to 16 megapixels.');
  let normalized: Buffer;
  try {
    normalized = await sharp(bytes, { limitInputPixels: 16_777_216, failOn: 'warning' }).rotate().resize(512, 512, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 88 }).toBuffer();
  } catch { throw new Fault(400, 'invalid_photo', 'This photo could not be opened. Choose another JPEG, PNG or WebP image.'); }
  return store.upload(device, data.requestId, data.epoch, 'contact-photo.webp', normalized.toString('base64'));
}
