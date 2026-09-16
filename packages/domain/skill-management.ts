import type { ProposalStatus } from './skill-workshop.js';
// Retain the existing draft envelope: name is a new name for create, an installed
// key for update, or the proposal key for revise. Native names resolve on host.
export type SkillDraft = { name: string; description: string; content: string; supportFiles: { path: string; content: string }[]; goal?: string; evidence?: string };
export type SkillIntent = { action: 'create' | 'update'; draft: SkillDraft; sourceReviewId?: string } | { action: 'revise'; reviewId: string; draft: SkillDraft } | { action: 'apply' | 'reject'; reviewId: string; reason: string };
export type SkillCommand = SkillIntent & { requestId: string; epoch: string; generation: string };
export type SkillOperationState = 'preparing' | 'dispatched' | 'confirmed' | 'unknown' | 'not-sent' | 'reviewed-unconfirmed';
export type SkillOperationSummary = {
  id: string; epoch: string; generation: string; deviceId: string; action: SkillIntent['action']; skillKey: string; state: SkillOperationState; message: string; createdAt: number; updatedAt: number;
  proposalId?: string; resultRevisionHash?: string; proposedVersion?: string; resultStatus?: ProposalStatus;
  skillName?: string;
};
export type SkillOperation = SkillOperationSummary & { intent: SkillCommand; authorizationId: string; reviewId?: string; preexistingProposalIds?: string[]; scanCursor?: number; associatedReviewId?: string; resolvedBy?: string; resolutionReason?: string };
export type SkillManagementState = {
  epoch: string; generation?: string; enabled: boolean; canConnect: boolean; connection: 'unavailable' | 'disconnected' | 'connecting' | 'pairing' | 'ready' | 'error'; message: string; pairingRequestId?: string; methods: string[]; operations: SkillOperationSummary[];
};
