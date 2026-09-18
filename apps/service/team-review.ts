import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AssistantOperation, Conversation } from '../../packages/domain/assistant.js';
import { canonical } from '../../packages/domain/contracts.js';
import { teamReviewSchema, type TeamReviewReport, type TeamReviewScope } from '../../packages/domain/team-review.js';
import type { TeamConversationAccess, TeamWork } from '../../packages/domain/team-work.js';
import { Fault, type Store } from './store.js';
import { teamHandoffMetadata } from './team-handoffs.js';

const scopeSchema = z.object({ teamId:z.uuid(),stage:z.number().int().nonnegative(),attempt:z.number().int().positive(),agentId:z.string().min(1),agentRevision:z.number().int().positive(),submitRequestId:z.uuid() }).strict();
const identitySchema = z.object({ epoch:z.uuid(),operationId:z.uuid(),conversationId:z.uuid(),requestId:z.uuid(),nativeId:z.string().min(1),nativeKey:z.string().min(1),connectionGeneration:z.string().min(1) }).strict();
const savedSchema = z.object({ identity:identitySchema,scope:scopeSchema,report:teamReviewSchema,createdAt:z.number().finite().nonnegative(),digest:z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type SavedReview = z.infer<typeof savedSchema>;
type ReviewOrigin = { operation:AssistantOperation;conversation:Conversation;generation:string|undefined };
type ReviewTeam = TeamWork & { epoch:string;requests:{submit:string}[];agents:{id:string;revision:number;value:{access?:unknown}}[] };
const key = (id:string) => 'team:review:' + id;
const identity = (operation:AssistantOperation) => identitySchema.parse({ epoch:operation.epoch,operationId:operation.id,conversationId:operation.conversationId,requestId:operation.requestId,nativeId:operation.nativeId,nativeKey:operation.nativeKey,connectionGeneration:operation.connectionGeneration });
const hash = (value:Pick<SavedReview,'identity'|'scope'|'report'>) => createHash('sha256').update(canonical(value)).digest('hex');
const publicReport = (value:SavedReview):TeamReviewReport => ({ ...value.report,operationId:value.identity.operationId,stage:value.scope.stage,attempt:value.scope.attempt,createdAt:value.createdAt,digest:value.digest });

/** Reporting the review is a narrow status capability. It never grants a
 * reviewer permission to edit files, records, accounts, or another stage. */
export function activeTeamReviewScope(store:Store,{operation,conversation,generation}:ReviewOrigin):TeamReviewScope {
  const parsed=scopeSchema.safeParse(operation.context.teamReview),binding=store.internalRead<TeamConversationAccess>('team:conversation:'+conversation.id);
  if(!parsed.success)throw new Fault(403,'team_review_owner','Only the original team review request can submit its report.');
  const scope=parsed.data,team=store.internalRead<ReviewTeam>('team:run:'+scope.teamId),step=team?.steps[scope.stage],captured=team?.agents[scope.stage],agent=store.readEntity('agent',scope.agentId);
  if(operation.epoch!==store.epoch||operation.cancelRequested||operation.steerTarget||!['dispatching','accepted','running'].includes(operation.state)||operation.requestId!==scope.submitRequestId||operation.conversationId!==conversation.id||operation.nativeId!==conversation.nativeId||operation.nativeKey!==conversation.nativeKey||operation.connectionGeneration!==conversation.connectionGeneration||operation.connectionGeneration!==generation||conversation.state!=='ready'||conversation.archived||conversation.deleted||conversation.pendingSettings||
    !binding||binding.epoch!==store.epoch||binding.teamId!==scope.teamId||binding.role!=='review'||binding.agentId!==scope.agentId||binding.agentRevision!==scope.agentRevision||canonical(binding.review)!==canonical(scope)||operation.context.teamHandoffs?.teamId!==scope.teamId||
    !team||team.epoch!==store.epoch||!['running','paused','attention'].includes(team.state)||team.next!==scope.stage||team.requests[scope.stage]?.submit!==operation.requestId||!step||step.role!=='review'||step.agentId!==scope.agentId||step.agentRevision!==scope.agentRevision||(step.attempt??1)!==scope.attempt||step.conversationId!==conversation.id||(step.operationId&&step.operationId!==operation.id)||
    !captured||captured.id!==scope.agentId||captured.revision!==scope.agentRevision||canonical(captured.value.access??{})!==canonical(binding.access)||!agent||agent.value.archived)
    throw new Fault(403,'team_review_owner','The original team review request or its authority changed.');
  return scope;
}

function saved(store:Store,operationId:string):SavedReview|undefined {
  const raw=store.internalRead(key(operationId));if(raw===undefined)return undefined;
  const parsed=savedSchema.safeParse(raw);
  if(!parsed.success||parsed.data.identity.operationId!==operationId||parsed.data.identity.epoch!==store.epoch)throw new Fault(409,'team_review_changed','The saved review no longer matches this workspace and execution.');
  const value=parsed.data;
  if(value.digest!==hash({identity:value.identity,scope:value.scope,report:value.report}))throw new Fault(409,'team_review_changed','The saved review does not match its original content.');
  return value;
}

function original(store:Store,operation:AssistantOperation):SavedReview|undefined {
  const value=saved(store,operation.id);if(!value)return undefined;
  if(canonical(value.identity)!==canonical(identity(operation))||canonical(value.scope)!==canonical(operation.context.teamReview))throw new Fault(409,'team_review_identity','This report belongs to a different review execution.');
  return value;
}

export function submitTeamReview(store:Store,input:ReviewOrigin&{report:unknown},now=Date.now()):TeamReviewReport {
  const scope=activeTeamReviewScope(store,input),report=teamReviewSchema.parse(input.report),previous=original(store,input.operation);
  if(previous){
    if(canonical(previous.report)!==canonical(report))throw new Fault(409,'team_review_immutable','This execution already submitted its review. A saved report cannot be replaced.');
    return publicReport(previous);
  }
  const value={identity:identity(input.operation),scope,report},record=savedSchema.parse({...value,createdAt:now,digest:hash(value)});
  store.internalWrite(key(input.operation.id),record);
  return publicReport(record);
}

/** A lost response can observe the original receipt after the run finishes.
 * Checking is deliberately unable to create a missing report. */
export function checkTeamReview(store:Store,operation:AssistantOperation,input:unknown):TeamReviewReport {
  const value=original(store,operation),report=teamReviewSchema.parse(input);
  if(!value)throw new Fault(409,'team_review_unconfirmed','The original review submission is unconfirmed. No new report was submitted.');
  if(canonical(value.report)!==canonical(report))throw new Fault(409,'team_review_immutable','The saved report belongs to different review input.');
  return publicReport(value);
}

export function completedTeamReview(store:Store,input:{teamId:string;stage:number;attempt:number;operation:AssistantOperation}):TeamReviewReport|undefined {
  if(input.operation.state!=='completed')return undefined;
  const value=original(store,input.operation);if(!value)return undefined;
  if(value.scope.teamId!==input.teamId||value.scope.stage!==input.stage||value.scope.attempt!==input.attempt)throw new Fault(409,'team_review_identity','This report belongs to a different team stage or attempt.');
  return publicReport(value);
}

/** Complete handoffs retain the original execution identity even if the owner
 * later removes the conversation. Fix agents may read only those inputs that
 * their own request captured; the module boundary enforces that access. */
export function readCompletedTeamReview(store:Store,teamId:string,operationId:string):TeamReviewReport {
  const value=saved(store,z.uuid().parse(operationId));
  if(!value||value.scope.teamId!==teamId)throw new Fault(404,'team_review_missing','This completed structured review is unavailable.');
  const handoff=teamHandoffMetadata(store,teamId,operationId);
  if(handoff.state!=='completed')throw new Fault(409,'team_review_unconfirmed','Only a confirmed completed review can be used for fixes.');
  const source=store.internalRead<Record<string,unknown>>('team:handoff:'+operationId)!;
  const expected={epoch:source.epoch,operationId:source.id,conversationId:source.conversationId,requestId:source.requestId,nativeId:source.nativeId,nativeKey:source.nativeKey,connectionGeneration:source.connectionGeneration};
  if(canonical(value.identity)!==canonical(expected)||source.stage!==value.scope.stage||source.attempt!==value.scope.attempt)throw new Fault(409,'team_review_identity','This report does not belong to the completed review handoff.');
  return publicReport(value);
}
