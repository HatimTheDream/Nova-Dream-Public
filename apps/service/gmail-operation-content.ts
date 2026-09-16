import { canonical } from '../../packages/domain/contracts.js';
import { gmailDraftContent } from './provider-mail-open.js';

/** Compare complete reviewed content while tolerating Gmail's own Message-ID.
 * Transport headers do not replace the unique operation marker or MIME proof. */
export async function gmailOperationContentMatches(operationId:string,expectedRaw:string,actualRaw:string,threadId:string):Promise<boolean> {
  const expected=await gmailDraftContent(expectedRaw,threadId),actual=await gmailDraftContent(actualRaw,threadId);
  const content=(value:typeof actual)=>{const {operationId:_marker,...envelope}=value.envelope;return {message:value.message,envelope};};
  return expected.operationMarker===operationId&&actual.operationMarker===operationId&&canonical(content(expected))===canonical(content(actual));
}
