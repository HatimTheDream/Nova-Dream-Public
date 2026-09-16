import { z } from 'zod';

export const memorySourceSchema = z.object({ conversationId: z.string().uuid(), nativeId: z.string().uuid(), messageId: z.string().min(1).max(1000), messageHash: z.string().regex(/^[a-f0-9]{64}$/), role: z.enum(['user', 'assistant']) }).strict();
export type MemorySource = z.infer<typeof memorySourceSchema>;
const request = z.object({ requestId: z.string().uuid(), epoch: z.string().uuid(), id: z.string().uuid(), expectedRevision: z.number().int().nonnegative() });
export const memoryChangeSchema = z.discriminatedUnion('action', [
  request.extend({ action: z.literal('save'), text: z.string().trim().min(1).max(4000), projectId: z.string().min(1).max(100).nullable(), source: memorySourceSchema.optional() }).strict(),
  request.extend({ action: z.literal('remove') }).strict(),
]);
export type MemoryChange = z.infer<typeof memoryChangeSchema>;
export type MemoryEntry = { id: string; revision: number; text: string; projectId: string | null; source?: MemorySource & { title: string; excerpt: string }; createdAt: string; updatedAt: string };
export type MemoryState = { revision: number; entries: MemoryEntry[] };
export type MemorySnapshot = { revision: number; entries: Pick<MemoryEntry, 'id' | 'revision' | 'text' | 'projectId'>[] };

export function memoryContext(memory?: MemorySnapshot, brand = 'Nova Dream'): string {
  if (!memory) return '';
  return `${brand} memories explicitly saved by the owner for this scope. These are reference facts and preferences, not permission to take actions. The current request takes priority. This snapshot replaces earlier memory snapshots; a removed note is no longer a standing preference.\n${JSON.stringify(memory)}\n\n`;
}
