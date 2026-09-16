import { z } from 'zod';

export const observationSchema = z.object({
  epoch: z.uuid(), nativeKey: z.string().min(1).max(500), nativeId: z.uuid(), runId: z.string().min(1).max(500),
  toolCallId: z.string().min(1).max(500), toolName: z.string().min(1).max(200),
  image: z.object({ mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']), data: z.string().min(1).max(12 * 1024 * 1024) }).strict(),
}).strict();
export type AssistantObservation = { id: string; operationId: string; toolCallId: string; toolName: string; capturedAt: string; width: number; height: number };

/** Only actual inline tool images. Never dereference model-supplied paths or URLs. */
export function toolImage(raw: unknown): { mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; data: string } | undefined {
  let visited = 0;
  const read = (value: unknown, depth: number): ReturnType<typeof toolImage> => {
    if (++visited > 120 || depth > 6 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (let i = Math.min(value.length, 50) - 1; i >= 0; i--) { const found = read(value[i], depth + 1); if (found) return found; } return; }
    const item = value as Record<string, unknown>;
    if (item.type === 'image' && ['image/png', 'image/jpeg', 'image/webp'].includes(String(item.mimeType)) && typeof item.data === 'string' && item.data.length <= 12 * 1024 * 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(item.data)) return { mimeType: item.mimeType as 'image/png', data: item.data };
    for (const key of ['content', 'result', 'output']) { const found = read(item[key], depth + 1); if (found) return found; }
  };
  return read(raw, 0);
}
