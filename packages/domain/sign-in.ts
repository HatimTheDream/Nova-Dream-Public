import type { UsageWindow } from './usage.js';
export type ChatGptSignInMethod = 'browser' | 'device-code';
export type ChatGptSignInIntent = 'add' | 'reconnect';
export type ChatGptSignInStatus = {
  id?: string;
  method?: ChatGptSignInMethod;
  intent?: ChatGptSignInIntent;
  profileId?: string;
  state: 'idle' | 'starting' | 'waiting' | 'completed' | 'failed' | 'interrupted';
  message: string;
  expiresAt?: number;
  verificationUrl?: string;
  userCode?: string;
  authorizationUrl?: string;
};
export type ChatGptAccountUsage = {
  state: 'ready' | 'stale' | 'unavailable'; checkedAt: number | null; reportedAt: number | null;
  windows: UsageWindow[]; plan: string | null; credits: number | null;
};
export type ChatGptAccount = {
  profileId: string; label: string; email?: string; duplicateOf?: string;
  /** An opaque runtime account identity. Never an OAuth credential or raw provider account id. */
  identityKey?: string;
  health: 'ready' | 'cooldown' | 'reconnect' | 'unknown'; cooldownUntil: number | null; expiresAt: number | null;
  usage: ChatGptAccountUsage;
};
export type ChatGptAccountStatus = {
  state: 'available' | 'empty' | 'unavailable';
  emails: string[];
  profileCount: number;
  message: string;
  /** Optional only for compatibility with an older paired host. */
  checkedAt?: number; accounts?: ChatGptAccount[]; order?: string[]; preferredProfileId?: string | null; canManage?: boolean;
};
