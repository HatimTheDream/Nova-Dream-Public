import { z } from 'zod';
import { homeReferenceSchema } from './home-library.js';

const id = z.string().min(1).max(200).regex(/^[a-zA-Z0-9:_-]+$/);
const scope = z.union([
  z.object({ kind: z.enum(['all', 'up-next', 'unassigned']) }).strict(),
  z.object({ kind: z.literal('space'), id }).strict(),
]);

/** Where the owner selected inputs, independent from subsequent version choices. */
export const workLibraryOriginSchema = z.object({
  view: z.object({
    query: z.string(),
    mode: z.enum(['cards', 'compact']),
    filter: z.enum(['all', 'pinned', 'archived']),
    collectionId: id.nullable(),
    selection: z.object({ collectionId: id, references: z.array(homeReferenceSchema).max(200) }).strict().nullable(),
    route: scope.optional(),
  }).strict(),
  scrollTop: z.number().finite().nonnegative(),
}).strict();
export type LibraryWorkOrigin = z.infer<typeof workLibraryOriginSchema>;
