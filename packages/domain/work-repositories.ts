import { z } from 'zod';
import { githubNamePattern, validGitBranch } from './work-input.js';

export const workEnvelope = { requestId: z.uuid(), epoch: z.uuid() };
export const githubName = z.string().regex(githubNamePattern).max(220);
export const gitBranch = z.string().min(1).max(200).refine(validGitBranch);
export const githubActionSchema = z.object({ ...workEnvelope, action: z.enum(['connect', 'cancel', 'disconnect']) }).strict();
export type GitHubIdentity = { id: number; login: string; name: string; email: string };
export type GitHubState = { available: boolean; message: string; account: GitHubIdentity | null; attempt: null | { id: string; state: 'starting'|'waiting'|'connected'|'cancelled'|'failed'; code?: string; url?: string; expiresAt: number; message: string } };
export type GitHubRepository = { id: number; fullName: string; description: string; private: boolean; defaultBranch: string; canPush: boolean; archived: boolean };
export type WorkCheckout = { id: string; repository: GitHubRepository; branch: string; folder: string; state: 'preparing'|'ready'|'failed'|'unknown'; message: string; createdAt: number; accountId: number; operationId: string };
export const checkoutSchema = z.object({ ...workEnvelope, repository: githubName, baseBranch: gitBranch }).strict();
export type GitChange = { path: string; status: string; binary: boolean; patch: string; truncated: boolean };
export type GitReview = { conversationId: string; checkoutId: string; repository: string; branch: string; baseBranch: string; head: string; fingerprint: string; files: GitChange[]; canPublish: boolean; message: string; published?: { head: string; url?: string }; operations: GitPublication[] };
export const publishSchema = z.object({ ...workEnvelope, conversationId: z.uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), title: z.string().trim().min(1).max(200), body: z.string().max(10000), action: z.enum(['commit','push','pull-request']) }).strict();
export type GitPublication = { id: string; conversationId: string; checkoutId: string; state: 'prepared'|'running'|'complete'|'failed'|'unknown'; action: 'commit'|'push'|'pull-request'; title: string; head?: string; url?: string; message: string; createdAt: number };
