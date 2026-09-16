import { z } from 'zod';

export const workerFailureSchema=z.enum(['usage_limit','rate_limit','authentication']);
export type WorkerFailure=z.infer<typeof workerFailureSchema>;

/** Only the native wait result's error field is classified, never generated
 * reply text. Raw provider details may contain secrets and are not retained. */
export function classifyWorkerFailure(error:unknown):WorkerFailure|undefined {
  if(typeof error!=='string'||error.length>100000)return undefined;
  if(/\b(?:subscription usage limit|insufficient_quota|quota exceeded|exceeded your current quota)\b/i.test(error))return 'usage_limit';
  if(/\b(?:rate_limit_exceeded|rate limit exceeded|too many requests|temporarily rate limited)\b/i.test(error))return 'rate_limit';
  if(/\b(?:authentication_error|invalid_api_key|invalid api key|authentication failed|refresh token (?:has )?expired|refresh_token_expired|not authenticated)\b/i.test(error))return 'authentication';
  return undefined;
}

export function workerFailureMessage(reason?:WorkerFailure):string {
  if(reason==='usage_limit')return 'Your AI connection has reached its usage limit. Wait for the limit to reset before starting another attempt. Your saved work is kept.';
  if(reason==='rate_limit')return 'Your AI connection is temporarily rate limited. Try a new attempt later. Your saved work is kept.';
  if(reason==='authentication')return 'Your AI account needs to be reconnected before starting another attempt. Your saved work is kept.';
  return 'The native run ended with an error. Any returned text is saved.';
}
