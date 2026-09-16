import type { MailIndexProvider } from './mail-index.js';

export type MailAssistantAction =
  | 'delete'
  | 'archive'
  | 'mark-read'
  | 'mark-unread'
  | 'flag'
  | 'unflag'
  | 'organize'
  | 'remove-organization'
  | 'unsubscribe'
  | 'block-sender'
  | 'unblock-sender';

export type MailAssistantPlanStatus =
  | 'awaiting_confirmation'
  | 'applying'
  | 'completed'
  | 'partial'
  | 'cancelled'
  | 'expired';

export type MailAssistantUndoStatus =
  | 'available'
  | 'unsupported'
  | 'applying'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'expired';

export interface MailAssistantCriteria {
  provider?: MailIndexProvider;
  accountId?: string;
  sender?: string;
  text?: string;
  category?: string;
  readState?: 'read' | 'unread';
  before?: string;
  after?: string;
  explicitAll: boolean;
}

export interface ParsedMailAssistantIntent {
  action: MailAssistantAction;
  organization?: string;
  criteria: MailAssistantCriteria;
  clarification?: string;
}

export interface MailAssistantTarget {
  provider: MailIndexProvider;
  accountId: string;
  threadId: string;
  sourceMessageId?: string;
  subject: string;
  from: string;
  date: string;
  messageCount: number;
  before: string;
  after: string;
  senderAddress?: string;
  actionMethod?: 'one-click' | 'external-page' | 'mailto-draft' | 'gmail-filter' | 'outlook-rule';
  actionDetail?: string;
  stateFingerprint?: string;
}

export interface MailAssistantScope {
  provider: MailIndexProvider;
  accountId: string;
  targetCount: number;
  messageCount: number;
  before: string;
  after: string;
}

export interface MailAssistantApprovalReceipt {
  id: string;
  planId: string;
  approvalDigest: string;
  action: MailAssistantAction;
  organization?: string;
  decision: 'approved';
  status: 'applying' | 'completed' | 'partial' | 'failed' | 'undone';
  approvedAt: string;
  completedAt?: string;
  scopes: MailAssistantScope[];
  targetCount: number;
  messageCount: number;
  succeeded: number;
  failed: number;
  summary: string;
  errors?: string[];
  undo: {
    status: MailAssistantUndoStatus;
    digest?: string;
    expiresAt?: string;
    reason?: string;
  };
}

export interface MailAssistantStoredReceipt {
  receipt: MailAssistantApprovalReceipt;
  undoTokens: Array<{ provider: MailIndexProvider; token: string }>;
  undoUsed: boolean;
}

export interface MailAssistantSelectionRequest {
  action: MailAssistantAction;
  organization?: string;
  targets: Array<{
    provider: MailIndexProvider;
    accountId: string;
    threadId: string;
  }>;
}

export interface MailAssistantPlan {
  id: string;
  digest: string;
  request: string;
  action: MailAssistantAction;
  organization?: string;
  status: MailAssistantPlanStatus;
  destructive: boolean;
  summary: string;
  targetCount: number;
  messageCount: number;
  targets: MailAssistantTarget[];
  scopes: MailAssistantScope[];
  createdAt: string;
  expiresAt: string;
  incompleteAccounts: string[];
  warning?: string;
}

export interface MailAssistantPrepareResult {
  handled: boolean;
  success: boolean;
  plan?: MailAssistantPlan;
  clarification?: string;
  error?: string;
}

export interface MailAssistantApplyResult {
  success: boolean;
  status: Extract<MailAssistantPlanStatus, 'completed' | 'partial' | 'expired'>;
  succeeded: number;
  failed: number;
  message: string;
  errors?: string[];
  receipt?: MailAssistantApprovalReceipt;
}

export interface MailAssistantUndoResult {
  success: boolean;
  status: Extract<MailAssistantUndoStatus, 'completed' | 'partial' | 'failed' | 'expired' | 'unsupported'>;
  succeeded: number;
  failed: number;
  message: string;
  errors?: string[];
  receipt?: MailAssistantApprovalReceipt;
}
