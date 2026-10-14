"""Bounded protected host configuration coverage for rehearsal and installation.

Linux CI uses real root-owned files under QA_PROTECTED_PARENT. Windows exercises
the same path/type guards, substituting only unavailable Unix ownership/mode bits.
No service, release, snapshot or controller operation runs in these tests.
"""
import ast
import contextlib
import hashlib
import os
import pathlib
import stat
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'deploy/update-runner'))
if sys.platform != 'linux':
    sys.modules.setdefault('fcntl', types.SimpleNamespace())
import install
import operator_rehearsal


class ProtectedConfigurationFilesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nova-protected-files-', dir=os.environ.get('QA_PROTECTED_PARENT'))
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name).resolve()
        self.workspace, self.releases = self.root / 'workspace', self.root / 'releases'
        self.workspace.mkdir(mode=0o700)
        self.releases.mkdir(mode=0o700)
        self.paths = []
        for i in range(33):
            path = self.root / ('configuration-%02d' % i)
            path.write_bytes(('protected configuration %d\n' % i).encode())
            path.chmod(0o600)
            self.paths.append(path)

    @contextlib.contextmanager
    def host_authority(self):
        if sys.platform == 'linux':
            yield
            return
        original = pathlib.Path.lstat

        def unix_authority(path, *args, **kwargs):
            result = list(original(path, *args, **kwargs))
            result[0] &= ~0o022
            result[4] = 0
            return os.stat_result(result)

        with patch.object(pathlib.Path, 'lstat', unix_authority):
            yield

    def validate(self, values):
        with self.host_authority():
            return install.protected_configuration_files(values, self.workspace, self.releases)

    def test_twenty_and_thirty_two_files_keep_every_path_and_byte(self):
        for count in (20, 32):
            with self.subTest(count=count):
                before = {p: p.read_bytes() for p in self.paths[:count]}
                result = self.validate([str(p) for p in before])
                self.assertEqual(result, list(before))
                self.assertEqual({p: p.read_bytes() for p in result}, before)

    def test_empty_oversized_and_non_list_sets_are_refused(self):
        for values in ([], [str(p) for p in self.paths], str(self.paths[0]), (str(self.paths[0]),), None):
            with self.subTest(values_type=type(values).__name__, count=len(values) if values is not None else None):
                with self.assertRaises(RuntimeError):
                    self.validate(values)

    def test_duplicate_normalized_paths_are_refused(self):
        path = self.paths[0]
        for duplicate in (str(path), str(path.parent) + '/./' + path.name):
            with self.subTest(duplicate=duplicate), self.assertRaises(RuntimeError):
                self.validate([str(path), duplicate])

    def test_workspace_and_release_files_cannot_be_protected_replacements(self):
        for root in (self.workspace, self.releases):
            path = root / 'configuration'
            path.write_bytes(b'unsafe replacement boundary\n')
            path.chmod(0o600)
            with self.subTest(root=root.name), self.assertRaises(RuntimeError):
                self.validate([str(path)])

    def test_relative_traversed_missing_and_directory_paths_are_refused(self):
        values = [self.paths[0].name, str(self.workspace / '..' / self.paths[0].name),
                  str(self.root / 'missing'), str(self.workspace)]
        for value in values:
            with self.subTest(value=value), self.assertRaises((RuntimeError, FileNotFoundError)):
                self.validate([value])

    @unittest.skipUnless(sys.platform == 'linux', 'Real Unix root ownership and permission qualification runs on Linux.')
    def test_unprotected_file_parent_and_owner_are_refused(self):
        self.paths[0].chmod(0o622)
        with self.assertRaises(RuntimeError):
            self.validate([str(self.paths[0])])
        self.paths[0].chmod(0o600)
        self.root.chmod(0o722)
        try:
            with self.assertRaises(RuntimeError):
                self.validate([str(self.paths[0])])
        finally:
            self.root.chmod(0o700)
        self.assertEqual(os.geteuid(), 0, 'Run protected-path qualification as root beneath QA_PROTECTED_PARENT.')
        os.chown(self.paths[0], 65534, -1)
        try:
            with self.assertRaises(RuntimeError):
                self.validate([str(self.paths[0])])
        finally:
            os.chown(self.paths[0], 0, -1)

    def test_symlink_file_and_parent_are_refused(self):
        link = self.root / 'linked-file'
        parent = self.root / 'linked-parent'
        try:
            link.symlink_to(self.paths[0])
            parent.symlink_to(self.root, target_is_directory=True)
        except (OSError, NotImplementedError) as error:
            if sys.platform == 'linux':
                raise
            self.skipTest('Host does not grant test symlink creation: ' + error.__class__.__name__)
        for value in (link, parent / self.paths[0].name):
            with self.subTest(path=value.name), self.assertRaises(RuntimeError):
                self.validate([str(value)])

    def test_both_consumers_retain_hashes_for_all_thirty_two_files(self):
        for module, class_name, method_name in ((install, 'Driver', 'validate'), (operator_rehearsal, 'Rehearsal', 'validate_operator')):
            with self.subTest(consumer=class_name):
                tree = ast.parse(pathlib.Path(module.__file__).read_bytes())
                cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == class_name)
                method = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == method_name)

                def assignment_to(node, name):
                    return isinstance(node, ast.Assign) and any(isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name) and t.value.id == 'self' and t.attr == name for t in node.targets)

                start = next(i for i, n in enumerate(method.body) if assignment_to(n, 'config_files'))
                end = next(i for i, n in enumerate(method.body) if assignment_to(n, 'config_hashes'))
                body = method.body[start:end + 1]
                self.assertTrue(any(isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == 'protected_configuration_files' for n in ast.walk(ast.Module(body=body, type_ignores=[]))), 'Both consumers must use the same protected-file bound and authority checks.')
                instance = types.SimpleNamespace(settings={'protectedFiles': [str(p) for p in self.paths[:32]]}, data=self.workspace, releases=self.releases)
                namespace = dict(vars(module), self=instance)
                with self.host_authority():
                    exec(compile(ast.Module(body=body, type_ignores=[]), str(module.__file__), 'exec'), namespace)
                self.assertEqual(instance.config_files, self.paths[:32])
                self.assertEqual(instance.config_hashes, {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in self.paths[:32]})


if __name__ == '__main__':
    unittest.main()
