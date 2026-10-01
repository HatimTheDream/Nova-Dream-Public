"""Synthetic packaging checks against the actual maintained archive parser."""
import ast
import importlib.util
import json
import os
import pathlib
import shutil
import tarfile
import tempfile
import types
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('app_archive', ROOT / 'scripts/update-app-archive.py')
packer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packer)


class AppArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nova-app-archive-fixture-')
        self.root = pathlib.Path(self.temporary.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.node = os.environ.get('NODE_BINARY') or shutil.which('node')
        self.assertIsNotNone(self.node, 'Set NODE_BINARY to the selected build Node executable.')
        self.package = {'name': 'nova-dream-edition-3', 'version': '1.0.0', 'dependencies': {},
                        'edition3': {'buildVersion': '1.0.1', 'schemaVersion': 55,
                                     'apiVersion': 1, 'appId': 'fixture.nova'}}
        self.write('package.json', self.package)
        self.write('package-lock.json', {'name': self.package['name'], 'version': '1.0.0',
                                        'lockfileVersion': 3, 'packages': {'': {'version': '1.0.0'}}})
        artifact_paths = ['dist/client/index.html', 'dist/service/apps/service/main.js',
                          'dist/service/apps/service/assignments.js',
                          'dist/service/apps/service/runtime-child.js',
                          'dist/service/packages/domain/worker.js']
        plugin = 'dist/service/apps/service/worker-plugin/'
        artifact_paths += [plugin + name for name in ('index.js', 'identity.js', 'journal.js',
                                                     'openclaw.plugin.json', 'package.json')]
        for name in artifact_paths:
            self.write(name, {'id': 'edition3-worker'} if name.endswith('openclaw.plugin.json')
                       else {'openclaw': {'extensions': ['./index.js']}} if name.endswith('/package.json')
                       else 'inert fixture\n')
        self.write('dist/candidate.json', {'version': '1.0.0', **self.package['edition3'], 'artifacts': [
            {'path': name, 'sha256': packer.sha((self.source / name).read_bytes())} for name in artifact_paths]})
        self.write('scripts/host.mjs', '// inert host fixture\n')
        self.write('scripts/candidate.mjs', '// inert verifier fixture\n')
        self.output = self.root / 'app.tgz'

    def tearDown(self):
        self.temporary.cleanup()

    def write(self, name, value):
        path = self.source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value) if isinstance(value, dict) else value, encoding='utf-8')

    def package_archive(self):
        return packer.package_app_archive(self.source, self.output, self.node)

    def test_actual_installer_parser_accepts_only_selected_files_with_protected_modes(self):
        for name in ('release.json', 'scripts/unreviewed.mjs', '.env', 'workspace/private.json', 'dist/client/stale.js'):
            self.write(name, 'must not ship')
        metadata = self.package_archive()
        tree = ast.parse((ROOT / 'deploy/update-runner/install.py').read_text(encoding='utf-8'))
        driver = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'Driver')
        method = next(node for node in driver.body if isinstance(node, ast.FunctionDef) and node.name == 'archive_members')
        namespace = {'tarfile': tarfile, 'pathlib': pathlib, 'MAXIMUM': packer.MAXIMUM, 'require': packer.require}
        exec(compile(ast.Module(body=[method], type_ignores=[]), str(ROOT / 'deploy/update-runner/install.py'), 'exec'), namespace)
        members = namespace['archive_members'](types.SimpleNamespace(archive=self.output))
        names = {member.name for member in members}
        self.assertTrue({'dist/candidate.json', 'package.json', 'package-lock.json', 'scripts/host.mjs', 'scripts/candidate.mjs'} <= names)
        self.assertFalse({'release.json', 'scripts/unreviewed.mjs', '.env', 'workspace/private.json', 'dist/client/stale.js'} & names)
        self.assertTrue(all(member.mode == (0o755 if member.isdir() else 0o644)
                            and member.uid == member.gid == member.mtime == 0 for member in members))
        self.assertEqual(metadata['fileCount'], len(members))
        self.assertEqual(metadata['archiveSha256'], packer.sha(self.output.read_bytes()))
        self.assertEqual(metadata['archiveBytes'], self.output.stat().st_size)
        self.assertEqual(metadata['expandedBytes'], sum(member.size for member in members))

    def test_repeated_packaging_is_deterministic_and_never_overwrites(self):
        first = self.package_archive()
        second = packer.package_app_archive(self.source, self.root / 'second.tgz', self.node)
        self.assertEqual(first, second)
        with self.assertRaisesRegex(RuntimeError, 'already exists'):
            self.package_archive()
        self.assertEqual(first['archiveSha256'], packer.sha(self.output.read_bytes()))

    def test_tampered_candidate_or_package_is_rejected_before_output(self):
        self.write('dist/client/index.html', 'changed after build')
        with self.assertRaisesRegex(RuntimeError, 'Candidate verification failed'):
            self.package_archive()
        self.assertFalse(self.output.exists())

    def test_unpaired_lockfile_is_rejected_before_output(self):
        self.write('package-lock.json', {'name': self.package['name'], 'version': '0.9.0',
                                        'lockfileVersion': 3, 'packages': {'': {'version': '0.9.0'}}})
        with self.assertRaisesRegex(RuntimeError, 'do not match'):
            self.package_archive()
        self.assertFalse(self.output.exists())

    def test_host_script_symlink_is_rejected(self):
        host = self.source / 'scripts/host.mjs'
        host.unlink()
        try:
            host.symlink_to(self.source / 'scripts/candidate.mjs')
        except OSError as error:
            self.skipTest('Fixture host cannot create file symlinks: ' + str(error.errno))
        with self.assertRaisesRegex(RuntimeError, 'symlinks'):
            self.package_archive()

    def test_output_cannot_be_written_inside_the_application(self):
        with self.assertRaisesRegex(RuntimeError, 'outside its source'):
            packer.package_app_archive(self.source, self.source / 'app.tgz', self.node)


if __name__ == '__main__':
    unittest.main()
