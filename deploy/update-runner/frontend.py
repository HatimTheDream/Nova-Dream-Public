"""Signed, root-controlled frontend selection without touching workspace data.

Preparation is complete before taking a service lease. Every network mutation
has a durable intent; resume observes it instead of repeating an uncertain call.
There are no service commands, workspace/database reads or retention operations.
"""
import argparse
import base64
import contextlib
import datetime
import gzip
import hashlib
import http.client
import io
import json
import os
import pathlib
import re
import socket
import stat
import subprocess
import sys
import time
import uuid

try:
    import fcntl
except ImportError:
    fcntl = None

MANIFEST_MAXIMUM = 128 * 1024
ARCHIVE_MAXIMUM = EXPANDED_MAXIMUM = 128 * 1024 ** 2
FILE_MAXIMUM = 32 * 1024 ** 2
FILE_COUNT = 1024
HASH = re.compile(r'[a-f0-9]{64}')
VERSION = re.compile(r'(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)')
VERIFY = r"""
const fs=require('node:fs'), crypto=require('node:crypto');
if(process.versions.node.split('.')[0]!=='22')throw Error('Use the reviewed Node22 verifier.');
const key=crypto.createPublicKey(fs.readFileSync(process.argv[1]));
if(key.asymmetricKeyType!=='ed25519')throw Error('Use the existing Ed25519 trust.');
const raw=fs.readFileSync(0), signature=Buffer.from(process.argv[2],'hex');
if(signature.length!==64||!crypto.verify(null,raw,key,signature))throw Error('Invalid frontend signature.');
process.stdout.write('verified\n');
"""


def require(value, message):
    if not value:
        raise RuntimeError(message)


class ControlRejected(RuntimeError):
    """An acknowledged refusal never acquired a lease or dispatched a switch."""


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def compact(value):
    # Manifest/file keys are ASCII. Avoid ensure_ascii's different UTF8 encoding.
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


def encoded(value):
    return compact(value) + b'\n'


def frontend_identity(files):
    return sha(compact([{'path': entry['path'], 'bytes': entry['bytes'], 'sha256': entry['sha256']} for entry in files]))


def strict_json(raw):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, 'Duplicate JSON key.')
            value[key] = item
        return value
    return json.loads(raw.decode('utf-8'), object_pairs_hook=unique,
                      parse_constant=lambda _: (_ for _ in ()).throw(RuntimeError('Nonfinite JSON number.')))


def fields(value, names, message):
    require(isinstance(value, dict) and set(value) == set(names), message)


def is_hash(value):
    return isinstance(value, str) and HASH.fullmatch(value) is not None


def is_uuid(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except (ValueError, AttributeError):
        return False


def absolute(value):
    return isinstance(value, str) and len(value) <= 4096 and value.startswith('/') and str(pathlib.PurePosixPath(value)) == value


def file_path(value):
    require(isinstance(value, str) and len(value) <= 100 and not value.startswith('/'), 'Unsafe frontend path.')
    parts = value.split('/')
    require(all(part not in ('', '.', '..') and re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]*', part)
                for part in parts) or value == '.vite/manifest.json', 'Unsafe frontend path.')
    require(not value.lower().endswith(('.html', '.htm')) or value == 'index.html', 'Unexpected frontend HTML.')
    require(value in ('index.html', '.vite/manifest.json', 'icons/provenance.json') or pathlib.PurePosixPath(value).suffix.lower()
            in ('.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.otf', '.webmanifest'), 'Unexpected frontend file type.')
    return value


def validate_manifest(value, now=None):
    fields(value, ('format', 'kind', 'channel', 'sequence', 'createdAt', 'expiresAt', 'frontendId',
                  'frontendVersion', 'frontendBuildVersion', 'sourceRevision', 'base', 'artifact', 'files'), 'Invalid frontend manifest fields.')
    require(type(value['format']) is int and value['format'] == 1 and value['kind'] == 'frontend' and value['channel'] == 'frontend-stable', 'Invalid frontend channel.')
    require(type(value['sequence']) is int and 1 <= value['sequence'] <= 2 ** 53 - 1, 'Invalid frontend sequence.')
    for key in ('frontendId',):
        require(is_hash(value[key]), 'Invalid frontend identity.')
    for key in ('frontendVersion', 'frontendBuildVersion'):
        require(isinstance(value[key], str) and VERSION.fullmatch(value[key]), 'Invalid frontend version.')
    require(isinstance(value['sourceRevision'], str) and re.fullmatch(r'[a-f0-9]{40}', value['sourceRevision']), 'Invalid source revision.')
    times = []
    for key in ('createdAt', 'expiresAt'):
        require(isinstance(value[key], str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', value[key]), 'Invalid manifest time.')
        times.append(datetime.datetime.fromisoformat(value[key].replace('Z', '+00:00')).timestamp())
    current = time.time() if now is None else now
    require(times[0] <= current + 300 and times[1] > current and 0 < times[1] - times[0] <= 31 * 86400, 'Frontend manifest is not current.')
    fields(value['base'], ('candidateId', 'serviceInputsSha256', 'apiVersion', 'schemaVersion'), 'Invalid base contract.')
    require(is_hash(value['base']['candidateId']) and is_hash(value['base']['serviceInputsSha256']), 'Invalid base identity.')
    require(type(value['base']['apiVersion']) is int and value['base']['apiVersion'] == 1
            and type(value['base']['schemaVersion']) is int and 1 <= value['base']['schemaVersion'] <= 100000, 'Invalid base compatibility.')
    fields(value['artifact'], ('url', 'bytes', 'sha256'), 'Invalid artifact contract.')
    require(type(value['artifact']['bytes']) is int and 0 < value['artifact']['bytes'] <= ARCHIVE_MAXIMUM
            and is_hash(value['artifact']['sha256']), 'Invalid artifact bounds.')
    from urllib.parse import urlsplit
    url = urlsplit(value['artifact']['url'])
    require(len(value['artifact']['url']) <= 2048 and url.scheme == 'https' and url.netloc and not url.username
            and not url.password and not url.fragment and not url.query, 'Invalid artifact address.')
    require(isinstance(value['files'], list) and 0 < len(value['files']) <= FILE_COUNT, 'Invalid frontend file count.')
    names, expanded = [], 0
    for entry in value['files']:
        fields(entry, ('path', 'bytes', 'sha256'), 'Invalid frontend file fields.')
        names.append(file_path(entry['path']))
        require(type(entry['bytes']) is int and 0 <= entry['bytes'] <= FILE_MAXIMUM and is_hash(entry['sha256']), 'Invalid frontend file bounds.')
        expanded += entry['bytes']
    require(expanded <= EXPANDED_MAXIMUM and names == sorted(set(names)) and 'index.html' in names
            and '.vite/manifest.json' in names, 'Invalid frontend file closure.')
    require(value['frontendId'] == frontend_identity(value['files']), 'Frontend closure identity differs.')
    return value


def validate_operation(value):
    if isinstance(value, dict) and 'rollbackOf' in value:
        fields(value, ('format', 'operationId', 'rollbackOf'), 'Invalid frontend rollback operation.')
        require(type(value['format']) is int and value['format'] == 1 and is_uuid(value['operationId']) and absolute(value['rollbackOf']), 'Invalid frontend rollback identities.')
        return value
    fields(value, ('format', 'operationId', 'manifestPath', 'signaturePath', 'archivePath'), 'Invalid frontend operation.')
    require(type(value['format']) is int and value['format'] == 1 and is_uuid(value['operationId']) and all(absolute(value[key]) for key in ('manifestPath', 'signaturePath', 'archivePath')), 'Invalid operation identities or paths.')
    require(len({value[key] for key in ('manifestPath', 'signaturePath', 'archivePath')}) == 3, 'Frontend inputs must be independent files.')
    return value


def validate_config(value):
    fields(value, ('format', 'frontendDirectory', 'stateDirectory', 'nodeBinary', 'nodeSha256',
                  'publicKeyFile', 'publicKeySha256', 'artifactOrigins', 'controlSocket'), 'Invalid frontend configuration.')
    require(type(value['format']) is int and value['format'] == 1 and all(absolute(value[key]) for key in ('frontendDirectory', 'stateDirectory', 'nodeBinary', 'publicKeyFile', 'controlSocket')), 'Invalid frontend configuration paths.')
    require(value['frontendDirectory'] == '/opt/nova/frontend' and value['stateDirectory'] == '/var/lib/nova-update/frontend', 'Use the provisioned frontend roots.')
    require(value['controlSocket'] == '/run/nova-update/frontend.sock', 'Use the provisioned root-only frontend socket.')
    require(is_hash(value['nodeSha256']) and is_hash(value['publicKeySha256']), 'Unpinned verification inputs.')
    require(isinstance(value['artifactOrigins'], list) and 0 < len(value['artifactOrigins']) <= 8, 'Invalid trusted artifact origins.')
    from urllib.parse import urlsplit
    for item in value['artifactOrigins']:
        require(isinstance(item, str), 'Invalid trusted artifact origin.')
        parsed = urlsplit(item)
        require(parsed.scheme == 'https' and parsed.netloc and not parsed.username and not parsed.password
                and not parsed.query and not parsed.fragment and parsed.path in ('', '/'), 'Invalid trusted artifact origin.')
    return value


def protected(path, directory=False, private=False):
    path = pathlib.Path(path)
    require(path.is_absolute() and path.resolve(strict=True) == path, 'Protected path was redirected.')
    for current in (path, *path.parents):
        info = current.lstat()
        require(not stat.S_ISLNK(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'Frontend authority is not protected by root.')
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode), 'Unexpected frontend path type.')
    require(directory or info.st_nlink == 1, 'Frontend authority needs an independent regular file.')
    require(not private or not info.st_mode & 0o077, 'Frontend private evidence is not private.')


def archive_files(raw, manifest):
    require(len(raw) == manifest['artifact']['bytes'] and sha(raw) == manifest['artifact']['sha256'], 'Frontend archive bytes differ.')
    expected = {entry['path']: entry for entry in manifest['files']}
    # Bound decompression before parsing any header. General-purpose tar readers
    # consume PAX/GNU extension records internally before yielding an entry.
    # This capsule uses only regular USTAR records, so parse that small grammar.
    maximum = min(EXPANDED_MAXIMUM, sum(512 + ((entry['bytes'] + 511) // 512) * 512 for entry in manifest['files']) + 10240)
    with gzip.GzipFile(fileobj=io.BytesIO(raw), mode='rb') as compressed:
        unpacked = compressed.read(maximum + 1)
    require(len(unpacked) <= maximum and len(unpacked) % 512 == 0, 'Frontend archive expansion exceeds its bound.')

    def octal(field):
        value = field.strip(b'\0 ')
        require(re.fullmatch(b'[0-7]+', value) is not None, 'Invalid USTAR numeric field.')
        return int(value, 8)

    result = {}
    offset, ended = 0, False
    while offset + 512 <= len(unpacked):
        header = unpacked[offset:offset + 512]
        if header == bytes(512):
            require(len(unpacked) - offset >= 1024 and not any(unpacked[offset:]), 'Invalid USTAR termination.')
            ended = True
            break
        require(len(result) < FILE_COUNT and header[156:157] in (b'0', b'\0') and header[257:265] == b'ustar\0' + b'00'
                and not any(header[157:257]) and not any(header[345:512]), 'Unsafe frontend USTAR entry.')
        require(octal(header[148:156]) == sum(header[:148]) + 8 * 32 + sum(header[156:]), 'Invalid USTAR checksum.')
        name_raw = header[:100].split(b'\0', 1)[0]
        require(not any(header[len(name_raw):100]), 'Invalid USTAR name padding.')
        name = file_path(name_raw.decode('ascii'))
        mode, size = octal(header[100:108]), octal(header[124:136])
        for start, end in ((108, 116), (116, 124), (136, 148)):
            octal(header[start:end])
        require(name in expected and name not in result and size == expected[name]['bytes'] and size <= FILE_MAXIMUM
                and not mode & 0o7000, 'Unexpected frontend archive entry.')
        offset += 512
        padded = ((size + 511) // 512) * 512
        require(offset + padded <= len(unpacked), 'Truncated frontend USTAR entry.')
        data = unpacked[offset:offset + size]
        require(not any(unpacked[offset + size:offset + padded]) and sha(data) == expected[name]['sha256'], 'Frontend entry bytes differ.')
        result[name] = data
        offset += padded
    require(ended, 'Missing USTAR termination.')
    require(set(result) == set(expected), 'Incomplete frontend archive.')
    return result


class FileIO:
    def protect(self, path, directory=False, private=False):
        protected(path, directory, private)

    def read(self, path, maximum, private=False):
        self.protect(path, private=private)
        info = pathlib.Path(path).lstat()
        require(info.st_size <= maximum, 'Frontend input exceeds its bound.')
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            before = os.fstat(fd)
            require(before.st_ino == info.st_ino and before.st_dev == info.st_dev and before.st_nlink == 1, 'Frontend input changed.')
            with os.fdopen(fd, 'rb', closefd=False) as handle:
                raw = handle.read(maximum + 1)
            require(len(raw) <= maximum and len(raw) == before.st_size, 'Frontend input changed or exceeded its bound.')
            return raw
        finally:
            os.close(fd)

    def sync(self, directory):
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def mkdir(self, path, private=False):
        path = pathlib.Path(path)
        self.protect(path.parent, directory=True)
        try:
            path.mkdir(mode=0o700 if private else 0o755)
            self.sync(path.parent)
        except FileExistsError:
            pass
        self.protect(path, directory=True, private=private)

    def write(self, path, raw, private=True, replace=False):
        path = pathlib.Path(path)
        self.protect(path.parent, directory=True)
        if path.exists() or path.is_symlink():
            self.protect(path, private=private)
            require(replace, 'Frontend record already exists.')
        temporary = path.with_name('.' + path.name + '-' + str(uuid.uuid4()))
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600 if private else 0o644)
        try:
            with os.fdopen(fd, 'wb', closefd=False) as handle:
                handle.write(raw)
                handle.flush()
                os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(temporary, path)
        self.sync(path.parent)

    def remove(self, path):
        self.protect(path)
        pathlib.Path(path).unlink()
        self.sync(pathlib.Path(path).parent)

    def verify_signature(self, config, manifest_raw, signature):
        require(len(signature) == 64, 'Invalid detached Ed25519 signature.')
        require(sha(self.read(config['nodeBinary'], 128 * 1024 ** 2)) == config['nodeSha256']
                and sha(self.read(config['publicKeyFile'], 16384)) == config['publicKeySha256'], 'Frontend verification authority changed.')
        environment = {'PATH': '/usr/bin:/bin', 'NODE_OPTIONS': '', 'NODE_PATH': ''}
        if sys.platform == 'win32':  # Offline crypto tests only; worker is Linux.
            environment['SystemRoot'] = os.environ['SystemRoot']
        result = subprocess.run([config['nodeBinary'], '-e', VERIFY, config['publicKeyFile'], signature.hex()],
                                input=manifest_raw, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30,
                                check=False, env=environment)
        require(result.returncode == 0 and result.stdout == b'verified\n' and len(result.stderr) <= 65536, 'Frontend signature did not verify.')

    def control(self, config, action, body):
        require(action in ('begin', 'end', 'observe', 'cancel-before-begin'), 'Invalid frontend control action.')
        self.protect(pathlib.Path(config['controlSocket']).parent, directory=True)
        info = os.lstat(config['controlSocket'])
        require(stat.S_ISSOCK(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600, 'Frontend control socket is not root-only.')
        content = encoded(body)
        connection = http.client.HTTPConnection('localhost', timeout=10)
        connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.sock.settimeout(10)
        try:
            connection.sock.connect(config['controlSocket'])
            connection.request('POST', '/v1/' + action, body=content,
                               headers={'Content-Type': 'application/json', 'Content-Length': str(len(content)), 'Connection': 'close'})
            response = connection.getresponse()
            raw = response.read(65537)
            require(len(raw) <= 65536, 'Frontend control response exceeds its bound.')
            if response.status == 409:
                raise ControlRejected('Frontend control refused this exact operation.')
            require(response.status == 200 and len(raw) <= 65536, 'Frontend control requires reconciliation.')
            return strict_json(raw)
        finally:
            connection.close()

    def get(self, endpoint):
        require(endpoint in ('health', 'access/context'), 'Invalid frontend loopback read.')
        connection = http.client.HTTPConnection('127.0.0.1', 4383, timeout=10)
        try:
            connection.request('GET', '/api/' + endpoint, headers={'Accept': 'application/json', 'Connection': 'close'})
            response = connection.getresponse()
            raw = response.read(65537)
            require(response.status == 200 and len(raw) <= 65536, 'Live frontend service identity is unavailable.')
            return strict_json(raw)
        finally:
            connection.close()

    @contextlib.contextmanager
    def lock(self, path):
        require(sys.platform == 'linux' and os.geteuid() == 0 and fcntl is not None, 'Use the provisioned Linux root worker.')
        self.protect(pathlib.Path(path).parent, directory=True, private=True)
        descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            self.protect(path, private=True)
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield
        finally:
            os.close(descriptor)


class FrontendWorker:
    def __init__(self, operation_path, config_path, file_io=None):
        self.io = file_io or FileIO()
        self.operation_raw = self.io.read(operation_path, 16384, private=True)
        self.operation = validate_operation(strict_json(self.operation_raw))
        self.config_raw = self.io.read(config_path, 65536, private=True)
        self.config = validate_config(strict_json(self.config_raw))
        self.operation_id = self.operation['operationId']
        self.root = pathlib.Path(self.config['frontendDirectory'])
        self.state = pathlib.Path(self.config['stateDirectory'])
        self.io.protect(self.root, directory=True)
        self.io.protect(self.state, directory=True, private=True)
        self.selector = self.root / 'selector.json'
        self.current = self.state / 'current.json'
        self.journal_path = self.state / (self.operation_id + '.json')

    def optional(self, path, maximum=65536, private=False):
        if pathlib.Path(path).exists() or pathlib.Path(path).is_symlink():
            return self.io.read(path, maximum, private=private)
        self.io.protect(pathlib.Path(path).parent, directory=True)
        return None

    def prepare(self, now=None, resume=False):
        if 'rollbackOf' in self.operation:
            return self.prepare_rollback(resume=resume)
        self.manifest_raw = self.io.read(self.operation['manifestPath'], MANIFEST_MAXIMUM)
        self.signature = self.io.read(self.operation['signaturePath'], 64)
        self.io.verify_signature(self.config, self.manifest_raw, self.signature)
        self.manifest = validate_manifest(strict_json(self.manifest_raw), now=now)
        from urllib.parse import urlsplit
        parsed = urlsplit(self.manifest['artifact']['url'])
        require(parsed.scheme + '://' + parsed.netloc in [origin.rstrip('/') for origin in self.config['artifactOrigins']], 'Untrusted frontend artifact origin.')
        self.files = archive_files(self.io.read(self.operation['archivePath'], ARCHIVE_MAXIMUM), self.manifest)
        self.manifest_sha = sha(self.manifest_raw)
        self.target = self.root / 'releases' / self.manifest['frontendId']
        self.target_selector = {'format': 1, 'frontendId': self.manifest['frontendId'], 'manifestSha256': self.manifest_sha,
                                'manifestPath': str(self.root / 'manifests' / (self.manifest_sha + '.json')),
                                'signaturePath': str(self.root / 'manifests' / (self.manifest_sha + '.sig')), 'operationId': self.operation_id}
        return self.manifest

    def stored_manifest(self, selector):
        fields(selector, ('format', 'frontendId', 'manifestSha256', 'manifestPath', 'signaturePath', 'operationId'), 'Invalid retained frontend selector.')
        require(type(selector['format']) is int and selector['format'] == 1 and is_hash(selector['frontendId']) and is_hash(selector['manifestSha256'])
                and is_uuid(selector['operationId']) and selector['manifestPath'] == str(self.root / 'manifests' / (selector['manifestSha256'] + '.json'))
                and selector['signaturePath'] == str(self.root / 'manifests' / (selector['manifestSha256'] + '.sig')), 'Retained frontend authority escaped its root.')
        raw = self.io.read(selector['manifestPath'], MANIFEST_MAXIMUM)
        signature = self.io.read(selector['signaturePath'], 64)
        require(sha(raw) == selector['manifestSha256'], 'Retained frontend manifest changed.')
        self.io.verify_signature(self.config, raw, signature)
        value = strict_json(raw)
        created = datetime.datetime.fromisoformat(value['createdAt'].replace('Z', '+00:00')).timestamp()
        validate_manifest(value, now=created)
        require(value['frontendId'] == selector['frontendId'], 'Retained frontend closure differs.')
        target = self.root / 'releases' / value['frontendId']
        self.io.protect(target, directory=True)
        require(self.io.read(target / '.frontend-manifest.json', MANIFEST_MAXIMUM) == raw
                and self.io.read(target / '.frontend-manifest.sig', 64) == signature, 'Retained release-local frontend trust changed.')
        files = {entry['path']: self.io.read(target / entry['path'], FILE_MAXIMUM) for entry in value['files']}
        for entry in value['files']:
            require(len(files[entry['path']]) == entry['bytes'] and sha(files[entry['path']]) == entry['sha256'], 'Retained frontend bytes changed.')
        actual = set()
        for path in target.rglob('*'):
            self.io.protect(path, directory=path.is_dir())
            if path.is_file():
                actual.add(path.relative_to(target).as_posix())
        require(actual == set(files) | {'.frontend-manifest.json', '.frontend-manifest.sig'}, 'Unexpected retained frontend files.')
        return raw, signature, value, files

    def prepare_rollback(self, resume=False):
        original_path = pathlib.Path(self.operation['rollbackOf'])
        require(original_path.parent == self.state and original_path.suffix == '.json'
                and is_uuid(original_path.stem) and original_path.stem != self.operation_id, 'Rollback must name a retained operation journal.')
        self.original_raw = self.io.read(original_path, MANIFEST_MAXIMUM, private=True)
        self.original = strict_json(self.original_raw)
        require(type(self.original.get('format')) is int and self.original.get('format') == 1 and self.original.get('operationId') == original_path.stem
                and self.original.get('phase') == 'completed' and self.original.get('outcome') == 'selected'
                and self.original.get('configSha256') == sha(self.config_raw), 'Rollback source is not a completed matching promotion.')
        self.target_selector = self.original['targetSelector']
        self.manifest_raw, self.signature, self.manifest, self.files = self.stored_manifest(self.target_selector)
        self.manifest_sha = sha(self.manifest_raw)
        self.target = self.root / 'releases' / self.manifest['frontendId']
        prior = base64.b64decode(self.original['priorSelector'], validate=True) if self.original['priorSelector'] is not None else None
        current = self.optional(self.selector)
        require(current == encoded(self.target_selector) or resume and current == prior, 'The completed promotion is no longer selected.')
        if prior is not None:
            _, _, prior_manifest, _ = self.stored_manifest(strict_json(prior))
            require(prior_manifest['base'] == self.manifest['base'], 'Prior frontend has a different backend contract.')
            self.restore_frontend = {'id': prior_manifest['frontendId'], 'version': prior_manifest['frontendVersion'],
                                     'buildVersion': prior_manifest['frontendBuildVersion'], 'source': 'frontend'}
        else:
            self.restore_frontend = self.original['health']['frontend']
            require(isinstance(self.restore_frontend, dict) and self.restore_frontend.get('source') == 'bundled', 'The retained bundled frontend identity is missing.')
        require(self.original['health']['candidateId'] == self.manifest['base']['candidateId']
                and self.original['health']['serviceInputsSha256'] == self.manifest['base']['serviceInputsSha256'], 'Original promotion backend binding changed.')
        return self.manifest

    def live(self, response, require_active=None, enforce_base=True):
        fields(response, ('format', 'operationId', 'leaseId', 'leaseProcessIdentity', 'active', 'candidateId', 'serviceInputsSha256',
                          'apiVersion', 'schemaVersion', 'epoch', 'processIdentity'), 'Invalid frontend control response.')
        require(type(response['format']) is int and response['format'] == 1 and type(response['active']) is bool and is_uuid(response['epoch'])
                and is_uuid(response['processIdentity']), 'Invalid live service identity.')
        require(is_hash(response['candidateId']) and is_hash(response['serviceInputsSha256']) and type(response['apiVersion']) is int and response['apiVersion'] == 1
                and type(response['schemaVersion']) is int and response['schemaVersion'] > 0, 'Invalid controller service compatibility.')
        require(not enforce_base or all(response[key] == self.manifest['base'][key] for key in ('candidateId', 'serviceInputsSha256', 'apiVersion', 'schemaVersion')), 'The live service no longer matches this frontend.')
        if response['active']:
            require(response['operationId'] == self.operation_id and response['leaseId'] == self.operation_id
                    and is_uuid(response['leaseProcessIdentity']), 'A different frontend operation owns the service lease.')
        else:
            require(response['operationId'] is None or response['operationId'] == self.operation_id, 'A different frontend operation owns the service record.')
            require(response['leaseId'] is None or is_uuid(response['leaseId']), 'Invalid ended lease identity.')
            require(response['leaseProcessIdentity'] is None or is_uuid(response['leaseProcessIdentity']), 'Invalid lease process identity.')
        require(require_active is None or response['active'] is require_active, 'Frontend lease state differs.')
        return response

    def observe(self, active=None, enforce_base=True):
        return self.live(self.io.control(self.config, 'observe', {'operationId': self.operation_id}), active, enforce_base=enforce_base)

    def health(self, enforce_base=True):
        value = self.io.get('health')
        context = self.io.get('access/context')
        require(isinstance(value, dict) and value.get('status') == 'ready'
                and is_hash(value.get('candidateId')) and is_hash(value.get('serviceInputsSha256'))
                and type(value.get('apiVersion')) is int and value['apiVersion'] == 1
                and type(value.get('schemaVersion')) is int and value['schemaVersion'] > 0
                and (not enforce_base or all(value.get(key) == self.manifest['base'][key] for key in ('candidateId', 'serviceInputsSha256', 'apiVersion', 'schemaVersion')))
                and is_uuid(value.get('processIdentity')) and isinstance(context, dict) and is_uuid(context.get('workspaceEpoch'))
                and context.get('recovery') is False and context.get('recoveryLocal') is False, 'Live service is incompatible or in recovery.')
        frontend = value.get('frontend')
        require(frontend is None or isinstance(frontend, dict) and (not enforce_base or frontend.get('blocked') is not True)
                and is_hash(frontend.get('id')) and isinstance(frontend.get('version'), str) and VERSION.fullmatch(frontend['version'])
                and isinstance(frontend.get('buildVersion'), str) and VERSION.fullmatch(frontend['buildVersion'])
                and frontend.get('source') in ('bundled', 'frontend') and set(frontend) in ({'id', 'version', 'buildVersion', 'source'}, {'id', 'version', 'buildVersion', 'source', 'blocked'}), 'Live frontend selection is blocked or invalid.')
        return {key: value.get(key) for key in ('candidateId', 'serviceInputsSha256', 'apiVersion', 'schemaVersion', 'processIdentity', 'frontend')} | {'epoch': context['workspaceEpoch']}

    def same_health(self, journal, selected=None):
        value = self.health()
        require(all(value[key] == journal['health'][key] for key in ('candidateId', 'serviceInputsSha256', 'apiVersion', 'schemaVersion', 'processIdentity', 'epoch')), 'The frontend operation crossed a service restart or workspace change.')
        if selected is True:
            require(value.get('frontend') == {'id': self.manifest['frontendId'], 'version': self.manifest['frontendVersion'],
                    'buildVersion': self.manifest['frontendBuildVersion'], 'source': 'frontend'}, 'The selected frontend is not being served.')
        elif selected is False:
            require(value.get('frontend') == journal.get('restoreFrontend', journal['health']['frontend']), 'The prior frontend was not restored.')
        return value

    def prior_recovery(self, prior, bundled):
        if prior is None:
            require(isinstance(bundled, dict) and bundled.get('source') == 'bundled' and bundled.get('id') == self.manifest['base']['candidateId'], 'Bundled recovery identity differs.')
            return {'format': 1, 'selectorSha256': None, 'frontend': bundled, 'base': self.manifest['base']}
        raw, signature, manifest, _ = self.stored_manifest(strict_json(prior))
        require(manifest['base'] == self.manifest['base'], 'Prior frontend has a different backend contract.')
        return {'format': 1, 'selectorSha256': sha(prior), 'manifestSha256': sha(raw), 'signatureSha256': sha(signature),
                'frontend': {'id': manifest['frontendId'], 'version': manifest['frontendVersion'], 'buildVersion': manifest['frontendBuildVersion'], 'source': 'frontend'},
                'base': manifest['base'], 'filesSha256': frontend_identity(manifest['files'])}

    def plan(self):
        self.prepare()
        require(self.optional(self.current, private=True) is None and self.optional(self.journal_path, private=True) is None, 'Reconcile the existing frontend operation before planning another.')
        previous = self.optional(self.selector)
        live = self.observe(False)
        health = self.health()
        require(live['epoch'] == health['epoch'], 'Controller and service workspace identities differ.')
        if 'rollbackOf' in self.operation:
            require(all(health[key] == self.original['health'][key] for key in ('candidateId', 'serviceInputsSha256', 'apiVersion', 'schemaVersion', 'processIdentity', 'epoch')), 'Rollback crossed a service restart or workspace change.')
            prior = base64.b64decode(self.original['priorSelector'], validate=True) if self.original['priorSelector'] is not None else None
            recovery = self.prior_recovery(prior, self.restore_frontend)
            return {'format': 1, 'operationId': self.operation_id, 'operationSha256': sha(self.operation_raw),
                    'configSha256': sha(self.config_raw), 'manifestSha256': self.manifest_sha, 'signatureSha256': sha(self.signature),
                    'frontendId': self.manifest['frontendId'], 'selectorSha256': sha(previous) if previous else None,
                    'rollbackOf': self.operation['rollbackOf'], 'originalJournalSha256': sha(self.original_raw),
                    'priorSelectorSha256': sha(base64.b64decode(self.original['priorSelector'])) if self.original['priorSelector'] is not None else None,
                    'priorRecovery': recovery, 'live': live, 'health': health}
        recovery = self.prior_recovery(previous, health['frontend'])
        high_raw = self.optional(self.state / 'sequence.json', private=True)
        high = strict_json(high_raw) if high_raw else {'format': 1, 'sequence': 0, 'manifestSha256': None}
        fields(high, ('format', 'sequence', 'manifestSha256'), 'Invalid frontend sequence record.')
        require(type(high['format']) is int and high['format'] == 1 and type(high['sequence']) is int and high['sequence'] >= 0
                and (high['manifestSha256'] is None or is_hash(high['manifestSha256'])), 'Invalid frontend sequence record.')
        require(self.manifest['sequence'] > high['sequence'] or self.manifest['sequence'] == high['sequence']
                and self.manifest_sha == high['manifestSha256'], 'Frontend sequence rollback or equivocation.')
        return {'format': 1, 'operationId': self.operation_id, 'operationSha256': sha(self.operation_raw),
                'configSha256': sha(self.config_raw), 'manifestSha256': self.manifest_sha, 'signatureSha256': sha(self.signature),
                'archiveSha256': self.manifest['artifact']['sha256'], 'frontendId': self.manifest['frontendId'],
                'selectorSha256': sha(previous) if previous else None, 'sequenceRecordSha256': sha(high_raw) if high_raw else None,
                'priorRecovery': recovery, 'live': live, 'health': health}

    def journal(self, value):
        self.io.write(self.journal_path, encoded(value), replace=self.journal_path.exists())

    def phase(self, journal, phase, **values):
        journal.update(phase=phase, **values)
        self.journal(journal)

    def materialize(self):
        for name in ('releases', 'manifests'):
            self.io.mkdir(self.root / name)
        if self.target.exists() or self.target.is_symlink():
            self.verify_materialized()
        else:
            staging = self.root / 'releases' / ('.prepare-' + self.operation_id)
            require(not staging.exists() and not staging.is_symlink(), 'An incomplete frontend preparation requires reconciliation.')
            self.io.mkdir(staging)
            for name, raw in self.files.items():
                path = staging / name
                for parent in reversed(path.parents):
                    if parent != staging and parent.is_relative_to(staging):
                        self.io.mkdir(parent)
                self.io.write(path, raw, private=False)
            os.rename(staging, self.target)
            self.io.sync(self.target.parent)
            self.verify_materialized()
        for path, raw in ((self.target_selector['manifestPath'], self.manifest_raw),
                          (self.target_selector['signaturePath'], self.signature),
                          (self.target / '.frontend-manifest.json', self.manifest_raw),
                          (self.target / '.frontend-manifest.sig', self.signature)):
            old = self.optional(path, MANIFEST_MAXIMUM)
            if old is None:
                self.io.write(path, raw, private=False)
            else:
                require(old == raw, 'Immutable frontend authority bytes changed.')

    def verify_materialized(self):
        self.io.protect(self.target, directory=True)
        found = set()
        for path in self.target.rglob('*'):
            self.io.protect(path, directory=path.is_dir())
            if path.is_file():
                name = path.relative_to(self.target).as_posix()
                if name in ('.frontend-manifest.json', '.frontend-manifest.sig'):
                    require(self.io.read(path, MANIFEST_MAXIMUM) == (self.manifest_raw if name.endswith('.json') else self.signature), 'Release-local frontend trust changed.')
                    continue
                require(name in self.files and self.io.read(path, FILE_MAXIMUM) == self.files[name], 'Immutable frontend asset changed.')
                found.add(name)
        require(found == set(self.files), 'Immutable frontend closure is incomplete.')

    def execute(self, plan_path, intent_path):
        with self.io.lock(self.state / 'worker.lock'):
            plan_raw = self.io.read(plan_path, MANIFEST_MAXIMUM, private=True)
            intent = strict_json(self.io.read(intent_path, 16384, private=True))
            fields(intent, ('format', 'operationId', 'planSha256', 'operationSha256'), 'Invalid frontend execution intent.')
            require(type(intent['format']) is int and intent == {'format': 1, 'operationId': self.operation_id, 'planSha256': sha(plan_raw),
                               'operationSha256': sha(self.operation_raw)}, 'Frontend intent is not bound to the exact plan.')
            require(type(strict_json(plan_raw).get('format')) is int and strict_json(plan_raw) == self.plan(), 'Frontend admission changed after the read-only plan.')
            previous = self.optional(self.selector)
            journal = {'format': 1, 'operationId': self.operation_id, 'operationSha256': sha(self.operation_raw),
                       'configSha256': sha(self.config_raw), 'manifestSha256': self.manifest_sha,
                       'frontendId': self.manifest['frontendId'], 'planSha256': sha(plan_raw), 'phase': 'preparing',
                       'priorSelector': self.original['priorSelector'] if 'rollbackOf' in self.operation else base64.b64encode(previous).decode() if previous else None,
                       'beforeSelector': base64.b64encode(previous).decode() if previous else None,
                       'targetSelector': self.target_selector, 'live': strict_json(plan_raw)['live'], 'leaseId': None,
                       'health': strict_json(plan_raw)['health'],
                       'priorRecovery': strict_json(plan_raw)['priorRecovery'],
                       'originalControllerProcessIdentity': strict_json(plan_raw)['live']['processIdentity'],
                       'createdAt': int(time.time() * 1000)}
            if 'rollbackOf' in self.operation:
                journal.update(rollbackOf=self.operation['rollbackOf'], originalJournalSha256=sha(self.original_raw), restoreFrontend=self.restore_frontend)
            self.journal(journal)
            # Persist the original inputs before the first materialization write.
            # An interrupted preparation can then be fenced without replaying
            # admission or discarding its partially written asset evidence.
            if 'rollbackOf' not in self.operation:
                self.materialize()
            self.phase(journal, 'prepared')
            self.io.write(self.current, encoded({'format': 1, 'operationId': self.operation_id, 'journalPath': str(self.journal_path)}))
            self.phase(journal, 'begin-intent')
            try:
                begin = self.live(self.io.control(self.config, 'begin', {'operationId': self.operation_id,
                                  'baseCandidateId': self.manifest['base']['candidateId'],
                                  'serviceInputsSha256': self.manifest['base']['serviceInputsSha256'],
                                  'workspaceEpoch': journal['health']['epoch']}), True)
            except ControlRejected:
                self.phase(journal, 'completed', outcome='refused', completedAt=int(time.time() * 1000))
                self.clear_marker(journal)
                return journal
            require(begin['leaseId'] == self.operation_id and begin['epoch'] == journal['live']['epoch']
                    and begin['processIdentity'] == journal['live']['processIdentity']
                    and begin['leaseProcessIdentity'] == begin['processIdentity'], 'Controller changed during frontend lease admission.')
            self.phase(journal, 'leased', leaseId=begin['leaseId'], live=begin)
            if 'rollbackOf' in self.operation:
                self.phase(journal, 'rollback-intent')
            return self.finish(journal)

    def same_service(self, journal, view):
        require(view['epoch'] == journal['live']['epoch'] and view['processIdentity'] == journal.get('reconciledControllerProcessIdentity', journal['live']['processIdentity'])
                and view['leaseId'] == journal['leaseId'] and view['leaseProcessIdentity'] == journal['live']['leaseProcessIdentity'], 'The leased service process or workspace changed.')

    def restore(self, journal):
        current = self.optional(self.selector)
        target = encoded(journal['targetSelector'])
        prior = base64.b64decode(journal['priorSelector'], validate=True) if journal['priorSelector'] is not None else None
        require(current in (target, prior), 'A different selector prevents frontend rollback.')
        require(self.prior_recovery(prior, journal['priorRecovery']['frontend']) == journal['priorRecovery'], 'Prior frontend recovery changed after qualification.')
        if current != prior:
            self.phase(journal, 'rollback-intent')
            self.same_service(journal, self.observe(True))
            self.same_health(journal)
            if prior is None:
                self.io.remove(self.selector)
            else:
                self.io.write(self.selector, prior, private=False, replace=True)
        self.phase(journal, 'rolled-back')
        self.same_health(journal, selected=False)

    def finish(self, journal):
        try:
            if journal['phase'] in ('leased', 'selector-intent'):
                self.same_service(journal, self.observe(True))
                self.same_health(journal)
                current = self.optional(self.selector)
                target = encoded(journal['targetSelector'])
                prior = base64.b64decode(journal['priorSelector'], validate=True) if journal['priorSelector'] is not None else None
                require(current in (prior, target), 'A different frontend selection requires reconciliation.')
                self.phase(journal, 'selector-intent')
                if current != target:
                    require(time.time() < datetime.datetime.fromisoformat(self.manifest['expiresAt'].replace('Z', '+00:00')).timestamp(), 'Frontend admission expired before atomic selection.')
                    self.io.write(self.selector, target, private=False, replace=current is not None)
                self.phase(journal, 'selected')
            if journal['phase'] == 'selected':
                self.verify_materialized()
                self.same_service(journal, self.observe(True))
                self.same_health(journal, selected=True)
                self.io.write(self.state / 'sequence.json', encoded({'format': 1, 'sequence': self.manifest['sequence'],
                              'manifestSha256': self.manifest_sha}), replace=(self.state / 'sequence.json').exists())
                self.phase(journal, 'end-intent', outcome='selected')
            elif journal['phase'] in ('rollback-intent', 'rolled-back'):
                self.restore(journal)
                self.phase(journal, 'end-intent', outcome='restored')
            require(journal['phase'] == 'end-intent', 'Unexpected frontend closeout phase.')
        except Exception:
            # Only a retained exact live lease authorizes compensating selection.
            # A control timeout leaves the marker/journal for resume, not retry.
            if journal['phase'] not in ('end-intent', 'rollback-intent', 'rolled-back'):
                try:
                    self.same_service(journal, self.observe(True))
                    self.restore(journal)
                    self.phase(journal, 'end-intent', outcome='restored')
                except Exception:
                    raise
            else:
                raise
        end = self.live(self.io.control(self.config, 'end', {'operationId': self.operation_id, 'leaseId': journal['leaseId']}), False)
        self.same_service(journal, end)
        self.phase(journal, 'completed', completedAt=int(time.time() * 1000))
        self.clear_marker(journal)
        return journal

    def clear_marker(self, journal, absent_ok=False):
        marker = self.optional(self.current, private=True)
        if marker is None and absent_ok:
            return
        require(marker is not None and type(strict_json(marker).get('format')) is int and strict_json(marker) == {'format': 1, 'operationId': self.operation_id,
                'journalPath': str(self.journal_path)}, 'Frontend operation marker changed.')
        self.io.remove(self.current)

    def cancel_before_begin(self, journal, view):
        require(not view['active'], 'Another active lease prevents safe frontend cancellation.')
        prior = base64.b64decode(journal['beforeSelector'], validate=True) if journal['beforeSelector'] is not None else None
        require(self.optional(self.selector) == prior, 'Selection changed before frontend admission was acknowledged.')
        actual = self.health(enforce_base=False)
        require(all(actual[key] == view[key] for key in ('candidateId', 'serviceInputsSha256', 'apiVersion', 'schemaVersion', 'epoch')), 'Controller and actual service differ before cancellation.')
        if journal['phase'] != 'cancel-intent' or view['leaseId'] != self.operation_id:
            self.phase(journal, 'cancel-intent')
            cancelled = self.live(self.io.control(self.config, 'cancel-before-begin', {'operationId': self.operation_id,
                       'baseCandidateId': self.manifest['base']['candidateId'], 'serviceInputsSha256': self.manifest['base']['serviceInputsSha256'],
                       'workspaceEpoch': journal['health']['epoch']}), False, enforce_base=False)
            require(cancelled['leaseId'] == self.operation_id, 'Frontend cancellation was not durably fenced.')
        self.phase(journal, 'completed', outcome='refused', abortObservation=actual, completedAt=int(time.time() * 1000))
        self.clear_marker(journal, absent_ok=True)
        return journal

    def resume(self):
        with self.io.lock(self.state / 'worker.lock'):
            journal = strict_json(self.io.read(self.journal_path, MANIFEST_MAXIMUM, private=True))
            require(type(journal.get('createdAt')) is int, 'Frontend journal time is missing.')
            # Installed signed bytes remain usable for compensation after their
            # admission window; expiration never permits a new selection.
            self.prepare(now=journal['createdAt'] / 1000, resume=True)
            require(type(journal.get('format')) is int and journal.get('format') == 1 and journal.get('operationId') == self.operation_id
                    and journal.get('operationSha256') == sha(self.operation_raw) and journal.get('configSha256') == sha(self.config_raw)
                    and journal.get('manifestSha256') == self.manifest_sha and journal.get('targetSelector') == self.target_selector,
                    'Frontend journal does not match immutable operation inputs.')
            if 'rollbackOf' in self.operation:
                require(journal.get('rollbackOf') == self.operation['rollbackOf'] and journal.get('originalJournalSha256') == sha(self.original_raw)
                        and journal.get('priorSelector') == self.original['priorSelector'] and journal.get('restoreFrontend') == self.restore_frontend, 'Rollback journal bindings changed.')
            if journal['phase'] == 'completed':
                expected = encoded(journal['targetSelector']) if journal['outcome'] == 'selected' else base64.b64decode(journal['beforeSelector']) if journal['outcome'] == 'refused' and journal['beforeSelector'] is not None else None if journal['outcome'] == 'refused' else base64.b64decode(journal['priorSelector']) if journal['priorSelector'] is not None else None
                require(self.optional(self.selector) == expected, 'Completed frontend selection changed.')
                if self.optional(self.current, private=True) is not None:
                    self.clear_marker(journal)
                return journal
            marker = self.optional(self.current, private=True)
            if marker is not None:
                require(type(strict_json(marker).get('format')) is int and strict_json(marker) == {'format': 1, 'operationId': self.operation_id, 'journalPath': str(self.journal_path)}, 'A different frontend worker owns the marker.')
            else:
                require(journal['phase'] in ('preparing', 'prepared', 'begin-intent', 'cancel-intent'), 'Incomplete frontend operation lost its marker.')
            view = self.observe(enforce_base=journal['phase'] not in ('preparing', 'prepared', 'begin-intent', 'cancel-intent'))
            if journal['phase'] in ('preparing', 'prepared', 'begin-intent', 'cancel-intent') and not view['active']:
                return self.cancel_before_begin(journal, view)
            original_controller = journal.get('originalControllerProcessIdentity', journal['live']['processIdentity'])
            require(view['leaseId'] == self.operation_id and view['leaseProcessIdentity'] == original_controller
                    and view['epoch'] == journal['health']['epoch'], 'The durable frontend lease does not match its original intent.')
            self.same_health(journal)
            if view['processIdentity'] != journal['live']['processIdentity']:
                self.phase(journal, journal['phase'], reconciledControllerProcessIdentity=view['processIdentity'])
            if journal['phase'] == 'begin-intent':
                require(view['active'], 'Unacknowledged begin remains uncertain; do not repeat it.')
                self.phase(journal, 'leased', leaseId=view['leaseId'], live=view)
                if 'rollbackOf' in self.operation:
                    self.phase(journal, 'rollback-intent')
            elif journal['phase'] == 'end-intent':
                self.same_service(journal, view)
                expected = encoded(journal['targetSelector']) if journal['outcome'] == 'selected' else base64.b64decode(journal['priorSelector'], validate=True) if journal['priorSelector'] is not None else None
                require(self.optional(self.selector) == expected, 'End reconciliation found a different selector.')
                self.same_health(journal, selected=journal['outcome'] == 'selected')
                if view['active']:
                    # END is an idempotent closure of this original durable lease,
                    # admitted only after observe proves the exact selected bytes.
                    return self.finish(journal)
                self.phase(journal, 'completed', completedAt=int(time.time() * 1000))
                self.clear_marker(journal)
                return journal
            if journal['phase'] in ('leased', 'selector-intent') and time.time() >= datetime.datetime.fromisoformat(self.manifest['expiresAt'].replace('Z', '+00:00')).timestamp():
                self.phase(journal, 'rollback-intent')
            return self.finish(journal)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--plan', metavar='OPERATION')
    mode.add_argument('--execute', metavar='OPERATION')
    mode.add_argument('--resume', metavar='OPERATION')
    parser.add_argument('--config', required=True)
    parser.add_argument('--plan-receipt')
    parser.add_argument('--intent')
    args = parser.parse_args()
    require(sys.platform == 'linux' and os.geteuid() == 0, 'Use the provisioned Linux root frontend worker.')
    worker = FrontendWorker(args.plan or args.execute or args.resume, args.config)
    if args.plan:
        require(not args.plan_receipt and not args.intent, 'Planning has no execution intent.')
        result = worker.plan()
    elif args.execute:
        require(args.plan_receipt and args.intent, 'Execution needs the exact plan and separate intent.')
        result = worker.execute(args.plan_receipt, args.intent)
    else:
        require(not args.plan_receipt and not args.intent, 'Resume uses the retained exact intent.')
        result = worker.resume()
    print(json.dumps(result, separators=(',', ':')))


if __name__ == '__main__':
    main()
