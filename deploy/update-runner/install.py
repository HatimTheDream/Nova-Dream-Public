"""Reviewed Linux app-only update driver; fixed entry invoked with --request.

No operation runs on import. This driver deliberately supports unchanged
OpenClaw 2026.9.2, unchanged dependencies, and schema55 only. It never installs
packages, prunes recovery, downloads additional code, or chooses another release.
"""
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
                      require, saved_state, native_preflight, native_saved_state, snapshot_closed, sync_dir, write_json)

SOCKET = '/run/nova-update/control.sock'
ENGINE = '2026.9.2'
MAXIMUM = 128 * 1024 ** 2
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
        require(all(re.fullmatch('[a-f0-9]{64}', value) for value in (self.target_id, self.prior_id)) and self.target_id != self.prior_id, 'Invalid exact candidate pair.')
        compatibility = self.release['compatibility']
        require(self.release['agentVersion'] == compatibility['fromAgentVersion'] == ENGINE
                and compatibility['fromSchemaVersion'] == compatibility['toSchemaVersion'] == 55
                and compatibility['reviewed'] is True and compatibility['gatewayProtocol'] == 4
                and compatibility['pluginVersion'] == self.release['novaVersion'], 'This runner does not qualify an engine or schema upgrade.')
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
        self.dependencies = pathlib.Path(self.settings['dependencyDirectory'])
        self.recovery_root = pathlib.Path(self.settings['recoveryDirectory'])
        self.node = pathlib.Path(self.settings['nodePath'])
        for path in (self.releases, self.agent, self.dependencies, self.recovery_root):
            protected(path, True)
        protected(self.node)
        require(self.data.resolve(strict=True) == self.data and self.data.is_dir() and not self.data.is_symlink(), 'Workspace path changed.')
        require(not self.recovery_root.is_relative_to(self.data) and not self.data.is_relative_to(self.recovery_root), 'Recovery must be outside live workspace replacement.')
        require(self.recovery_root.stat().st_dev == self.data.stat().st_dev == self.data.parent.stat().st_dev, 'Recovery and workspace must share the reviewed filesystem.')
        require(self.current.is_symlink() and self.current.lstat().st_uid == 0, 'The selected release pointer is not owned by root.')
        self.prior = self.current.resolve(strict=True)
        require(self.prior.parent == self.releases, 'Selected release is outside its protected root.')
        self.prior_manifest = candidate(self.prior, self.prior_id, compatibility['fromNovaVersion'])
        self.target = self.releases / (self.release['novaVersion'] + '-' + self.target_id[:12])
        self.recovery = self.recovery_root / ('update-' + self.job_id)
        self.restore = self.data.parent / ('workspace.restore-' + self.job_id)
        self.failed = self.recovery / 'failed-workspace'
        self.baseline = pathlib.Path(self.settings['baselineDirectory'])
        latest = self.recovery_root / 'latest-update.json'
        if latest.exists():
            protected(latest, private=True)
            selected = read_json(latest, 4096)
            require(selected['candidateId'] == self.prior_id, 'Latest recovery acceptance does not match the installed pair.')
            self.baseline = pathlib.Path(selected['directory'])
        protected(self.baseline, True, True)
        require(self.baseline.parent == self.recovery_root, 'Recovery baseline is outside the reviewed root.')
        acceptance = read_json(self.baseline / 'acceptance.json')
        require(acceptance['health']['candidateId'] == self.prior_id, 'The recovery baseline is not paired with the installed candidate.')
        manifest_file = self.baseline / ('snapshot-manifest.json' if (self.baseline / 'snapshot-manifest.json').exists() else 'linked-snapshot-source.json')
        verified = read_json(self.baseline / 'snapshot-verified.json')
        require(digest(manifest_file) == verified['manifestSha256'], 'The recovery baseline verification changed.')
        self.baseline_entries = read_json(manifest_file, 64 * 1024 ** 2)
        require(inventory(self.baseline / 'workspace')[0] == self.baseline_entries, 'The verified closed baseline changed.')
        self.pair = read_json(self.bundle / 'reviewed-pair.json', 65536)
        require({'format', 'candidateId', 'priorCandidateId', 'archiveBytes', 'archiveSha256'} <= set(self.pair)
                and set(self.pair) <= {'format', 'candidateId', 'priorCandidateId', 'archiveBytes', 'archiveSha256', 'startupBarrier'}
                and self.pair['format'] == 1 and self.pair['candidateId'] == self.target_id and self.pair['priorCandidateId'] == self.prior_id,
                'The reviewed archive does not identify this exact pair.')
        self.archive = self.bundle / 'app.tgz'
        protected(self.archive, private=True)
        require(self.archive.stat().st_size == self.pair['archiveBytes'] <= MAXIMUM and digest(self.archive) == self.pair['archiveSha256'], 'Reviewed application archive changed.')
        self.config_files = [pathlib.Path(value) for value in self.settings['protectedFiles']]
        require(1 <= len(self.config_files) <= 16 and len(set(self.config_files)) == len(self.config_files), 'Invalid protected host configuration set.')
        for path in self.config_files:
            protected(path)
            require(not path.is_relative_to(self.data) and not path.is_relative_to(self.releases), 'Host protection files must remain outside replacements.')
        self.config_hashes = {str(path): digest(path) for path in self.config_files}
        self.agent_identity = inventory(self.agent)[0]
        require(read_json(self.agent / 'package.json')['version'] == ENGINE, 'The installed agent version changed.')
        self.runtime_node_hash = digest(self.node)
        self.dependency_identity = inventory(self.dependencies)[0]
        self.origin = 'http://127.0.0.1:' + str(self.settings['healthPort'])
        self.client = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.client_candidate = None
        require(not (self.output / 'result.json').exists() and not (self.output / 'driver-attempt.json').exists(), 'The original runner attempt must be reconciled, never repeated.')
        write_json(self.output / 'driver-attempt.json', {'jobId': self.job_id, 'candidateId': self.target_id, 'priorCandidateId': self.prior_id})

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

    def acceptance(self, expected, version, require_idle=True):
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
        require(agent.get('id') == 'openclaw' and agent.get('state') == 'ready' and agent.get('version') == ENGINE, 'The actual agent is not the reviewed unchanged version.')
        assistant = self.api('assistant/state')['connection']
        require(assistant.get('state') == 'ready' and assistant.get('modelAuthReady') is True
                and 'operator.write' in assistant.get('grantedScopes', []), 'Assistant access is not ready.')
        accounts = self.api('accounts')['accounts']
        require(all(account.get('state') in {'connected', 'reconnect', 'disconnected'} for account in accounts), 'Account state is unsettled.')
        retained_accounts = sorted((item['id'], item['provider'], item['state'], tuple(sorted(item.get('scopes', [])))) for item in accounts)
        require(self.api('health') == health, 'The app changed during readiness checks.')
        return {'health': health, 'accounts': retained_accounts, 'epoch': guard['epoch']}

    def guarded_stop(self):
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
            self.acceptance(expected, version)
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
        require(inventory(self.agent)[0] == self.agent_identity and digest(self.node) == self.runtime_node_hash,
                'The unchanged runtime or Node binary changed.')
        require(inventory(self.dependencies)[0] == self.dependency_identity, 'The retained dependency tree changed.')

    def service(self, action):
        require(action in {'start', 'stop'}, 'Unsupported service action.')
        if action == 'start':
            selected = self.current.resolve(strict=True)
            require(selected in {self.target, self.prior}, 'Refuse to start an unexpected selected application.')
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
        native_preflight(self.data, self.before['epoch'])
        members = self.archive_members()
        source, source_inodes = inventory(self.data)
        baseline, baseline_inodes = inventory(self.baseline / 'workspace')
        required = sum(member.size for member in members) + len(members) * 4096
        plan = capacity(source, source_inodes, baseline, baseline_inodes, shutil.disk_usage(self.recovery_root).free, required)
        require(self.releases.stat().st_dev == self.recovery_root.stat().st_dev, 'Candidate and recovery capacity need a separately reviewed filesystem plan.')
        write_json(self.output / 'capacity.json', plan)
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
        pointer = self.current.parent / ('update-pointer-' + self.job_id + ('-restore' if target == self.prior else '-next'))
        require(not pointer.exists() and not pointer.is_symlink(), 'Previous pointer-switch evidence exists.')
        pointer.symlink_to(target)
        os.replace(pointer, self.current)
        sync_dir(self.current.parent)

    def wait_acceptance(self, expected, version):
        deadline = time.monotonic() + self.release['recovery']['readinessTimeoutSeconds']
        while time.monotonic() < deadline:
            try:
                accepted = self.acceptance(expected, version)
                require(self.before is None or accepted['accounts'] == self.before['accounts'], 'Retained account connections changed.')
                require(self.before is None or accepted['epoch'] == self.before['epoch'], 'The selected workspace changed.')
                return accepted
            except Exception:
                time.sleep(1)
        raise RuntimeError('Expected app, agent, barrier and retained accounts did not pass bounded readiness.')

    def retained_native(self):
        snapshot = self.recovery / 'workspace'
        native_saved_state(snapshot, self.data, self.before['epoch'] if self.before else None)
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

    def result(self, outcome):
        payload = {'format': 1, 'jobId': self.job_id, 'candidateId': self.target_id, 'priorCandidateId': self.prior_id, 'outcome': outcome}
        if outcome == 'unchanged':
            require(not self.stop_attempted and not self.switch_attempted and not self.switched and not self.workspace_mutated, 'An unchanged receipt cannot follow a mutation.')
            require(self.current.resolve(strict=True) == self.prior, 'The installed pointer changed.')
            candidate(self.prior, self.prior_id, self.release['compatibility']['fromNovaVersion'])
            self.acceptance(self.prior_id, self.release['compatibility']['fromNovaVersion'])
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
        self.switch(self.prior)
        self.stage('restarting')
        self.service('start')
        self.stage('checking')
        accepted = self.wait_acceptance(self.prior_id, self.release['compatibility']['fromNovaVersion'])
        saved_state(self.recovery / 'workspace', self.data, restored=True)
        self.retained_native()
        self.verify_configuration()
        write_json(self.recovery / 'restoration-accepted.json', {'health': accepted['health'], 'failedWorkspaceRetained': True})
        latest = self.recovery_root / ('latest-restored-' + self.job_id + '.json')
        write_json(latest, {'candidateId': self.prior_id, 'directory': str(self.baseline)})
        os.replace(latest, self.recovery_root / 'latest-update.json')
        sync_dir(self.recovery_root)
        self.result('restored')

    def run(self):
        self.validate()
        self.before = self.acceptance(self.prior_id, self.release['compatibility']['fromNovaVersion'])
        self.stage('preparing')
        try:
            self.stage_app()
            require(self.release['manifestExpiresAt'] > int(time.time() * 1000), 'Reviewed release information expired before the switch.')
            require(not self.recovery.exists() and not self.restore.exists() and not self.restore.is_symlink(), 'A previous recovery attempt must be retained.')
            self.acceptance(self.prior_id, self.release['compatibility']['fromNovaVersion'])
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
            self.switch(self.target)
            self.switched = True
            self.stage('restarting')
            self.service('start')
            self.stage('checking')
            accepted = self.wait_acceptance(self.target_id, self.release['novaVersion'])
            saved_state(self.recovery / 'workspace', self.data)
            self.retained_native()
            self.verify_configuration()
            require(self.current.resolve(strict=True) == self.target, 'The selected target changed during acceptance.')
            candidate(self.target, self.target_id, self.release['novaVersion'])
            write_json(self.recovery / 'acceptance.json', {'health': accepted['health']})
            latest = self.recovery_root / ('latest-' + self.job_id + '.json')
            write_json(latest, {'candidateId': self.target_id, 'directory': str(self.recovery)})
            os.replace(latest, self.recovery_root / 'latest-update.json')
            sync_dir(self.recovery_root)
            self.result('completed')
        except BaseException as failure:
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
