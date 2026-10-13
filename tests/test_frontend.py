"""Offline frontend admission, atomic-selection and uncertainty regressions.

Fixtures use synthetic files and an in-memory controller. No production paths,
HTTP/socket calls, databases, user data, production signing keys or services are accessed.
"""
import base64
import contextlib
import copy
import datetime
import gzip
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'deploy' / 'update-runner'))
import frontend


def archive(files, extra=None):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz', format=tarfile.USTAR_FORMAT) as bundle:
        for name, raw in files.items():
            entry = tarfile.TarInfo(name)
            entry.mode = 0o644
            entry.size = len(raw)
            bundle.addfile(entry, io.BytesIO(raw))
        if extra is not None:
            bundle.addfile(extra)
    return output.getvalue()


def manifest(files=None):
    files = files or {'index.html': b'<html><head></head><body></body></html>', 'assets/ui.js': b'export default 1;', '.vite/manifest.json': b'{}'}
    entries = [{'path': name, 'bytes': len(raw), 'sha256': frontend.sha(raw)} for name, raw in sorted(files.items())]
    raw = archive(files)
    now = datetime.datetime.now(datetime.timezone.utc)
    stamp = lambda value: value.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    return {'format': 1, 'kind': 'frontend', 'channel': 'frontend-stable', 'sequence': 1,
            'createdAt': stamp(now - datetime.timedelta(seconds=1)), 'expiresAt': stamp(now + datetime.timedelta(days=1)),
            'frontendId': frontend.sha(frontend.compact(entries)), 'frontendVersion': '2.3.1', 'frontendBuildVersion': '1.0.290',
            'sourceRevision': 'a' * 40, 'base': {'candidateId': 'b' * 64, 'serviceInputsSha256': 'c' * 64, 'apiVersion': 1, 'schemaVersion': 55},
            'artifact': {'url': 'https://example.invalid/ui.tgz', 'bytes': len(raw), 'sha256': frontend.sha(raw)}, 'files': entries}, raw


class Crash(BaseException):
    pass


class FixtureIO(frontend.FileIO):
    """Real temporary file/rename behavior; only root ownership is substituted."""
    def __init__(self, fixture):
        self.fixture = fixture
        self.calls = []
        self.lease = None
        self.active = False
        self.controller_id = str(uuid.uuid4())
        self.lease_controller_id = None
        self.service_id = str(uuid.uuid4())
        self.epoch = str(uuid.uuid4())
        self.crash_after_selector = False
        self.crash_after_prepared = False
        self.crash_during_materialization = False
        self.crash_after_preparing = False
        self.crash_before_begin = False
        self.crash_before_end = False
        self.expire_before_selector = False
        self.expired_time = None
        self.corrupt_after_selector = None
        self.cancelled_ids = set()
        self.current_base = copy.deepcopy(fixture.value['base'])
        self.fail_begin_after_commit = False
        self.fail_end_after_commit = False
        self.refuse_begin = False
        self.bad_selected_health = False
        self.restart_after_selection = False
        self.signature_valid = True
        self.syncs = []

    def protect(self, path, directory=False, private=False):
        path = pathlib.Path(path)
        frontend.require(path.is_relative_to(self.fixture.root) and path.resolve(strict=True) == path and not path.is_symlink(), 'Fixture path redirected.')
        frontend.require(path.is_dir() if directory else path.is_file(), 'Unexpected fixture path type.')
        frontend.require(directory or path.stat().st_nlink == 1, 'Hardlinked fixture authority.')

    def read(self, path, maximum, private=False):
        self.protect(path, private=private)
        raw = pathlib.Path(path).read_bytes()
        frontend.require(len(raw) <= maximum, 'Fixture input exceeded its bound.')
        return raw

    def sync(self, directory):
        self.syncs.append(str(directory))

    def mkdir(self, path, private=False):
        self.protect(pathlib.Path(path).parent, directory=True)
        pathlib.Path(path).mkdir(exist_ok=True)
        self.protect(path, directory=True)

    def write(self, path, raw, private=True, replace=False):
        path = pathlib.Path(path)
        self.protect(path.parent, directory=True)
        if path.exists():
            self.protect(path)
            frontend.require(replace, 'Fixture record already exists.')
        temporary = path.with_name('.test-' + str(uuid.uuid4()))
        with temporary.open('xb') as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        self.sync(path.parent)
        if any(part == '.prepare-' + self.fixture.operation_id for part in path.parts) and self.crash_during_materialization:
            self.crash_during_materialization = False
            raise Crash('Synthetic process termination during asset preparation.')
        if path == self.fixture.root / 'state' / (self.fixture.operation_id + '.json'):
            phase = json.loads(raw)['phase']
            if phase == 'preparing' and self.crash_after_preparing:
                self.crash_after_preparing = False
                raise Crash('Synthetic process termination after preparation intent.')
            if phase == 'prepared' and self.crash_after_prepared:
                self.crash_after_prepared = False
                raise Crash('Synthetic process termination before worker marker.')
            if phase == 'selector-intent' and self.expire_before_selector:
                self.expired_time = datetime.datetime.fromisoformat(self.fixture.value['expiresAt'].replace('Z', '+00:00')).timestamp() + 1
        if path == self.fixture.root / 'frontend' / 'selector.json' and self.corrupt_after_selector is not None:
            self.corrupt_after_selector.write_bytes(b'corrupted retained recovery')
            self.corrupt_after_selector = None
            self.bad_selected_health = True
        if path == self.fixture.root / 'frontend' / 'selector.json' and self.crash_after_selector:
            self.crash_after_selector = False
            raise Crash('Synthetic process termination after atomic replacement.')

    def verify_signature(self, config, manifest_raw, signature):
        frontend.require(self.signature_valid and len(signature) == 64, 'Synthetic signature refusal.')

    @contextlib.contextmanager
    def lock(self, path):
        yield

    def control(self, config, action, body):
        self.calls.append((action, copy.deepcopy(body)))
        if action == 'begin':
            if self.crash_before_begin:
                self.crash_before_begin = False
                raise Crash('Synthetic process termination before controller admission.')
            if self.refuse_begin:
                raise frontend.ControlRejected('Synthetic busy controller.')
            frontend.require(body['operationId'] not in self.cancelled_ids, 'A cancelled admission is fenced.')
            frontend.require(not self.active and body['workspaceEpoch'] == self.epoch, 'Fixture admission refused.')
            self.active = True
            self.lease = body['operationId']
            self.lease_controller_id = self.controller_id
            if self.fail_begin_after_commit:
                self.fail_begin_after_commit = False
                raise TimeoutError('Synthetic lost begin acknowledgement.')
        elif action == 'end':
            if self.crash_before_end:
                self.crash_before_end = False
                raise Crash('Synthetic process termination after end intent before closure.')
            frontend.require(body['operationId'] == body['leaseId'] == self.lease, 'Fixture end refused.')
            self.active = False
            if self.fail_end_after_commit:
                self.fail_end_after_commit = False
                raise TimeoutError('Synthetic lost end acknowledgement.')
        elif action == 'cancel-before-begin':
            frontend.require(not self.active, 'A live lease prevents cancellation.')
            self.cancelled_ids.add(body['operationId'])
            self.lease = body['operationId']
            self.lease_controller_id = self.controller_id
        lease = self.lease if self.active or self.lease == body['operationId'] else None
        return {'format': 1, 'operationId': body['operationId'], 'leaseId': lease, 'leaseProcessIdentity': self.lease_controller_id if lease else None,
                'active': self.active, **self.current_base, 'epoch': self.epoch, 'processIdentity': self.controller_id}

    def get(self, endpoint):
        if endpoint == 'access/context':
            return {'workspaceEpoch': self.epoch, 'recovery': False, 'recoveryLocal': False}
        selector = self.fixture.root / 'frontend' / 'selector.json'
        ui = {'id': 'b' * 64, 'version': '2.3.0', 'buildVersion': '1.0.289', 'source': 'bundled'}
        if selector.exists():
            value = json.loads(selector.read_bytes())
            selected = json.loads(pathlib.Path(value['manifestPath']).read_bytes())
            ui = {'id': value['frontendId'], 'version': selected['frontendVersion'],
                  'buildVersion': selected['frontendBuildVersion'], 'source': 'frontend'}
            if self.bad_selected_health:
                ui['id'] = 'd' * 64
            if self.restart_after_selection:
                self.service_id = str(uuid.uuid4())
        return {'status': 'ready', **self.current_base, 'processIdentity': self.service_id, 'frontend': ui}


class Fixture:
    def __init__(self, root):
        self.root = pathlib.Path(root)
        (self.root / 'frontend').mkdir()
        (self.root / 'state').mkdir()
        self.value, raw = manifest()
        self.operation_id = str(uuid.uuid4())
        self.operation_path = self.root / 'operation.json'
        self.operation = {'format': 1, 'operationId': self.operation_id, 'manifestPath': str(self.root / 'manifest.json'),
                          'signaturePath': str(self.root / 'manifest.sig'), 'archivePath': str(self.root / 'ui.tgz')}
        self.config = {'format': 1, 'frontendDirectory': str(self.root / 'frontend'), 'stateDirectory': str(self.root / 'state'),
                       'nodeBinary': '/opt/nova/node/bin/node', 'nodeSha256': '1' * 64, 'publicKeyFile': '/etc/nova/release.pem',
                       'publicKeySha256': '2' * 64, 'artifactOrigins': ['https://example.invalid'], 'controlSocket': '/run/nova-update/frontend.sock'}
        for name, data in (('manifest.json', frontend.encoded(self.value)), ('manifest.sig', b's' * 64), ('ui.tgz', raw),
                           ('operation.json', frontend.encoded(self.operation)), ('config.json', frontend.encoded(self.config))):
            (self.root / name).write_bytes(data)
        self.io = FixtureIO(self)

    def worker(self):
        # Provisioned paths are separately tested; fixture state uses temporary
        # paths so these tests cannot operate on production directories.
        with patch.object(frontend, 'validate_config', lambda value: value), patch.object(frontend, 'validate_operation', lambda value: value):
            return frontend.FrontendWorker(self.operation_path, self.root / 'config.json', self.io)

    def plan(self):
        value = self.worker().plan()
        raw = frontend.encoded(value)
        (self.root / 'plan.json').write_bytes(raw)
        (self.root / 'intent.json').write_bytes(frontend.encoded({'format': 1, 'operationId': self.operation_id,
                'planSha256': frontend.sha(raw), 'operationSha256': frontend.sha(self.operation_path.read_bytes())}))
        return value

    def execute(self):
        return self.worker().execute(self.root / 'plan.json', self.root / 'intent.json')

    def calls(self, action):
        return sum(name == action for name, _ in self.io.calls)

    def journal(self):
        return json.loads((self.root / 'state' / (self.operation_id + '.json')).read_bytes())

    def rollback(self, original_id):
        self.operation_id = str(uuid.uuid4())
        self.operation_path = self.root / (self.operation_id + '.json')
        self.operation = {'format': 1, 'operationId': self.operation_id, 'rollbackOf': str(self.root / 'state' / (original_id + '.json'))}
        self.operation_path.write_bytes(frontend.encoded(self.operation))

    def next_promotion(self):
        self.operation_id = str(uuid.uuid4())
        self.operation_path = self.root / (self.operation_id + '.json')
        self.value, raw = manifest({'index.html': b'<html><head></head><body>new</body></html>', 'assets/ui.js': b'export default 2;', '.vite/manifest.json': b'{}'})
        self.value['sequence'] = 2
        self.operation = {'format': 1, 'operationId': self.operation_id,
                          'manifestPath': str(self.root / 'next-manifest.json'), 'signaturePath': str(self.root / 'next-manifest.sig'),
                          'archivePath': str(self.root / 'next-ui.tgz')}
        for path, data in ((self.operation['manifestPath'], frontend.encoded(self.value)),
                           (self.operation['signaturePath'], b's' * 64), (self.operation['archivePath'], raw),
                           (self.operation_path, frontend.encoded(self.operation))):
            pathlib.Path(path).write_bytes(data)


class ManifestTests(unittest.TestCase):
    def test_valid_exact_closure(self):
        value, raw = manifest()
        self.assertEqual(frontend.validate_manifest(value), value)
        self.assertEqual(set(frontend.archive_files(raw, value)), {'index.html', 'assets/ui.js', '.vite/manifest.json'})

    def test_canonical_identity_ignores_object_key_order(self):
        value, _ = manifest()
        value['files'] = [{'sha256': entry['sha256'], 'bytes': entry['bytes'], 'path': entry['path']} for entry in value['files']]
        self.assertEqual(frontend.validate_manifest(value), value)

    def test_required_vite_and_strict_version_or_format_refusals(self):
        for mutate in (lambda v: v.update(format=True), lambda v: v.update(frontendVersion='01.2.3'),
                       lambda v: v.update(frontendVersion='1.2.3-beta'), lambda v: v.update(frontendBuildVersion='1.02.3'),
                       lambda v: v.update(files=[entry for entry in v['files'] if entry['path'] != '.vite/manifest.json'])):
            value, _ = manifest()
            mutate(value)
            value['frontendId'] = frontend.frontend_identity(value['files'])
            with self.assertRaises(RuntimeError):
                frontend.validate_manifest(value)

    def test_bounded_expansion_and_hidden_extension_headers_refused(self):
        value, raw = manifest()
        huge = gzip.compress(bytes(2048))
        value['artifact'].update(bytes=len(huge), sha256=frontend.sha(huge))
        with patch.object(frontend, 'EXPANDED_MAXIMUM', 1024), self.assertRaises(RuntimeError):
            frontend.archive_files(huge, value)
        decoded = bytearray(gzip.decompress(raw))
        for kind in (b'x', b'g', b'L', b'K', b'S'):
            header = bytearray(decoded[:512])
            header[156:157] = kind
            header[124:136] = b'77777777777\0'
            header[148:156] = b'        '
            header[148:156] = format(sum(header), '06o').encode() + b'\0 '
            changed = gzip.compress(bytes(header) + bytes(decoded[512:]))
            value['artifact'].update(bytes=len(changed), sha256=frontend.sha(changed))
            with self.subTest(kind=kind), self.assertRaises(RuntimeError):
                frontend.archive_files(changed, value)

    def test_tampered_archive_and_missing_entries_are_rejected(self):
        value, raw = manifest()
        with self.assertRaises(RuntimeError):
            frontend.archive_files(raw + b'x', value)
        partial = archive({'index.html': b'<html></html>'})
        value['artifact'].update(bytes=len(partial), sha256=frontend.sha(partial))
        with self.assertRaises(RuntimeError):
            frontend.archive_files(partial, value)

    def test_unsafe_path_and_file_type_refusals(self):
        for path in ('../index.html', '/index.html', 'assets//ui.js', 'other.html', '.frontend-manifest.json',
                     'assets/.hidden.js', 'assets/config.json', 'assets/UI;exec.js', 'a' * 101 + '.css'):
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                frontend.file_path(path)
        self.assertEqual(frontend.file_path('icons/provenance.json'), 'icons/provenance.json')

    def test_archive_link_and_duplicate_refusals(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.DIRTYPE, tarfile.CHRTYPE):
            entry = tarfile.TarInfo('assets/link.js')
            entry.type, entry.linkname = kind, '/outside'
            value, _ = manifest()
            raw = archive({'index.html': b'x'}, entry)
            value['artifact'].update(bytes=len(raw), sha256=frontend.sha(raw))
            with self.subTest(kind=kind), self.assertRaises(RuntimeError):
                frontend.archive_files(raw, value)
        value, raw = manifest()
        value['files'].append(copy.deepcopy(value['files'][0]))
        value['frontendId'] = frontend.sha(frontend.compact(value['files']))
        with self.assertRaises(RuntimeError):
            frontend.validate_manifest(value)

    def test_expiry_unknown_fields_and_url_refusals(self):
        for mutate in (lambda v: v.update(expiresAt=v['createdAt']), lambda v: v.update(unknown=True),
                       lambda v: v['base'].update(apiVersion=2), lambda v: v['artifact'].update(url='https://example.invalid/ui?token=x'),
                       lambda v: v['artifact'].update(url='http://example.invalid/ui'), lambda v: v.update(sequence=True)):
            value, _ = manifest()
            mutate(value)
            with self.assertRaises((RuntimeError, ValueError)):
                frontend.validate_manifest(value)

    def test_duplicate_json_keys_refused(self):
        with self.assertRaises(RuntimeError):
            frontend.strict_json(b'{"format":1,"format":2}')

    def test_production_config_binds_provisioned_roots_socket_and_keys(self):
        value = {'format': 1, 'frontendDirectory': '/opt/nova/frontend', 'stateDirectory': '/var/lib/nova-update/frontend',
                 'nodeBinary': '/opt/nova/node/bin/node', 'nodeSha256': '1' * 64, 'publicKeyFile': '/etc/nova/release.pem',
                 'publicKeySha256': '2' * 64, 'artifactOrigins': ['https://example.invalid'], 'controlSocket': '/run/nova-update/frontend.sock'}
        self.assertEqual(frontend.validate_config(value), value)
        for key, bad in (('format', True), ('frontendDirectory', '/tmp/frontend'), ('controlSocket', '/run/public.sock'), ('nodeSha256', ''),
                         ('artifactOrigins', ['https://example.invalid/private'])):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                frontend.validate_config({**value, key: bad})

    def test_production_operation_requires_canonical_distinct_paths(self):
        value = {'format': 1, 'operationId': str(uuid.uuid4()), 'manifestPath': '/var/lib/nova-update/input/manifest.json',
                 'signaturePath': '/var/lib/nova-update/input/manifest.sig', 'archivePath': '/var/lib/nova-update/input/ui.tgz'}
        self.assertEqual(frontend.validate_operation(value), value)
        for mutation in ({'format': True}, {'archivePath': value['manifestPath']}, {'operationId': 'not-a-uuid'}, {'manifestPath': '../manifest.json'}):
            with self.subTest(mutation=mutation), self.assertRaises(RuntimeError):
                frontend.validate_operation({**value, **mutation})


class SelectionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.fixture = Fixture(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def test_plan_is_read_only_then_selection_preserves_unrelated_data(self):
        f = self.fixture
        owner_data = f.root / 'synthetic-owner-work.txt'
        owner_data.write_bytes(b'unsent draft and saved reply')
        before = {path.relative_to(f.root).as_posix(): path.read_bytes() for path in f.root.rglob('*') if path.is_file()}
        f.plan()
        after = {path.relative_to(f.root).as_posix(): path.read_bytes() for path in f.root.rglob('*') if path.is_file() and path.name not in ('plan.json', 'intent.json')}
        self.assertEqual(before, after)
        self.assertEqual(f.calls('begin'), 0)
        result = f.execute()
        self.assertEqual(result['outcome'], 'selected')
        self.assertEqual(f.calls('begin'), 1)
        self.assertEqual(f.calls('end'), 1)
        self.assertFalse((f.root / 'state/current.json').exists())
        self.assertEqual(owner_data.read_bytes(), b'unsent draft and saved reply')
        target = f.root / 'frontend/releases' / f.value['frontendId']
        self.assertEqual((target / '.frontend-manifest.json').read_bytes(), (f.root / 'manifest.json').read_bytes())
        self.assertEqual((target / '.frontend-manifest.sig').read_bytes(), b's' * 64)

    def test_changed_plan_and_invalid_signature_do_not_acquire_lease(self):
        f = self.fixture
        f.plan()
        f.io.service_id = str(uuid.uuid4())
        with self.assertRaises(RuntimeError):
            f.execute()
        self.assertEqual(f.calls('begin'), 0)
        f.io.signature_valid = False
        with self.assertRaises(RuntimeError):
            f.worker().plan()
        self.assertEqual(f.calls('begin'), 0)

    def test_boolean_intent_format_refused_before_effect(self):
        f = self.fixture
        f.plan()
        path = f.root / 'intent.json'
        value = json.loads(path.read_bytes())
        value['format'] = True
        path.write_bytes(frontend.encoded(value))
        with self.assertRaises(RuntimeError):
            f.execute()
        self.assertEqual(f.calls('begin'), 0)

    def test_lost_begin_acknowledgement_resumes_original_lease(self):
        f = self.fixture
        f.plan()
        f.io.fail_begin_after_commit = True
        with self.assertRaises(TimeoutError):
            f.execute()
        self.assertEqual(f.journal()['phase'], 'begin-intent')
        result = f.worker().resume()
        self.assertEqual(result['outcome'], 'selected')
        self.assertEqual(f.calls('begin'), 1)
        self.assertEqual(f.calls('end'), 1)

    def test_lost_end_acknowledgement_does_not_send_end_again(self):
        f = self.fixture
        f.plan()
        f.io.fail_end_after_commit = True
        with self.assertRaises(TimeoutError):
            f.execute()
        self.assertEqual(f.journal()['phase'], 'end-intent')
        result = f.worker().resume()
        self.assertEqual(result['phase'], 'completed')
        self.assertEqual(f.calls('begin'), 1)
        self.assertEqual(f.calls('end'), 1)

    def test_pre_begin_crash_is_cancelled_and_delayed_begin_fenced(self):
        f = self.fixture
        f.plan()
        f.io.crash_before_begin = True
        with self.assertRaises(Crash):
            f.execute()
        self.assertEqual(f.journal()['phase'], 'begin-intent')
        begin_body = next(body for action, body in f.io.calls if action == 'begin')
        result = f.worker().resume()
        self.assertEqual(result['outcome'], 'refused')
        self.assertEqual(f.calls('cancel-before-begin'), 1)
        self.assertEqual(f.calls('begin'), 1)
        self.assertFalse((f.root / 'state/current.json').exists())
        self.assertFalse((f.root / 'frontend/selector.json').exists())
        with self.assertRaises(RuntimeError):
            f.io.control(f.config, 'begin', begin_body)

    def test_prepared_crash_before_marker_resumes_fenced_cancellation(self):
        f = self.fixture
        f.plan()
        f.io.crash_after_prepared = True
        with self.assertRaises(Crash):
            f.execute()
        self.assertEqual(f.journal()['phase'], 'prepared')
        self.assertFalse((f.root / 'state/current.json').exists())
        self.assertEqual(f.worker().resume()['outcome'], 'refused')
        self.assertEqual(f.calls('begin'), 0)
        self.assertEqual(f.calls('cancel-before-begin'), 1)

    def test_partial_preparation_crash_resumes_fenced_cancellation_and_retains_assets(self):
        f = self.fixture
        f.plan()
        f.io.crash_during_materialization = True
        with self.assertRaises(Crash):
            f.execute()
        self.assertEqual(f.journal()['phase'], 'preparing')
        staging = f.root / 'frontend/releases' / ('.prepare-' + f.operation_id)
        before = {str(path.relative_to(staging)): path.read_bytes() for path in staging.rglob('*') if path.is_file()}
        self.assertTrue(before)
        self.assertEqual(f.worker().resume()['outcome'], 'refused')
        self.assertEqual(f.calls('begin'), 0)
        self.assertEqual(f.calls('cancel-before-begin'), 1)
        self.assertFalse(f.io.active)
        self.assertFalse((f.root / 'frontend/selector.json').exists())
        self.assertFalse((f.root / 'state/current.json').exists())
        self.assertEqual(before, {str(path.relative_to(staging)): path.read_bytes() for path in staging.rglob('*') if path.is_file()})
        with self.assertRaises(RuntimeError):
            f.execute()

    def test_preparation_intent_crash_resumes_without_materializing_or_beginning(self):
        f = self.fixture
        f.plan()
        f.io.crash_after_preparing = True
        with self.assertRaises(Crash):
            f.execute()
        self.assertEqual(f.journal()['phase'], 'preparing')
        self.assertFalse((f.root / 'frontend/releases').exists())
        self.assertEqual(f.worker().resume()['outcome'], 'refused')
        self.assertEqual(f.calls('begin'), 0)
        self.assertEqual(f.calls('cancel-before-begin'), 1)

    def test_unadmitted_cancel_after_base_change_does_not_claim_restoration(self):
        f = self.fixture
        f.plan()
        f.io.crash_before_begin = True
        with self.assertRaises(Crash):
            f.execute()
        f.io.current_base['candidateId'] = 'd' * 64
        f.io.current_base['serviceInputsSha256'] = 'e' * 64
        f.io.service_id, f.io.controller_id, f.io.epoch = (str(uuid.uuid4()) for _ in range(3))
        result = f.worker().resume()
        self.assertEqual(result['outcome'], 'refused')
        self.assertEqual(result['abortObservation']['candidateId'], 'd' * 64)
        self.assertEqual(f.calls('cancel-before-begin'), 1)
        self.assertEqual(f.calls('end'), 0)
        self.assertFalse((f.root / 'frontend/selector.json').exists())

    def test_pre_end_crash_reconciles_same_original_idempotent_closure(self):
        f = self.fixture
        f.plan()
        f.io.crash_before_end = True
        with self.assertRaises(Crash):
            f.execute()
        self.assertEqual(f.journal()['phase'], 'end-intent')
        self.assertTrue(f.io.active)
        f.io.controller_id = str(uuid.uuid4())
        result = f.worker().resume()
        self.assertEqual(result['outcome'], 'selected')
        self.assertEqual(f.calls('begin'), 1)
        self.assertEqual(f.calls('end'), 2)
        ends = [body for action, body in f.io.calls if action == 'end']
        self.assertEqual(ends[0], ends[1])
        self.assertFalse(f.io.active)

    def test_expiry_between_lease_and_atomic_selector_restores_prior(self):
        f = self.fixture
        f.plan()
        f.io.expire_before_selector = True
        actual_time = time.time
        with patch.object(frontend.time, 'time', lambda: f.io.expired_time if f.io.expired_time is not None else actual_time()):
            result = f.execute()
        self.assertEqual(result['outcome'], 'restored')
        self.assertFalse((f.root / 'frontend/selector.json').exists())
        self.assertEqual(f.calls('begin'), 1)
        self.assertEqual(f.calls('end'), 1)

    def test_corrupt_prior_recovery_refused_before_new_lease(self):
        f = self.fixture
        f.plan()
        f.execute()
        prior_asset = f.root / 'frontend/releases' / f.value['frontendId'] / 'assets/ui.js'
        f.next_promotion()
        prior_asset.write_bytes(b'corrupted prior recovery')
        with self.assertRaises(RuntimeError):
            f.plan()
        self.assertEqual(f.calls('begin'), 1)

    def test_prior_recovery_corrupted_after_selection_never_claims_restored(self):
        f = self.fixture
        f.plan()
        f.execute()
        prior_asset = f.root / 'frontend/releases' / f.value['frontendId'] / 'assets/ui.js'
        f.next_promotion()
        f.plan()
        f.io.corrupt_after_selector = prior_asset
        with self.assertRaises(RuntimeError):
            f.execute()
        self.assertNotIn('outcome', f.journal())
        self.assertTrue(f.io.active)
        self.assertEqual(f.calls('end'), 1)
        self.assertTrue((f.root / 'state/current.json').exists())
        self.assertEqual(json.loads((f.root / 'frontend/selector.json').read_bytes())['frontendId'], f.value['frontendId'])

    def test_atomic_switch_crash_reconciles_bytes_without_redispatch(self):
        f = self.fixture
        f.plan()
        f.io.crash_after_selector = True
        with self.assertRaises(Crash):
            f.execute()
        self.assertEqual(f.journal()['phase'], 'selector-intent')
        self.assertEqual(json.loads((f.root / 'frontend/selector.json').read_bytes())['frontendId'], f.value['frontendId'])
        result = f.worker().resume()
        self.assertEqual(result['outcome'], 'selected')
        self.assertEqual(f.calls('begin'), 1)

    def test_failed_selected_health_restores_bundled_selector(self):
        f = self.fixture
        f.plan()
        f.io.bad_selected_health = True
        result = f.execute()
        self.assertEqual(result['outcome'], 'restored')
        self.assertFalse((f.root / 'frontend/selector.json').exists())
        self.assertEqual(f.calls('begin'), 1)
        self.assertEqual(f.calls('end'), 1)
        self.assertTrue((f.root / 'frontend/releases' / f.value['frontendId']).is_dir())

    def test_service_restart_keeps_uncertain_marker_and_no_repeated_effect(self):
        f = self.fixture
        f.plan()
        f.io.restart_after_selection = True
        with self.assertRaises(RuntimeError):
            f.execute()
        self.assertTrue((f.root / 'state/current.json').exists())
        self.assertTrue(f.io.active)
        with self.assertRaises(RuntimeError):
            f.worker().resume()
        self.assertEqual(f.calls('begin'), 1)
        self.assertEqual(f.calls('end'), 0)

    def test_controller_refusal_leaves_working_selector_unchanged(self):
        f = self.fixture
        f.plan()
        f.io.refuse_begin = True
        result = f.execute()
        self.assertEqual(result['outcome'], 'refused')
        self.assertFalse((f.root / 'state/current.json').exists())
        self.assertFalse((f.root / 'frontend/selector.json').exists())
        self.assertEqual(f.calls('end'), 0)

    def test_sequence_rollback_and_other_active_operation_refused(self):
        f = self.fixture
        (f.root / 'state/sequence.json').write_bytes(frontend.encoded({'format': 1, 'sequence': 2, 'manifestSha256': 'e' * 64}))
        with self.assertRaises(RuntimeError):
            f.worker().plan()
        (f.root / 'state/sequence.json').unlink()
        f.io.active, f.io.lease = True, str(uuid.uuid4())
        with self.assertRaises(RuntimeError):
            f.worker().plan()
        self.assertEqual(f.calls('begin'), 0)

    def test_immutable_asset_tampering_refused(self):
        f = self.fixture
        f.plan()
        f.execute()
        (f.root / 'frontend/releases' / f.value['frontendId'] / 'assets/ui.js').write_bytes(b'changed')
        with self.assertRaises(RuntimeError):
            worker = f.worker()
            worker.prepare()
            worker.verify_materialized()

    def test_controller_restart_reconciles_original_lost_begin(self):
        f = self.fixture
        f.plan()
        f.io.fail_begin_after_commit = True
        with self.assertRaises(TimeoutError):
            f.execute()
        old = f.io.controller_id
        f.io.controller_id = str(uuid.uuid4())
        result = f.worker().resume()
        self.assertEqual(result['outcome'], 'selected')
        self.assertEqual(result['originalControllerProcessIdentity'], old)
        self.assertEqual(result['reconciledControllerProcessIdentity'], f.io.controller_id)
        self.assertEqual(f.calls('begin'), 1)

    def test_controller_restart_reconciles_lost_end(self):
        f = self.fixture
        f.plan()
        f.io.fail_end_after_commit = True
        with self.assertRaises(TimeoutError):
            f.execute()
        f.io.controller_id = str(uuid.uuid4())
        self.assertEqual(f.worker().resume()['phase'], 'completed')
        self.assertEqual(f.calls('end'), 1)

    def test_deliberate_rollback_is_new_operation_and_preserves_high_water(self):
        f = self.fixture
        f.plan()
        f.execute()
        original_id = f.operation_id
        high = (f.root / 'state/sequence.json').read_bytes()
        old_release = f.root / 'frontend/releases' / f.value['frontendId']
        f.rollback(original_id)
        f.plan()
        result = f.execute()
        self.assertEqual(result['outcome'], 'restored')
        self.assertNotEqual(result['operationId'], original_id)
        self.assertEqual(result['rollbackOf'], str(f.root / 'state' / (original_id + '.json')))
        self.assertFalse((f.root / 'frontend/selector.json').exists())
        self.assertEqual((f.root / 'state/sequence.json').read_bytes(), high)
        self.assertTrue(old_release.is_dir())
        self.assertEqual(f.calls('begin'), 2)
        self.assertEqual(f.calls('end'), 2)

    def test_rollback_wrong_journal_and_restart_do_not_dispatch(self):
        f = self.fixture
        f.plan()
        f.execute()
        original_id = f.operation_id
        f.rollback(original_id)
        f.io.service_id = str(uuid.uuid4())
        with self.assertRaises(RuntimeError):
            f.plan()
        self.assertEqual(f.calls('begin'), 1)
        f.operation['rollbackOf'] = str(f.root / 'manifest.json')
        f.operation_path.write_bytes(frontend.encoded(f.operation))
        with self.assertRaises(RuntimeError):
            f.plan()
        self.assertEqual(f.calls('begin'), 1)

    def test_controller_restart_after_switch_reconciles_original_lease(self):
        f = self.fixture
        f.plan()
        f.io.crash_after_selector = True
        with self.assertRaises(Crash):
            f.execute()
        f.io.controller_id = str(uuid.uuid4())
        self.assertEqual(f.worker().resume()['outcome'], 'selected')
        self.assertEqual(f.calls('begin'), 1)


NODE = os.environ.get('NODE_BINARY') or shutil.which('node')


class CryptoTests(unittest.TestCase):
    @unittest.skipUnless(NODE, 'A reviewed Node22 executable is needed for producer compatibility.')
    def test_actual_producer_regular_ustar_matches_worker(self):
        files = {'index.html': b'<html></html>', '.vite/manifest.json': b'{}',
                 'assets/font.woff2': bytes(range(256)) * 3, 'assets/empty.css': b''}
        value, _ = manifest(files)
        script = "const {frontendArchive}=await import(process.argv[1]);const entries=JSON.parse(process.argv[2]).map(([path,raw])=>[path,Buffer.from(raw,'base64')]);process.stdout.write(frontendArchive(entries));"
        entries = [[path, base64.b64encode(raw).decode()] for path, raw in sorted(files.items())]
        raw = subprocess.run([NODE, '--input-type=module', '-e', script, (ROOT / 'scripts/frontend-package.mjs').as_uri(), json.dumps(entries)], capture_output=True, check=True, timeout=10).stdout
        value['artifact'].update(bytes=len(raw), sha256=frontend.sha(raw))
        self.assertEqual(frontend.archive_files(raw, value), files)

    @unittest.skipUnless(NODE, 'A reviewed Node22 executable is needed for actual Ed25519 verification.')
    def test_real_detached_signature_and_tamper_refusal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            value, _ = manifest()
            raw = frontend.encoded(value)
            public = root / 'release.pem'
            program = "const c=require('node:crypto'),fs=require('node:fs');const {privateKey,publicKey}=c.generateKeyPairSync('ed25519');fs.writeFileSync(process.argv[1],publicKey.export({type:'spki',format:'pem'}));process.stdout.write(c.sign(null,Buffer.from(process.argv[2],'hex'),privateKey).toString('hex'));"
            generated = subprocess.run([NODE, '-e', program, str(public), raw.hex()], capture_output=True, check=True, timeout=10)
            signature = bytes.fromhex(generated.stdout.decode())

            class SignatureIO(frontend.FileIO):
                def read(self, path, maximum, private=False):
                    data = pathlib.Path(path).read_bytes()
                    frontend.require(len(data) <= maximum, 'Signature input bound exceeded.')
                    return data

            config = {'nodeBinary': str(pathlib.Path(NODE).resolve()), 'nodeSha256': frontend.sha(pathlib.Path(NODE).read_bytes()),
                      'publicKeyFile': str(public), 'publicKeySha256': frontend.sha(public.read_bytes())}
            verifier = SignatureIO()
            original_run = subprocess.run

            def actual_run(*args, **kwargs):
                result = original_run(*args, **kwargs)
                if result.returncode:
                    raise AssertionError(result.stderr[:4096].decode('utf-8', errors='replace'))
                return result

            with patch.object(frontend.subprocess, 'run', actual_run):
                verifier.verify_signature(config, raw, signature)
            for changed_raw, changed_signature in ((raw + b'x', signature), (raw, b'x' * 64)):
                with self.assertRaises(RuntimeError):
                    verifier.verify_signature(config, changed_raw, changed_signature)
            with self.assertRaises(RuntimeError):
                verifier.verify_signature({**config, 'publicKeySha256': 'f' * 64}, raw, signature)


@unittest.skipUnless(sys.platform == 'linux' and hasattr(os, 'geteuid') and os.geteuid() == 0,
                     'Actual root-protected path checks require Linux root.')
class ProtectedFilesystemTests(unittest.TestCase):
    def setUp(self):
        parent = os.environ.get('QA_PROTECTED_PARENT')
        if not parent:
            self.skipTest('QA_PROTECTED_PARENT must be set for root-protected fixtures.')
        self.temporary = tempfile.TemporaryDirectory(prefix='nova-frontend-fixture-', dir=parent)
        self.root = pathlib.Path(self.temporary.name).resolve()
        self.root.chmod(0o755)

    def tearDown(self):
        self.temporary.cleanup()

    def test_real_root_paths_reject_writable_ancestor_symlink_and_hardlink(self):
        path = self.root / 'manifest.json'
        path.write_bytes(b'{}')
        path.chmod(0o644)
        frontend.protected(path)
        path.chmod(0o664)
        with self.assertRaises(RuntimeError):
            frontend.protected(path)
        path.chmod(0o644)
        linked = self.root / 'linked.json'
        linked.symlink_to(path)
        with self.assertRaises(RuntimeError):
            frontend.protected(linked)
        linked.unlink()
        os.link(path, linked)
        with self.assertRaises(RuntimeError):
            frontend.protected(path)
        linked.unlink()
        self.root.chmod(0o777)
        with self.assertRaises(RuntimeError):
            frontend.protected(path)
        self.root.chmod(0o755)

    def test_real_atomic_write_is_private_independent_and_fsynced(self):
        file_io = frontend.FileIO()
        path = self.root / 'journal.json'
        file_io.write(path, b'first\n')
        self.assertEqual(file_io.read(path, 64, private=True), b'first\n')
        first = path.stat().st_ino
        file_io.write(path, b'second\n', replace=True)
        self.assertNotEqual(first, path.stat().st_ino)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(path.stat().st_nlink, 1)
        self.assertEqual(file_io.read(path, 64, private=True), b'second\n')

    def test_native_worker_filesystem_with_synthetic_control(self):
        f = Fixture(self.root)
        (self.root / 'state').chmod(0o700)
        for name in ('operation.json', 'config.json'):
            (self.root / name).chmod(0o600)
        controller = f.io

        class NativeIO(frontend.FileIO):
            def control(self, config, action, body):
                return controller.control(config, action, body)

            def get(self, endpoint):
                return controller.get(endpoint)

            def verify_signature(self, config, raw, signature):
                return controller.verify_signature(config, raw, signature)

        f.io = NativeIO()
        f.plan()
        for name in ('plan.json', 'intent.json'):
            (self.root / name).chmod(0o600)
        result = f.execute()
        self.assertEqual(result['outcome'], 'selected')
        frontend.protected(self.root / 'state' / (f.operation_id + '.json'), private=True)
        frontend.protected(self.root / 'frontend/selector.json')

    def test_real_root_only_unix_control_transport(self):
        import http.server
        import socketserver
        import threading
        requests = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                requests.append((self.path, self.headers.get('Origin'), json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
                raw = b'{"observed":true}\n'
                self.send_response(200)
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        path = self.root / 'frontend.sock'
        server = socketserver.UnixStreamServer(str(path), Handler)
        # Bounded accept: if control() rejects the fixture before connecting,
        # handle_request must not block forever and hang the runner.
        server.socket.settimeout(10)
        path.chmod(0o600)
        thread = threading.Thread(target=server.handle_request)
        thread.start()
        operation_id = str(uuid.uuid4())
        try:
            result = frontend.FileIO().control({'controlSocket': str(path)}, 'observe', {'operationId': operation_id})
            self.assertEqual(result, {'observed': True})
            self.assertEqual(requests, [('/v1/observe', None, {'operationId': operation_id})])
            path.chmod(0o660)
            with self.assertRaises(RuntimeError):
                frontend.FileIO().control({'controlSocket': str(path)}, 'observe', {'operationId': operation_id})
        finally:
            server.server_close()
            thread.join(timeout=15)
            self.assertFalse(thread.is_alive(), 'control transport thread did not exit; test would hang CI')


if __name__ == '__main__':
    unittest.main()
