"""Packaged preflight contract regression over a complete synthetic host.

The real main/preflight/validate/qualification and subsequent archive, baseline,
helper and configuration checks run. Linux ownership/symlink authority, Windows
xattr/block-allocation availability, Node ABI discovery and loopback health are boundary fakes. These tests are
not Linux host admission, retained-state qualification or installation proof.
"""
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
HELPERS = ROOT / 'deploy/update-runner'
sys.dont_write_bytecode = True
sys.path.insert(0, str(HELPERS))
import app_dependencies
import recovery

spec = importlib.util.spec_from_file_location('qualification_preflight_driver', HELPERS / 'install.py')
driver = importlib.util.module_from_spec(spec)
with contextlib.ExitStack() as imports:
    if os.name == 'nt':
        imports.enter_context(patch.dict(sys.modules, {'fcntl': types.SimpleNamespace(flock=None)}))
    spec.loader.exec_module(driver)

EPOCH = '174e023c-91c1-44cf-b65b-e75ba6cc9fa0'
JOB = 'b7fd26ae-0db7-4e88-990e-15aafac58dc7'
TARGET = 'b' * 64
TRANSITION = {'format': 1, 'kind': 'schema-55-to-60-same-runtime',
              'fromSchemaVersion': 55, 'toSchemaVersion': 60, 'apiVersion': 1,
              'fromAgentVersion': '2026.9.8', 'toAgentVersion': '2026.9.8'}


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


class PackagedQualificationPreflightTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nova-qualified-preflight-',
                                                      dir=os.getenv('NOVA_TEST_TEMP'))
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.saved_umask = os.umask(0o077)
        self.addCleanup(os.umask, self.saved_umask)
        self.boundaries = contextlib.ExitStack()
        self.addCleanup(self.boundaries.close)
        if not hasattr(os, 'listxattr'):
            self.boundaries.enter_context(patch.object(os, 'listxattr', return_value=[], create=True))
        if not hasattr(self.root.lstat(), 'st_blocks'):
            native_lstat = Path.lstat

            class PortableStat:
                def __init__(self, value):
                    self.value = value
                    self.st_blocks = (value.st_size + 511) // 512

                def __getattr__(self, name):
                    return getattr(self.value, name)

            self.boundaries.enter_context(patch.object(Path, 'lstat',
                lambda path, *args, **kwargs: PortableStat(native_lstat(path, *args, **kwargs))))
        self.bundle = self.root / 'bundle'
        self.attempt = self.bundle / 'attempts' / JOB
        self.data = self.root / 'live-workspace'
        self.releases = self.root / 'releases'
        self.prior = self.releases / 'prior'
        self.runtime_root = self.root / 'runtime'
        self.agent = self.runtime_root / 'agent'
        self.dependencies = self.root / 'dependencies' / 'node_modules'
        self.recovery_root = self.root / 'recovery'
        self.baseline = self.recovery_root / 'baseline'
        for path in (self.attempt, self.data, self.prior, self.agent,
                     self.dependencies, self.baseline / 'workspace'):
            path.mkdir(parents=True)
        self.current = self.root / 'current'
        self.pointer = self.prior / 'node_modules'
        self.current.write_bytes(b'synthetic current selector')
        self.pointer.write_bytes(b'synthetic dependency selector')
        self.selectors = {self.current: self.prior, self.pointer: self.dependencies}
        self.node = self.runtime_root / 'node'
        self.agent_node = self.runtime_root / 'agent-node'
        self.node.write_bytes(b'synthetic exact platform binary')
        self.agent_node.write_bytes(b'synthetic exact agent binary')
        self.write(self.agent / 'package.json', {'version': '2026.9.8'})
        (self.dependencies / 'retained.js').write_bytes(b'unchanged dependency')
        (self.baseline / 'workspace' / 'saved.txt').write_bytes(b'closed baseline')
        self.prior_id = self.make_prior()
        entries, _ = recovery.inventory(self.baseline / 'workspace')
        self.write(self.baseline / 'snapshot-manifest.json', entries)
        self.write(self.baseline / 'snapshot-verified.json', {
            'manifestSha256': recovery.digest(self.baseline / 'snapshot-manifest.json')})
        self.write(self.baseline / 'acceptance.json', {
            'health': {'candidateId': self.prior_id}, 'agentVersion': '2026.9.8'})
        self.config = self.root / 'config.json'
        self.runner = self.root / 'runner.json'
        self.write(self.config, {'workspaceDirectory': str(self.data),
            'releaseDirectory': str(self.releases), 'appCurrent': str(self.current),
            'agentDirectory': str(self.agent), 'runtimeDirectory': str(self.runtime_root),
            'agentNodePath': str(self.agent_node)})
        self.write(self.runner, {'format': 1, 'serviceName': 'fixture.service',
            'serviceUser': 'fixture', 'nodePath': str(self.node), 'healthPort': 4001,
            'dependencyDirectory': str(self.dependencies), 'recoveryDirectory': str(self.recovery_root),
            'baselineDirectory': str(self.baseline), 'protectedFiles': [str(self.config), str(self.runner)]})
        self.helpers = {}
        for name in sorted(recovery.APPLICATION_TRANSITION_HELPERS):
            raw = (HELPERS / name).read_bytes()
            (self.bundle / name).write_bytes(raw)
            self.helpers[name] = sha(raw)
        self.dependency_description = self.make_dependencies()
        self.archive = self.bundle / 'app.tgz'
        self.tar(self.archive, {'package.json': b'{}', 'dist/client/index.html': b'fixture'},
                 directories=('dist', 'dist/client'))
        runtime = {'agent': str(self.agent), 'agentNode': str(self.agent_node),
            'agentNodeSha256': recovery.digest(self.agent_node), 'agentVersion': '2026.9.8',
            'node': str(self.node), 'nodeSha256': recovery.digest(self.node), 'root': str(self.runtime_root),
            'inventory': {'path': '/synthetic-qualification/runtime-inventory.json',
                          'sha256': sha(encoded(recovery.inventory(self.runtime_root)[0]))}}
        self.binding = {'format': 1, 'kind': 'same-runtime-startup-candidate-binding',
            'applicationTransition': copy.deepcopy(TRANSITION), 'workspaceEpoch': EPOCH,
            'prior': {'candidateId': self.prior_id},
            'targets': {side: {'candidateId': TARGET if side == 'private' else 'c' * 64,
                              'packageLockSha256': self.dependency_description['packageLockSha256']}
                        for side in ('private', 'public')},
            'dependencyGraphSha256': self.dependency_description['dependencyGraphSha256'],
            'applicationDependencies': copy.deepcopy(self.dependency_description),
            'runtime': runtime, 'helpers': dict(self.helpers)}
        self.proof = {'format': 1, 'kind': 'actual-retained-startup-qualification-observation',
            'scope': 'retained-same-runtime-startup-restart-restoration',
            'readOnly': True, 'hostEffects': False, 'productionAdmission': False,
            'scenarios': [], 'references': {}}
        for name in ('actualSettledQualification', 'independentOriginalRestored',
                     'completeMaintainedSavedAndNativeState', 'heldBootstrapVerified',
                     'workerClosed', 'freshFullRehearsalStillRequired', 'liveAcceptanceStillRequired'):
            self.proof[name] = True
        for index, name in enumerate(('target-first-start', 'target-restart', 'pristine-prior-restoration')):
            reference = {'path': '/synthetic-qualification/' + name + '/preservation.json', 'sha256': 'f' * 64}
            self.proof['scenarios'].append({'scenario': name,
                'candidateId': self.prior_id if index == 2 else TARGET,
                'startedAtSeconds': 100 + index * 20, 'closedAtSeconds': 110 + index * 20,
                'preservation': reference})
            self.proof['references'][name + '/preservation'] = {**reference, 'bytes': 123}
        self.pair = {'format': 1, 'candidateId': TARGET, 'priorCandidateId': self.prior_id,
            'archiveBytes': self.archive.stat().st_size, 'archiveSha256': recovery.digest(self.archive),
            'applicationTransition': copy.deepcopy(TRANSITION),
            'applicationDependencies': copy.deepcopy(self.dependency_description), 'helpers': dict(self.helpers)}
        self.refresh_qualification()
        release = {'candidateId': TARGET, 'fromCandidateId': self.prior_id,
            'novaVersion': '2.28.27', 'agentVersion': '2026.9.8', 'nodeMajor': 22,
            'platform': 'linux', 'arch': 'x64', 'manifestExpiresAt': 2_000_000,
            'compatibility': {'fromAgentVersion': '2026.9.8', 'fromNovaVersion': '2.7.11',
                'fromSchemaVersion': 55, 'toSchemaVersion': 60, 'reviewed': True,
                'gatewayProtocol': 4, 'pluginVersion': '2.28.27'},
            'applicationDependenciesBundle': {'bytes': self.dependency_description['archiveBytes'],
                                             'sha256': self.dependency_description['archiveSha256']}}
        self.request = self.attempt / 'preflight.json'
        self.write(self.request, {'format': 1, 'jobId': JOB, 'release': release,
            'hostConfiguration': str(self.config),
            'preflightIdentity': {'candidateId': self.prior_id, 'workspaceEpoch': EPOCH}})
        self.api_calls = []
        self.abi_calls = []

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(encoded(value))

    def tar(self, path, files, directories=()):
        with tarfile.open(path, 'w:gz') as archive:
            for name in directories:
                member = tarfile.TarInfo(name)
                member.type = tarfile.DIRTYPE
                member.mode = 0o755
                archive.addfile(member)
            for name, raw in files.items():
                member = tarfile.TarInfo(name)
                member.size = len(raw)
                member.mode = 0o644
                archive.addfile(member, io.BytesIO(raw))

    def make_prior(self):
        artifacts = {'dist/client/index.html': b'prior UI', 'dist/service/apps/service/main.js': b'prior service'}
        package = {'name': 'nova-dream-edition-3', 'version': '2.7.11',
            'edition3': {'buildVersion': '1.0.308', 'schemaVersion': 55, 'apiVersion': 1,
                        'appId': 'private.novadream.edition3.preview'}}
        manifest = {'version': package['version'], **package['edition3'],
                    'artifacts': [{'path': name, 'sha256': sha(raw)} for name, raw in artifacts.items()]}
        for name, raw in artifacts.items():
            path = self.prior / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
        self.write(self.prior / 'package.json', package)
        self.write(self.prior / 'dist/candidate.json', manifest)
        return sha((self.prior / 'package.json').read_bytes() + (self.prior / 'dist/candidate.json').read_bytes())

    def make_dependencies(self):
        package = {'name': 'preflight-fixture', 'version': '1.0.0', 'dependencies': {}}
        lock = {'name': package['name'], 'version': package['version'], 'lockfileVersion': 3,
                'packages': {'': package}}
        files = {'package.json': encoded(package), 'package-lock.json': encoded(lock)}
        archive = self.bundle / 'app-dependencies.tgz'
        self.tar(archive, files, directories=('node_modules',))
        description = {'format': 1, 'archiveBytes': archive.stat().st_size,
            'archiveSha256': recovery.digest(archive), 'expandedBytes': sum(map(len, files.values())),
            'fileCount': 3, 'packageLockSha256': sha(files['package-lock.json']),
            'dependencyGraphSha256': app_dependencies.dependency_graph_sha256(lock),
            'platform': 'linux', 'arch': 'x64', 'nodeVersion': '22.23.2', 'nodeAbi': 127}
        app_dependencies.archive_members(archive, description)
        return description

    def refresh_qualification(self):
        self.proof['qualificationBinding'] = copy.deepcopy(self.binding)
        self.write(self.bundle / 'startup-qualification.json', self.proof)
        self.pair['startupQualification'] = {'binding': copy.deepcopy(self.binding),
            'projection': {'path': 'startup-qualification.json',
                           'sha256': recovery.digest(self.bundle / 'startup-qualification.json')}}
        self.write(self.bundle / 'reviewed-pair.json', self.pair)

    def file_bytes(self):
        return {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}

    def invoke(self):
        original_resolve, original_link, original_stat = Path.resolve, Path.is_symlink, Path.lstat
        selectors, case = self.selectors, self

        def resolve(path, *args, **kwargs):
            return selectors[path] if path in selectors else original_resolve(path, *args, **kwargs)

        def is_symlink(path):
            return path in selectors or original_link(path)

        def lstat(path, *args, **kwargs):
            return types.SimpleNamespace(st_uid=0) if path in selectors else original_stat(path, *args, **kwargs)

        def protected(path, directory=False, private=False):
            case.assertTrue(Path(path).is_relative_to(case.root), 'Synthetic authority must stay in this fixture.')

        def api(_driver, path, session=False):
            case.assertFalse(session)
            case.assertIn(path, ('health', 'access/context'))
            case.api_calls.append(path)
            return {'workspaceEpoch': EPOCH} if path == 'access/context' else {
                'status': 'ready', 'candidateId': case.prior_id, 'version': '2.7.11', 'schemaVersion': 55, 'apiVersion': 1}

        def abi(command, **kwargs):
            case.assertEqual(command[:2], [str(case.node), '-e'])
            case.assertIn('process.versions.modules', command[2])
            case.abi_calls.append(command)
            return types.SimpleNamespace(stdout=encoded({key: case.dependency_description[key]
                for key in ('platform', 'arch', 'nodeVersion', 'nodeAbi')}))

        before = self.file_bytes()
        with contextlib.ExitStack() as stack:
            for manager in (patch.object(sys, 'argv', ['install.py', '--preflight', str(self.request)]),
                    patch.object(sys, 'platform', 'linux'), patch.object(os, 'geteuid', return_value=0, create=True),
                    patch.object(driver, '__file__', str(self.bundle / 'install.py')),
                    patch.object(driver, 'protected', protected), patch.object(Path, 'resolve', resolve),
                    patch.object(Path, 'is_symlink', is_symlink), patch.object(Path, 'lstat', lstat),
                    patch.object(driver.subprocess, 'run', abi), patch.object(driver.Driver, 'api', api),
                    patch.object(driver.time, 'time', return_value=1000),
                    patch.object(driver.Driver, 'run', side_effect=AssertionError('Preflight must not install.')),
                    patch.object(driver, 'write_json', side_effect=AssertionError('Preflight must not write receipts.')),
                    patch.object(driver.fcntl, 'flock', side_effect=AssertionError('Preflight must not acquire a lock.'))):
                stack.enter_context(manager)
            output = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            try:
                driver.main()
                return json.loads(output.getvalue())
            finally:
                self.assertEqual(before, self.file_bytes())
                self.assertEqual({p.name for p in self.attempt.iterdir()}, {'preflight.json'})

    def test_complete_producer_packet_passes_real_main_validate_and_later_checks(self):
        self.assertEqual(self.invoke(), {'format': 1, 'preflight': 'passed',
                                        'candidateId': self.prior_id, 'workspaceEpoch': EPOCH})
        self.assertEqual(self.api_calls, ['health', 'access/context', 'health'])
        self.assertEqual(len(self.abi_calls), 1)

    def test_changed_actual_runtime_identity_is_rejected_with_full_bound_proof(self):
        self.binding['runtime']['nodeSha256'] = '0' * 64
        self.refresh_qualification()
        with self.assertRaises(RuntimeError):
            self.invoke()
        self.assertEqual(self.api_calls, [])

    def test_missing_producer_inventory_is_rejected(self):
        del self.binding['runtime']['inventory']
        self.refresh_qualification()
        with self.assertRaises(RuntimeError):
            self.invoke()

    def test_real_helper_and_original_proof_bytes_remain_authenticated(self):
        original = (self.bundle / 'recovery.py').read_bytes()
        (self.bundle / 'recovery.py').write_bytes(original + b'\n# changed fixture bytes\n')
        with self.assertRaises(RuntimeError):
            self.invoke()
        (self.bundle / 'recovery.py').write_bytes(original)
        self.proof['workerClosed'] = False
        self.write(self.bundle / 'startup-qualification.json', self.proof)
        self.pair['startupQualification']['projection']['sha256'] = recovery.digest(self.bundle / 'startup-qualification.json')
        self.write(self.bundle / 'reviewed-pair.json', self.pair)
        with self.assertRaises(RuntimeError):
            self.invoke()

    def test_later_archive_validation_is_not_replaced_by_qualification_success(self):
        self.tar(self.archive, {'../unreviewed': b'unsafe'})
        self.pair.update(archiveBytes=self.archive.stat().st_size, archiveSha256=recovery.digest(self.archive))
        self.write(self.bundle / 'reviewed-pair.json', self.pair)
        with self.assertRaises(RuntimeError):
            self.invoke()
        self.assertEqual(len(self.abi_calls), 1, 'Actual validate must finish the dependency ABI check first.')
        self.assertEqual(self.api_calls, [])


if __name__ == '__main__':
    unittest.main()
