import { z } from 'zod';

export const providerSchema = z.enum(['google', 'microsoft']);
export type Provider = z.infer<typeof providerSchema>;
export const clientConfigurationSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('google'), clientId: z.string().trim().regex(/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/).max(300), clientSecret: z.string().max(1000).optional() }).strict(),
  z.object({ provider: z.literal('microsoft'), clientId: z.uuid(), clientSecret: z.string().max(1000).optional(), tenant: z.union([z.enum(['common', 'organizations', 'consumers']), z.uuid()]).default('common').transform(value => value.toLowerCase()), callbackPort: z.number().int().min(1024).max(65535).default(4389) }).strict(),
]);
export type ClientConfiguration = z.infer<typeof clientConfigurationSchema>;
export const accountRequestSchema = z.object({ requestId: z.uuid(), epoch: z.uuid() });
/** Service-owned account IDs are opaque; OAuth currently uses provider:subject-hash. */
export const accountIdSchema = z.string().regex(/^[A-Za-z0-9:_-]{1,100}$/);
export const configureAccountSchema = accountRequestSchema.extend({ expectedRevision: z.number().int().nonnegative(), configuration: clientConfigurationSchema }).strict();
export const accountPermissionSchema = z.enum(['mailDraft', 'mailSend', 'mailModify', 'calendarWrite', 'contactsRead', 'contactsWrite']);
export type AccountPermission = z.infer<typeof accountPermissionSchema>;
export const connectAccountSchema = accountRequestSchema.extend({ provider: providerSchema, accountId: accountIdSchema.optional(), expectedRevision: z.number().int().nonnegative().optional(), permissions: z.array(accountPermissionSchema).max(6).optional() }).strict().refine(value => (value.accountId === undefined) === (value.expectedRevision === undefined), 'Account identity and current revision must be supplied together.');
export const accountActionSchema = accountRequestSchema.extend({ accountId: accountIdSchema, expectedRevision: z.number().int().positive() }).strict();
export const cancelAccountSignInSchema = accountRequestSchema.extend({ attemptId: z.uuid() }).strict();

export type AccountCapabilities = { mailRead: boolean; calendarRead: boolean; mailDraft: boolean; mailSend: boolean; mailModify?: boolean; calendarWrite: boolean; contactsRead: boolean; contactsWrite?: boolean };
export type ConnectedAccount = {
  id: string; provider: Provider; subject: string; label: string; email: string; revision: number; generation: string;
  state: 'connected' | 'refreshing' | 'reconnect' | 'disconnected'; scopes: string[]; capabilities: AccountCapabilities;
  connectedAt: string; updatedAt: string; message?: string;
};
export type AccountSignIn = {
  id: string; provider: Provider; deviceId: string; epoch: string; createdAt: number; expiresAt: number;
  state: 'preparing' | 'waiting' | 'exchanging' | 'completed' | 'cancelled' | 'expired' | 'failed' | 'unknown';
  message: string; accountId?: string; requestedPermissions?: AccountPermission[]; missingPermissions?: AccountPermission[];
};
export type CalendarSource = { id: string; name: string; primary: boolean; timezone?: string; color?: string; providerCanWrite: boolean };
export type MailFolder = { id: string; name: string; total?: number; unread?: number };
export type AccountReadProbe = {
  accountId: string; generation: string; checkedAt: string;
  calendars: { state: 'available' | 'unavailable'; items: CalendarSource[]; limited: boolean; message?: string };
  mail: { state: 'available' | 'unavailable'; folders: MailFolder[]; limited: boolean; message?: string };
};
export type AccountsState = {
  callbackUri?: string;
  clients: { provider: Provider; revision: number; configured: boolean; clientId?: string; tenant?: string; callbackPort?: number; hasClientSecret?: boolean }[];
  accounts: ConnectedAccount[]; attempts: (AccountSignIn & { authorizationUrl?: string })[]; probes: AccountReadProbe[];
};
