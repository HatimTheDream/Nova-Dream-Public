import type { ConnectedResultDetail } from '../../../packages/domain/connected-work';

type Subject = { epoch: string; requestId: string; attemptId: string; sha256: string };
export type ResultCommand =
  | { action: 'review'; input: Subject & { reviewerId: string; reviewerRevision: number } }
  | { action: 'revise'; input: Subject & { correction: string } }
  | { action: 'accept'; input: Subject & { reviewAttemptId: string; reviewSha256: string; acknowledgedFindingIds: string[] } }
  | { action: 'save'; input: Subject };

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function resultJournalKey(deviceId: string, epoch: string, attemptId: string, sha256: string) {
  return ['e3:connected-result', deviceId, epoch, attemptId, sha256].join(':');
}

export function pendingResultCommand(storage: Storage, key: string, subject: Omit<Subject, 'requestId'>): ResultCommand | null {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  const value: ResultCommand = JSON.parse(raw);
  if (!value || !['review', 'revise', 'accept', 'save'].includes(value.action) || !value.input
    || value.input.attemptId !== subject.attemptId || value.input.sha256 !== subject.sha256
    || value.input.epoch !== subject.epoch || typeof value.input.requestId !== 'string') {
    throw Error('The original pending action could not be matched to this result.');
  }
  return value;
}

/** Acknowledging an older request may not clear a later request opened in another window. */
export function clearResultCommand(storage: Storage, key: string, command: ResultCommand) {
  if (storage.getItem(key) === JSON.stringify(command)) storage.removeItem(key);
}

export function reviewCanBeAccepted(detail: ConnectedResultDetail, acknowledged: ReadonlySet<string>) {
  const review = detail.review;
  return detail.available && detail.document !== null && review.available && review.state === 'complete' && !!review.report && !!review.attempt?.result
    && review.report.findings.every(finding => finding.severity === 'advisory' && acknowledged.has(finding.id));
}
