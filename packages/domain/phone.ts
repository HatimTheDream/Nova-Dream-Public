import { z } from 'zod';

export const phoneCommandSchema = z.object({ requestId: z.uuid(), epoch: z.uuid() }).strict();
export const phoneRevokeSchema = phoneCommandSchema.extend({ deviceId: z.uuid() });
export const phonePairSchema = z.object({
  requestId: z.uuid(),
  code: z.string().max(80).transform(value => value.replace(/[\s-]/g, '').toLowerCase()).pipe(z.string().regex(/^[0-9]{8}$/)),
  name: z.string().trim().min(1).max(80).refine(value => !/[\x00-\x1f\x7f]/.test(value)),
}).strict();

export type PhoneDevice = { id: string; name: string; pairedAt: number; expiresAt: number; lastSeenAt: number; revokedAt?: number };
export type PhonePairing = { code: string; expiresAt: number };
export type PhoneRoute = { state: 'off' | 'checking' | 'ready' | 'unavailable' | 'error'; message: string; origin?: string; qrCodeDataUrl?: string };
export type PhoneState = { enabled: boolean; route: PhoneRoute; devices: PhoneDevice[] };
export type AccessContext = { surface: 'desktop' | 'phone' | 'web'; requiresPairing: boolean; workspaceEpoch?: string; recovery?: boolean; recoveryLocal?: boolean };
