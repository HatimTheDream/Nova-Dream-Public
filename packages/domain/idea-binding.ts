import {z} from 'zod';
export const ideaBindingSchema=/* @__PURE__ */(()=>z.object({pursuitId:z.string().uuid(),entryId:z.string().uuid()}).strict())();
export type IdeaBinding=z.infer<typeof ideaBindingSchema>;
