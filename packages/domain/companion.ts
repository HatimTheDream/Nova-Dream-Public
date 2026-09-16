import { z } from 'zod';

export const companionProtocol = 1;
export const companionTools = ['start_session', 'end_session', 'launch_app', 'bring_to_front', 'list_windows', 'get_window_state', 'click', 'press_key', 'type_text', 'scroll', 'drag', 'double_click', 'right_click', 'hotkey', 'move_cursor', 'invoke_menu', 'set_value', 'verify_state', 'get_desktop_state'] as const;
export const companionToolSchema = z.object({ name: z.enum(companionTools), description: z.string().max(8000).optional(), inputSchema: z.record(z.string(), z.unknown()) }).strict();
export const companionCallSchema = z.object({ deviceId: z.uuid(), tool: z.enum(companionTools), arguments: z.record(z.string(), z.unknown()) }).strict();
export type CompanionCall = z.infer<typeof companionCallSchema>;
export const companionCommandSchema = z.object({ requestId: z.uuid(), epoch: z.uuid() }).strict();
export const companionLinkSchema = companionCommandSchema.extend({ challengeId: z.uuid(), deviceId: z.uuid(), name: z.string().trim().min(1).max(80), platform: z.enum(['darwin', 'win32', 'linux']), publicKey: z.string().min(50).max(200), signature: z.string().min(80).max(100) });
export type CompanionChallenge = { id: string; epoch: string; nonce: string; expiresAt: number };
// null means the desktop explicitly enabled access until stopped; 0 is off.
export const computerAccessActive = (until: number | null, now = Date.now()) => until === null || until > now;
export type CompanionDevice = { id: string; name: string; platform: 'darwin' | 'win32' | 'linux'; linkedAt: number; lastSeenAt: number; revokedAt?: number; connected: boolean; enabledUntil: number | null; scope?: 'apps' | 'desktop'; apps: string[]; tools?: z.infer<typeof companionToolSchema>[] };
export type CompanionOperation = { id: string; epoch: string; ownerId: string; call: CompanionCall; createdAt: number; expiresAt: number; state: 'queued' | 'claimed' | 'completed' | 'refused' | 'unknown' | 'cancelled'; result?: unknown; message?: string };
export const companionPacketSchema = z.object({
  protocol: z.literal(companionProtocol), deviceId: z.uuid(), epoch: z.uuid(), requestId: z.uuid(), issuedAt: z.number().int(),
  action: z.enum(['poll', 'claim', 'result', 'disconnect']), payload: z.record(z.string(), z.unknown()), signature: z.string().min(80).max(100),
}).strict();
export type CompanionPacket = z.infer<typeof companionPacketSchema>;
export function companionSignedData(packet: Omit<CompanionPacket, 'signature'>) {
  return JSON.stringify([packet.protocol, packet.deviceId, packet.epoch, packet.requestId, packet.issuedAt, packet.action, packet.payload]);
}
export function companionLinkData(challenge: CompanionChallenge, deviceId: string) {
  return JSON.stringify(['nova-desktop-link', companionProtocol, challenge.id, challenge.epoch, challenge.nonce, challenge.expiresAt, deviceId]);
}
