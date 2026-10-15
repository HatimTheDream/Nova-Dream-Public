import { z } from 'zod';
import { homeReferenceSchema, type HomeReference } from './home-library.js';
const id = z.string().min(1).max(200).regex(/^[a-zA-Z0-9:_-]+$/), revision = z.number().int().positive();
export const homeFeedTargetSchema = z.discriminatedUnion('kind', [
 z.object({ kind: z.literal('assignment'), id, attemptId: id }).strict(),
 z.object({ kind: z.literal('conversation'), id, outputId: id.optional(), outputVersion: revision.optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().refine(v => !!v.outputId === !!v.outputVersion && (!v.sha256 || !!v.outputId), 'Keep the output identity and version together.'),
 z.object({ kind: z.literal('content'), id, reviewId: id.optional(), sourceRevision: revision.optional(), reviewRevision: revision.optional() }).strict().refine(v => !v.reviewId || !!v.sourceRevision, 'Keep the reviewed Content version.'),
 z.object({ kind: z.literal('routine'), id, occurrenceId: id }).strict(),
]);
export type HomeFeedTarget = z.infer<typeof homeFeedTargetSchema>;
export const homeFeedOpenSchema = z.union([z.object({ epoch: z.uuid(), target: homeFeedTargetSchema }).strict(), z.object({ epoch: z.uuid(), reference: homeReferenceSchema }).strict()]);
export type HomeFeedOpenRequest = z.infer<typeof homeFeedOpenSchema>;
export type HomeDestinationLink = { kind: 'assignment' | 'content' | 'conversation' | 'routine' | 'project' | 'task'; id: string; attemptId?: string; occurrenceId?: string };
export type HomeDestination = { epoch: string; title: string; status: string; text: string; sourceDetails?: string; links: HomeDestinationLink[]; target?: HomeFeedTarget; reference?: HomeReference; previewOnly?: boolean };
export type HomeFeedCard = { id: string; title: string; summary: string; detail: string; at: string; kind: 'result' | 'review' | 'routine' | 'attention'; status: string; target: HomeFeedTarget; references: HomeReference[]; projectId: string | null };
export type HomeFeedState = { epoch: string; cards: HomeFeedCard[] };
