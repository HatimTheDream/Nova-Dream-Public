import type { RecoveryHost } from './workspace-host.js';
import { UploadTransfers } from './upload-transfers.js';
import { AssistantObservations } from './assistant-observations.js';
import { WorkspaceBackups } from './workspace-backups.js';
import { importMaxBytes } from '../../packages/domain/workspace-import.js';
import { ManagedNativeBackup, type NativeBackup } from './native-backup.js';
import { ModuleActions } from './module-actions.js';
import { ContactDirectory } from './contact-directory.js';
import { AddressBooks } from './address-books.js';
import { ContactCrm } from './contact-crm.js';
import { uploadContactPhoto } from './contact-photo.js';
import { SubtaskSuggestions } from './subtask-suggestions.js';
import { WorkspaceKeys, type KeyProtector } from './workspace-keys.js';
import { authorizePrivateWeb, validatePrivateWeb, type PrivateWebOptions } from './private-web.js';
import { PhoneAccess } from './phone-access.js';
import { PhoneHost } from './phone-host.js';
import { phoneRouteAllowed } from './phone-policy.js';
import type { PhoneTransport } from './phone-transport.js';
import { AssistantQuestions } from './questions.js';
import { AssistantApprovals } from './approvals.js';
import { SessionSettingsControl, type AccessTransport } from './full-access.js';
import { DictationService } from './dictation.js';
import { CalendarWriteService } from './calendar-write.js';
import { CalendarGroups } from './calendar-groups.js';
import {MailFiles} from './mail-files.js';
import { MailDeliveryService } from './mail-delivery.js';
import { MailTriageService } from './mail-triage.js';
import { MailService } from './mail.js';
import { MailImages, type EmailImageLoader } from './mail-images.js';
import { MailContacts } from './mail-contacts.js';
import { MailIndexService } from './mail-index.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { ZodError } from 'zod';
import { Fault, Store } from './store.js';
import { imagePreviewType } from './image-preview.js';
import { Gateway, type AssistantTransport } from './gateway.js';
import { AssistantService } from './assistant.js';
import { AssignmentService } from './assignments.js';
import { AgentRoutines } from './agent-routines.js';
import { HubMeetings } from './hub-meetings.js';
import { ContentWorkspace } from './content-workspace.js';
import { exportContentPackage } from './content-package.js';
import { AgentHub } from './agent-hub.js';
import { AgentSkills } from './agent-skills.js';
import { SkillWorkshop } from './skill-workshop.js';
import { SkillManagement, type SkillManagementTransport } from './skill-management.js';
import { connectionSchema, assistantRequestSchema } from '../../packages/domain/assistant.js';
import { z } from 'zod';
import { ManagedRuntime } from './runtime.js';
import { ChatGptSignIn } from './sign-in.js';
import { ChatGptAccount } from './chatgpt-account.js';
import { VoiceSetup } from './voice.js';
import { VoiceCalls } from './voice-calls.js';
import { Accounts } from './accounts.js';
import { WorkspaceRecovery } from './workspace-recovery.js';
import { withRetainedNative } from './retained-native.js';
import { recoveryResumeSchema } from '../../packages/domain/workspace-backup.js';
import { CalendarService } from './calendar.js';
import { ProviderError, type Providers } from './providers.js';

const LIMIT = 12 * 1024 * 1024;
async function body(request: IncomingMessage, maximumBytes = LIMIT, source: AsyncIterable<Buffer> = request): Promise<any> {
  if (request.headers['content-type'] !== 'application/json') throw new Fault(415, 'content_type', 'Use JSON for this operation.');
  let size = 0; const chunks: Buffer[] = [];
  for await (const part of source) { size += part.length; if (size > maximumBytes) throw new Fault(413, 'too_large', 'This request is too large.'); chunks.push(part); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new Fault(400, 'invalid_json', 'The request was incomplete.'); }
}
const tokenFrom = (request: IncomingMessage, name: string) => request.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1);
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.glb': 'model/gltf-binary', '.webmanifest': 'application/manifest+json; charset=utf-8' };

const recoveredLocalRoutes = new Set([
  '/api/transfers/start', '/api/transfers/piece',
  '/api/session', '/api/commands', '/api/attachments', '/api/contacts/photo',
  '/api/profile/quests', '/api/content/workspace', '/api/content/from-output', '/api/content/from-assignment',
  '/api/tasks/order', '/api/tasks/focus', '/api/tasks/history', '/api/tasks/reminders/action',
  '/api/records/history', '/api/records/follow-up', '/api/contacts/read', '/api/contacts/merge', '/api/contacts/restore',
  '/api/contacts/crm', '/api/contacts/activity', '/api/contacts/organization', '/api/agents/hub/layout',
  '/api/calendar/local', '/api/storage/protect',
  '/api/storage/backups/create', '/api/storage/backups/upload', '/api/storage/backups/remove',
  '/api/storage/backups/inspect', '/api/storage/backups/restore', '/api/storage/backups/open',
  '/api/storage/backups/activate', '/api/storage/backups/return',
  '/api/storage/recovery/resume',
  '/api/assistant/retained/export',
  '/api/assistant/browse',
]);

// These existing operations only end work or reduce access. A stale window
// must still be able to stop an ongoing call/run before reloading.
const staleClientCleanup = new Set([
  '/api/tasks/suggestions/stop', '/api/assignments/stop', '/api/accounts/cancel',
  '/api/accounts/disconnect', '/api/phone/revoke', '/api/assistant/dictation/end',
  '/api/assistant/voice/end', '/api/assistant/sign-in/cancel', '/api/assistant/cancel',
]);

export async function startServer(options: { directory: string; port: number; privateWeb?: PrivateWebOptions; recoveryPreview?: boolean; recoveryHost?: RecoveryHost; nativeBackup?: NativeBackup; emailImageLoader?: EmailImageLoader; keyProtector?: KeyProtector; phonePort?: number; phoneTransport?: PhoneTransport; clientDirectory?: string; development?: boolean; developmentOrigin?: string; version?: string; buildVersion?: string; schemaVersion?: number; candidateId?: string; gateway?: AssistantTransport; providers?: Providers; skillManagementFactory?: () => SkillManagementTransport; accessControlFactory?: () => AccessTransport; responseControlFactory?: () => AccessTransport; approvalReviewFactory?: () => AccessTransport; questionReviewFactory?: () => AccessTransport }) {
  if (options.privateWeb) validatePrivateWeb(options.privateWeb);
  if (options.candidateId !== undefined && !/^[a-f0-9]{64}$/.test(options.candidateId)) throw new Error('Use a verified candidate identity.');
  if (options.developmentOrigin && (!options.development || !/^http:\/\/127\.0\.0\.1:[0-9]{4,5}$/.test(options.developmentOrigin) || Number(new URL(options.developmentOrigin).port) < 1024 || Number(new URL(options.developmentOrigin).port) > 65535)) throw new Error('Use an explicit loopback development origin.');
  const keys = new WorkspaceKeys(options.directory, options.keyProtector);
  const protectedKey = await keys.readProtected();
  let store: Store;
  try { store = new Store(options.directory, undefined, protectedKey, options.recoveryPreview); } finally { protectedKey?.fill(0); }
  if (keys.status().provider === 'server-secret') {
    try { await keys.protect(key => store.matchesKey(key)); } catch { store.close(); throw new Error('The server credential could not protect this workspace. Saved data was kept; no listener or connected work was started.'); }
  }
  const accounts = new Accounts(store, options.providers, undefined, options.privateWeb?.origin);
  const calendar = new CalendarService(store, accounts);
  const calendarWrites = new CalendarWriteService(store, accounts, calendar);
  const calendarGroups = new CalendarGroups(store, accounts, calendar, calendarWrites);
  const mail = new MailService(store, accounts);
  const mailImages = new MailImages(store, accounts, options.emailImageLoader);
  const mailContacts = new MailContacts(store, accounts);
  const mailDelivery = new MailDeliveryService(store, accounts);
  const mailIndex = new MailIndexService(store, accounts);
  const contactDirectory = new ContactDirectory(store, accounts, mailIndex, calendar);
  const contactCrm = new ContactCrm(store);
  const addressBooks = new AddressBooks(store, accounts);
  const mailTriage = new MailTriageService(store, accounts, Date.now, (target,unread) => mailIndex.providerChanged({epoch:store.epoch,accountId:target.accountId,generation:target.generation},target.threadId,unread));
  // Cookies share a host across ports. Keep each workspace's session independent,
  // while preserving its cookie name through restarts and local port changes.
  const cookieName = store.internalRead<string>('http:session-cookie') ?? store.internalWrite('http:session-cookie', `e3_session_${randomUUID().replaceAll('-', '')}`);
  const sessionToken = (request: IncomingMessage) => tokenFrom(request, cookieName) ?? tokenFrom(request, 'e3_session') ?? '';
  const phoneAccess = new PhoneAccess(store);
  const phoneCookie = '__Host-' + cookieName + '_phone';
  const webCookie = '__Host-' + cookieName + '_web';
  const reauthorize = new WeakMap<IncomingMessage, () => void>();
  const transfers = new UploadTransfers(options.directory, store.epoch);
  const bodySources = new WeakMap<IncomingMessage, AsyncIterable<Buffer>>();
  const gateway = options.gateway ?? new Gateway(store, options.version);
  const accessControl = new SessionSettingsControl(gateway, options.accessControlFactory ?? (gateway instanceof Gateway ? () => new Gateway(store, options.version, undefined, 'permission-control') : undefined));
  const responseControl = options.responseControlFactory || gateway instanceof Gateway ? new SessionSettingsControl(gateway, options.responseControlFactory ?? (() => new Gateway(store, options.version, undefined, 'response-control')), 'response') : undefined;
  const assistant = new AssistantService(store, gateway, undefined, accessControl, responseControl);
  const assignments = new AssignmentService(store, gateway);
  const approvals = new AssistantApprovals(store, gateway, () => [...assistant.conversations(), ...assignments.approvalTargets()], options.approvalReviewFactory ?? (gateway instanceof Gateway ? () => new Gateway(store, options.version, undefined, 'approval-review') : undefined));
  const questions = new AssistantQuestions(store, gateway, () => assistant.conversations(), id => assistant.history(id), options.questionReviewFactory ?? (gateway instanceof Gateway ? () => new Gateway(store, options.version, undefined, 'question-review') : undefined));
  assistant.setApprovalReview(async id => { await Promise.all([approvals.prepare(id), questions.prepare(id)]); });
  const subtaskSuggestions = new SubtaskSuggestions(store, gateway);
  const agentRoutines = new AgentRoutines(store, assignments);
  const agentHub = new AgentHub(store, assignments, Date.now, () => approvals.state().items);
  const hubMeetings = new HubMeetings(store, assignments);
  const contentWorkspace = new ContentWorkspace(store, assignments);
  const agentSkills = new AgentSkills(gateway);
  const skillWorkshop = new SkillWorkshop(store, gateway);
  const skillManagement = new SkillManagement(store, gateway, skillWorkshop, options.skillManagementFactory ?? (gateway instanceof Gateway ? () => new Gateway(store, options.version, undefined, 'skill-management') : undefined));
  const observations = new AssistantObservations(store, assistant);
  const moduleActions = new ModuleActions({store,assistant,gateway,accounts,calendar,calendarWrites,crm:contactCrm,mail,mailDelivery,mailTriage,assignments});
  const moduleToken = randomBytes(32).toString('hex');
  const runtime = gateway instanceof Gateway ? new ManagedRuntime(store, gateway, 45000, () => ({url:ownOrigin+'/workspace',token:moduleToken})) : undefined;
  const backups = new WorkspaceBackups(store, options.version ?? 'development', options.nativeBackup ?? (runtime ? new ManagedNativeBackup(runtime) : undefined), () => assistant.captureSavedHistories());
  const recovery = new WorkspaceRecovery(store);
  const recoveryServices = new Map<string, { origin: string; close: () => Promise<void> }>();
  const recoveryOpening = new Map<string, Promise<{ origin: string; close: () => Promise<void> }>>();
  const signIn = runtime ? new ChatGptSignIn(store, runtime) : undefined;
  const chatGptAccount = runtime ? new ChatGptAccount(runtime) : undefined;
  const voice = new VoiceSetup(gateway);
  const dictation = new DictationService(store, gateway);
  const calls = new VoiceCalls(store, gateway, assistant, voice);
  if (gateway instanceof Gateway && !store.recoveryEffectsPaused) gateway.start();
  let ownOrigin = '', closing = false;
  const requests = new Set<Promise<unknown>>();
  const commandBody = async (request: IncomingMessage, maximumBytes = LIMIT) => {
    const input = await body(request, maximumBytes, bodySources.get(request));
    if (closing) throw new Fault(503, 'service_closing', 'The workspace is restarting. Reconcile the original change when it is ready.');
    reauthorize.get(request)?.();
    return input;
  };
  const handle = async (request: IncomingMessage, response: ServerResponse, surface: 'desktop' | 'phone' | 'web' = 'desktop') => {
    let transferred: ReturnType<UploadTransfers['read']> | undefined;
    const json = (status: number, value: unknown) => {
      const text = JSON.stringify(value), headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
      // These reads reach this point only after their normal authentication.
      // Never answer a conditional request before the owner/session guards.
      if (status === 200 && request.method === 'GET' && ['/api/snapshot', '/api/assistant/state', '/api/assistant/outputs'].includes((request.url ?? '').split('?')[0])) {
        headers.ETag = `"e3-${createHash('sha256').update(store.epoch).update('\n').update(text).digest('hex')}"`;
        headers.Vary = 'Cookie';
        if (request.headers['if-none-match'] === headers.ETag) { response.writeHead(304, headers); response.end(); return; }
      }
      response.writeHead(status, headers); response.end(text);
    };
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    // GLB's embedded images are decoded from same-document Blob URLs. External
    // connection destinations remain disallowed.
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
    try {
      if (closing) { response.setHeader('Connection', 'close'); throw new Fault(503, 'service_closing', 'The workspace is restarting. Saved work is kept.'); }
      const remote = surface === 'phone';
      const web = surface === 'web';
      if (web) authorizePrivateWeb(request, options.privateWeb!);
      const localSessionToken = () => web ? tokenFrom(request, webCookie) ?? '' : sessionToken(request);
      if (remote && (!phoneAccess.enabled || !phoneHost.origin || !request.headers['tailscale-user-login'])) throw new Fault(403, 'private_route_required', 'Use the paired phone address from your private Tailscale network.');
      const allowedOrigins = web ? [options.privateWeb!.origin] : remote ? [phoneHost.origin!] : [ownOrigin, ...(options.development ? [options.developmentOrigin ?? 'http://127.0.0.1:4384'] : [])];
      const hostOrigin = `${remote || web ? 'https' : 'http'}://${request.headers.host}`;
      if (!allowedOrigins.includes(hostOrigin)) throw new Fault(403, 'host_rejected', 'This service only accepts its local workspace address.');
      const url = new URL(request.url ?? '/', allowedOrigins[0]);
      // A provider returns by cross-site top-level navigation. The exact owner
      // proxy identity, HTTPS host and one-use PKCE state still gate this route.
      if (web && url.pathname === '/oauth/callback' && request.method === 'GET') return accounts.webCallback(request, response);
      const origin = request.headers.origin;
      if (origin && !allowedOrigins.includes(origin)) throw new Fault(403, 'origin_rejected', 'This origin is not allowed.');
      // An authenticated Vercel sign-in may return by cross-site document
      // navigation. Only the inert root document is allowed here; API reads,
      // writes, subresources and embedded frames retain their existing guards.
      const ownerLanding = web && options.privateWeb?.auth === 'vercel' && request.method === 'GET' && url.pathname === '/' && request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document';
      if (request.headers['sec-fetch-site'] === 'cross-site' && !ownerLanding) throw new Fault(403, 'origin_rejected', 'Cross-site access is not allowed.');
      if (store.recoveryHeld && request.method === 'POST' && url.pathname !== '/api/session') throw new Fault(409, 'recovery_held', 'This is a recovered copy for review. Changes and connected services are paused; your current workspace is separate.');
      if (!store.recoveryHeld && store.recoveryEffectsPaused && request.method === 'POST' && !recoveredLocalRoutes.has(url.pathname)) throw new Fault(409, 'recovery_connections_paused', 'Connected services and automated work remain paused in this recovered workspace. Local records can be edited.');
      if (['/workspace', '/workspace/observation'].includes(url.pathname) && request.method === 'POST' && !remote && !web) {
        const supplied=Buffer.from(request.headers.authorization??''),expected=Buffer.from('Bearer '+moduleToken);
        if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))throw new Fault(403,'workspace_tool_auth','Use the connected Assistant for workspace tools.');
        if (url.pathname === '/workspace/observation') { await observations.accept(await commandBody(request, 13*1024*1024)); return json(200, { accepted: true }); }
        const result=await moduleActions.invoke(await commandBody(request,2*1024*1024));
        if(Buffer.byteLength(JSON.stringify(result))>512*1024)throw new Fault(413,'workspace_result_large','Narrow this request to one record or a smaller page.');
        return json(200,result);
      }
      if (url.pathname.startsWith('/api/')) {
        if (!['GET', 'POST'].includes(request.method ?? '')) throw new Fault(405, 'method', 'This method is not available.');
        if (url.pathname === '/api/health' && request.method === 'GET') return json(200, { application: 'nova-dream-edition-3', apiVersion: 1, version: options.version, buildVersion: options.buildVersion, schemaVersion: options.schemaVersion, candidateId: options.candidateId, status: 'ready' });
        if (request.method === 'POST' && request.headers['x-edition3-client'] !== '1') throw new Fault(403, 'client_required', 'Use the Edition 3 client for this operation.');
        if (url.pathname === '/api/access/context' && request.method === 'GET') {
          let requiresPairing = false;
          if (remote) try { phoneAccess.authenticate(tokenFrom(request, phoneCookie) ?? ''); } catch { requiresPairing = true; }
          return json(200, { surface, requiresPairing, workspaceEpoch: remote ? undefined : store.epoch, recovery: store.recoveryHeld, recoveryLocal: store.recoveryEffectsPaused && !store.recoveryHeld });
        }
        if (remote && url.pathname === '/api/pair' && request.method === 'POST') {
          const paired = phoneAccess.pair(await commandBody(request, 2048), tokenFrom(request, phoneCookie));
          response.setHeader('Set-Cookie', `${phoneCookie}=${paired.token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
          return json(200, { deviceId: paired.deviceId, apiVersion: 1 });
        }
        if (url.pathname === '/api/session' && request.method === 'POST') {
          if (remote) return json(200, { deviceId: phoneAccess.authenticate(tokenFrom(request, phoneCookie) ?? ''), apiVersion: 1 });
          const existing = localSessionToken();
          const session = store.session(existing);
          // A valid legacy cookie adopts the new name without changing its device
          // or retained drafts. An invalid token is replaced by Store.session.
          const token = session.token ?? (!web && tokenFrom(request, cookieName) === undefined ? existing : undefined);
          if (token) response.setHeader('Set-Cookie', `${web ? webCookie : cookieName}=${token}; ${web ? 'Secure; ' : ''}HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
          return json(200, { deviceId: session.deviceId, apiVersion: 1 });
        }
        const authenticate = () => { if (web) authorizePrivateWeb(request, options.privateWeb!); return remote ? phoneAccess.authenticate(tokenFrom(request, phoneCookie) ?? '') : store.authenticate(localSessionToken()); };
        const device = authenticate();
        reauthorize.set(request, () => { if (authenticate() !== device) throw new Fault(401, 'session_changed', 'Reconnect to your workspace.'); });
        if (remote && !phoneRouteAllowed(url.pathname, request.method ?? '')) throw new Fault(403, 'desktop_required', 'Manage host setup and connected devices in Settings on your computer.');
        if (options.candidateId && (url.pathname === '/api/snapshot' || request.method === 'POST' && !staleClientCleanup.has(url.pathname)) && (request.headers['x-edition3-candidate'] !== options.candidateId || request.headers['x-edition3-desktop'] !== undefined && request.headers['x-edition3-desktop'] !== options.candidateId)) {
          throw new Fault(409, 'client_update', 'This window needs the latest app. Keep your writing and reopen the app to continue saving.');
        }
        const transferOwner = surface + ':' + device;
        if (request.headers['x-edition3-transfer'] !== undefined) {
          if (request.method !== 'POST' || typeof request.headers['x-edition3-transfer'] !== 'string' || Number(request.headers['content-length'] ?? 0) !== 0 || request.headers['transfer-encoding'] || url.search) throw new Fault(400, 'transfer_request', 'Use the original upload request without an additional body.');
          transferred = transfers.read(transferOwner, request.headers['x-edition3-transfer'], url.pathname, String(request.headers['content-type']));
          bodySources.set(request, transferred.stream);
        }
        if (url.pathname === '/api/transfers/start' && request.method === 'POST') return json(200, await transfers.begin(transferOwner, await commandBody(request, 2048)));
        if (url.pathname === '/api/transfers/piece' && request.method === 'POST') return json(200, await transfers.piece(transferOwner, await commandBody(request, 1500000)));
        if (!remote && url.pathname === '/api/storage/backups' && request.method === 'GET') return json(200, { jobs: backups.list(device), host: options.recoveryHost?.status(), recovery: recovery.review() });
        if (!remote && url.pathname === '/api/storage/recovery/resume' && request.method === 'POST') {
          if (!options.recoveryHost) throw new Fault(409, 'recovery_host_required', 'Open this recovered workspace through the normal launcher first.');
          const input = recoveryResumeSchema.parse(await commandBody(request, 2048));
          if (input.epoch !== store.epoch) throw new Fault(409, 'epoch_changed', 'Refresh the recovery review.');
          const result = await backups.whileIdle(async () => {
            if (options.recoveryHost!.status().switching) throw new Fault(409, 'recovery_switching', 'Wait for the workspace switch to finish.');
            await withRetainedNative(store, { status: 'not-configured', notes: [] });
            await keys.protect(key => store.matchesKey(key));
            if (closing || options.recoveryHost!.status().switching) throw new Fault(409, 'recovery_switching', 'Wait for the workspace switch to finish.');
            reauthorize.get(request)?.();
            return recovery.resume(device, input);
          });
          if (result.fresh) options.recoveryHost.switchTo(store.directory, true);
          return json(202, result.value);
        }
        if (!remote && url.pathname === '/api/storage/imports' && request.method === 'GET') return json(200, { reviews: backups.imports(device) });
        if (!remote && url.pathname === '/api/storage/imports/review' && request.method === 'POST') return json(200, backups.reviewImport(device, await commandBody(request, importMaxBytes + 1024)));
        if (!remote && url.pathname === '/api/storage/imports/restore' && request.method === 'POST') return json(202, backups.restoreImport(device, await commandBody(request, 4096)));
        if (!remote && url.pathname === '/api/storage/imports/remove' && request.method === 'POST') return json(200, backups.removeImport(device, await commandBody(request, 4096)));
        const importDownload = /^\/api\/storage\/imports\/([a-f0-9-]{36})\/source$/.exec(url.pathname);
        if (!remote && importDownload && request.method === 'GET') {
          const bytes = Buffer.from(JSON.stringify(backups.importSource(device, importDownload[1]), null, 2));
          response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="preserved-workspace-source.json"', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' }); return response.end(bytes);
        }
        if (!remote && ['/api/storage/backups/activate', '/api/storage/backups/return'].includes(url.pathname) && request.method === 'POST') {
          if (!options.recoveryHost) throw new Fault(409, 'recovery_host_required', 'Open this workspace through its normal launcher before switching copies.');
          const returning = url.pathname.endsWith('/return');
          const input = assistantRequestSchema.extend({ recoveryId: z.string().uuid().optional() }).strict().parse(await commandBody(request, 2048));
          if (!returning && !input.recoveryId) throw new Fault(400, 'recovery_missing', 'Choose the verified recovery copy.');
          const directory = returning ? undefined : backups.recoveredDirectory(device, input.recoveryId!);
          store.admit(device, input, { ...input, type: returning ? 'recovery.return' : 'recovery.activate' }, () => ({ accepted: true }));
          options.recoveryHost.switchTo(directory);
          return json(202, { accepted: true, epoch: store.epoch });
        }
        if (!remote && url.pathname === '/api/storage/backups/create' && request.method === 'POST') return json(202, backups.create(device, await commandBody(request, 4096)));
        if (!remote && url.pathname === '/api/storage/backups/upload' && request.method === 'POST') {
          if (request.headers['content-type'] !== 'application/octet-stream') throw new Fault(415, 'backup_type', 'Select a backup file.');
          return json(200, await backups.upload(device, String(request.headers['x-edition3-epoch'] ?? ''), bodySources.get(request) ?? request, () => { if (closing) throw new Fault(503, 'service_closing', 'The workspace is restarting.'); reauthorize.get(request)?.(); }));
        }
        if (!remote && url.pathname === '/api/storage/backups/remove' && request.method === 'POST') return json(200, await backups.remove(device, await commandBody(request, 2048)));
        if (!remote && url.pathname === '/api/storage/backups/inspect' && request.method === 'POST') return json(202, backups.inspect(device, await commandBody(request, 4096)));
        if (!remote && url.pathname === '/api/storage/backups/restore' && request.method === 'POST') return json(202, backups.restore(device, await commandBody(request, 4096)));
        const backupDownload = /^\/api\/storage\/backups\/([a-f0-9-]{36})\/download$/.exec(url.pathname);
        if (!remote && backupDownload && request.method === 'GET') { const file = await backups.download(device, backupDownload[1]); response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${file.name}"`, 'Content-Length': file.bytes.length, 'Cache-Control': 'no-store' }); return response.end(file.bytes); }
        if (!remote && url.pathname === '/api/storage/backups/open' && request.method === 'POST') {
          if (web) throw new Fault(409, 'recovery_local_preview', 'Separate review windows are available through the host connection. Use the verified recovery switch to open a restored copy in this web workspace.');
          const input = assistantRequestSchema.extend({ recoveryId: z.string().uuid() }).strict().parse(await commandBody(request, 2048));
          const directory = backups.recoveredDirectory(device, input.recoveryId);
          store.admit(device, input, { ...input, type: 'recovery.open' }, () => ({ accepted: true }));
          if (!recoveryServices.has(input.recoveryId)) {
            if (!recoveryOpening.has(input.recoveryId)) {
              if (recoveryServices.size + recoveryOpening.size >= 2) throw new Fault(409, 'recovery_preview_limit', 'Two recovery copies are already open. Restart this workspace to close their previews before opening another.');
              const opening = startServer({ directory, port: 0, keyProtector: options.keyProtector, recoveryPreview: true, version: options.version, buildVersion: options.buildVersion, schemaVersion: options.schemaVersion, candidateId: options.candidateId, clientDirectory: options.clientDirectory }).then(async recovery => { if (closing) { await recovery.close(); throw new Fault(503, 'service_closing', 'The workspace is restarting.'); } recoveryServices.set(input.recoveryId, recovery); return recovery; }).finally(() => recoveryOpening.delete(input.recoveryId));
              recoveryOpening.set(input.recoveryId, opening);
            }
            await recoveryOpening.get(input.recoveryId);
          }
          return json(200, { origin: recoveryServices.get(input.recoveryId)!.origin });
        }
        if (!remote && url.pathname === '/api/storage/state' && request.method === 'GET') return json(200, keys.status());
        if (!remote && url.pathname === '/api/storage/protect' && request.method === 'POST') {
          const input = assistantRequestSchema.strict().parse(await commandBody(request, 2048));
          store.admit(device, input, { type: 'storage.protect', ...input }, () => ({ accepted: true }));
          try { await keys.protect(key => store.matchesKey(key)); }
          catch { throw new Fault(503, 'os_key_unavailable', 'The operating system could not protect the workspace key. Existing saved data is kept. Unlock this computer and retry.'); }
          return json(200, keys.status());
        }
        if (!remote && url.pathname === '/api/phone/state' && request.method === 'GET') return json(200, phoneHost.state());
        if (!remote && url.pathname === '/api/phone/enable' && request.method === 'POST') { phoneAccess.setEnabled(device, await commandBody(request, 2048), true); return json(200, await phoneHost.reconcile(true)); }
        if (!remote && url.pathname === '/api/phone/disable' && request.method === 'POST') { phoneAccess.setEnabled(device, await commandBody(request, 2048), false); return json(200, await phoneHost.reconcile()); }
        if (!remote && url.pathname === '/api/phone/pairing' && request.method === 'POST') {
          if (!phoneHost.origin) throw new Fault(409, 'phone_route_unavailable', 'Connect the private phone route before creating a code.');
          return json(200, phoneAccess.startPairing(device, await commandBody(request, 2048)));
        }
        if (!remote && url.pathname === '/api/phone/revoke' && request.method === 'POST') return json(200, phoneAccess.revoke(device, await commandBody(request, 2048)).value);
        if (url.pathname === '/api/snapshot' && request.method === 'GET') {
          const connection = gateway.status();
          return json(200, { ...store.snapshot(device), calendarReminders: calendar.reminders.state(), version: options.version, capabilities: { assistant: connection.state === 'ready' && connection.modelAuthReady && connection.grantedScopes.includes('operator.write'), voice: connection.state === 'ready' && connection.methods.includes('talk.client.create'), reason: connection.message } });
        }
        if (url.pathname === '/api/calendar/state' && request.method === 'GET') return json(200, calendar.state(device, { from: url.searchParams.get('from'), to: url.searchParams.get('to'), timezone: url.searchParams.get('timezone') }));
        if (url.pathname === '/api/calendar/sources' && request.method === 'POST') return json(202, calendar.discover(device, await commandBody(request)));
        if (url.pathname === '/api/calendar/refresh' && request.method === 'POST') return json(202, calendar.refresh(device, await commandBody(request)));
        if (url.pathname === '/api/calendar/selection' && request.method === 'POST') return json(200, calendar.select(device, await commandBody(request)));
        const localCalendarMatch = /^\/api\/calendar\/local\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (localCalendarMatch && request.method === 'GET') return json(200, calendar.readLocal(localCalendarMatch[1], url.searchParams.get('originalDate') ?? undefined));
        if (url.pathname === '/api/calendar/write/open' && request.method === 'POST') return json(200, await calendarWrites.open(device, await commandBody(request)));
        if (url.pathname === '/api/calendar/write/prepare' && request.method === 'POST') return json(200, await calendarWrites.prepare(device, await commandBody(request)));
        if (url.pathname === '/api/calendar/write/read' && request.method === 'POST') return json(200, await calendarWrites.read(device, await commandBody(request)));
        if (url.pathname === '/api/calendar/write/confirm' && request.method === 'POST') return json(200, await calendarWrites.confirm(device, await commandBody(request)));
        if (url.pathname === '/api/calendar/write/reconcile' && request.method === 'POST') return json(200, await calendarWrites.reconcile(device, await commandBody(request)));
        if (url.pathname === '/api/calendar/groups/prepare' && request.method === 'POST') return json(200, await calendarGroups.prepare(device, await commandBody(request)));
        if (url.pathname === '/api/calendar/groups/read' && request.method === 'POST') return json(200, calendarGroups.read(device, await commandBody(request)));
        if (url.pathname === '/api/calendar/groups/reconcile' && request.method === 'POST') return json(200, await calendarGroups.reconcile(device, await commandBody(request)));
        if (url.pathname === '/api/calendar/groups/action' && request.method === 'POST') return json(200, await calendarGroups.action(device, await commandBody(request)));
        if (url.pathname === '/api/calendar/followups' && request.method === 'POST') return json(200, calendar.saveFollowup(device, await commandBody(request)));
        if (url.pathname === '/api/calendar/local' && request.method === 'POST') return json(200, calendar.saveLocal(device, await commandBody(request)));
        if (url.pathname === '/api/tasks/suggestions' && request.method === 'POST') return json(202, subtaskSuggestions.start(device, await commandBody(request)));
        if (url.pathname === '/api/tasks/suggestions/stop' && request.method === 'POST') return json(200, await subtaskSuggestions.stop(device, await commandBody(request)));
        const suggestionMatch = /^\/api\/tasks\/suggestions\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (suggestionMatch && request.method === 'GET') return json(200, await subtaskSuggestions.check(suggestionMatch[1]));
        if (url.pathname === '/api/tasks/calendar-completion' && request.method === 'POST') return json(200, calendar.completeTaskEvent(device, await commandBody(request)));
        if (url.pathname === '/api/tasks/order' && request.method === 'POST') return json(200, store.orderTasks(device, await commandBody(request)));
        if (url.pathname === '/api/calendar/reminders/action' && request.method === 'POST') return json(200, calendar.reminders.act(device, await commandBody(request)));
        if (url.pathname === '/api/calendar/reminders/delivery' && request.method === 'POST') return json(200, calendar.reminders.deliver(device, await commandBody(request)));
        if (url.pathname === '/api/tasks/reminders/action' && request.method === 'POST') return json(200, store.actOnReminder(device, await commandBody(request)));
        if (url.pathname === '/api/tasks/reminders/delivery' && request.method === 'POST') return json(200, store.deliverReminder(device, await commandBody(request)));
        if (url.pathname === '/api/tasks/focus' && request.method === 'POST') return json(200, store.focus(device, await commandBody(request)));
        if (url.pathname === '/api/tasks/history' && request.method === 'POST') return json(200, store.taskHistory(await commandBody(request)));
        if (url.pathname === '/api/commands' && request.method === 'POST') return json(200, store.mutate(device, await commandBody(request)));
        const workChangesMatch = /^\/api\/assistant\/work-changes\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (workChangesMatch && request.method === 'GET') return json(200, await assistant.workChanges(workChangesMatch[1]));
        const observationMatch = /^\/api\/assistant\/observation\/([a-f0-9-]{36})(?:\/([a-f0-9]{64}))?$/.exec(url.pathname);
        if (observationMatch && request.method === 'GET') {
          if (!observationMatch[2]) return json(200, observations.read(observationMatch[1]));
          const bytes = observations.image(observationMatch[1], observationMatch[2]);
          response.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'no-store', 'Content-Length': bytes.length }); return response.end(bytes);
        }
        if (url.pathname === '/api/assistant/module-actions' && request.method === 'POST') { const input=z.union([z.object({conversationId:z.uuid()}).strict(),z.object({assignmentId:z.uuid()}).strict()]).parse(await commandBody(request));return json(200,'assignmentId' in input?moduleActions.listAssignment(input.assignmentId):moduleActions.list(input.conversationId)); }
        if (url.pathname === '/api/assistant/module-action' && request.method === 'POST') return json(200,await moduleActions.decide(device,await commandBody(request)));
        if (url.pathname === '/api/contacts/read' && request.method === 'POST') return json(200, await contactDirectory.read(device, await commandBody(request)));
        if (url.pathname === '/api/contacts/merge' && request.method === 'POST') return json(200, store.mergeContacts(device, await commandBody(request)));
        if (url.pathname === '/api/contacts/restore' && request.method === 'POST') return json(200, store.restoreContact(device, await commandBody(request)));
        if (url.pathname === '/api/records/history' && request.method === 'POST') return json(200, store.recordHistory(await commandBody(request)));
        if (url.pathname === '/api/records/follow-up' && request.method === 'POST') return json(200, store.createRecordTask(device, await commandBody(request)));
        if (url.pathname === '/api/mail/contacts/prepare' && request.method === 'POST') return json(200, await mailContacts.prepare(device, await commandBody(request)));
        if (url.pathname === '/api/mail/contacts/link' && request.method === 'POST') return json(200, mailContacts.link(device, await commandBody(request)));
        if (url.pathname === '/api/agent-routines/state' && request.method === 'GET') {
          const query = z.object({ routineId: z.string().uuid().optional(), before: z.string().uuid().optional() }).strict().parse(Object.fromEntries(url.searchParams));
          return json(200, agentRoutines.state(query.routineId, query.before));
        }
        if (url.pathname === '/api/agent-skills/installed' && request.method === 'GET') {
          z.object({}).strict().parse(Object.fromEntries(url.searchParams));
          return json(200, await agentSkills.installed());
        }
        if (url.pathname === '/api/agent-skills/proposals' && request.method === 'GET') {
          z.object({}).strict().parse(Object.fromEntries(url.searchParams));
          return json(200, await skillWorkshop.list());
        }
        if (url.pathname === '/api/agent-skills/proposal' && request.method === 'GET') {
          const query = z.object({ proposalId: z.string().min(1).max(500) }).strict().parse(Object.fromEntries(url.searchParams));
          return json(200, await skillWorkshop.inspect(query.proposalId));
        }
        if (url.pathname === '/api/agent-skills/proposal-events' && request.method === 'GET') {
          const query = z.object({ proposalId: z.string().min(1).max(500), afterSequence: z.coerce.number().int().nonnegative().optional() }).strict().parse(Object.fromEntries(url.searchParams));
          return json(200, await skillWorkshop.events(query.proposalId, query.afterSequence));
        }
        if (url.pathname === '/api/agent-skills/reviews' && request.method === 'GET') {
          const query = z.object({ savedId: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().parse(Object.fromEntries(url.searchParams));
          return json(200, query.savedId ? skillWorkshop.saved(query.savedId) : skillWorkshop.savedList());
        }
        if (url.pathname === '/api/agent-skills/keep-review' && request.method === 'POST') return json(200, await skillWorkshop.keep(device, await commandBody(request)));
        if (url.pathname === '/api/agent-skills/management' && request.method === 'GET') {
          z.object({}).strict().parse(Object.fromEntries(url.searchParams)); return json(200, skillManagement.state(device));
        }
        if (url.pathname === '/api/agent-skills/management/access' && request.method === 'POST') return json(200, await skillManagement.access(device, await commandBody(request)));
        if (url.pathname === '/api/agent-skills/operation' && request.method === 'GET') {
          const query = z.object({ id: z.string().uuid() }).strict().parse(Object.fromEntries(url.searchParams)); return json(200, skillManagement.operation(query.id));
        }
        if (url.pathname === '/api/agent-skills/operation' && request.method === 'POST') return json(202, skillManagement.submit(device, await commandBody(request)));
        if (url.pathname === '/api/agent-skills/operation/check' && request.method === 'POST') {
          const cmd = z.object({ id: z.string().uuid() }).strict().parse(await commandBody(request)); return json(200, await skillManagement.check(cmd.id));
        }
        if (url.pathname === '/api/agent-skills/operation/resolve' && request.method === 'POST') return json(200, skillManagement.resolve(device, await commandBody(request)));
        if (url.pathname === '/api/agents/meetings' && request.method === 'GET') return json(200, hubMeetings.state());
        if (url.pathname === '/api/agents/meetings' && request.method === 'POST') return json(200, hubMeetings.command(device, await commandBody(request)));
        if (url.pathname === '/api/agents/hub/layout' && request.method === 'POST') return json(200, agentHub.changeLayout(device, await commandBody(request)));
        if (url.pathname === '/api/agents/hub' && request.method === 'GET') {
          const query = z.object({ before: z.string().min(1).max(100).optional(), agentId: z.string().min(1).max(100).optional(), archived: z.enum(['true', 'false']).optional() }).strict().refine(q => !(q.before && q.agentId)).parse(Object.fromEntries(url.searchParams));
          return json(200, agentHub.state(query.before, query.archived === 'true', query.agentId));
        }
        if (url.pathname === '/api/agent-routines/save' && request.method === 'POST') return json(200, agentRoutines.save(device, await commandBody(request)));
        if (url.pathname === '/api/agent-routines/preview' && request.method === 'POST') return json(200, agentRoutines.preview(await commandBody(request)));
        if (url.pathname === '/api/assignments/state' && request.method === 'GET') {
          const query = z.object({ assignmentId: z.string().min(1).max(100).optional(), before: z.string().uuid().optional() }).strict().parse(Object.fromEntries(url.searchParams));
          return json(200, assignments.state(query.assignmentId, query.before));
        }
        if (url.pathname === '/api/assignments/approvals' && request.method === 'GET') { const ids = new Set(assignments.approvalTargets().map(target => target.id)); const state = approvals.state(); return json(200, { ...state, items: state.items.filter(item => ids.has(item.conversationId)) }); }
        if (url.pathname === '/api/assignments/start' && request.method === 'POST') return json(202, assignments.start(device, await commandBody(request)));
        if (url.pathname === '/api/assignments/stop' && request.method === 'POST') return json(200, assignments.stop(device, await commandBody(request)));
        if (url.pathname === '/api/assignments/acknowledge' && request.method === 'POST') return json(200, assignments.acknowledgeUnresolved(device, await commandBody(request)));
        const assignmentMatch = /^\/api\/assignments\/attempt\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (assignmentMatch && request.method === 'GET') return json(200, assignments.detail(assignmentMatch[1]));
        const assignmentCheck = /^\/api\/assignments\/check\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (assignmentCheck && request.method === 'GET') return json(200, await assignments.reconcile(assignmentCheck[1]));
        if (url.pathname === '/api/contacts/address-books' && request.method === 'POST') return json(200, addressBooks.state(device, await commandBody(request)));
        if (url.pathname === '/api/contacts/address-browse' && request.method === 'POST') return json(200, await addressBooks.browse(device, await commandBody(request)));
        if (url.pathname === '/api/contacts/address-import' && request.method === 'POST') return json(200, addressBooks.import(device, await commandBody(request)));
        if (url.pathname === '/api/contacts/address-sync' && request.method === 'POST') return json(200, await addressBooks.sync(device, await commandBody(request)));
        if (url.pathname === '/api/contacts/address-link' && request.method === 'POST') return json(200, addressBooks.changeLink(device, await commandBody(request)));
        if (url.pathname === '/api/contacts/crm' && request.method === 'POST') return json(200, contactCrm.read(device, await commandBody(request)));
        if (url.pathname === '/api/contacts/activity' && request.method === 'POST') return json(200, contactCrm.saveActivity(device, await commandBody(request)));
        if (url.pathname === '/api/contacts/organization' && request.method === 'POST') return json(200, contactCrm.saveOrganization(device, await commandBody(request)));
        if (url.pathname === '/api/content/from-output' && request.method === 'POST') return json(200, store.createContentFromOutput(device, await commandBody(request)));
        if (url.pathname === '/api/profile/progress' && request.method === 'GET') return json(200, store.profileProgress());
        if (url.pathname === '/api/profile/history' && request.method === 'GET') return json(200, store.profileHistory(z.string().min(1).max(200).optional().parse(url.searchParams.get('before') ?? undefined)));
        if (url.pathname === '/api/profile/quests' && request.method === 'POST') return json(200, store.saveQuest(device, await commandBody(request)));
        if (url.pathname === '/api/content/library' && request.method === 'GET') return json(200, contentWorkspace.library());
        if (url.pathname === '/api/content/workspace' && request.method === 'POST') return json(200, await contentWorkspace.command(device, await commandBody(request)));
        if (url.pathname === '/api/content/state' && request.method === 'GET') return json(200, contentWorkspace.state(z.string().min(1).max(100).parse(url.searchParams.get('id'))));
        if (url.pathname === '/api/content/result' && request.method === 'GET') return json(200, contentWorkspace.result(z.uuid().parse(url.searchParams.get('id'))));
        if (url.pathname === '/api/content/package' && request.method === 'GET') {
          const query=z.object({id:z.string().min(1).max(100),revision:z.coerce.number().int().positive()}).strict().parse(Object.fromEntries(url.searchParams));
          const file=exportContentPackage(store,query.id,query.revision);
          response.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,'Content-Length':file.bytes.length,'Cache-Control':'no-store'});return response.end(file.bytes);
        }
        if (url.pathname === '/api/content/from-assignment' && request.method === 'POST') return json(200, store.createContentFromAssignment(device, await commandBody(request)));
        if (['/api/attachments', '/api/contacts/photo'].includes(url.pathname) && request.method === 'POST') {
          const data = await commandBody(request);
          if (!data || ['requestId', 'epoch', 'name', 'base64'].some(key => typeof data[key] !== 'string')) throw new Fault(400, 'invalid_upload', 'The attachment upload was incomplete.');
          return json(200, url.pathname === '/api/contacts/photo' ? await uploadContactPhoto(store, device, data) : store.upload(device, data.requestId, data.epoch, data.name, data.base64));
        }
        const match = /^\/api\/attachments\/([a-z0-9-]{36})$/.exec(url.pathname);
        if (match && request.method === 'GET') {
          const file = store.download(match[1]);
          const preview = url.searchParams.get('preview') === '1' ? imagePreviewType(file.bytes) : undefined;
          response.writeHead(200, { 'Content-Type': preview ?? 'application/octet-stream', 'Content-Disposition': `${preview ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.metadata.name)}`, 'Content-Length': file.bytes.length, 'Cache-Control': 'no-store', 'Content-Security-Policy': "sandbox; default-src 'none'" });
          return response.end(file.bytes);
        }
        if (url.pathname === '/api/accounts' && request.method === 'GET') { const state = accounts.state(device); return json(200, remote ? { ...state, clients: state.clients.map(({ provider, configured, revision }) => ({ provider, configured, revision })), attempts: [] } : state); }
        const configurationReceipt = /^\/api\/accounts\/configuration-receipts\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (configurationReceipt && request.method === 'GET') return json(200, accounts.configurationReceipt(device, configurationReceipt[1]));
        if (url.pathname === '/api/accounts/configure' && request.method === 'POST') return json(200, accounts.configure(device, await commandBody(request)));
        if (url.pathname === '/api/accounts/start' && request.method === 'POST') return json(202, await accounts.start(device, await commandBody(request)));
        if (url.pathname === '/api/accounts/cancel' && request.method === 'POST') return json(200, accounts.cancel(device, await commandBody(request)));
        if (url.pathname === '/api/accounts/disconnect' && request.method === 'POST') return json(200, accounts.disconnect(device, await commandBody(request)));
        if (url.pathname === '/api/mail/triage/prepare' && request.method === 'POST') return json(200, await mailTriage.prepare(device, await commandBody(request)));
        if (url.pathname === '/api/mail/triage/displayed' && request.method === 'POST') return json(200, await mailTriage.displayed(device, await commandBody(request)));
        if (url.pathname === '/api/mail/triage/read' && request.method === 'POST') return json(200, mailTriage.read(device, await commandBody(request)));
        if (url.pathname === '/api/mail/triage/confirm' && request.method === 'POST') return json(200, await mailTriage.confirm(device, await commandBody(request)));
        if (url.pathname === '/api/mail/triage/reconcile' && request.method === 'POST') return json(200, await mailTriage.reconcile(device, await commandBody(request)));
        if (url.pathname === '/api/mail/delivery/prepare' && request.method === 'POST') return json(200, await mailDelivery.prepare(device, await commandBody(request, 40 * 1024 * 1024)));
        if (url.pathname === '/api/mail/delivery/open' && request.method === 'POST') return json(200, await mailDelivery.openDraft(device, await commandBody(request)));
        if (url.pathname === '/api/mail/delivery/reconcile' && request.method === 'POST') return json(200, await mailDelivery.reconcile(device, await commandBody(request)));
        if (url.pathname === '/api/mail/delivery/read' && request.method === 'POST') return json(200, mailDelivery.read(device, await commandBody(request)));
        if (url.pathname === '/api/mail/files' && request.method === 'POST') return json(200, new MailFiles(store).upload(device, await commandBody(request, 15 * 1024 * 1024)));
        if (url.pathname === '/api/mail/files/read' && request.method === 'POST') return json(200, new MailFiles(store).read(device, await commandBody(request)));
        if (url.pathname === '/api/mail/delivery/file' && request.method === 'POST') return json(200, mailDelivery.readFile(device, await commandBody(request)));
        if (url.pathname === '/api/mail/delivery/confirm' && request.method === 'POST') return json(200, await mailDelivery.confirm(device, await commandBody(request)));
        if (url.pathname === '/api/mail/images' && request.method === 'POST') return json(200, await mailImages.read(device, await commandBody(request)));
        if (url.pathname === '/api/mail/read' && request.method === 'POST') {
          const input = await commandBody(request), result = await mail.read(device, input);
          mailImages.remember(device, (input as { epoch: string }).epoch, result);
          return json(200, result);
        }
        if (url.pathname === '/api/mail/index/read' && request.method === 'POST') return json(200, await mailIndex.read(device, await commandBody(request)));
        if (url.pathname === '/api/mail/index/command' && request.method === 'POST') return json(200, await mailIndex.command(device, await commandBody(request)));
        if (url.pathname === '/api/accounts/probe' && request.method === 'POST') return json(200, await accounts.probe(device, await commandBody(request)));
        if (url.pathname === '/api/assistant/runtime' && request.method === 'GET') return json(200, runtime?.status() ?? { state: 'unavailable', message: 'This test transport has no managed runtime.' });
        if (url.pathname === '/api/assistant/voice/catalog' && request.method === 'GET') return json(200, await voice.read());
        const voiceMatch = /^\/api\/assistant\/voice\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (voiceMatch && request.method === 'GET') return json(200, calls.read(device, voiceMatch[1]));
        const voiceRecovery = /^\/api\/assistant\/voice\/recover\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (voiceRecovery && request.method === 'GET') return json(200, calls.recover(device, voiceRecovery[1]));
        if (url.pathname === '/api/assistant/dictation/offer' && request.method === 'POST') return json(200, await dictation.offer(device, await commandBody(request)));
        if (url.pathname === '/api/assistant/dictation/caption' && request.method === 'POST') return json(200, dictation.caption(device, await commandBody(request)));
        if (url.pathname === '/api/assistant/dictation/start' && request.method === 'POST') return json(202, dictation.start(device, await commandBody(request)));
        if (url.pathname === '/api/assistant/dictation/audio' && request.method === 'POST') return json(200, await dictation.audio(device, await commandBody(request)));
        if (url.pathname === '/api/assistant/dictation/end' && request.method === 'POST') return json(200, await dictation.end(device, await commandBody(request)));
        if (url.pathname.startsWith('/api/assistant/dictation/') && request.method === 'GET') return json(200, dictation.read(device, url.pathname.split('/').at(-1)!));
        if (url.pathname === '/api/assistant/voice/start' && request.method === 'POST') return json(202, calls.start(device, await commandBody(request)));
        if (url.pathname === '/api/assistant/voice/offer' && request.method === 'POST') return json(200, await calls.offer(device, await commandBody(request)));
        if (url.pathname === '/api/assistant/voice/pulse' && request.method === 'POST') return json(200, await calls.pulse(device, await commandBody(request)));
        if (url.pathname === '/api/assistant/voice/finals' && request.method === 'POST') return json(200, await calls.finals(device, await commandBody(request)));
        if (url.pathname === '/api/assistant/voice/consult' && request.method === 'POST') return json(200, await calls.consult(device, await commandBody(request)));
        if (url.pathname === '/api/assistant/voice/end' && request.method === 'POST') return json(200, await calls.end(device, await commandBody(request)));
        if (url.pathname === '/api/assistant/sign-in' && request.method === 'GET') return json(200, signIn?.status() ?? { state: 'idle', message: 'Connect this host’s managed runtime to sign in here.' });
        if (url.pathname === '/api/assistant/account' && request.method === 'GET') return json(200, await chatGptAccount?.read(url.searchParams.get('refresh') === '1') ?? { state: 'unavailable', emails: [], profileCount: 0, message: 'Check the saved account on the host running your Assistant.' });
        if (url.pathname === '/api/assistant/sign-in/start' && request.method === 'POST') {
          if (!signIn) throw new Fault(503, 'signin_unavailable', 'This host cannot start OpenClaw sign-in.');
          const input = await commandBody(request);
          if (web && input && typeof input === 'object' && 'method' in input && input.method === 'browser') throw new Fault(409, 'server_device_signin', 'Use a sign-in code on this server. Browser callback sign-in needs a separately prepared host connection.');
          return json(202, signIn.start(device, input));
        }
        if (url.pathname === '/api/assistant/sign-in/cancel' && request.method === 'POST') {
          if (!signIn) throw new Fault(503, 'signin_unavailable', 'This host cannot manage OpenClaw sign-in.');
          return json(200, await signIn.cancel(device, await commandBody(request)));
        }
        if (url.pathname === '/api/assistant/runtime/start' && request.method === 'POST') {
          const input = assistantRequestSchema.strict().parse(await commandBody(request));
          if (input.epoch !== store.epoch) throw new Fault(409, 'epoch_changed', 'Review setup after workspace recovery.');
          if (!runtime) throw new Fault(503, 'runtime_unavailable', 'No managed runtime is available.');
          void runtime.start();
          return json(202, runtime.status());
        }
        if (url.pathname === '/api/assistant/search' && request.method === 'POST') return json(200, await assistant.search(await commandBody(request)));
        if (url.pathname === '/api/assistant/browse' && request.method === 'POST') return json(200, await assistant.browse(await commandBody(request)));
        if (url.pathname === '/api/assistant/approval/resolve' && request.method === 'POST') return json(200, await approvals.resolve(device, await commandBody(request)));
        if (url.pathname === '/api/assistant/approval/check' && request.method === 'POST') return json(200, await approvals.check(await commandBody(request)));
        if (url.pathname === '/api/assistant/question/resolve' && request.method === 'POST') return json(200, await questions.resolve(device, await commandBody(request)));
        if (url.pathname === '/api/assistant/question/check' && request.method === 'POST') return json(200, await questions.check(await commandBody(request)));
        if (url.pathname === '/api/assistant/question/dismiss' && request.method === 'POST') return json(200, questions.dismiss(device, await commandBody(request)));
        if (url.pathname === '/api/assistant/state' && request.method === 'GET') {
          const ids = new Set(assistant.conversations().map(conversation => conversation.id)), state = approvals.state();
          // Assignments have their own review surface. Their IDs cannot be
          // selected as ordinary conversations by the Assistant sidebar.
          return json(200, { ...assistant.state(), approvals: { ...state, items: state.items.filter(item => ids.has(item.conversationId)) }, questions: questions.state() });
        }
        const retainedTranscript = /^\/api\/assistant\/retained\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (retainedTranscript && request.method === 'GET') return json(200, assistant.retainedTranscriptReview(retainedTranscript[1]));
        if (url.pathname === '/api/assistant/retained/export' && request.method === 'POST') return json(200, assistant.exportRetainedTranscript(device, await commandBody(request)));
        if (url.pathname === '/api/assistant/steer' && request.method === 'POST') return json(202, assistant.submit(device, await commandBody(request), true));
        if (url.pathname === '/api/assistant/queue' && request.method === 'POST') return json(200, assistant.enqueue(device, await commandBody(request)));
        if (url.pathname === '/api/assistant/queue/edit' && request.method === 'POST') return json(200, assistant.editQueued(device, await commandBody(request)));
        if (url.pathname === '/api/assistant/queue/order' && request.method === 'POST') return json(200, assistant.reorderQueue(device, await commandBody(request)));
        if (url.pathname.startsWith('/api/assistant/access/') && request.method === 'GET') return json(200, await assistant.readAccess(url.pathname.split('/').at(-1)!));
        if (url.pathname === '/api/assistant/queue/state' && request.method === 'POST') return json(200, assistant.setQueueState(device, await commandBody(request)));
        if (url.pathname === '/api/assistant/queue/run' && request.method === 'POST') return json(200, assistant.runQueued(device, await commandBody(request)));
        if (url.pathname === '/api/assistant/models' && request.method === 'GET') return json(200, await gateway.models());
        if (url.pathname === '/api/assistant/memory' && request.method === 'POST') return json(200, assistant.memory.change(device, await commandBody(request)));
        if (url.pathname === '/api/assistant/conversation/remove' && request.method === 'POST') return json(200, await assistant.removals.remove(device, await commandBody(request)));
        if (url.pathname === '/api/assistant/message-pin' && request.method === 'POST') return json(200, assistant.pins.change(device, await commandBody(request)));
        if (url.pathname === '/api/assistant/outputs' && request.method === 'GET') return json(200, assistant.outputs());
        if (url.pathname === '/api/assistant/outputs' && request.method === 'POST') return json(200, assistant.saveOutput(device, await commandBody(request)));
        if (url.pathname === '/api/assistant/artifact/save' && request.method === 'POST') return json(200, await assistant.saveArtifact(device, await commandBody(request)));
        if (url.pathname === '/api/assistant/artifact/read' && request.method === 'POST') {
          const file = await assistant.readArtifact(await commandBody(request));
          const preview = imagePreviewType(file.bytes);
          response.writeHead(200, { 'Content-Type': preview ?? 'application/octet-stream', 'Content-Disposition': `${preview ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`, 'Content-Length': file.bytes.length, 'Cache-Control': 'no-store', 'Content-Security-Policy': "sandbox; default-src 'none'", 'X-Artifact-SHA256': file.sha256 });
          return response.end(file.bytes);
        }
        if (url.pathname === '/api/assistant/connection' && request.method === 'POST') {
          const input = connectionSchema.parse(await commandBody(request));
          if (input.epoch !== store.epoch) throw new Fault(409, 'epoch_changed', 'Review this connection after recovery.');
          if (!(gateway instanceof Gateway)) throw new Fault(400, 'injected_gateway', 'This test transport cannot be configured.');
          return json(200, await gateway.configure(input.url, input.token));
        }
        if (url.pathname === '/api/assistant/conversation/recover-settings' && request.method === 'POST') return json(200, await assistant.recoverSettings(device, await commandBody(request)));
        if (url.pathname === '/api/assistant/conversation/fork' && request.method === 'POST') return json(200, await assistant.fork(device, await commandBody(request)));
        if (url.pathname === '/api/assistant/conversations' && request.method === 'POST') return json(200, await assistant.create(device, await commandBody(request)));
        if (url.pathname === '/api/assistant/submit' && request.method === 'POST') {
          if (gateway.status().state === 'unconfigured') throw new Fault(503, 'assistant_unverified', 'Assistant execution is not configured. The draft remains saved; nothing was dispatched.');
          return json(200, assistant.submit(device, await commandBody(request)));
        }
        if (url.pathname === '/api/assistant/conversation/edit' && request.method === 'POST') return json(200, await assistant.edit(device, await commandBody(request)));
        if (url.pathname === '/api/assistant/draft/remove' && request.method === 'POST') return json(200, store.removeDraft(device, await commandBody(request)));
        if (url.pathname === '/api/assistant/draft/organize' && request.method === 'POST') return json(200, store.organizeDraft(device, await commandBody(request)));
        if (url.pathname === '/api/assistant/cancel' && request.method === 'POST') return json(200, await assistant.cancel(device, assistantRequestSchema.extend({ operationId: z.string().uuid() }).strict().parse(await commandBody(request))));
        const historyMatch = /^\/api\/assistant\/history\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (historyMatch && request.method === 'GET') {
          const offset = url.searchParams.has('offset') ? z.coerce.number().int().min(0).parse(url.searchParams.get('offset')) : undefined;
          const messageId = url.searchParams.get('messageId') ?? undefined;
          if (messageId && messageId.length > 1000) throw new Fault(400, 'message_identity', 'This message identity is invalid.');
          return json(200, await assistant.historyForReading(historyMatch[1], { offset, messageId, resume: url.searchParams.get('resume') === '1' }));
        }
        if (url.pathname === '/api/assistant/goal' && request.method === 'POST') return json(200, await assistant.changeGoal(device, await commandBody(request)));
        const goalMatch = /^\/api\/assistant\/goal\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (goalMatch && request.method === 'GET') return json(200, await assistant.goal(goalMatch[1]));
        const reconcileMatch = /^\/api\/assistant\/reconcile\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (reconcileMatch && request.method === 'GET') return json(200, await assistant.reconcile(reconcileMatch[1]));
        throw new Fault(404, 'not_found', 'This operation is unavailable.');
      }
      if (request.method !== 'GET' || !options.clientDirectory) throw new Fault(404, 'not_found', 'Open the Edition 3 client.');
      const root = resolve(options.clientDirectory);
      const path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
      if (path !== root && !path.startsWith(root + sep)) throw new Fault(403, 'path_rejected', 'This path is not available.');
      let file = path;
      try { if (!(await stat(file)).isFile()) file = resolve(root, 'index.html'); } catch { if (extname(path)) throw new Fault(404, 'not_found', 'This file is unavailable.'); file = resolve(root, 'index.html'); }
      const contentType = mime[extname(file)];
      if (!contentType) throw new Fault(404, 'not_found', 'This file is unavailable.');
      const bytes = await readFile(file);
      // The frozen HTML is a template: inject the serving candidate after its
      // hash is known, avoiding a circular build hash or a separate identity fetch.
      const content = file === resolve(root, 'index.html') && options.candidateId
        ? bytes.toString('utf8').replace('<head>', `<head><meta name="e3-candidate" content="${options.candidateId}">`)
        : bytes;
      response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' }); response.end(content);
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) { response.end(); return; }
      if (error instanceof Fault) return json(error.status, { code: error.code, message: error.message, current: error.current });
      if (error instanceof ProviderError) return json(error.code === 'throttled' ? 429 : error.code === 'permission' ? 403 : error.code === 'reconnect' ? 409 : error.code === 'not_found' ? 404 : 503, { code: `account_provider_${error.code}`, message: error.message, ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}) });
      if (error instanceof ZodError) return json(400, { code: 'validation', message: 'Some fields are invalid. Review your entry and try again.', fields: error.issues.map(i => i.path.join('.')) });
      json(500, { code: 'service_error', message: 'The workspace could not complete this operation. Your existing saved work is kept.' });
    } finally { await transferred?.discard(); }
  };
  const dispatch = (surface: 'desktop' | 'phone' | 'web') => (request: IncomingMessage, response: ServerResponse) => {
    const job = handle(request, response, surface); requests.add(job);
    void job.finally(() => requests.delete(job)).catch(() => { if (!response.destroyed) response.destroy(); });
  };
  const phoneHost = new PhoneHost(phoneAccess, dispatch('phone'), options.phonePort, options.phoneTransport);
  const server = createServer(dispatch('desktop'));
  const webServer = options.privateWeb ? createServer(dispatch('web')) : undefined;
  if (webServer) { webServer.requestTimeout = 15000; webServer.headersTimeout = 10000; }
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', () => { server.off('error', reject); accept(); }); }).then(async () => { if (webServer) await new Promise<void>((accept, reject) => { webServer.once('error', reject); webServer.listen(options.privateWeb!.port, '127.0.0.1', () => { webServer.off('error', reject); accept(); }); }); }).catch(async error => { if (server.listening) await new Promise<void>(ok => server.close(() => ok())); if (webServer?.listening) await new Promise<void>(ok => webServer.close(() => ok())); await hubMeetings.close(); await moduleActions.close(); await addressBooks.close(); await phoneHost.close(); await questions.close(); await approvals.close(); await accessControl.close(); await responseControl?.close(); await skillManagement.close(); await calendarGroups.close(); await Promise.all([calendarWrites.close(), mailTriage.close(), mailDelivery.close(), mailIndex.close(), calendar.close(), accounts.close()]); await dictation.close(); await calls.close(); assistant.close(); await assignments.close(); await subtaskSuggestions.close(); if (gateway instanceof Gateway) await gateway.stop(); await transfers.close(); store.close(); throw error; });
  if (!store.recoveryEffectsPaused) { mailIndex.start(); addressBooks.start(); contactCrm.tick();
    assignments.startPolling(); subtaskSuggestions.startPolling();
    agentRoutines.start(); hubMeetings.startPolling(); }
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Unexpected listening address');
  ownOrigin = `http://127.0.0.1:${address.port}`;
  // Resume only after the service owns its listening address. A competing
  // launch that failed to bind must not create another managed process.
  if (!store.recoveryEffectsPaused) { void runtime?.resume(); if (phoneAccess.enabled) void phoneHost.reconcile(); }
  const taskTimer = setInterval(() => { if (store.recoveryEffectsPaused) return; try { store.tickTasks(); calendar.reminders.tick(); } catch { /* Persisted schedules remain retryable on the next tick or snapshot. */ } }, 1000); taskTimer.unref();
  const crmTimer = setInterval(() => { if (store.recoveryEffectsPaused) return; try { contactCrm.tick(); } catch { /* Contact settings and existing Tasks remain available for retry. */ } }, 60000); crmTimer.unref();
  let closePromise: Promise<void> | undefined;
  const close = () => {
    if (closePromise) return closePromise;
    closing = true; clearInterval(taskTimer); clearInterval(crmTimer); agentRoutines.close();
    // Stop admission before closing any authority. Browsers may retain sockets
    // without a complete HTTP request, so idle-connection cleanup is insufficient.
    const httpClosed = new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
    const webClosed = webServer?.listening ? new Promise<void>((accept, reject) => webServer.close(error => error ? reject(error) : accept())) : Promise.resolve();
    const drainTimer = setTimeout(() => { server.closeAllConnections(); webServer?.closeAllConnections(); }, 1000);
    closePromise = (async () => {
      try {
        await backups.close(); await Promise.all([...recoveryServices.values()].map(service => service.close()));
        await hubMeetings.close(); await moduleActions.close(); await addressBooks.close(); await phoneHost.close(); await questions.close(); await approvals.close(); await accessControl.close(); await responseControl?.close(); await skillManagement.close(); await calendarGroups.close(); await Promise.all([calendarWrites.close(), mailTriage.close(), mailDelivery.close(), mailIndex.close(), calendar.close(), accounts.close()]); await dictation.close(); await calls.close(); assistant.close(); await assignments.close(); await subtaskSuggestions.close();
        await signIn?.close(); await chatGptAccount?.close(); await runtime?.stop(); if (gateway instanceof Gateway) await gateway.stop();
      } finally {
        try { await Promise.all([httpClosed, webClosed]); await Promise.allSettled([...requests]); }
        finally { clearTimeout(drainTimer); await transfers.close(); store.close(); }
      }
    })();
    return closePromise;
  };
  return { origin: ownOrigin, privateWebOrigin: webServer?.address() && typeof webServer.address() === 'object' ? `http://127.0.0.1:${(webServer.address() as import('node:net').AddressInfo).port}` : undefined, moduleActions, phoneHost, phoneAccess, store, assistant, approvals, questions, assignments, subtaskSuggestions, agentRoutines, hubMeetings, skillWorkshop, skillManagement, gateway, runtime, calls, accounts, calendar, calendarWrites, calendarGroups, mailIndex, mailDelivery, mailTriage, close };
}
