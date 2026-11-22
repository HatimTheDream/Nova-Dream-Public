import { z } from 'zod';
import { homeReferenceSchema, homeReferenceKey, type HomeReference } from './home-library.js';
import { MAX_WORK_SOURCES } from './work-source-limits.js';

export const workSourceSelectionSchema = z.object({
  reference: homeReferenceSchema,
  confirmedAgainst: homeReferenceSchema.optional(),
  allowReferenceOnly: z.boolean().optional(),
}).strict();
export const workSourceSelectionsSchema = z.array(workSourceSelectionSchema).max(MAX_WORK_SOURCES)
  .refine(rows => new Set(rows.map(row => homeReferenceKey(row.reference))).size === rows.length,
    'Choose each Library source once.');
export const workSourceCheckRequestSchema = z.object({
  epoch: z.uuid(), agentId: z.string().min(1).max(100).nullable(), sources: workSourceSelectionsSchema,
}).strict();
export type WorkSourceSelection = z.infer<typeof workSourceSelectionSchema>;
export type WorkSourceMaterial = {
  title: string;
  representation: 'saved-text' | 'result-text' | 'reference-only';
  /** Only bytes actually supplied are represented as text. */
  text?: string;
  url?: string;
  sha256: string;
  omissions: string[];
};
export type WorkSourceCheck = {
  reference: HomeReference;
  current: HomeReference | null;
  status: 'ready' | 'changed' | 'missing' | 'denied' | 'unsupported' | 'reference-only' | 'unavailable';
  canUseSelected: boolean;
  ready: boolean;
  message: string;
  selected?: WorkSourceMaterial;
  latest?: WorkSourceMaterial;
};
export type CapturedWorkSource = {
  epoch: string;
  origin: 'library';
  reference: HomeReference;
  availableAtCapture: HomeReference;
  capturedAt: string;
  material: WorkSourceMaterial;
};
export type WorkSourceInspection = { reference: HomeReference; capturedAt: string; accessible: boolean; material?: WorkSourceMaterial };
