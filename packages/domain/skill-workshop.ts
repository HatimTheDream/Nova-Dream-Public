export type ProposalStatus = 'pending' | 'applied' | 'rejected' | 'quarantined' | 'stale';
export type ProposalSummary = {
  id: string; kind: 'create' | 'update'; status: ProposalStatus; title: string; description: string;
  skillName: string; skillKey: string; createdAt: string; updatedAt: string;
  scanState: 'pending' | 'clean' | 'failed' | 'quarantined'; degradedState?: 'draft-missing';
};
export type ProposalList = { generation: string; observedAt: number; proposals: ProposalSummary[] };
export type ProposalFinding = { ruleId: string; severity: 'info' | 'warn' | 'critical'; file: string; line?: number; message: string; evidence?: string };
export type ProposalEvaluation = {
  id: string; proposedVersion: string; revisionHash: string; trigger: 'manual' | 'apply'; startedAt: string; completedAt: string;
  outcomes: { pluginId: string; evaluatorId: string; status: 'completed' | 'skipped' | 'error'; error?: string;
    result?: { summary?: string; decision?: 'pass' | 'revise' | 'block'; decisionReason?: string; findings?: ProposalFinding[] } }[];
};
export type ProposalView = {
  epoch: string; generation: string; observedAt: number; nativeAgentId: 'main'; revisionHash: string; targetFingerprint: string;
  record: Omit<ProposalSummary, 'scanState' | 'degradedState'> & {
    proposedVersion: string; source?: string; goal?: string; evidence?: string; statusReason?: string;
    scan: { state: ProposalSummary['scanState']; critical: number; warn: number; info: number; findings: ProposalFinding[] };
    evaluation?: ProposalEvaluation;
  };
  content: string; supportFiles: { path: string; content: string; sha256: string; sizeBytes: number }[];
};
export type SavedProposal = ProposalView & { savedId: string; savedAt: number };
export type SavedProposalSummary = Pick<SavedProposal, 'savedId' | 'savedAt' | 'epoch' | 'generation' | 'revisionHash'> & { proposalId: string; title: string; proposedVersion: string; status: ProposalStatus };
export type ProposalEvent = { sequence: number; eventId: string; proposalId: string; proposedVersion: string; revisionHash: string; type: string; occurredAt: string; actor: { type: string }; correlationId?: string };
export type ProposalEvents = { generation: string; observedAt: number; events: ProposalEvent[]; nextSequence?: number };
