"""Request one exact installation through the maintained controller.

--execute saves a private, exclusive intent before one POST /v1/install.
--observe reads that intent and the original journal/status; it never checks the
feed or submits an installation. Uncertain replies never permit automatic replay.
The client is bounded to 60 seconds and does not own or stop the controller worker.
"""
import argparse
import hashlib
import http.client
import json
import os
import pathlib
import posixpath
import re
import signal
import socket
import stat
import sys
import time
import uuid

CONFIG = '/etc/nova-update/config.json'
SOCKET = '/run/nova-update/control.sock'
MAX_SECONDS = 60
TERMINAL = {'completed', 'restored', 'failed', 'cancelled'}
STATES = TERMINAL | {'waiting', 'downloading', 'verifying', 'preparing', 'installing', 'restarting', 'checking'}
OPERATION_FIELDS = {
    'format', 'operationId', 'candidateId', 'priorCandidateId', 'workspaceEpoch',
    'version', 'buildVersion', 'priorVersion', 'priorBuildVersion', 'schemaVersion',
    'apiVersion', 'agentVersion', 'priorAgentVersion', 'bundleSha256',
    'rehearsalLeaseId', 'rehearsalProofSha256', 'idempotencyKey',
}


class Refusal(RuntimeError):
    """Only fixed diagnostic codes may cross the CLI boundary."""


class DeadlineExpired(Refusal):
    pass


def require(value, code):
    if not value:
        raise Refusal(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def is_hash(value):
    return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value) is not None


def is_uuid(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except (ValueError, TypeError, AttributeError):
        return False


def absolute(value):
    return (isinstance(value, str) and len(value) <= 4096 and '\0' not in value
            and value.startswith('/') and not value.startswith('//') and posixpath.normpath(value) == value)


def validate_operation(value):
    require(isinstance(value, dict) and set(value) == OPERATION_FIELDS and type(value['format']) is int
            and value['format'] == 1, 'invalid-operation-shape')
    for name in ('operationId', 'workspaceEpoch', 'rehearsalLeaseId', 'idempotencyKey'):
        require(is_uuid(value[name]), 'invalid-operation-identity')
    for name in ('candidateId', 'priorCandidateId', 'bundleSha256', 'rehearsalProofSha256'):
        require(is_hash(value[name]), 'invalid-operation-hash')
    for name in ('version', 'buildVersion', 'priorVersion', 'priorBuildVersion', 'agentVersion', 'priorAgentVersion'):
        require(isinstance(value[name], str) and re.fullmatch(r'\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[A-Za-z0-9.-]{1,40})?', value[name]),
                'invalid-operation-version')
    for name in ('schemaVersion', 'apiVersion'):
        require(type(value[name]) is int and 1 <= value[name] <= 100000, 'invalid-operation-version')
    return value


def validate_config(value):
    require(isinstance(value, dict) and value.get('format') == 1, 'invalid-controller-config')
    for name in ('stateDirectory', 'agentDirectory', 'runtimeDirectory'):
        require(absolute(value.get(name)), 'invalid-controller-config')
    group = value.get('socketGroup', 'nova')
    require(isinstance(group, str) and re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', group), 'invalid-controller-config')
    return {name: value[name] for name in ('stateDirectory', 'agentDirectory', 'runtimeDirectory')} | {'socketGroup': group}


def request_for(operation):
    return {'epoch': operation['workspaceEpoch'], 'candidateId': operation['candidateId'],
            'releaseId': operation['bundleSha256'], 'currentCandidateId': operation['priorCandidateId'],
            'idempotencyKey': operation['idempotencyKey'], 'when': 'now'}


def validate_offer(view, operation, allow_stale=False):
    require(isinstance(view, dict), 'invalid-controller-status')
    offer = view.get('release') or {}
    require(view.get('availability') == 'available' and isinstance(offer, dict)
            and offer.get('candidateId') == operation['candidateId'] and offer.get('releaseId') == operation['bundleSha256']
            and offer.get('novaVersion') == operation['version'] and offer.get('agentVersion') == operation['agentVersion'],
            'exact-signed-offer-unavailable')
    require(isinstance(view.get('installation'), dict) and view['installation'].get('supported') is True
            and 'holdFor' in view and view['holdFor'] is None, 'installation-held-or-unsupported')
    job = view.get('job')
    require(job is None or isinstance(job, dict) and job.get('state') in TERMINAL, 'another-installation-active')
    blocker = view.get('blocker')
    require(blocker is None or allow_stale and isinstance(blocker, dict) and blocker.get('code') == 'workspace_unknown',
            'installation-readiness-blocked')
    # A blocker-free status is the controller's actual <10s app heartbeat gate.
    # The controller rechecks it authoritatively when accepting the request.
    return blocker is None


def matched_job(journal, operation):
    require(isinstance(journal, dict) and journal.get('format') == 1 and isinstance(journal.get('jobs'), list)
            and len(journal['jobs']) <= 2048 and all(isinstance(j, dict) for j in journal['jobs']), 'invalid-controller-journal')
    matches = [j for j in journal['jobs'] if j.get('idempotencyKey') == operation['idempotencyKey']]
    require(len(matches) <= 1, 'ambiguous-original-request')
    if not matches:
        return None
    job = matches[0]
    release = job.get('release') or {}
    compatibility = release.get('compatibility') or {} if isinstance(release, dict) else {}
    require(job.get('candidateId') == operation['candidateId'] and job.get('releaseId') == operation['bundleSha256']
            and job.get('fromCandidateId') == operation['priorCandidateId'] and job.get('epoch') == operation['workspaceEpoch']
            and job.get('when') == 'now' and isinstance(release, dict)
            and release.get('candidateId') == operation['candidateId'] and release.get('fromCandidateId') == operation['priorCandidateId']
            and isinstance(release.get('bundle'), dict) and release['bundle'].get('sha256') == operation['bundleSha256']
            and release.get('novaVersion') == operation['version'] and release.get('agentVersion') == operation['agentVersion']
            and isinstance(compatibility, dict) and compatibility.get('reviewed') is True
            and compatibility.get('gatewayProtocol') == 4 and compatibility.get('fromNovaVersion') == operation['priorVersion']
            and compatibility.get('fromAgentVersion') == operation['priorAgentVersion']
            and compatibility.get('fromSchemaVersion') == operation['schemaVersion']
            and compatibility.get('toSchemaVersion') == operation['schemaVersion'], 'original-request-identity-mismatch')
    require(is_uuid(job.get('id')) and job.get('state') in STATES and type(job.get('hold')) is bool, 'invalid-original-job')
    return job


def file_identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_mode, info.st_uid, info.st_nlink)


class SystemIO:
    """Small production boundary; tests inject inert file/transport operations."""
    def __init__(self):
        self.deadline = time.monotonic() + MAX_SECONDS

    def remaining(self, maximum=10):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise DeadlineExpired('invocation-deadline')
        return min(maximum, remaining)

    def monotonic(self):
        return time.monotonic()

    def now_ms(self):
        return time.time_ns() // 1000000

    def sleep(self, seconds):
        time.sleep(min(seconds, self.remaining(seconds)))

    def exists(self, path):
        return os.path.lexists(path)

    def protect(self, path, directory=False, private=True):
        require(absolute(path), 'authority-path-invalid')
        selected = pathlib.Path(path)
        require(selected.resolve(strict=True) == selected, 'authority-path-redirected')
        for part in (selected, *selected.parents):
            info = part.lstat()
            require(not stat.S_ISLNK(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                    'authority-ownership-invalid')
            if part != selected:
                require(stat.S_ISDIR(info.st_mode), 'authority-parent-invalid')
        info = selected.lstat()
        require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
                'authority-type-invalid')
        require(not private or not info.st_mode & 0o077, 'authority-not-private')
        return info

    def read_bytes(self, path, maximum=65536, private=True):
        before = self.protect(path, private=private)
        require(before.st_size <= maximum, 'record-too-large')
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            opened = os.fstat(fd)
            require(file_identity(before) == file_identity(opened), 'record-replaced')
            data = bytearray()
            while len(data) <= maximum:
                chunk = os.read(fd, min(65536, maximum + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
            require(len(data) <= maximum and file_identity(opened) == file_identity(os.fstat(fd))
                    and file_identity(before) == file_identity(os.lstat(path)), 'record-changed')
            return bytes(data)
        finally:
            os.close(fd)

    def sync(self, directory):
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def mkdir(self, path):
        self.protect(posixpath.dirname(path), directory=True)
        os.mkdir(path, 0o700)
        self.protect(path, directory=True)
        self.sync(posixpath.dirname(path))

    def save(self, path, value):
        self.protect(posixpath.dirname(path), directory=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(canonical(value) + b'\n')
            stream.flush()
            os.fsync(stream.fileno())
        self.sync(posixpath.dirname(path))

    def runtime_version(self, config):
        selector = pathlib.Path(config['agentDirectory'])
        self.protect(str(selector.parent), directory=True, private=False)
        info = selector.lstat()
        require(info.st_uid == 0, 'runtime-selector-invalid')
        resolved = str(selector.resolve(strict=True))
        require(resolved.startswith(config['runtimeDirectory'] + '/') and config['agentDirectory'].startswith(config['runtimeDirectory'] + '/'),
                'runtime-selector-outside-root')
        self.protect(resolved, directory=True, private=False)
        package = json.loads(self.read_bytes(posixpath.join(resolved, 'package.json'), 262144, private=False))
        require(isinstance(package, dict) and package.get('name') == 'openclaw', 'runtime-package-invalid')
        return package.get('version')

    def _response(self, client):
        response = client.getresponse()
        chunks = bytearray()
        while len(chunks) <= 65536:
            if client.sock:
                client.sock.settimeout(self.remaining())
            data = response.read1(min(8192, 65537 - len(chunks)))
            if not data:
                break
            chunks.extend(data)
        require(len(chunks) <= 65536, 'response-too-large')
        value = json.loads(chunks)
        require(isinstance(value, dict), 'invalid-response')
        return response.status, value

    def control(self, action, body, group):
        import grp
        require(action in {'check', 'status', 'install'}, 'unsupported-controller-action')
        self.protect(posixpath.dirname(SOCKET), directory=True, private=False)
        info = os.lstat(SOCKET)
        require(stat.S_ISSOCK(info.st_mode) and info.st_uid == 0 and info.st_gid == grp.getgrnam(group).gr_gid
                and stat.S_IMODE(info.st_mode) == 0o660, 'controller-socket-invalid')
        client = http.client.HTTPConnection('localhost', timeout=self.remaining(25 if action == 'check' else 10))
        client.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.sock.settimeout(client.timeout)
        try:
            client.sock.connect(SOCKET)
            content = canonical(body)
            client.request('POST', '/v1/' + action, body=content, headers={'Content-Type': 'application/json', 'Content-Length': str(len(content)), 'Connection': 'close'})
            return self._response(client)
        finally:
            client.close()

    def get_json(self, endpoint):
        require(endpoint in {'health', 'access/context'}, 'unsupported-loopback-endpoint')
        client = http.client.HTTPConnection('127.0.0.1', 4383, timeout=self.remaining())
        try:
            client.request('GET', '/api/' + endpoint, headers={'Accept': 'application/json', 'Connection': 'close'})
            status, value = self._response(client)
            require(status == 200, 'loopback-unavailable')
            return value
        finally:
            client.close()


class InstallRequest:
    def __init__(self, operation_path, io):
        require(absolute(operation_path), 'operation-path-invalid')
        self.io = io
        self.operation_path = operation_path
        raw_operation = io.read_bytes(operation_path, 8192)
        self.operation = validate_operation(json.loads(raw_operation))
        self.operation_sha = sha(raw_operation)
        config_bytes = io.read_bytes(CONFIG, 65536, private=False)
        self.config = validate_config(json.loads(config_bytes))
        self.config_sha = sha(config_bytes)
        self.state = self.config['stateDirectory']
        io.protect(self.state, directory=True)
        self.root = posixpath.join(self.state, 'release-coordinator')
        self.audit = posixpath.join(self.root, self.operation['operationId'])
        self.intent_path = posixpath.join(self.audit, 'intent.json')
        self.request = request_for(self.operation)

    def read(self, path, maximum=65536):
        return json.loads(self.io.read_bytes(path, maximum))

    def control(self, action, body=None):
        return self.io.control(action, body or {}, self.config['socketGroup'])

    def prior_identity(self):
        o = self.operation
        health, context = self.io.get_json('health'), self.io.get_json('access/context')
        require(health.get('status') == 'ready' and health.get('candidateId') == o['priorCandidateId']
                and health.get('version') == o['priorVersion'] and health.get('buildVersion') == o['priorBuildVersion']
                and health.get('schemaVersion') == o['schemaVersion'] and health.get('apiVersion') == o['apiVersion']
                and context.get('workspaceEpoch') == o['workspaceEpoch'], 'prior-live-identity-changed')
        require(self.io.runtime_version(self.config) == o['priorAgentVersion'], 'prior-runtime-changed')
        return {key: health[key] for key in ('status', 'candidateId', 'version', 'buildVersion', 'schemaVersion', 'apiVersion')}

    def rehearsal_release(self):
        o = self.operation
        lease = self.read(posixpath.join(self.state, 'operator-maintenance/current.json'), 8192)
        require(lease.get('id') == o['rehearsalLeaseId'] and lease.get('candidateId') == o['priorCandidateId']
                and lease.get('workspaceEpoch') == o['workspaceEpoch'] and lease.get('phase') == 'released'
                and lease.get('releaseKind') == 'rehearsed' and lease.get('stopMarked') is True
                and lease.get('proofSha256') == o['rehearsalProofSha256'], 'full-rehearsal-not-released')
        data = self.io.read_bytes(posixpath.join(self.state, 'operator-maintenance', o['rehearsalLeaseId'], 'acceptance.json'), 8192)
        proof = json.loads(data)
        require(sha(data) == o['rehearsalProofSha256'] and proof.get('format') == 1 and proof.get('kind') == 'operator-maintenance-acceptance'
                and proof.get('outcome') == 'rehearsed' and proof.get('leaseId') == o['rehearsalLeaseId']
                and proof.get('candidateId') == o['priorCandidateId'] and proof.get('workspaceEpoch') == o['workspaceEpoch']
                and all(proof.get(k) is True for k in ('savedWorkVerified', 'accountsVerified', 'recoveryVerified', 'healthVerified')),
                'full-rehearsal-proof-mismatch')
        return {'leaseId': o['rehearsalLeaseId'], 'proofSha256': o['rehearsalProofSha256']}

    def load_intent(self):
        self.io.protect(self.audit, directory=True)
        intent = self.read(self.intent_path, 16384)
        require(isinstance(intent, dict) and intent.get('format') == 1 and intent.get('kind') == 'nova-normal-install-intent'
                and intent.get('operationId') == self.operation['operationId'] and intent.get('operationSha256') == self.operation_sha
                and intent.get('request') == self.request and intent.get('requestSha256') == sha(canonical(self.request))
                and intent.get('automaticResubmissionPermitted') is False, 'saved-intent-identity-changed')
        return intent

    def result(self, state='uncertain', job=None, view=None, reason=None):
        o = self.operation
        view = view if isinstance(view, dict) else {}
        hold = view.get('holdFor')
        current = view.get('job') or {}
        return {'format': 1, 'operationId': o['operationId'], 'candidateId': o['candidateId'], 'priorCandidateId': o['priorCandidateId'],
                'workspaceEpoch': o['workspaceEpoch'], 'idempotencyKey': o['idempotencyKey'], 'releaseId': o['bundleSha256'],
                'jobId': job['id'] if job else None, 'state': state, 'reason': reason,
                'jobHold': job['hold'] if job else None, 'controllerHoldFor': hold if is_uuid(hold) else None,
                'controllerHoldObserved': 'holdFor' in view and (hold is None or is_uuid(hold)),
                'currentJobMatches': bool(job and isinstance(current, dict) and current.get('id') == job['id']
                                          and current.get('candidateId') == o['candidateId'] and current.get('releaseId') == o['bundleSha256']),
                'automaticResubmissionPermitted': False, 'finalAcceptanceRequired': True,
                'targetBuildAcceptanceRequired': True}

    def observe(self, wait_seconds=0):
        self.load_intent()
        deadline = min(self.io.deadline, self.io.monotonic() + wait_seconds)
        while True:
            try:
                job = matched_job(self.read(posixpath.join(self.state, 'jobs/journal.json'), 16 * 1024 ** 2), self.operation)
                status, view = self.control('status')
                require(status == 200, 'controller-status-unavailable')
            except DeadlineExpired:
                return self.result(reason='observation-deadline')
            except Refusal as error:
                return self.result(reason=str(error))
            except Exception:
                return self.result(reason='observation-unavailable')
            result = self.result(job['state'] if job else 'uncertain', job, view, None if job else 'request-not-recorded-or-reply-uncertain')
            if job and job['state'] in TERMINAL or self.io.monotonic() >= deadline:
                return result
            self.io.sleep(min(5, max(0, deadline - self.io.monotonic())))

    def execute(self, wait_seconds=0):
        require(not self.io.exists(self.audit), 'intent-exists-observe-only')
        journal = self.read(posixpath.join(self.state, 'jobs/journal.json'), 16 * 1024 ** 2)
        require(matched_job(journal, self.operation) is None, 'idempotency-already-recorded-observe-only')
        rehearsal, health = self.rehearsal_release(), self.prior_identity()
        status, view = self.control('check')
        require(status == 200, 'signed-feed-check-incomplete')
        validate_offer(view, self.operation, allow_stale=True)
        heartbeat_deadline = min(self.io.deadline, self.io.monotonic() + 45)
        while True:
            status, view = self.control('status')
            require(status == 200, 'controller-status-unavailable')
            if validate_offer(view, self.operation, allow_stale=True):
                break
            require(self.io.monotonic() < heartbeat_deadline, 'fresh-real-heartbeat-not-observed')
            self.io.sleep(1)
        require(self.prior_identity() == health and self.rehearsal_release() == rehearsal, 'prior-authority-changed')
        require(sha(self.io.read_bytes(self.operation_path, 8192)) == self.operation_sha
                and sha(self.io.read_bytes(CONFIG, 65536, private=False)) == self.config_sha, 'operation-or-config-changed')
        status, view = self.control('status')
        require(status == 200 and validate_offer(view, self.operation), 'final-offer-or-heartbeat-changed')
        # An exclusive directory is a reservation, including if intent creation
        # is interrupted. Never reuse a partially written operation directory.
        if not self.io.exists(self.root):
            self.io.mkdir(self.root)
        self.io.protect(self.root, directory=True)
        self.io.mkdir(self.audit)
        self.io.save(self.intent_path, {'format': 1, 'kind': 'nova-normal-install-intent', 'operationId': self.operation['operationId'],
            'operationSha256': self.operation_sha, 'controllerConfigSha256': self.config_sha, 'request': self.request,
            'requestSha256': sha(canonical(self.request)), 'createdAtMilliseconds': self.io.now_ms(),
            'rehearsal': rehearsal, 'priorHealth': health, 'automaticResubmissionPermitted': False})
        try:
            status, response = self.control('install', self.request)
            # Retain only bounded status, never a controller body or message.
            self.io.save(posixpath.join(self.audit, 'response.json'), {'format': 1, 'httpStatus': status,
                'requestSha256': sha(canonical(self.request)), 'automaticResubmissionPermitted': False})
        except Exception:
            try:
                self.io.save(posixpath.join(self.audit, 'response-uncertain.json'), {'format': 1,
                    'reason': 'install-response-uncertain', 'requestSha256': sha(canonical(self.request)),
                    'automaticResubmissionPermitted': False})
            except Exception:
                pass  # The already durable intent remains the original authority.
        return self.observe(wait_seconds)


class StrictParser(argparse.ArgumentParser):
    def error(self, _message):
        raise Refusal('invalid-arguments')


def parse_args(argv=None):
    parser = StrictParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--execute', action='store_true')
    mode.add_argument('--observe', action='store_true')
    parser.add_argument('--operation', required=True)
    parser.add_argument('--wait-seconds', type=int, default=0)
    args = parser.parse_args(argv)
    require(absolute(args.operation), 'operation-path-invalid')
    require(0 <= args.wait_seconds <= MAX_SECONDS, 'wait-outside-bound')
    return args


def main(argv=None):
    def expired(_signum, _frame):
        raise DeadlineExpired('invocation-deadline')
    client, armed = None, False
    try:
        args = parse_args(argv)
        require(sys.platform == 'linux' and os.geteuid() == 0, 'linux-root-required')
        os.umask(0o077)
        signal.signal(signal.SIGALRM, expired)
        signal.setitimer(signal.ITIMER_REAL, MAX_SECONDS)
        armed = True
        client = InstallRequest(args.operation, SystemIO())
        result = client.execute(args.wait_seconds) if args.execute else client.observe(args.wait_seconds)
    except Refusal as error:
        result = client.result(reason=str(error)) if client else {'format': 1, 'state': 'uncertain', 'reason': str(error), 'automaticResubmissionPermitted': False}
    except Exception:
        result = client.result(reason='request-client-unavailable') if client else {'format': 1, 'state': 'uncertain', 'reason': 'request-client-unavailable', 'automaticResubmissionPermitted': False}
    finally:
        if armed:
            signal.setitimer(signal.ITIMER_REAL, 0)
    print(canonical(result).decode(), flush=True)
    return 2 if result['state'] == 'uncertain' else 0


if __name__ == '__main__':
    sys.exit(main())
