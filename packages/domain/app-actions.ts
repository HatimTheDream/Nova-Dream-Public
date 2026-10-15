import { z } from 'zod';
import { moduleIds } from './contracts.js';

export const appOpenSchema = z.object({
  module: z.enum([...moduleIds, 'settings']),
  settingsTab: z.enum(['general', 'accounts', 'assistant', 'usage', 'phone', 'data']).optional(),
}).strict().refine(input => !input.settingsTab || input.module === 'settings', 'Choose Settings for a settings tab.');
export const appAppearanceSchema = z.object({
  interfaceFont: z.enum(['system', 'sora', 'serif']).optional(),
  messageFont: z.enum(['system', 'sora', 'serif']).optional(),
  interfaceTextSize: z.enum(['small', 'standard', 'large', 'extra-large']).optional(),
  messageTextSize: z.enum(['small', 'standard', 'large', 'extra-large']).optional(),
}).strict().refine(input => Object.keys(input).length > 0, 'Choose at least one appearance preference.');
export const appActionReceiptSchema = z.object({
  requestId: z.uuid(), epoch: z.uuid(), actionId: z.uuid(),
  state: z.enum(['opened', 'saved', 'blocked']), message: z.string().max(500),
}).strict();
export const appActionReadySchema = appActionReceiptSchema.pick({epoch:true,actionId:true});
export type AppDestination = z.infer<typeof appOpenSchema>;
