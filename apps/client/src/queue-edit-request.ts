import { ApiError } from './api';

export type QueueEditRequest = { requestId: string; epoch: string; queueId: string; expectedRevision: number; input: string };
type Ports = {
  read: () => QueueEditRequest | undefined;
  keep: (input: QueueEditRequest | undefined) => boolean;
  send: (input: QueueEditRequest) => Promise<unknown>;
};

/** A retry reconciles the captured edit, never a newer draft under the same receipt. */
export async function saveRetainedQueueEdit(ports: Ports, proposed: QueueEditRequest): Promise<{ pending?: QueueEditRequest; confirmed?: QueueEditRequest; error: string }> {
  const input = ports.read() ?? proposed;
  if (!ports.keep(input)) return { pending: ports.read(), error: 'Free browser storage before saving this revision. Your writing is kept.' };
  try {
    await ports.send(input);
    if (!ports.keep(undefined)) return { pending: input, error: 'The original save was confirmed. Free browser storage, then reconcile its saved receipt.' };
    return { confirmed: input, error: '' };
  } catch (reason) {
    const rejected = reason instanceof ApiError && ['queue_changed', 'empty_message'].includes(reason.code);
    const cleared = rejected && ports.keep(undefined);
    return { pending: cleared ? undefined : input, error: reason instanceof Error ? reason.message : 'Revision not confirmed. Reconcile the original save.' };
  }
}
