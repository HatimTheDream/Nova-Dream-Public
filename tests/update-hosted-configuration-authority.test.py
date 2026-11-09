"""Exercise the actual installer's dependency authority and physical closure."""
import copy
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'deploy/update-runner'))
if os.name == 'nt':
    with patch.dict(sys.modules, {'fcntl': types.ModuleType('fcntl')}):
        import install
else:
    import install
import recovery
import hosted_retained_configuration as hosted


class InstallerConfigurationAuthorityTests(unittest.TestCase):
    def fixture(self, managed):
        temporary = tempfile.TemporaryDirectory(prefix='nova-installer-authority-', dir=os.getenv('NOVA_TEST_TEMP'))
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
        # A physical node_modules tree supports the same join on every platform.
        # Linux additionally tests the distinct managed root selected by a symlink.
        release = root / 'release'
        release.mkdir()
        archive = root / 'archive' if sys.platform == 'linux' and managed else release
        dependency = archive / 'node_modules'
        (dependency / 'zod/sub').mkdir(parents=True)
        if archive != release:
            (release / 'node_modules').symlink_to(dependency, target_is_directory=True)
        service = release / 'dist/service'
        service.mkdir(parents=True)
        (service / 'entry.js').write_bytes(b'export const value=1;')
        (dependency / 'zod/package.json').write_bytes(b'{"name":"zod"}')
        (dependency / 'zod/sub/imported.js').write_bytes(b'export const value=2;')
        inventory_root = archive if managed else dependency
        if sys.platform == 'linux':
            identity = recovery.inventory(inventory_root)[0]
        else:
            identity = {p.relative_to(inventory_root).as_posix():
                {'kind': 'file', 'size': p.stat().st_size, 'sha256': recovery.digest(p)}
                for p in inventory_root.rglob('*') if p.is_file()}
        owner = install.Driver(root / 'request.json')
        owner.target = release
        owner.target_id = 'a' * 64
        owner.before = {'epoch': 'fixture-epoch'}
        owner.application_transition = {'qualified': True}
        owner.closed_startup = {'closedAtSeconds': 102}
        owner.log_retention_window = lambda: (100, 102)
        owner.ready_startup_record = lambda: ({'attempt': 1}, None)
        owner.node = root / 'node'
        owner.node.write_bytes(b'fixture-runtime')
        for name in ('started', 'ready', 'closed'):
            (root / ('startup-1-' + name + '.json')).write_text('{"fixture":true}')
        owner.dependencies = dependency
        owner.dependency_identity = recovery.inventory(dependency)[0] if sys.platform == 'linux' else {}
        owner.application_dependencies = {'signed': True} if managed else None
        if managed:
            owner.application_dependency_target = archive
            owner.target_dependency_identity = identity
        else:
            owner.dependency_identity = identity
        manifest = {'artifacts': [{'path': 'dist/service/entry.js', 'sha256': recovery.digest(service / 'entry.js')}]}
        return owner, manifest, dependency, identity

    def authority(self, owner, manifest):
        return owner.hosted_configuration_authority(manifest, owner.target, (100, 102))

    def test_managed_archive_uses_actual_attested_subtree_and_builder(self):
        owner, manifest, dependency, inventory = self.fixture(True)
        original = copy.deepcopy(inventory)
        authority = self.authority(owner, manifest)
        self.assertEqual(Path(authority['dependencyRoot']), dependency)
        self.assertEqual(set(authority['dependencyFiles']), {'zod/package.json', 'zod/sub/imported.js'})
        self.assertEqual(len(hosted.attest_builder_closure(owner.target, manifest,
            authority['dependencyRoot'], authority['dependencyFiles'])), 3)
        self.assertEqual(inventory, original)
        self.assertIn('node_modules/zod/sub/imported.js', inventory)

    def test_retained_node_modules_layout_uses_existing_attestation(self):
        owner, manifest, dependency, inventory = self.fixture(False)
        authority = self.authority(owner, manifest)
        self.assertEqual(Path(authority['dependencyRoot']), dependency)
        self.assertEqual(len(hosted.attest_builder_closure(owner.target, manifest,
            authority['dependencyRoot'], authority['dependencyFiles'])), 3)

    def test_changed_missing_extra_and_redirected_dependencies_still_refuse(self):
        mutations = ['changed', 'missing', 'extra']
        if sys.platform == 'linux':
            mutations.append('redirected')
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                owner, manifest, dependency, _ = self.fixture(True)
                authority = self.authority(owner, manifest)
                target = dependency / 'zod/sub/imported.js'
                if mutation == 'changed':
                    target.write_bytes(b'changed')
                elif mutation == 'missing':
                    target.unlink()
                elif mutation == 'extra':
                    (dependency / 'zod/unlisted.js').write_bytes(b'extra')
                else:
                    target.unlink()
                    target.symlink_to(dependency / 'zod/package.json')
                with self.assertRaises(RuntimeError):
                    hosted.attest_builder_closure(owner.target, manifest,
                        authority['dependencyRoot'], authority['dependencyFiles'])

    def test_wrong_inventory_namespace_and_wrong_selector_still_refuse(self):
        owner, manifest, dependency, _ = self.fixture(True)
        authority = self.authority(owner, manifest)
        with self.assertRaisesRegex(RuntimeError, 'selector changed'):
            hosted.attest_builder_closure(owner.target, manifest,
                owner.application_dependency_target, authority['dependencyFiles'])
        owner.target_dependency_identity = {'zod/file.js': {'kind': 'file', 'size': 1, 'sha256': 'b' * 64}}
        with self.assertRaisesRegex(RuntimeError, 'previously attested complete Zod'):
            self.authority(owner, manifest)

    def test_unclosed_or_different_target_cannot_issue_authority(self):
        owner, manifest, _, _ = self.fixture(True)
        owner.closed_startup = None
        with self.assertRaisesRegex(RuntimeError, 'genuinely closed target'):
            self.authority(owner, manifest)


if __name__ == '__main__':
    unittest.main()
