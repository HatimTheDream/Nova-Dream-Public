import { createHash } from 'node:crypto';
import { canonical } from '../../packages/domain/contracts.js';

/** The existing module action and owner UI use the same exact item identity. */
export function conversationItemRequestId(actionId: string, conversationId: string): string {
  const hash = createHash('sha256').update(canonical([actionId, 'conversation', conversationId])).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
