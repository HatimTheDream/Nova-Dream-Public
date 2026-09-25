"""Reviewed Linux paired update driver; fixed entry invoked with --request.

No operation runs on import. This driver deliberately supports unchanged
app dependencies and schema55 only. Optional runtime closures are immutable,
offline packages; no package manager, download or release selection runs here.
"""
import ast
import contextlib
import fcntl
import hashlib
import http.client
import http.cookiejar
import json
import os
import pathlib
import re
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import time
import urllib.request
import uuid

sys.dont_write_bytecode = True
from recovery import (ALLOWANCE, RESERVE, InsufficientStorage, capacity, digest, inventory, prepare_independent,
                      require, saved_state, native_scope, native_preflight, native_saved_state, snapshot_closed, sync_dir, write_json)

SOCKET = '/run/nova-update/control.sock'
ENGINE = '2026.9.2'
ENGINES = {'2026.9.2', '2026.9.6'}
MAXIMUM = 128 * 1024 ** 2
RUNTIME_MAXIMUM = 512 * 1024 ** 2
RUNTIME_EXPANDED_MAXIMUM = 2 * 1024 ** 3
NATIVE_MIGRATION = r'''
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const root=process.argv[1], paths=JSON.parse(process.argv[2]);
const load=name=>import(pathToFileURL(join(root,'dist',name)).href);
const {withDoctorSqliteMaintenanceLock}=await load('doctor-sqlite-maintenance-lock-8wr_GXh1.mjs');
const {repairOpenClawStateDatabaseSchema,closeOpenClawStateDatabaseAsync}=await load('openclaw-state-db-quM4UOZq.mjs');
const {withAgentDatabaseMaintenanceLease,migrateOpenClawAgentDatabaseForMaintenance,closeOpenClawAgentDatabasesAsync}=await load('openclaw-agent-db-BrZi20Hq.mjs');
await withDoctorSqliteMaintenanceLock({env:process.env,operation:'reviewed Nova engine migration',protectedPaths:[join(process.env.OPENCLAW_STATE_DIR,'state','openclaw.sqlite'),...paths.map(x=>x.path)],run:async()=>{
 const report=repairOpenClawStateDatabaseSchema({env:process.env});
 if(report.warnings.length)throw Error('Shared schema migration was refused');
 await withAgentDatabaseMaintenanceLease({env:process.env},async maintenance=>{
  for(const entry of paths)await migrateOpenClawAgentDatabaseForMaintenance({agentId:entry.agentId,pathname:entry.path},maintenance);
 });
 await closeOpenClawAgentDatabasesAsync();
 await closeOpenClawStateDatabaseAsync();
}});
'''
CODEX_SURFACE = 'd05cd8ba6d0e24e4e81ec442be300da755d818c74be47885f65932a1d5622801'
CODEX_INSTALL = r'''
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const root=process.argv[1], plugin=process.argv[2], surface=process.argv[3];
const load=name=>import(pathToFileURL(join(root,'dist',name)).href);
const {c:readConfigFileSnapshot}=await load('io.runtime-hPN4FOBi.mjs');
const {installManagedPluginSource}=await load('management-install-DV30z_Uq.mjs');
const {r:loadRecords}=await load('installed-plugin-index-record-reader-B3UvF50J.mjs');
const {a:detectHealth}=await load('missing-configured-plugin-install-CFxe2oL4.mjs');
const {r:replaceConfigFile}=await load('mutate-CgnqHZzJ.mjs');
const {n:refreshPluginRegistry}=await load('registry-refresh-CrMs7Cpq.mjs');
const {n:discoverPlugins}=await load('discovery-D_5mAUI7.mjs');
const {closeOpenClawStateDatabaseAsync}=await load('openclaw-state-db-quM4UOZq.mjs');
try {
 const before=await loadRecords();
 if(!before.codex || before.codex.version!=='2026.9.2')throw Error('The original Codex companion changed');
 const originalConfig=JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH,'utf8'));
 const snapshot=await readConfigFileSnapshot();
 const result=await installManagedPluginSource({
  snapshot:{config:snapshot.sourceConfig??snapshot.config,baseHash:snapshot.hash,writeOptions:{}},env:process.env,
  request:{source:'local',recordSource:'path',path:plugin,link:true,mode:'update'},
  onCapabilityConsent:async review=>{
   if(review.pluginId!=='codex'||review.reviewToken!==surface)throw Error('Unreviewed Codex capability surface');
   return {reviewToken:surface};
  },
  // Nova owns the stopped-service transition. Retain the old package for
  // paired recovery; upstream marks that former managed payload as retained.
  deferRuntime:{record:value=>{if(value.operation!=='install'||value.pluginId!=='codex')throw Error('Unexpected plugin operation')},deferCleanup:()=>{}},
  runtime:{log:()=>{},error:()=>{},exit:()=>{throw Error('Companion install stopped')}},
  logger:{info:()=>{},warn:()=>{},error:()=>{}}
 });
 if(!result.ok)throw Error('The offline Codex companion was not installed');
 const after=await loadRecords(), record=after.codex;
 if(record.source!=='path'||record.installPath!==plugin||record.sourcePath!==plugin||record.version!=='2026.9.6'||record.acceptedSurfaceHash!==surface)throw Error('The Codex install record did not verify');
 for(const [id,record] of Object.entries(before))if(id!=='codex'&&JSON.stringify(record)!==JSON.stringify(after[id]))throw Error('An unrelated plugin record changed');
 if(Object.keys(before).length!==Object.keys(after).length)throw Error('The plugin inventory changed');
 const config=JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH,'utf8'));
 // The installed index already discovers this payload. Keep Nova's existing
 // generated-plugin path admission unchanged instead of adding a load path.
 if(originalConfig.plugins?.load===undefined)delete config.plugins.load;
 else config.plugins.load=structuredClone(originalConfig.plugins.load);
 const current=await readConfigFileSnapshot();
 await replaceConfigFile({nextConfig:config,baseHash:current.hash,writeOptions:{afterWrite:{mode:'none',reason:'Nova updater owns the stopped-service restart'}}});
 await refreshPluginRegistry({configPath:process.env.OPENCLAW_CONFIG_PATH,reason:'source-changed',installRecords:after});
 const finalConfig=JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH,'utf8'));
 if(JSON.stringify(finalConfig.plugins?.load)!==JSON.stringify(originalConfig.plugins?.load))throw Error('Plugin path admission changed');
 const candidates=discoverPlugins({config:finalConfig,installRecords:after}).candidates.filter(candidate=>candidate.rootDir===plugin||candidate.packageDir===plugin);
 if(candidates.length!==1||candidates[0].origin!=='global')throw Error('The installed Codex payload was not discovered');
 const issues=await detectHealth({cfg:finalConfig,env:process.env});
 if(issues.some(issue=>issue.pluginId==='codex'))throw Error('The Codex companion still requires repair');
 console.log(JSON.stringify({companionInstalled:true,pluginVersion:'2026.9.6',codexVersion:'0.155.1'}));
} finally { await closeOpenClawStateDatabaseAsync(); }
process.exit(0);
'''
STARTUP_FILES = {'dist/service/apps/service/http.js', 'dist/service/apps/service/store.js',
                 'dist/service/apps/service/software-updates.js', 'dist/service/apps/service/runtime.js',
                 'dist/service/apps/service/update-native-startup.js', 'dist/service/apps/service/update-native-idle.js',
                 'dist/service/apps/service/gateway.js', 'dist/service/apps/service/update-maintenance.js'}


def protected(path, directory=False, private=False):
    require(path.is_absolute() and path.resolve(strict=True) == path, 'A protected path was redirected.')
    for current in (path, *path.parents):
        info = current.lstat()
        require(not stat.S_ISLNK(info.st_mode) and info.st_uid == 0 and not stat.S_IMODE(info.st_mode) & 0o022,
                'An update authority path is not protected by root.')
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode), 'Unexpected update path type.')
    require(not private or not stat.S_IMODE(info.st_mode) & 0o077, 'Private update evidence is not private.')


def read_json(path, maximum=1024 * 1024):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and not path.is_symlink() and info.st_size <= maximum, 'Invalid bounded update JSON file.')
    return json.loads(path.read_bytes())


def protected_selector(path, root, directory):
    """Only the final, root-owned selector may be a symlink."""
    protected(path.parent, True)
    require(path.is_symlink() and path.lstat().st_uid == 0, 'The runtime selector is not owned by root.')
    selected = path.resolve(strict=True)
    require(selected.is_relative_to(root) and selected != root, 'The runtime selector escaped its protected root.')
    protected(selected, directory)
    return selected


def runtime_members(archive_path, description):
    with tarfile.open(archive_path, 'r:gz') as archive:
        members, expanded = [], 0
        for member in archive:
            expanded += member.size
            require(len(members) < 100000 and expanded <= RUNTIME_EXPANDED_MAXIMUM, 'Reviewed runtime expansion exceeded its bound.')
            members.append(member)
    require(1 <= len(members) == description['fileCount'] <= 100000
            and sum(member.size for member in members) == description['expandedBytes'] <= RUNTIME_EXPANDED_MAXIMUM,
            'Reviewed runtime expansion exceeded its bound.')
    names, links = set(), set()
    for member in members:
        name = member.name
        parts = name.split('/')
        require(name not in names and all(part not in ('', '.', '..') for part in parts)
                and not pathlib.PurePosixPath(name).is_absolute()
                and parts[0] in {'node', 'node_modules', 'package.json', 'package-lock.json', 'companions'}
                and (parts[0] != 'companions' or len(parts) == 1 or parts[1] == 'codex')
                and (member.isdir() or member.isfile() or member.issym()) and not member.islnk(),
                'Unsafe reviewed runtime archive entry.')
        require(not any('/'.join(parts[:index]) in links for index in range(1, len(parts))), 'Runtime entry follows an archive symlink.')
        names.add(name)
        if member.issym():
            require(member.linkname and not pathlib.PurePosixPath(member.linkname).is_absolute(), 'Runtime link is not internal.')
            resolved = list(parts[:-1])
            for part in member.linkname.split('/'):
                if part == '..':
                    require(resolved, 'Runtime link escaped its closure.')
                    resolved.pop()
                elif part not in ('', '.'):
                    resolved.append(part)
            require(resolved, 'Runtime link points outside its closure.')
            links.add(name)
    require(not any(any(name.startswith(link + '/') for name in names) for link in links), 'Runtime archive traverses a link.')
    require({'node/bin/node', 'node_modules/openclaw/package.json', 'node_modules/openclaw/openclaw.mjs',
             'package.json', 'package-lock.json'} <= names, 'The offline runtime closure is incomplete.')
    if description.get('companion') is not None:
        require({'companions/codex/package-lock.json', 'companions/codex/node_modules/openclaw',
                 'companions/codex/node_modules/@openclaw/codex/package.json',
                 'companions/codex/node_modules/@openclaw/codex/openclaw.plugin.json',
                 'companions/codex/node_modules/@openai/codex/package.json',
                 'companions/codex/node_modules/@openai/codex-linux-x64/package.json',
                 'companions/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'} <= names,
                'The offline Codex companion is incomplete.')
    return members


def candidate(directory, expected, version):
    protected(directory, True)
    for name in ('package.json', 'dist/candidate.json'):
        protected(directory / name)
    package_bytes, manifest_bytes = (directory / 'package.json').read_bytes(), (directory / 'dist/candidate.json').read_bytes()
    package, manifest = json.loads(package_bytes), json.loads(manifest_bytes)
    require(hashlib.sha256(package_bytes + manifest_bytes).hexdigest() == expected, 'The selected candidate identity changed.')
    require(package['name'] == 'nova-dream-edition-3' and package['version'] == version and package['edition3']['schemaVersion'] == 55,
            'The candidate is outside this reviewed app-only compatibility route.')
    for name in ('version', 'buildVersion', 'schemaVersion', 'apiVersion', 'appId'):
        require(manifest[name] == (package['version'] if name == 'version' else package['edition3'][name]), 'Paired candidate metadata differs.')
    artifacts = manifest['artifacts']
    require(isinstance(artifacts, list) and 1 <= len(artifacts) <= 5000, 'Invalid candidate artifact count.')
    seen = set()
    for artifact in artifacts:
        name = artifact['path']
        require(re.fullmatch(r'dist/(client|service|desktop)/[a-zA-Z0-9_./-]+', name)
                and all(part not in ('', '.', '..') for part in name.split('/')) and name not in seen, 'Invalid candidate artifact path.')
        seen.add(name)
        protected(directory / name)
        require(digest(directory / name) == artifact['sha256'], 'Candidate artifact bytes changed.')
    require({'dist/client/index.html', 'dist/service/apps/service/main.js'} <= seen, 'The candidate does not contain the paired app.')
    return manifest


class LocalSocket(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(SOCKET)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError('Unexpected redirect from local acceptance.')


class Driver:
    def __init__(self, request_path):
        self.request_path = request_path
        self.output = request_path.parent
        self.bundle = pathlib.Path(__file__).resolve().parent
        self.stop_attempted = False
        self.switched = False
        self.switch_attempted = False
        self.workspace_mutated = False
        self.result_publication_started = False
        self.stdout_open = True
        self.before = None
        self.launched = None
        self.runtime = None
        self.active_engine = None

    def stage(self, stage):
        if not self.stdout_open:
            return
        try:
            print(json.dumps({'stage': stage}), flush=True)
        except BrokenPipeError:
            # The external attempt owns recovery even if its controller restarts.
            self.stdout_open = False
            sys.stdout = open(os.devnull, 'w')

    def validate(self):
        require(sys.platform == 'linux' and os.geteuid() == 0, 'Use the provisioned Linux update host.')
        protected(self.request_path, private=True)
        protected(self.output, True, True)
        self.request = read_json(self.request_path)
        require(set(self.request) == {'format', 'jobId', 'release', 'hostConfiguration'} and self.request['format'] == 1, 'Unexpected installation request.')
        self.job_id = str(uuid.UUID(self.request['jobId']))
        require(self.job_id == self.request['jobId'] and self.output.name == self.job_id, 'The attempt directory does not match its receipt.')
        self.release = self.request['release']
        self.target_id, self.prior_id = self.release['candidateId'], self.release['fromCandidateId']
        require(all(re.fullmatch('[a-f0-9]{64}', value) for value in (self.target_id, self.prior_id)), 'Invalid exact candidate pair.')
        compatibility = self.release['compatibility']
        self.from_engine, self.to_engine = compatibility['fromAgentVersion'], self.release['agentVersion']
        self.active_engine = self.from_engine
        require(self.from_engine in ENGINES and self.to_engine in ENGINES
                and (self.from_engine == self.to_engine or (self.from_engine, self.to_engine) == ('2026.9.2', '2026.9.6'))
                and (self.target_id != self.prior_id or self.from_engine != self.to_engine)
                and compatibility['fromSchemaVersion'] == compatibility['toSchemaVersion'] == 55
                and compatibility['reviewed'] is True and compatibility['gatewayProtocol'] == 4
                and compatibility['pluginVersion'] == self.release['novaVersion'], 'This runner does not qualify this app and engine pair.')
        host_path = pathlib.Path(self.request['hostConfiguration'])
        protected(host_path)
        self.host = read_json(host_path, 65536)
        runner_path = host_path.with_name('runner.json')
        protected(runner_path, private=True)
        self.settings = read_json(runner_path, 65536)
        require(set(self.settings) == {'format', 'serviceName', 'serviceUser', 'nodePath', 'healthPort', 'dependencyDirectory', 'recoveryDirectory', 'baselineDirectory', 'protectedFiles'}
                and self.settings['format'] == 1, 'Unexpected reviewed host runner configuration.')
        require(re.fullmatch(r'[a-zA-Z0-9_-]+\.service', self.settings['serviceName'])
                and re.fullmatch('[a-z_][a-z0-9_-]{0,31}', self.settings['serviceUser'])
                and isinstance(self.settings['healthPort'], int) and 1024 <= self.settings['healthPort'] <= 65535, 'Invalid local service identity.')
        self.data = pathlib.Path(self.host['workspaceDirectory'])
        self.releases = pathlib.Path(self.host['releaseDirectory'])
        self.current = pathlib.Path(self.host['appCurrent'])
        self.agent = pathlib.Path(self.host['agentDirectory'])
        self.runtime_root = pathlib.Path(self.host['runtimeDirectory'])
        self.dependencies = pathlib.Path(self.settings['dependencyDirectory'])
        self.recovery_root = pathlib.Path(self.settings['recoveryDirectory'])
        self.node = pathlib.Path(self.settings['nodePath'])
        for path in (self.releases, self.runtime_root, self.dependencies, self.recovery_root):
            protected(path, True)
        if self.agent.is_symlink():
            self.prior_agent = protected_selector(self.agent, self.runtime_root, True)
        else:
            protected(self.agent, True)
            self.prior_agent = self.agent
        self.agent_node = pathlib.Path(self.host.get('agentNodePath', str(self.node)))
        if self.agent_node.is_symlink():
            self.prior_agent_node = protected_selector(self.agent_node, self.runtime_root, False)
        else:
            protected(self.agent_node)
            self.prior_agent_node = self.agent_node
        protected(self.node)
        require(self.data.resolve(strict=True) == self.data and self.data.is_dir() and not self.data.is_symlink(), 'Workspace path changed.')
        require(not self.recovery_root.is_relative_to(self.data) and not self.data.is_relative_to(self.recovery_root), 'Recovery must be outside live workspace replacement.')
        require(self.recovery_root.stat().st_dev == self.data.stat().st_dev == self.data.parent.stat().st_dev, 'Recovery and workspace must share the reviewed filesystem.')
        require(self.current.is_symlink() and self.current.lstat().st_uid == 0, 'The selected release pointer is not owned by root.')
        self.prior = self.current.resolve(strict=True)
        require(self.prior.parent == self.releases, 'Selected release is outside its protected root.')
        self.prior_manifest = candidate(self.prior, self.prior_id, compatibility['fromNovaVersion'])
        self.target = self.prior if self.target_id == self.prior_id else self.releases / (self.release['novaVersion'] + '-' + self.target_id[:12])
        self.recovery = self.recovery_root / ('update-' + self.job_id)
        self.restore = self.data.parent / ('workspace.restore-' + self.job_id)
        self.failed = self.recovery / 'failed-workspace'
        self.baseline = pathlib.Path(self.settings['baselineDirectory'])
        latest = self.recovery_root / 'latest-update.json'
        if latest.exists():
            protected(latest, private=True)
            selected = read_json(latest, 4096)
            require(selected['candidateId'] == self.prior_id and selected.get('agentVersion', ENGINE) == self.from_engine,
                    'Latest recovery acceptance does not match the installed pair.')
            self.baseline = pathlib.Path(selected['directory'])
        protected(self.baseline, True, True)
        require(self.baseline.parent == self.recovery_root, 'Recovery baseline is outside the reviewed root.')
        acceptance = read_json(self.baseline / 'acceptance.json')
        require(acceptance['health']['candidateId'] == self.prior_id and acceptance.get('agentVersion', ENGINE) == self.from_engine,
                'The recovery baseline is not paired with the installed candidate and engine.')
        manifest_file = self.baseline / ('snapshot-manifest.json' if (self.baseline / 'snapshot-manifest.json').exists() else 'linked-snapshot-source.json')
        verified = read_json(self.baseline / 'snapshot-verified.json')
        require(digest(manifest_file) == verified['manifestSha256'], 'The recovery baseline verification changed.')
        self.baseline_entries = read_json(manifest_file, 64 * 1024 ** 2)
        require(inventory(self.baseline / 'workspace')[0] == self.baseline_entries, 'The verified closed baseline changed.')
        self.pair = read_json(self.bundle / 'reviewed-pair.json', 65536)
        require({'format', 'candidateId', 'priorCandidateId', 'archiveBytes', 'archiveSha256'} <= set(self.pair)
                and set(self.pair) <= {'format', 'candidateId', 'priorCandidateId', 'archiveBytes', 'archiveSha256', 'startupBarrier', 'runtime'}
                and self.pair['format'] == 1 and self.pair['candidateId'] == self.target_id and self.pair['priorCandidateId'] == self.prior_id,
                'The reviewed archive does not identify this exact pair.')
        self.archive = self.bundle / 'app.tgz'
        protected(self.archive, private=True)
        require(self.archive.stat().st_size == self.pair['archiveBytes'] <= MAXIMUM and digest(self.archive) == self.pair['archiveSha256'], 'Reviewed application archive changed.')
        self.validate_runtime()
        self.config_files = [pathlib.Path(value) for value in self.settings['protectedFiles']]
        require(1 <= len(self.config_files) <= 16 and len(set(self.config_files)) == len(self.config_files), 'Invalid protected host configuration set.')
        for path in self.config_files:
            protected(path)
            require(not path.is_relative_to(self.data) and not path.is_relative_to(self.releases), 'Host protection files must remain outside replacements.')
        self.config_hashes = {str(path): digest(path) for path in self.config_files}
        self.agent_identity = inventory(self.prior_agent)[0]
        require(read_json(self.prior_agent / 'package.json')['version'] == self.from_engine, 'The installed agent version changed.')
        self.agent_node_hash = digest(self.prior_agent_node)
        self.runtime_node_hash = digest(self.node)
        self.dependency_identity = inventory(self.dependencies)[0]
        self.origin = 'http://127.0.0.1:' + str(self.settings['healthPort'])
        self.client = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.client_candidate = None
        require(not (self.output / 'result.json').exists() and not (self.output / 'driver-attempt.json').exists(), 'The original runner attempt must be reconciled, never repeated.')
        write_json(self.output / 'driver-attempt.json', {'jobId': self.job_id, 'candidateId': self.target_id, 'priorCandidateId': self.prior_id})

    def validate_runtime(self):
        runtime = self.pair.get('runtime')
        signed = self.release.get('runtimeBundle')
        require((runtime is None) == (signed is None), 'The runtime archive is not bound to the signed release.')
        if runtime is None:
            require(self.from_engine == self.to_engine, 'An engine upgrade requires its reviewed offline runtime closure.')
            return
        require(set(runtime) == {'format', 'fromVersion', 'toVersion', 'archiveBytes', 'archiveSha256',
                                 'expandedBytes', 'fileCount', 'nodeVersion', 'nodeSha256', 'companion'}
                and runtime['format'] == 1 and runtime['fromVersion'] == self.from_engine
                and runtime['toVersion'] == self.to_engine and self.from_engine != self.to_engine
                and runtime['nodeVersion'] == '24.21.0'
                and all(re.fullmatch('[a-f0-9]{64}', runtime[key]) for key in ('archiveSha256', 'nodeSha256'))
                and all(type(runtime[key]) is int and runtime[key] > 0 for key in ('archiveBytes', 'expandedBytes', 'fileCount'))
                and runtime['archiveBytes'] == signed['bytes'] <= RUNTIME_MAXIMUM
                and runtime['archiveSha256'] == signed['sha256'], 'The reviewed runtime does not match this signed pair.')
        companion = runtime['companion']
        require(isinstance(companion, dict) and set(companion) == {'pluginVersion', 'codexVersion', 'packageLockSha256', 'binarySha256'}
                and companion['pluginVersion'] == '2026.9.6' and companion['codexVersion'] == '0.155.1'
                and all(isinstance(companion[key], str) and re.fullmatch('[a-f0-9]{64}', companion[key])
                        for key in ('packageLockSha256', 'binarySha256')), 'The runtime companion is outside this reviewed pair.')
        require(self.agent.is_symlink() and self.agent_node.is_symlink() and self.agent != self.agent_node,
                'Runtime replacement requires separately provisioned root-owned selectors.')
        self.runtime = runtime
        self.runtime_archive = self.bundle / 'runtime.tgz'
        protected(self.runtime_archive, private=True)
        require(self.runtime_archive.stat().st_size == runtime['archiveBytes'] and digest(self.runtime_archive) == runtime['archiveSha256'],
                'The downloaded runtime archive changed.')
        self.runtime_archive_members = runtime_members(self.runtime_archive, runtime)
        self.runtime_target = self.runtime_root / 'managed-updates' / ('openclaw-' + self.to_engine + '-' + runtime['archiveSha256'][:12])
        self.target_agent = self.runtime_target / 'node_modules' / 'openclaw'
        self.target_agent_node = self.runtime_target / 'node' / 'bin' / 'node'
        self.target_codex = self.runtime_target / 'companions' / 'codex' / 'node_modules' / '@openclaw' / 'codex'

    def runtime_storage_required(self):
        if self.runtime is None:
            return 0
        if self.runtime_target.exists() or self.runtime_target.is_symlink():
            # Only the complete signed closure can receive an allocation credit.
            # Partial, redirected or altered retained staging fails verification.
            self.verify_staged_runtime()
            return 0
        return self.runtime['expandedBytes'] + self.runtime['fileCount'] * 4096

    def stage_runtime(self):
        if self.runtime is None:
            return
        if not self.runtime_target.parent.exists():
            self.runtime_target.parent.mkdir(mode=0o755)
        protected(self.runtime_target.parent, True)
        # The private runner umask must not hide public runtime packages from
        # the service user. Validate root ownership before repairing either a
        # fresh parent or one retained after an interrupted staging attempt.
        self.runtime_target.parent.chmod(0o755)
        if self.runtime_target.exists() or self.runtime_target.is_symlink():
            self.verify_staged_runtime()
            return
        self.runtime_target.mkdir(mode=0o755)
        with tarfile.open(self.runtime_archive, 'r:gz') as archive:
            for member in self.runtime_archive_members:
                destination = self.runtime_target / member.name
                destination.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                if member.isdir():
                    destination.mkdir(mode=0o755, exist_ok=True)
                elif member.issym():
                    destination.symlink_to(member.linkname)
                else:
                    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o755 if member.mode & 0o111 else 0o644)
                    with os.fdopen(descriptor, 'wb') as output, archive.extractfile(member) as source:
                        shutil.copyfileobj(source, output)
                        output.flush()
                        os.fsync(output.fileno())
        self.runtime_target.chmod(0o755)
        for destination in self.runtime_target.rglob('*'):
            if destination.is_symlink():
                require(destination.resolve(strict=True).is_relative_to(self.runtime_target), 'Extracted runtime link escaped its closure.')
            else:
                destination.chmod(0o755 if destination.is_dir() or destination.stat().st_mode & 0o111 else 0o644)
        self.verify_staged_runtime()
        sync_dir(self.runtime_target)

    def verify_staged_runtime(self):
        protected(self.runtime_target, True)
        expected = {'.'}
        with tarfile.open(self.runtime_archive, 'r:gz') as archive:
            for member in self.runtime_archive_members:
                destination = self.runtime_target / member.name
                expected.add(member.name)
                expected.update(parent.as_posix() for parent in pathlib.PurePosixPath(member.name).parents)
                info = destination.lstat()
                require(info.st_uid == 0 and (member.issym() or not stat.S_IMODE(info.st_mode) & 0o022), 'Staged runtime is writable outside root.')
                if member.issym():
                    require(destination.is_symlink() and os.readlink(destination) == member.linkname
                            and destination.resolve(strict=True).is_relative_to(self.runtime_target), 'Staged runtime link changed.')
                elif member.isdir():
                    protected(destination, True)
                else:
                    protected(destination)
                    with archive.extractfile(member) as source:
                        require(digest(destination) == hashlib.file_digest(source, 'sha256').hexdigest()
                                and bool(info.st_mode & 0o111) == bool(member.mode & 0o111), 'Staged runtime file changed.')
        require({'.'} | {path.relative_to(self.runtime_target).as_posix() for path in self.runtime_target.rglob('*')} == expected,
                'The runtime closure contains unreviewed files.')
        protected(self.target_agent, True)
        protected(self.target_agent_node)
        package = read_json(self.target_agent / 'package.json')
        require(package.get('name') == 'openclaw' and package.get('version') == self.to_engine
                and digest(self.target_agent_node) == self.runtime['nodeSha256'], 'The runtime closure contains a different engine or Node binary.')
        self.verify_codex_companion()
        self.verify_runtime_execution()
        self.target_runtime_identity = inventory(self.runtime_target)[0]

    def verify_codex_companion(self):
        root = self.runtime_target / 'companions' / 'codex'
        description = self.runtime['companion']
        require(digest(root / 'package-lock.json') == description['packageLockSha256'], 'The Codex dependency lock changed.')
        for relative, name, version in [('@openclaw/codex', '@openclaw/codex', description['pluginVersion']),
                                        ('@openai/codex', '@openai/codex', description['codexVersion']),
                                        ('@openai/codex-linux-x64', '@openai/codex', description['codexVersion'] + '-linux-x64')]:
            package = read_json(root / 'node_modules' / relative / 'package.json')
            require(package.get('name') == name and package.get('version') == version, 'The Codex companion package changed.')
        link = root / 'node_modules' / 'openclaw'
        require(link.is_symlink() and os.readlink(link) == '../../../node_modules/openclaw'
                and link.resolve(strict=True) == self.target_agent, 'The Codex SDK link does not select the reviewed engine.')
        self.target_codex_binary = root / 'node_modules' / '@openai' / 'codex-linux-x64' / 'vendor' / 'x86_64-unknown-linux-musl' / 'bin' / 'codex'
        protected(self.target_codex_binary)
        require(digest(self.target_codex_binary) == description['binarySha256'], 'The Codex executable changed.')

    def verify_runtime_execution(self):
        """Check the exact staged executable with the identity migration uses."""
        import pwd
        user = pwd.getpwnam(self.settings['serviceUser'])
        version = subprocess.check_output([str(self.target_agent_node), '--version'], text=True, timeout=10,
                                          user=user.pw_uid, group=user.pw_gid, extra_groups=[],
                                          env={'PATH': str(self.target_agent_node.parent) + ':/usr/bin:/bin',
                                               'HOME': user.pw_dir, 'LANG': 'C.UTF-8', 'NODE_DISABLE_COMPILE_CACHE': '1'}).strip()
        require(version == 'v' + self.runtime['nodeVersion'], 'The staged agent Node runtime has a different version.')
        if self.runtime.get('companion') is not None:
            version = subprocess.check_output([str(self.target_codex_binary), '--version'], text=True, timeout=10,
                                              user=user.pw_uid, group=user.pw_gid, extra_groups=[],
                                              env={'PATH': '/usr/bin:/bin', 'HOME': user.pw_dir, 'LANG': 'C.UTF-8'}).strip()
            require(version == 'codex-cli ' + self.runtime['companion']['codexVersion'], 'The staged Codex runtime has a different version.')

    def switch_runtime(self, restoring=False):
        if self.runtime is None:
            return
        self.require_stopped()
        for selector, target, kind in ((self.agent, self.prior_agent if restoring else self.target_agent, 'agent'),
                                      (self.agent_node, self.prior_agent_node if restoring else self.target_agent_node, 'node')):
            pointer = selector.parent / ('update-' + kind + '-' + self.job_id + ('-restore' if restoring else '-next'))
            require(not pointer.exists() and not pointer.is_symlink(), 'A runtime pointer attempt already exists.')
            pointer.symlink_to(target)
            os.replace(pointer, selector)
            sync_dir(selector.parent)
        self.active_engine = self.from_engine if restoring else self.to_engine

    def migrate_runtime(self):
        if self.runtime is None:
            return
        import pwd
        self.require_stopped()
        self.controller_hold()
        selected, _, paths = native_scope(self.data, self.before['epoch'])
        root = self.data / selected / 'openclaw-runtime'
        agents = [{'agentId': path.parts[-3], 'path': str(self.data / path)} for path in sorted(paths)
                  if path.name in {'openclaw-agent.sqlite', 'incognito-openclaw-agent.sqlite'}]
        user = pwd.getpwnam(self.settings['serviceUser'])
        env = {'PATH': str(self.target_agent_node.parent) + ':/usr/bin:/bin', 'HOME': user.pw_dir,
               'USER': user.pw_name, 'LOGNAME': user.pw_name, 'LANG': 'C.UTF-8',
               'OPENCLAW_HOME': str(root / 'home'), 'OPENCLAW_STATE_DIR': str(root / 'state'),
               'OPENCLAW_CONFIG_PATH': str(root / 'openclaw.json'), 'OPENCLAW_WORKSPACE_DIR': str(root / 'workspace'),
               'OPENCLAW_PROFILE': 'edition3', 'OPENCLAW_LOAD_SHELL_ENV': '0', 'OPENCLAW_EXEC_SHELL_SNAPSHOT': '0',
               'OPENCLAW_NO_AUTO_UPDATE': '1', 'OPENCLAW_DISABLE_BONJOUR': '1', 'OPENCLAW_SKIP_CHANNELS': '1',
               'NODE_DISABLE_COMPILE_CACHE': '1', 'TMPDIR': str(root / 'tmp')}
        self.workspace_mutated = True
        with (self.output / 'native-migration.log').open('xb') as log:
            subprocess.run([str(self.target_agent_node), '--input-type=module', '-e', NATIVE_MIGRATION,
                            str(self.target_agent), json.dumps(agents, separators=(',', ':'))],
                           cwd=root, env=env, user=user.pw_uid, group=user.pw_gid, extra_groups=[],
                           stdout=log, stderr=subprocess.STDOUT, check=True, timeout=600)
        self.require_stopped()
        self.controller_hold()
        with (self.output / 'codex-companion-install.log').open('xb') as log:
            subprocess.run([str(self.target_agent_node), '--input-type=module', '-e', CODEX_INSTALL,
                            str(self.target_agent), str(self.target_codex), CODEX_SURFACE],
                           cwd=root, env={**env, 'npm_config_offline': 'true'}, user=user.pw_uid, group=user.pw_gid, extra_groups=[],
                           stdout=log, stderr=subprocess.STDOUT, check=True, timeout=180)
        self.require_stopped()
        self.controller_hold()
        native_saved_state(self.recovery / 'workspace', self.data, self.before['epoch'], self.from_engine,
                           self.to_engine, self.target_agent_node)
        write_json(self.output / 'native-migration-verified.json', {'format': 1, 'fromVersion': self.from_engine,
                   'toVersion': self.to_engine, 'savedWorkVerified': True})

    def api(self, path, session=False):
        headers = {'Origin': self.origin, 'X-Edition3-Client': '1', 'Content-Type': 'application/json'}
        if self.client_candidate:
            headers['X-Edition3-Candidate'] = self.client_candidate
        request = urllib.request.Request(self.origin + '/api/' + path, data=b'{}' if session else None, headers=headers)
        with self.client.open(request, timeout=5) as response:
            raw = response.read(16 * 1024 ** 2 + 1)
        require(len(raw) <= 16 * 1024 ** 2, 'Local acceptance response exceeded its bound.')
        return json.loads(raw)

    def controller_hold(self):
        client = LocalSocket('localhost', timeout=5)
        try:
            client.request('POST', '/v1/status', body=b'{}', headers={'Content-Type': 'application/json'})
            response = client.getresponse()
            raw = response.read(65537)
            require(response.status == 200 and len(raw) <= 65536, 'Controller status could not be verified.')
            state = json.loads(raw)
            require(state.get('holdFor') == self.job_id and state.get('job', {}).get('id') == self.job_id
                    and state['job'].get('candidateId') == self.target_id, 'The controller no longer holds this exact installation.')
            return state
        finally:
            client.close()

    def acceptance(self, expected, version, require_idle=True, *, restored_prior=False):
        health = self.api('health')
        require(health.get('status') == 'ready' and health.get('candidateId') == expected and health.get('version') == version
                and health.get('schemaVersion') == 55 and health.get('apiVersion') == 1, 'Expected live candidate is not ready.')
        if self.client_candidate != expected:
            self.client_candidate = expected
            self.api('session', session=True)
        guard = self.api('software-update/acceptance')
        require(guard.get('candidateId') == expected and guard.get('heldFor') == self.job_id
                and guard.get('maintenanceHeld') is True and guard.get('nativeSuspended') is True, 'The live app and native agent must retain this exact update barrier.')
        require(not require_idle or guard.get('blockers') == [], 'Live work is not verified idle.')
        self.controller_hold()
        agent = self.api('assistant/service')
        require(agent.get('id') == 'openclaw' and agent.get('state') == 'ready' and agent.get('version') == self.active_engine, 'The actual agent is not the expected reviewed version.')
        assistant = self.api('assistant/state')['connection']
        # This is held acceptance: a cold OpenClaw process permits only suspend
        # controls, so models.list cannot establish model readiness yet. Keep
        # the authenticated connection and granted scopes checks here. After
        # the verified result, Nova durably retains local admission while it
        # resumes this exact lease and proves real model access on that child.
        require(assistant.get('state') == 'ready' and 'operator.read' in assistant.get('grantedScopes', [])
                and 'operator.write' in assistant.get('grantedScopes', []), 'Assistant access is not authenticated.')
        # An older restored app has no post-resume catalog gate. Its cold
        # catalog cannot be read under native suspension. Only the paired
        # restoration path may accept its real authenticated, idle connection;
        # saved/native/config verification still precedes the restored receipt.
        restored_cold = (restored_prior and require_idle and self.before is not None
                         and self.stop_attempted and self.workspace_mutated
                         and expected == self.prior_id and version == self.release['compatibility']['fromNovaVersion']
                         and self.active_engine == self.from_engine and self.current.resolve(strict=True) == self.prior
                         and self.launched is not None and self.launched['candidateId'] == self.prior_id)
        require(assistant.get('modelAuthReady') is True or guard.get('resumeReadinessRequired') is True or restored_cold,
                'This installed app cannot verify cold model access after releasing the update hold.')
        accounts = self.api('accounts')['accounts']
        require(all(account.get('state') in {'connected', 'reconnect', 'disconnected'} for account in accounts), 'Account state is unsettled.')
        retained_accounts = sorted((item['id'], item['provider'], item['state'], tuple(sorted(item.get('scopes', [])))) for item in accounts)
        require(self.api('health') == health, 'The app changed during readiness checks.')
        return {'health': health, 'accounts': retained_accounts, 'epoch': guard['epoch']}

    def guarded_stop(self, *, restored_prior=False):
        try:
            self.require_stopped()
            return
        except Exception:
            pass
        # A controller hold alone is not evidence that an unreachable native
        # service is idle. Keep uncertain running work intact for host review.
        selected = self.current.resolve(strict=True)
        expected = self.target_id if selected == self.target else self.prior_id
        version = self.release['novaVersion'] if selected == self.target else self.release['compatibility']['fromNovaVersion']
        try:
            self.acceptance(expected, version, restored_prior=True) if restored_prior else self.acceptance(expected, version)
        except Exception:
            self.qualify_started_barrier(selected, expected, version)
        self.service('stop')
        self.require_stopped()

    def qualify_started_barrier(self, selected, expected, version):
        """Only a publisher-reviewed exact bootstrap can prove an unresponsive
        process had no dispatch authority since this runner started it.
        """
        review = self.pair.get('startupBarrier')
        require(isinstance(review, dict) and set(review) == {'format', 'prior', 'target'} and review['format'] == 1,
                'The unresponsive candidate has no reviewed startup-barrier proof.')
        require(self.launched and self.launched['candidateId'] == expected, 'This runner did not launch the selected process under its barrier.')
        manifest = candidate(selected, expected, version)
        reviewed = review['target' if expected == self.target_id else 'prior']
        actual = {entry['path']: entry['sha256'] for entry in manifest['artifacts']}
        require(isinstance(reviewed, dict) and STARTUP_FILES <= set(reviewed)
                and all(name in actual and actual[name] == value for name, value in reviewed.items()),
                'The startup barrier is not bound to the reviewed exact candidate artifacts.')
        self.controller_hold()
        pid_text = subprocess.check_output(['/usr/bin/systemctl', 'show', self.settings['serviceName'], '--property=MainPID', '--value'], text=True, timeout=10).strip()
        require(pid_text.isdigit() and int(pid_text) > 1, 'The started app process cannot be identified.')
        process = pathlib.Path('/proc') / pid_text
        def bounded(name, limit):
            with (process / name).open('rb') as source:
                value = source.read(limit + 1)
            require(len(value) <= limit, 'Started process evidence exceeded its bound.')
            return value
        def start_ticks():
            state = bounded('stat', 4096)
            fields = state[state.rfind(b')') + 2:].split()
            require(len(fields) > 19, 'Invalid started process identity.')
            return int(fields[19])
        started = start_ticks()
        require(started >= self.launched['notBeforeTicks'], 'The selected process predates this guarded startup.')
        require((process / 'exe').resolve(strict=True) == self.node and (process / 'cwd').resolve(strict=True) == selected,
                'The selected process does not run the reviewed app and Node binary.')
        # No environment value is exported or logged. Check only this fixed
        # authority binding from the process's initial systemd environment.
        environment = bounded('environ', 256 * 1024).split(b'\0')
        matches = [value for value in environment if value.startswith(b'E3_UPDATE_SOCKET=')]
        require(matches == [b'E3_UPDATE_SOCKET=' + SOCKET.encode()], 'The started app is not bound to the protected update controller.')
        require(start_ticks() == started and self.current.resolve(strict=True) == selected,
                'Started process identity changed during barrier verification.')
        self.controller_hold()

    def verify_configuration(self):
        require(all(digest(path) == self.config_hashes[str(path)] for path in self.config_files), 'Protected host configuration changed; all versions were retained.')
        require(inventory(self.prior_agent)[0] == self.agent_identity and digest(self.node) == self.runtime_node_hash
                and digest(self.prior_agent_node) == self.agent_node_hash, 'The retained runtime or Node binary changed.')
        if self.runtime is not None:
            require(protected_selector(self.agent, self.runtime_root, True) in {self.prior_agent, self.target_agent}
                    and protected_selector(self.agent_node, self.runtime_root, False) in {self.prior_agent_node, self.target_agent_node},
                    'A runtime selector selected an unreviewed package.')
            if hasattr(self, 'target_runtime_identity'):
                require(inventory(self.runtime_target)[0] == self.target_runtime_identity, 'The immutable staged runtime changed.')
        require(inventory(self.dependencies)[0] == self.dependency_identity, 'The retained dependency tree changed.')

    def service(self, action):
        require(action in {'start', 'stop'}, 'Unsupported service action.')
        if action == 'start':
            selected = self.current.resolve(strict=True)
            require(selected in {self.target, self.prior}, 'Refuse to start an unexpected selected application.')
            if self.runtime is not None:
                restoring = self.active_engine == self.from_engine
                require(self.agent.resolve(strict=True) == (self.prior_agent if restoring else self.target_agent)
                        and self.agent_node.resolve(strict=True) == (self.prior_agent_node if restoring else self.target_agent_node),
                        'Refuse to start a mixed engine and Node pair.')
            self.launched = {'candidateId': self.target_id if selected == self.target else self.prior_id,
                             'notBeforeTicks': int(time.clock_gettime(time.CLOCK_BOOTTIME) * os.sysconf('SC_CLK_TCK'))}
        subprocess.run(['/usr/bin/systemctl', action, self.settings['serviceName']], check=True, timeout=120)

    def require_stopped(self):
        values = subprocess.check_output(['/usr/bin/systemctl', 'show', self.settings['serviceName'], '--property=ActiveState', '--property=SubState', '--property=MainPID', '--property=ControlPID', '--property=ControlGroup'], text=True, timeout=10)
        state = dict(line.split('=', 1) for line in values.splitlines() if '=' in line)
        require(state.get('ActiveState') == 'inactive' and state.get('SubState') == 'dead'
                and state.get('MainPID') == state.get('ControlPID') == '0', 'The owning dispatcher is not fully stopped.')
        group = state.get('ControlGroup')
        if group:
            path = pathlib.Path('/sys/fs/cgroup') / group.lstrip('/') / 'cgroup.procs'
            require(not path.exists() or path.read_text().strip() == '', 'The owning service still has running processes.')

    def archive_members(self):
        with tarfile.open(self.archive, 'r:gz') as archive:
            members = archive.getmembers()
        names = set()
        require(1 <= len(members) <= 6000 and sum(member.size for member in members) <= MAXIMUM, 'Reviewed archive expansion exceeded its bound.')
        for member in members:
            name = member.name
            path = pathlib.PurePosixPath(name)
            require(name not in names and not path.is_absolute() and all(part not in ('', '.', '..') for part in name.split('/'))
                    and (member.isdir() or member.isfile()) and not member.issym() and not member.islnk(), 'Unsafe reviewed archive entry.')
            names.add(name)
            require(path.parts[0] in {'dist', 'package.json', 'package-lock.json', 'scripts'}
                    and (path.parts[0] != 'scripts' or name in {'scripts', 'scripts/host.mjs', 'scripts/candidate.mjs'}), 'Archive contains an unreviewed host entry.')
        return members

    def stage_app(self):
        _, _, native_paths = native_preflight(self.data, self.before['epoch'], self.from_engine, self.to_engine)
        members = self.archive_members()
        source, source_inodes = inventory(self.data)
        baseline, baseline_inodes = inventory(self.baseline / 'workspace')
        required = sum(member.size for member in members) + len(members) * 4096
        if self.runtime is not None:
            required += self.runtime_storage_required()
            # Native23 rebuilds payload tables in SQLite transactions. Preserve
            # rollback capacity separately from both replacement tables and WAL.
            native_bytes = sum((self.data / path).stat().st_size + sum(side.stat().st_size for side in
                               ((self.data / path).with_name(path.name + '-wal'),) if side.exists()) for path in native_paths)
            required += 2 * native_bytes
            require(self.runtime_root.stat().st_dev == self.recovery_root.stat().st_dev, 'Runtime and recovery capacity require the same reviewed filesystem.')
        plan = capacity(source, source_inodes, baseline, baseline_inodes, shutil.disk_usage(self.recovery_root).free, required)
        require(self.releases.stat().st_dev == self.recovery_root.stat().st_dev, 'Candidate and recovery capacity need a separately reviewed filesystem plan.')
        write_json(self.output / 'capacity.json', plan)
        self.stage_runtime()
        if self.target.exists() or self.target.is_symlink():
            candidate(self.target, self.target_id, self.release['novaVersion'])
            with tarfile.open(self.archive, 'r:gz') as archive:
                for member in members:
                    destination = self.target / member.name
                    protected(destination, member.isdir())
                    if member.isfile():
                        with archive.extractfile(member) as source:
                            require(digest(destination) == hashlib.file_digest(source, 'sha256').hexdigest(), 'An existing staged host file differs from the reviewed archive.')
        else:
            self.target.mkdir(mode=0o755)
            with tarfile.open(self.archive, 'r:gz') as archive:
                for member in members:
                    destination = self.target / member.name
                    if member.isdir():
                        destination.mkdir(mode=0o755, parents=True, exist_ok=True)
                    else:
                        destination.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
                        with os.fdopen(descriptor, 'wb') as output, archive.extractfile(member) as source:
                            shutil.copyfileobj(source, output)
                            output.flush()
                            os.fsync(output.fileno())
            # Staged code is public application material. The private runner's
            # restrictive umask must not make it unreadable to the app user.
            self.target.chmod(0o755)
            for destination in self.target.rglob('*'):
                require(not destination.is_symlink(), 'Extracted application path was redirected.')
                destination.chmod(0o755 if destination.is_dir() else 0o644)
        dependencies = lambda path: {key: value for key, value in read_json(path / 'package-lock.json')['packages'].items() if key}
        require(dependencies(self.prior) == dependencies(self.target), 'Dependencies changed; this runner cannot install them.')
        require((self.prior / 'node_modules').is_symlink() and (self.prior / 'node_modules').resolve(strict=True) == self.dependencies,
                'Prior app dependencies differ from the provisioned retained directory.')
        link = self.target / 'node_modules'
        if not link.exists() and not link.is_symlink():
            link.symlink_to(self.dependencies, target_is_directory=True)
        require(link.is_symlink() and link.lstat().st_uid == 0 and link.resolve(strict=True) == self.dependencies, 'Staged dependency pointer changed.')
        candidate(self.target, self.target_id, self.release['novaVersion'])
        subprocess.run(['/usr/sbin/runuser', '-u', self.settings['serviceUser'], '--', str(self.node), '--input-type=module', '-e',
                        "import {accessSync,constants} from 'node:fs';accessSync('node_modules',constants.R_OK|constants.X_OK);accessSync('dist/service/apps/service/main.js',constants.R_OK);"],
                       cwd=self.target, check=True, timeout=20)
        sync_dir(self.target)

    def switch(self, target):
        if target == self.current.resolve(strict=True):
            return
        pointer = self.current.parent / ('update-pointer-' + self.job_id + ('-restore' if target == self.prior else '-next'))
        require(not pointer.exists() and not pointer.is_symlink(), 'Previous pointer-switch evidence exists.')
        pointer.symlink_to(target)
        os.replace(pointer, self.current)
        sync_dir(self.current.parent)

    def wait_acceptance(self, expected, version, *, restored_prior=False):
        deadline = time.monotonic() + self.release['recovery']['readinessTimeoutSeconds']
        while time.monotonic() < deadline:
            try:
                accepted = self.acceptance(expected, version, restored_prior=True) if restored_prior else self.acceptance(expected, version)
                require(self.before is None or accepted['accounts'] == self.before['accounts'], 'Retained account connections changed.')
                require(self.before is None or accepted['epoch'] == self.before['epoch'], 'The selected workspace changed.')
                return accepted
            except Exception:
                time.sleep(1)
        raise RuntimeError('Expected app, agent, barrier and retained accounts did not pass bounded readiness.')

    def retained_native(self):
        snapshot = self.recovery / 'workspace'
        selected = self.current.resolve(strict=True)
        require(selected in {self.prior, self.target}, 'Native retention requires the verified selected application.')
        target = selected == self.target
        manifest = candidate(selected, self.target_id if target else self.prior_id,
                             self.release['novaVersion'] if target else self.release['compatibility']['fromNovaVersion'])
        native_saved_state(snapshot, self.data, self.before['epoch'] if self.before else None,
                           self.from_engine, self.active_engine, self.target_agent_node if self.runtime is not None else None,
                           app_releases=((self.prior, self.prior_manifest), (selected, manifest)))
        for path in snapshot.rglob('*.jsonl'):
            if 'openclaw-runtime' not in path.parts:
                continue
            current = self.data / path.relative_to(snapshot)
            require(current.is_file() and not current.is_symlink(), 'Retained native history is missing.')
            with path.open('rb') as old, current.open('rb') as live:
                while chunk := old.read(1024 * 1024):
                    require(live.read(len(chunk)) == chunk, 'Retained native transcript bytes changed.')
        for path in snapshot.rglob('openclaw.json'):
            if 'openclaw-runtime' in path.parts:
                old, new = read_json(path), read_json(self.data / path.relative_to(snapshot))
                search = lambda value: value.get('tools', {}).get('web', {}).get('search')
                require(search(old) == search(new), 'Existing web-search configuration changed.')

    def settled_acceptance(self, expected, version, *, restored=False):
        # Startup may open otherwise inactive SQLite stores and their transient
        # sidecars. Prove held readiness first, then compare the complete saved
        # state with every process in the managed pair stopped. The final start
        # must independently pass readiness before any result can be published.
        self.wait_acceptance(expected, version, restored_prior=restored)
        self.controller_hold()
        self.guarded_stop(restored_prior=restored)
        self.require_stopped()
        saved_state(self.recovery / 'workspace', self.data, restored=restored)
        self.retained_native()
        self.verify_configuration()
        self.require_stopped()
        self.controller_hold()
        self.service('start')
        accepted = self.wait_acceptance(expected, version, restored_prior=restored)
        self.verify_configuration()
        return accepted

    def result(self, outcome):
        payload = {'format': 1, 'jobId': self.job_id, 'candidateId': self.target_id, 'priorCandidateId': self.prior_id, 'outcome': outcome}
        if outcome == 'unchanged':
            require(not self.stop_attempted and not self.switch_attempted and not self.switched and not self.workspace_mutated, 'An unchanged receipt cannot follow a mutation.')
            require(self.current.resolve(strict=True) == self.prior, 'The installed pointer changed.')
            candidate(self.prior, self.prior_id, self.release['compatibility']['fromNovaVersion'])
            self.wait_acceptance(self.prior_id, self.release['compatibility']['fromNovaVersion'])
            self.verify_configuration()
            payload.update(unchangedVerified=True, healthVerified=True,
                           reasonCode=getattr(self, 'preflight_reason', 'preflight_failed'),
                           reason='The update could not be prepared. The installed version is unchanged.')
        else:
            payload.update(savedWorkVerified=True, accountsVerified=True, recoveryVerified=True, healthVerified=True)
        temporary = self.output / 'result.ready.json'
        write_json(temporary, payload)
        # Once the atomic result may be visible, a controller can release the
        # barrier. Never roll back after an uncertain acceptance publication.
        self.result_publication_started = True
        os.replace(temporary, self.output / 'result.json')
        sync_dir(self.output)

    def restore_prior(self):
        # Both app generations retain the exact controller barrier. If the new
        # service is unreachable, systemd must still prove no dispatcher remains.
        self.controller_hold()
        require(self.current.resolve(strict=True) in {self.target, self.prior}, 'An unexpected release was selected; recovery needs review.')
        self.guarded_stop()
        verify = read_json(self.recovery / 'snapshot-verified.json')
        manifest = self.recovery / 'snapshot-manifest.json'
        require(digest(manifest) == verify['manifestSha256'] and inventory(self.recovery / 'workspace')[0] == read_json(manifest, 64 * 1024 ** 2), 'Closed recovery identity changed.')
        prepare_independent(self.recovery / 'workspace', self.restore, self.data, self.require_stopped)
        saved_state(self.recovery / 'workspace', self.restore, restored=True)
        self.verify_configuration()
        require(not self.failed.exists() and not self.failed.is_symlink(), 'Failed workspace preservation path already exists.')
        self.workspace_mutated = True
        os.rename(self.data, self.failed)
        sync_dir(self.recovery)
        sync_dir(self.data.parent)
        try:
            os.rename(self.restore, self.data)
        except BaseException:
            if not self.data.exists() and not self.data.is_symlink():
                os.rename(self.failed, self.data)
            raise
        sync_dir(self.data.parent)
        candidate(self.prior, self.prior_id, self.release['compatibility']['fromNovaVersion'])
        self.switch_runtime(restoring=True)
        self.switch(self.prior)
        self.stage('restarting')
        self.service('start')
        self.stage('checking')
        accepted = self.settled_acceptance(self.prior_id, self.release['compatibility']['fromNovaVersion'], restored=True)
        write_json(self.recovery / 'restoration-accepted.json', {'health': accepted['health'], 'agentVersion': self.from_engine, 'failedWorkspaceRetained': True})
        latest = self.recovery_root / ('latest-restored-' + self.job_id + '.json')
        write_json(latest, {'candidateId': self.prior_id, 'agentVersion': self.from_engine, 'directory': str(self.baseline)})
        os.replace(latest, self.recovery_root / 'latest-update.json')
        sync_dir(self.recovery_root)
        self.result('restored')

    def record_failure(self, failure):
        # Preserve the original cause before recovery. Only literal guard
        # messages in this verified driver pair may enter the private receipt;
        # subprocess output, dynamic exception text and commands never do.
        with contextlib.suppress(Exception):
            reason = 'The update failed before acceptance.'
            if type(failure) is RuntimeError:
                messages = set()
                with contextlib.suppress(Exception):
                    for name in ('install.py', 'recovery.py'):
                        source = self.bundle / name
                        require(source.stat().st_size <= 512 * 1024, 'Failure diagnostic source exceeded its bound.')
                        for node in ast.walk(ast.parse(source.read_bytes())):
                            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
                                continue
                            index = 1 if node.func.id == 'require' else 0 if node.func.id == 'RuntimeError' else None
                            if index is not None and len(node.args) > index and isinstance(node.args[index], ast.Constant) and isinstance(node.args[index].value, str):
                                messages.add(node.args[index].value)
                if str(failure) in messages:
                    reason = str(failure)
            write_json(self.output / 'failure.json', {'errorType': type(failure).__name__, 'reason': reason})

    def run(self):
        self.validate()
        self.before = self.wait_acceptance(self.prior_id, self.release['compatibility']['fromNovaVersion'])
        self.stage('preparing')
        try:
            self.stage_app()
            require(self.release['manifestExpiresAt'] > int(time.time() * 1000), 'Reviewed release information expired before the switch.')
            require(not self.recovery.exists() and not self.restore.exists() and not self.restore.is_symlink(), 'A previous recovery attempt must be retained.')
            self.wait_acceptance(self.prior_id, self.release['compatibility']['fromNovaVersion'])
            self.recovery.mkdir(mode=0o700)
            self.verify_configuration()
            # A failed stop is an uncertain mutation, so it can never produce unchanged.
            self.stop_attempted = True
            self.service('stop')
            self.require_stopped()
            snapshot_closed(self.data, self.recovery / 'workspace', self.baseline / 'workspace', self.require_stopped)
            saved_state(self.recovery / 'workspace', self.data, restored=True)
            for number, path in enumerate(self.config_files):
                shutil.copy2(path, self.recovery / ('protected-' + str(number)))
                require(digest(path) == digest(self.recovery / ('protected-' + str(number))), 'Protected configuration copy did not verify.')
            self.verify_configuration()
            independent = sum(item['allocated'] for item in inventory(self.recovery / 'workspace')[1].values())
            require(shutil.disk_usage(self.recovery_root).free >= independent + RESERVE + ALLOWANCE,
                    'Verified snapshot no longer leaves full independent restore capacity and reserve.')
            require(self.release['manifestExpiresAt'] > int(time.time() * 1000), 'Reviewed release information expired before the switch.')
            self.stage('installing')
            self.switch_attempted = True
            self.switch_runtime()
            self.migrate_runtime()
            self.switch(self.target)
            self.switched = True
            self.stage('restarting')
            self.service('start')
            self.stage('checking')
            accepted = self.settled_acceptance(self.target_id, self.release['novaVersion'])
            require(shutil.disk_usage(self.recovery_root).free >= independent + RESERVE + ALLOWANCE,
                    'The migrated pair no longer leaves full independent recovery capacity and reserve.')
            require(self.current.resolve(strict=True) == self.target, 'The selected target changed during acceptance.')
            candidate(self.target, self.target_id, self.release['novaVersion'])
            write_json(self.recovery / 'acceptance.json', {'health': accepted['health'], 'agentVersion': self.active_engine})
            latest = self.recovery_root / ('latest-' + self.job_id + '.json')
            write_json(latest, {'candidateId': self.target_id, 'agentVersion': self.active_engine, 'directory': str(self.recovery)})
            os.replace(latest, self.recovery_root / 'latest-update.json')
            sync_dir(self.recovery_root)
            self.result('completed')
        except BaseException as failure:
            self.record_failure(failure)
            if self.result_publication_started:
                raise
            if self.switch_attempted:
                self.restore_prior()
            elif self.stop_attempted:
                # Before a pointer switch, the original closed workspace remains
                # selected. Restart only that exact verified prior pair.
                require(self.current.resolve(strict=True) == self.prior, 'The prior pointer changed unexpectedly.')
                self.service('start')
                self.wait_acceptance(self.prior_id, self.release['compatibility']['fromNovaVersion'])
                # No paired restoration occurred. Keep the original job held for
                # review instead of reporting a rollback or an unchanged attempt.
                raise
            else:
                self.preflight_reason = 'insufficient_storage' if isinstance(failure, InsufficientStorage) else 'preflight_failed'
                self.result('unchanged')


def main():
    require(len(sys.argv) == 3 and sys.argv[1] == '--request', 'Use the original controller request file.')
    os.umask(0o077)
    request = pathlib.Path(sys.argv[2])
    protected(request, private=True)
    descriptor = os.open(request.parent / 'driver.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        Driver(request).run()
    finally:
        os.close(descriptor)


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        # Detailed files stay beside the exact request. Never print credentials,
        # arbitrary exceptions, filesystem paths, API bodies, or retry commands.
        print('The reviewed update needs host review; original evidence was retained.', file=sys.stderr)
        sys.exit(1)
