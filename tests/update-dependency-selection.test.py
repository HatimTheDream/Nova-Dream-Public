"""Successive offline dependency selection over isolated protected Linux trees."""
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import sys
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'deploy/update-runner'))
if sys.platform != 'linux':
    sys.modules['fcntl'] = types.SimpleNamespace()
import app_dependencies
spec = importlib.util.spec_from_file_location('dependency_selection_driver', ROOT / 'deploy/update-runner/install.py')
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0,
                     'Dependency selectors require isolated Linux root ownership fixtures.')
class DependencySelectionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nova-dependency-selection-',
            dir=os.environ.get('QA_PROTECTED_PARENT', '/opt'))
        self.root = pathlib.Path(self.temporary.name).resolve()
        self.root.chmod(0o700)
        self.umask = os.umask(0o077)
        self.anchor = self.root / 'dependencies' / 'baseline'
        self.anchor.mkdir(parents=True)
        self.identity = {'platform': 'linux', 'arch': 'x64', 'nodeVersion': '22.23.2', 'nodeAbi': 127}

    def tearDown(self):
        os.umask(self.umask)
        self.temporary.cleanup()

    def instance(self, name, dependencies):
        prior = self.root / name
        prior.mkdir()
        (prior / 'node_modules').symlink_to(dependencies, target_is_directory=True)
        instance = driver.Driver(self.root / 'request.json')
        instance.configured_dependencies = self.anchor
        instance.dependency_root = self.anchor.parent
        instance.prior = prior
        return instance

    def bundle(self, name):
        bundle = self.root / name
        bundle.mkdir()
        lock = {'lockfileVersion': 3, 'packages': {'': {'version': name, 'dependencies': {}}}}
        files = {'package.json': json.dumps({'version': name, 'dependencies': {}}).encode(),
                 'package-lock.json': json.dumps(lock).encode()}
        archive = bundle / 'app-dependencies.tgz'
        with tarfile.open(archive, 'w:gz') as output:
            directory = tarfile.TarInfo('node_modules')
            directory.type, directory.mode = tarfile.DIRTYPE, 0o755
            output.addfile(directory)
            for path, raw in files.items():
                member = tarfile.TarInfo(path)
                member.mode, member.size = 0o644, len(raw)
                output.addfile(member, io.BytesIO(raw))
        description = {'format': 1, 'archiveBytes': archive.stat().st_size,
                       'archiveSha256': app_dependencies.digest(archive),
                       'expandedBytes': sum(map(len, files.values())), 'fileCount': 3,
                       'packageLockSha256': hashlib.sha256(files['package-lock.json']).hexdigest(),
                       'dependencyGraphSha256': app_dependencies.dependency_graph_sha256(lock), **self.identity}
        return bundle, description

    def qualify(self, instance, bundle, description):
        instance.pair = {'applicationDependencies': description}
        instance.release = {'nodeMajor': 22, 'platform': 'linux', 'arch': 'x64',
                            'applicationDependenciesBundle': {'bytes': description['archiveBytes'],
                                                               'sha256': description['archiveSha256']}}
        instance.bundle, instance.recovery_root = bundle, self.root
        instance.node = pathlib.Path('/fixture/node')
        with patch.object(driver.subprocess, 'run', return_value=types.SimpleNamespace(stdout=json.dumps(self.identity).encode())):
            instance.validate_application_dependencies()

    def test_two_successive_updates_resolve_current_closure_and_keep_one_stable_dependency_root(self):
        first = self.instance('release-one', self.anchor)
        first.resolve_prior_dependencies()
        self.assertEqual(first.dependencies, self.anchor)
        bundle, description = self.bundle('bundle-one')
        self.qualify(first, bundle, description)
        first.application_dependency_target.parent.mkdir()
        first_dependencies = app_dependencies.stage_closure(bundle / 'app-dependencies.tgz', first.application_dependency_target, description)
        before = (first.application_dependency_target / 'package-lock.json').read_bytes()
        second = self.instance('release-two', first_dependencies)
        second.resolve_prior_dependencies()
        self.assertEqual(second.dependencies, first_dependencies)
        second_bundle, second_description = self.bundle('bundle-two')
        self.qualify(second, second_bundle, second_description)
        self.assertEqual(second.application_dependency_target.parent, first.application_dependency_target.parent)
        self.assertFalse(second.application_dependency_target.is_relative_to(first.application_dependency_target))
        second_dependencies = app_dependencies.stage_closure(second_bundle / 'app-dependencies.tgz', second.application_dependency_target, second_description)
        third = self.instance('release-three', second_dependencies)
        third.resolve_prior_dependencies()
        self.assertEqual(third.dependencies, second_dependencies)
        self.assertEqual((first.application_dependency_target / 'package-lock.json').read_bytes(), before)
        self.assertEqual(second.configured_dependencies, self.anchor)

    def test_selector_cannot_escape_or_choose_an_unreviewed_layout(self):
        for index, path in enumerate([self.root / 'outside' / 'node_modules',
                                     self.anchor.parent / 'managed-updates' / 'not-a-hash' / 'node_modules',
                                     self.anchor.parent / 'managed-updates' / ('a' * 64) / 'other']):
            path.mkdir(parents=True)
            instance = self.instance('invalid-' + str(index), path)
            with self.subTest(path=path), self.assertRaisesRegex(RuntimeError, 'escaped'):
                instance.resolve_prior_dependencies()

    def test_root_owned_selector_and_protected_closure_are_required(self):
        instance = self.instance('unowned-release', self.anchor)
        pointer = instance.prior / 'node_modules'
        os.chown(pointer, 65534, 65534, follow_symlinks=False)
        with self.assertRaisesRegex(RuntimeError, 'not root-owned'):
            instance.resolve_prior_dependencies()
        os.chown(pointer, 0, 0, follow_symlinks=False)
        self.anchor.chmod(0o775)
        with self.assertRaises(RuntimeError):
            instance.resolve_prior_dependencies()

    def test_signed_target_cannot_claim_a_different_node_abi(self):
        instance = self.instance('release', self.anchor)
        instance.resolve_prior_dependencies()
        bundle, description = self.bundle('bundle')
        description['nodeAbi'] += 1
        with self.assertRaisesRegex(RuntimeError, 'exact installed Node version and ABI'):
            self.qualify(instance, bundle, description)
        self.assertFalse((self.anchor.parent / 'managed-updates').exists())


if __name__ == '__main__':
    unittest.main()
