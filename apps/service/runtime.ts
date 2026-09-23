import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, lstatSync, openSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Fault, Store } from './store.js';
import { Gateway } from './gateway.js';
import { BrowserNetwork } from './browser-network.js';
import { withWorkerPlugin } from './worker-runtime-config.js';
import { withModulePlugin } from './module-runtime-config.js';
import { withSourcePlugin } from './source-runtime-config.js';
import { withAccountPlugin } from './account-runtime-config.js';
import { chatGptProfileIdSchema } from '../../packages/domain/chatgpt-accounts.js';
import type { RuntimeStatus } from '../../packages/domain/runtime.js';
import type { ChatGptSignInMethod } from '../../packages/domain/sign-in.js';
export type { RuntimeStatus } from '../../packages/domain/runtime.js';

type RuntimeConfiguration = { port: number; token: string; entry: string };
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
// Chromium appends its own directory and SingletonSocket to TMPDIR. Recovered
// workspaces can exceed Linux's 108-byte Unix socket limit before that suffix.
export function needsShortRuntimeTemporaryDirectory(root:string,platform:NodeJS.Platform=process.platform){return platform==='linux'&&Buffer.byteLength(join(root,'tmp'))>60;}
/** Owns only Nova Dream's foreground Gateway process. Never uses service install/restart or --force. */
export class ManagedRuntime {
  private child?: ChildProcess;
  private browserNetwork=new BrowserNetwork();
  private shortTemporaryDirectory?:string;
  private launching?: Promise<RuntimeStatus>;
  private generation = 0;
  private stopping = false;
  private stopPromise?: Promise<void>;
  private current: RuntimeStatus = { state: 'stopped', phase: 'idle', message: 'Nova Dream can start its own isolated OpenClaw workspace.', platform: process.platform, managedServiceInstalled: false };
  constructor(private store: Store, private gateway: Pick<Gateway, 'configure' | 'status'>, private readinessTimeoutMs = 45000, private moduleBridge?:()=>{url:string;token:string}) {}
  async configureBrowser(enabled:boolean) {
    if(this.store.recoveryEffectsPaused)throw new Fault(409,'recovery_held','Host browsing is paused in this recovered copy.');
    const root=join(this.store.directory,'openclaw-runtime'),path=join(root,'openclaw.json');
    if(!existsSync(path)||lstatSync(path).isSymbolicLink())throw new Fault(409,'browser_runtime','Start the managed Assistant before enabling its browser.');
    const data=JSON.parse(readFileSync(path,'utf8'));
    const browser=await this.browserConfiguration(data.browser,enabled);
    const next={...data,browser,gateway:{...data.gateway,nodes:{...data.gateway?.nodes,browser:{mode:'off'}}},tools:{...data.tools,deny:[...new Set([...(data.tools?.deny??[]),'browser'])]}};
    const temp=path+'.browser-'+randomBytes(8).toString('hex'),fd=openSync(temp,'wx',0o600);try{writeFileSync(fd,JSON.stringify(next,null,2));fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,path);
  }
  private async browserConfiguration(previous:any,enabled:boolean){
    let port=this.store.internalRead<number>('browser:port');
    if(!port){const socket=createServer();await new Promise<void>((ok,no)=>{socket.once('error',no);socket.listen(0,'127.0.0.1',ok);});const address=socket.address();if(!address||typeof address==='string')throw Error('No browser port');port=address.port;await new Promise<void>(ok=>socket.close(()=>ok()));this.store.internalWrite('browser:port',port);}
    const proxy=await this.browserNetwork.start();this.browserNetwork.enable(enabled);
    // OpenClaw's hostname policy cannot enforce proxy egress. Delegate that
    // boundary to Nova's DNS-pinned public-only proxy, not to the remote page.
    return {enabled:true,defaultProfile:'nova-work',evaluateEnabled:false,ssrfPolicy:{dangerouslyAllowPrivateNetwork:true},extraArgs:[`--proxy-server=${proxy}`,'--proxy-bypass-list=<-loopback>','--disable-quic','--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],profiles:{'nova-work':{cdpPort:port,headless:process.platform==='linux'}}};
  }
  status() {
    const config = this.store.internalRead<RuntimeConfiguration>('runtime:configuration');
    const connection = this.gateway.status();
    const owned = !!config && !!this.child?.pid && !this.child.killed && this.child.exitCode === null && this.child.signalCode === null && connection.url === `ws://127.0.0.1:${config.port}`;
    return { ...this.current, ...(this.current.startedAt ? { elapsedSeconds: Math.max(0, Math.floor(((this.current.readyAt ?? Date.now()) - this.current.startedAt) / 1000)) } : {}), canSignIn: owned && !this.stopping };
  }
  signInCommand(method: ChatGptSignInMethod = 'device-code', profileId = 'openai:edition3-voice'): { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
    chatGptProfileIdSchema.parse(profileId);
    const config = this.store.internalRead<RuntimeConfiguration>('runtime:configuration');
    if (this.stopping || !config || !this.child?.pid || this.child.killed || this.child.exitCode !== null || this.child.signalCode !== null || this.gateway.status().url !== `ws://127.0.0.1:${config.port}`) throw new Fault(409, 'local_runtime_required', 'Start the Assistant on this host before signing in here.');
    const { root, config: configPath } = this.paths();
    return { file: process.execPath, args: [this.entry(), '--profile', 'edition3', 'models', 'auth', 'login', '--agent', 'main', '--provider', 'openai', ...(method === 'browser' ? ['--method', 'oauth'] : ['--device-code']), '--profile-id', profileId], cwd: root, env: this.environment(config, root, configPath) };
  }
  accountCommand() {
    const command = this.signInCommand(); // Same live, owned-host check; no sign-in is executed.
    return { ...command, args: [...command.args.slice(0, 3), 'models', 'auth', 'list', '--agent', 'main', '--provider', 'openai', '--json'] };
  }
  accountOrderCommand() {
    const command = this.accountCommand();
    return { ...command, args: [...command.args.slice(0, 3), 'models', 'auth', 'order', 'get', '--agent', 'main', '--provider', 'openai', '--json'] };
  }
  backupCommand(args: string[]): { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } | undefined {
    const config = this.store.internalRead<RuntimeConfiguration>('runtime:configuration') ?? (['restore', 'verify'].includes(args[0]) ? { port: 1, token: randomBytes(32).toString('hex'), entry: this.entry() } : undefined);
    if (!config) return undefined;
    const { root, config: configPath } = this.paths();
    return { file: process.execPath, args: [this.entry(), '--profile', 'edition3', 'backup', ...args], cwd: root, env: this.environment(config, root, configPath) };
  }
  private entry() {
    const candidates = [process.env.E3_OPENCLAW_ENTRY, '/opt/homebrew/lib/node_modules/openclaw/openclaw.mjs', '/usr/local/lib/node_modules/openclaw/openclaw.mjs', join(dirname(process.execPath), 'node_modules/openclaw/openclaw.mjs'), ...(process.env.APPDATA ? [join(process.env.APPDATA, 'npm/node_modules/openclaw/openclaw.mjs')] : [])].filter((p): p is string => !!p);
    const entry = candidates.find(p => existsSync(p) && p.endsWith('openclaw.mjs'));
    if (!entry) throw new Fault(503, 'openclaw_missing', 'Install OpenClaw on this host or connect a configured private Gateway.');
    const pkg = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8'));
    if (pkg.name !== 'openclaw' || pkg.version !== '2026.9.2') throw new Fault(503, 'openclaw_version', 'This build’s managed runtime requires the verified OpenClaw 2026.9.2 package.');
    return resolve(entry);
  }
  private paths() {
    const root = join(this.store.directory, 'openclaw-runtime');
    const marker = join(root, 'edition3-runtime.identity');
    if (existsSync(root) && (!existsSync(marker) || readFileSync(marker, 'utf8') !== 'edition3-owned-gateway\n')) throw new Fault(409, 'runtime_identity', 'The selected runtime directory is not owned by Nova Dream.');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!existsSync(marker)) writeFileSync(marker, 'edition3-owned-gateway\n', { mode: 0o600, flag: 'wx' });
    for (const directory of ['home', 'state', 'workspace', 'tmp']) mkdirSync(join(root, directory), { recursive: true, mode: 0o700 });
    return { root, config: join(root, 'openclaw.json') };
  }
  private environment(config: RuntimeConfiguration, root: string, configPath: string) {
    // Existing ChatGPT access is consumed only by OpenClaw's supported native login bridge.
    // No ambient provider key, channel token, runtime flag, or old OpenClaw profile is inherited.
    const env: NodeJS.ProcessEnv = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    const temporary=needsShortRuntimeTemporaryDirectory(root)?(this.shortTemporaryDirectory??=mkdtempSync('/tmp/nova-')):join(root,'tmp');
    return { ...env, OPENCLAW_HOME: join(root, 'home'), OPENCLAW_STATE_DIR: join(root, 'state'), OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_WORKSPACE_DIR: join(root, 'workspace'), OPENCLAW_PROFILE: 'edition3', OPENCLAW_GATEWAY_PORT: String(config.port), OPENCLAW_GATEWAY_TOKEN: config.token, OPENCLAW_LOAD_SHELL_ENV: '0', OPENCLAW_EXEC_SHELL_SNAPSHOT: '0', OPENCLAW_NO_AUTO_UPDATE: '1', OPENCLAW_DISABLE_BONJOUR: '1', OPENCLAW_SKIP_CHANNELS: '1', TMPDIR: temporary, TEMP: temporary, TMP: temporary };
  }
  resume() {
    const owned = this.store.internalRead<RuntimeConfiguration>('runtime:configuration');
    const selected = this.store.internalRead<{ url: string; token: string }>('gateway:configuration');
    // The owned configuration comes from an explicit Start; the selected pair
    // is saved only after that runtime became healthy. Reuse that intent, but
    // never replace a later host or credential choice (including the same URL).
    if (!owned || !Number.isInteger(owned.port) || owned.port < 1 || owned.port > 65535 || !owned.token || selected?.url !== `ws://127.0.0.1:${owned.port}` || selected.token !== owned.token) return Promise.resolve(this.status());
    return this.start();
  }
  start() {
    if (this.stopping) return Promise.resolve(this.status());
    if (!this.launching) { const generation = ++this.generation; this.current = { ...this.current, state: 'starting', phase: 'preparing', startedAt: Date.now(), readyAt: undefined, message: 'Preparing this workspace’s Assistant…' }; this.launching = this.launch(generation).finally(() => { this.launching = undefined; }); }
    return this.launching;
  }
  private async launch(generation: number, allowMigrationRestart = true): Promise<RuntimeStatus> {
    const assertCurrent = () => { if (this.stopping || generation !== this.generation) throw new Fault(503, 'runtime_stopped', 'Assistant startup stopped with this workspace service.'); };
    try {
      assertCurrent();
      const selectedConnection = JSON.stringify(this.store.internalRead('gateway:configuration'));
      if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
        const config = this.store.internalRead<RuntimeConfiguration>('runtime:configuration');
        if (!config) throw new Fault(409, 'runtime_configuration_missing', 'The running workspace’s connection details are unavailable. Its process is kept.');
        const url = `ws://127.0.0.1:${config.port}`;
        if (this.gateway.status().state !== 'ready' || this.gateway.status().url !== url) {
          this.current = { ...this.current, phase: 'gateway', message: 'OpenClaw is running. Connecting this workspace…' };
          await this.gateway.configure(url, config.token);
        }
        assertCurrent();
        this.current = { ...this.current, state: 'running', phase: 'ready', readyAt: Date.now(), message: 'Nova Dream’s isolated OpenClaw runtime is running.' };
        return this.status();
      }
      const entry = this.entry(), { root, config: configPath } = this.paths();
      let config = this.store.internalRead<RuntimeConfiguration>('runtime:configuration');
      if (!config) {
        const socket = createServer(); await new Promise<void>((ok, fail) => { socket.once('error', fail); socket.listen(0, '127.0.0.1', ok); });
        const address = socket.address(); if (!address || typeof address === 'string') throw new Error('No local port');
        const port = address.port; await new Promise<void>(ok => socket.close(() => ok()));
        assertCurrent();
        config = { port, token: randomBytes(32).toString('hex'), entry }; this.store.internalWrite('runtime:configuration', config);
      }
      assertCurrent();
      const data = { gateway: { mode: 'local', port: config.port, bind: 'loopback', auth: { mode: 'token' }, tailscale: { mode: 'off' }, controlUi: { enabled: false } }, agents: { defaults: { workspace: join(root, 'workspace'), model: { primary: 'openai/gpt-5.6-sol' }, heartbeat: { every: '0m' } } }, models: { catalogRefresh: { enabled: false } }, plugins: { enabled: true, allow: ['openai', 'codex'], entries: { openai: { enabled: true }, codex: { enabled: true } } }, browser: { enabled: false }, cron: { enabled: false }, telemetry: { enabled: false }, update: { checkOnStart: false, auto: { enabled: false } }, env: { shellEnv: { enabled: false } }, logging: { file: join(root, 'gateway.log'), consoleLevel: 'error' } };
      if (!existsSync(configPath)) writeFileSync(configPath, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
      if (lstatSync(configPath).isSymbolicLink()) throw new Fault(409, 'runtime_config_identity', 'The owned runtime configuration must be a local regular file.');
      const serviceDirectory = dirname(fileURLToPath(import.meta.url));
      const bundlePath = import.meta.url.endsWith('.ts') ? resolve(serviceDirectory, '../../dist/service/apps/service/worker-plugin') : join(serviceDirectory, 'worker-plugin');
      const originalConfig = readFileSync(configPath, 'utf8');
      const parsedConfig = JSON.parse(originalConfig);
      const browserSetting=this.store.internalRead<{epoch:string;enabled:boolean}>('browser:setting');
      const browserEnabled=browserSetting?.epoch===this.store.epoch&&browserSetting.enabled&&!this.store.recoveryEffectsPaused;
      parsedConfig.browser=await this.browserConfiguration(parsedConfig.browser,!!browserEnabled);
      parsedConfig.tools={...parsedConfig.tools,deny:[...new Set([...(parsedConfig.tools?.deny??[]),'browser'])]};
      parsedConfig.gateway={...parsedConfig.gateway,nodes:{...parsedConfig.gateway?.nodes,browser:{mode:'off'}}};
      parsedConfig.plugins = { ...parsedConfig.plugins, allow:[...new Set([...(parsedConfig.plugins?.allow??[]),'browser'])], entries:{...parsedConfig.plugins?.entries,browser:{...parsedConfig.plugins?.entries?.browser,enabled:true}} };
      const stagedConfig = withAccountPlugin(withSourcePlugin(withWorkerPlugin(parsedConfig, this.store.epoch, bundlePath, join(root, 'assignment-receipts')), this.store.epoch, join(dirname(bundlePath), 'source-plugin'), join(root, 'source-cache')), this.store.epoch, join(dirname(bundlePath), 'account-plugin'), entry);
      const sessionBindings = this.store.internalList<import('../../packages/domain/assistant.js').Conversation>('assistant:conversation:').flatMap(conversation => conversation.nativeId && !conversation.deleted ? [{nativeKey:conversation.nativeKey,nativeId:conversation.nativeId}] : []);
      const updatedConfig = JSON.stringify(this.moduleBridge ? withModulePlugin(stagedConfig,this.store.epoch,join(dirname(bundlePath),'module-plugin'),{...this.moduleBridge(),sessionBindings}) : stagedConfig,null,2);
      if (JSON.stringify(JSON.parse(originalConfig)) !== JSON.stringify(JSON.parse(updatedConfig))) {
        // The old path and replacement are recorded in the same atomic config
        // write. A service crash cannot leave a forgotten duplicate plugin path.
        const temporary = `${configPath}.edition3-${randomBytes(8).toString('hex')}`;
        const fd = openSync(temporary, 'wx', 0o600);
        try { writeFileSync(fd, updatedConfig); fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(temporary, configPath);
        if (process.platform !== 'win32') { const folder = openSync(root, 'r'); try { fsyncSync(folder); } finally { closeSync(folder); } }
      }
      this.current = { ...this.current, state: 'starting', phase: 'process', message: 'Starting the isolated Nova Dream OpenClaw runtime…' };
      let log = '';
      const ownerEntry = join(serviceDirectory, import.meta.url.endsWith('.ts') ? 'runtime-child.ts' : 'runtime-child.js');
      // Keep the verified CLI in the IPC-owned process. Native respawning would
      // detach its lifetime from that descriptor. Supply its Windows stack flag
      // here; disable ambient compile-cache respawns in this managed launch only.
      const child = spawn(process.execPath, [...(process.platform === 'win32' ? ['--stack-size=8192'] : []), ownerEntry, entry, '--profile', 'edition3', 'gateway', 'run', '--port', String(config.port), '--bind', 'loopback', '--auth', 'token', '--tailscale', 'off'], { cwd: root, env: { ...this.environment(config, root, configPath), OPENCLAW_NO_RESPAWN: '1', NODE_DISABLE_COMPILE_CACHE: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, shell: false });
      this.child = child;
      const append = (buffer: Buffer) => { log = (log + buffer.toString()).slice(-500000); };
      child.stdout?.on('data', append); child.stderr?.on('data', append);
      child.on('error', () => { if (this.child === child) this.current = { ...this.current, state: 'error', phase: 'failed', message: 'The isolated OpenClaw process could not start.' }; });
      child.on('exit', () => { writeFileSync(join(root, 'startup.log'), log.replaceAll(config!.token, '[redacted]'), { mode: 0o600 }); if (this.child === child) this.current = { ...this.current, state: 'stopped', phase: 'idle', message: 'The Nova Dream runtime stopped. Existing apps are separate.' }; });
      const deadline = Date.now() + this.readinessTimeoutMs;
      while (true) {
        assertCurrent();
        if (child.exitCode !== null || child.signalCode !== null) {
          // OpenClaw installs its pinned Codex plugin into this new profile on
          // first launch, then explicitly requires one convergence restart.
          if (allowMigrationRestart && log.includes('OpenClaw plugin migration inputs changed during startup convergence')) return this.launch(generation, false);
          throw new Fault(503, 'runtime_start', 'OpenClaw could not start this isolated runtime. Review its local setup.');
        }
        let healthy = false;
        try { healthy = (await fetch(`http://127.0.0.1:${config.port}/healthz`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* Retry observation, never another process launch. */ }
        assertCurrent();
        if (healthy) {
          this.current = { ...this.current, state: 'starting', phase: 'gateway', message: 'OpenClaw is running. Connecting this workspace…' };
          // A later explicit connection choice takes precedence over this
          // pending launch, including a credential change on the same host.
          if (JSON.stringify(this.store.internalRead('gateway:configuration')) === selectedConnection) {
            const connection = this.gateway.status(), url = `ws://127.0.0.1:${config.port}`;
            if (connection.state !== 'ready' || connection.url !== url) await this.gateway.configure(url, config.token);
          }
          assertCurrent(); this.current = { ...this.current, state: 'running', phase: 'ready', readyAt: Date.now(), message: 'Nova Dream’s isolated OpenClaw runtime is running.' }; return this.status();
        }
        const slow = Date.now() >= deadline;
        if (slow) this.current = { ...this.current, message: 'OpenClaw is taking longer to start. Still checking this workspace’s process…' };
        // The observation deadline is not a process failure. Keep one launch
        // pending until readiness, exit or explicit stop; never spawn a retry.
        await delay(slow ? 2000 : 300);
      }
    } catch (error) { if (this.stopping || generation !== this.generation) { this.current = { ...this.current, state: 'stopped', phase: 'idle', message: 'Assistant startup stopped with this workspace service.' }; return this.status(); } this.current = { ...this.current, state: error instanceof Fault && error.code === 'openclaw_missing' ? 'unavailable' : 'error', phase: 'failed', message: error instanceof Fault ? error.message : 'Isolated OpenClaw setup failed.' }; return this.status(); }
  }
  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true; ++this.generation;
    const child = this.child, launching = this.launching;
    this.current = { ...this.current, state: 'stopped', phase: 'stopping', message: 'Stopping this workspace’s Assistant runtime…' };
    this.stopPromise = (async () => {
      try {
        await this.browserNetwork.close();
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = new Promise<void>(ok => {
            const done = () => { clearTimeout(timer); child.off('exit', done); ok(); };
            const timer = setTimeout(done, 5000); child.once('exit', done);
          });
          child.kill('SIGTERM'); await exited;
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            await new Promise<void>(ok => { if (child.exitCode !== null || child.signalCode !== null) ok(); else child.once('exit', () => ok()); });
          }
        }
        // A launch may be waiting for its port, readiness response or Gateway
        // configuration. Its generation fence prevents later spawn/restart/write.
        await launching;
      } finally {
        if(this.shortTemporaryDirectory){rmSync(this.shortTemporaryDirectory,{recursive:true,force:true});this.shortTemporaryDirectory=undefined;}
        this.child = undefined; this.stopping = false; this.stopPromise = undefined;
        this.current = { ...this.current, state: 'stopped', phase: 'idle', message: 'The Nova Dream runtime stopped. Existing apps are separate.' };
      }
    })();
    return this.stopPromise;
  }
}
