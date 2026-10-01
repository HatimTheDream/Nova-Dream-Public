"""Offline dependency admission and independent extraction regressions.

No production paths, network or package installation. Archive checks run on all
platforms. The privileged filesystem cases need Linux root and a temporary /opt
directory so the real root-ownership checks are exercised without mocks.
"""
import copy
import hashlib
import io
import json
import os
import pathlib
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'deploy' / 'update-runner'))
import app_dependencies as dependencies


def entry(name, data=b'', kind='file', target='', mode=None):
    member = tarfile.TarInfo(name)
    member.type = {'file': tarfile.REGTYPE, 'directory': tarfile.DIRTYPE,
                   'symlink': tarfile.SYMTYPE, 'hardlink': tarfile.LNKTYPE,
                   'device': tarfile.CHRTYPE}[kind]
    member.mode = mode if mode is not None else (0o777 if kind == 'symlink' else 0o755 if kind == 'directory' else 0o644)
    member.size = len(data) if kind == 'file' else 0
    member.linkname = target
    return member, data


class Fixture:
    def __init__(self, root):
        self.root = pathlib.Path(root)
        self.serial = 0
        self.package = {'name': 'test-app', 'version': '2.0.4', 'dependencies': {'fixture': '1.0.0'}}
        self.lock = {'name': 'test-app', 'version': '2.0.4', 'lockfileVersion': 3,
                     'packages': {'': self.package, 'node_modules/fixture': {'version': '1.0.0', 'integrity': 'sha512-fixture'}}}

    def entries(self):
        return [entry('package.json', json.dumps(self.package).encode()),
                entry('package-lock.json', json.dumps(self.lock).encode()),
                entry('node_modules', kind='directory'),
                entry('node_modules/.bin', kind='directory'),
                entry('node_modules/fixture', kind='directory'),
                entry('node_modules/fixture/package.json', b'{"name":"fixture","version":"1.0.0"}'),
                entry('node_modules/fixture/index.js', b'module.exports = 42;\n'),
                entry('node_modules/fixture/cli.js', b'#!/usr/bin/env node\n', mode=0o755),
                entry('node_modules/.bin/fixture', kind='symlink', target='../fixture/cli.js')]

    def archive(self, entries=None):
        entries = self.entries() if entries is None else entries
        self.serial += 1
        archive = self.root / ('closure-' + str(self.serial) + '.tgz')
        with tarfile.open(archive, 'w:gz', format=tarfile.PAX_FORMAT) as stream:
            for member, data in entries:
                stream.addfile(member, io.BytesIO(data) if member.isfile() else None)
        lock_raw = next(data for member, data in entries if member.name == 'package-lock.json')
        description = {'format': 1, 'archiveBytes': archive.stat().st_size,
                       'archiveSha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
                       'expandedBytes': sum(member.size for member, _ in entries), 'fileCount': len(entries),
                       'packageLockSha256': hashlib.sha256(lock_raw).hexdigest(),
                       'dependencyGraphSha256': dependencies.dependency_graph_sha256(self.lock),
                       'platform': 'linux', 'arch': 'x64', 'nodeVersion': '22.23.2', 'nodeAbi': 127}
        return archive, description


class DependencyArchiveTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='nova-dependencies-test-')
        self.addCleanup(self.directory.cleanup)
        self.fixture = Fixture(self.directory.name)

    def test_valid_linux_closure_has_bounded_storage_and_internal_executable_link(self):
        archive, description = self.fixture.archive()
        members = dependencies.archive_members(archive, description)
        self.assertEqual(len(members), description['fileCount'])
        self.assertEqual(dependencies.storage_required(description), description['expandedBytes'] + 4096 * len(members))
        self.assertTrue(next(member for member in members if member.name == 'node_modules/.bin/fixture').issym())
        self.assertEqual(next(member.mode for member in members if member.name == 'node_modules/fixture/cli.js'), 0o755)

    def test_description_requires_exact_signed_bytes_hash_platform_and_abi(self):
        _, description = self.fixture.archive()
        signed = {'bytes': description['archiveBytes'], 'sha256': description['archiveSha256'], 'url': 'https://example.invalid/closure.tgz'}
        dependencies.validate_description(description, signed)
        for changes in ({'format': True}, {'fileCount': True}, {'nodeAbi': '127'}, {'nodeAbi': 0},
                        {'platform': 'win32'}, {'arch': 'ia32'}, {'nodeVersion': '22'},
                        {'archiveBytes': dependencies.ARCHIVE_MAXIMUM + 1},
                        {'expandedBytes': dependencies.EXPANDED_MAXIMUM + 1},
                        {'fileCount': dependencies.MEMBER_MAXIMUM + 1}, {'unexpected': True},
                        {'archiveSha256': 'z' * 64}):
            with self.subTest(changes=changes), self.assertRaises(RuntimeError):
                dependencies.validate_description({**description, **changes}, signed)
        for changes in ({'bytes': signed['bytes'] + 1}, {'sha256': 'a' * 64}):
            with self.subTest(signed=changes), self.assertRaises(RuntimeError):
                dependencies.validate_description(description, {**signed, **changes})

    def test_dependency_identity_ignores_only_the_root_package_record(self):
        original = dependencies.dependency_graph_sha256(self.fixture.lock)
        root_change = copy.deepcopy(self.fixture.lock)
        root_change['version'] = '2.0.5'
        root_change['packages']['']['version'] = '2.0.5'
        self.assertEqual(original, dependencies.dependency_graph_sha256(root_change))
        changed = copy.deepcopy(root_change)
        changed['packages']['node_modules/fixture']['integrity'] = 'sha512-different'
        self.assertNotEqual(original, dependencies.dependency_graph_sha256(changed))
        self.assertEqual(original, dependencies.dependency_graph_sha256(json.loads(json.dumps(self.fixture.lock, sort_keys=True))))

    def test_malformed_locks_and_duplicate_json_keys_are_rejected(self):
        for lock in ({}, {'lockfileVersion': 1, 'packages': {}}, {'lockfileVersion': 3, 'packages': {'': {}}}):
            if lock.get('lockfileVersion') == 3:
                # An empty graph is allowed for an application with no dependencies.
                dependencies.dependency_graph_sha256(lock)
            else:
                with self.assertRaises(RuntimeError):
                    dependencies.dependency_graph_sha256(lock)
        for raw in (b'{"x":1,"x":2}', b'{"packages":{"a":{"x":1,"x":2}}}', b'{"number":NaN}'):
            with self.subTest(raw=raw), self.assertRaises(RuntimeError):
                dependencies.parse_json(raw)

    def test_archive_bytes_counts_and_graph_must_all_match(self):
        archive, description = self.fixture.archive()
        for changes in ({'archiveBytes': description['archiveBytes'] + 1}, {'archiveSha256': 'a' * 64},
                        {'fileCount': description['fileCount'] - 1}, {'fileCount': description['fileCount'] + 1},
                        {'expandedBytes': description['expandedBytes'] - 1}, {'expandedBytes': description['expandedBytes'] + 1},
                        {'packageLockSha256': 'a' * 64}, {'dependencyGraphSha256': 'a' * 64}):
            with self.subTest(changes=changes), self.assertRaises(RuntimeError):
                dependencies.archive_members(archive, {**description, **changes})

    def test_package_and_lock_root_dependency_mismatch_is_rejected(self):
        entries = self.fixture.entries()
        entries[0] = entry('package.json', b'{"dependencies":{"fixture":"9.0.0"}}')
        with self.assertRaisesRegex(RuntimeError, 'disagree'):
            dependencies.archive_members(*self.fixture.archive(entries))

    def test_installed_versions_unknown_packages_and_missing_dependencies_are_rejected(self):
        for case in ('version', 'unlisted', 'missing'):
            entries = self.fixture.entries()
            if case == 'version':
                entries = [(member, b'{"name":"fixture","version":"9.0.0"}') if member.name == 'node_modules/fixture/package.json'
                           else (member, data) for member, data in entries]
                for member, data in entries:
                    if member.isfile(): member.size = len(data)
            elif case == 'unlisted':
                entries += [entry('node_modules/unlisted', kind='directory'),
                            entry('node_modules/unlisted/package.json', b'{"name":"unlisted","version":"1.0.0"}')]
            else:
                entries = [(member, data) for member, data in entries if member.name != 'node_modules/fixture/package.json']
            with self.subTest(case=case), self.assertRaises(RuntimeError):
                dependencies.archive_members(*self.fixture.archive(entries))

    def test_optional_development_and_incompatible_packages_can_be_omitted(self):
        self.fixture.lock['packages'].update({'node_modules/optional': {'version': '1.0.0', 'optional': True},
                                             'node_modules/dev': {'version': '1.0.0', 'dev': True},
                                             'node_modules/windows': {'version': '1.0.0', 'os': ['win32']}})
        dependencies.archive_members(*self.fixture.archive())
        self.fixture.lock['packages']['node_modules/mandatory'] = {'version': '1.0.0'}
        with self.assertRaisesRegex(RuntimeError, 'missing a required'):
            dependencies.archive_members(*self.fixture.archive())

    def test_path_traversal_unrelated_entries_and_missing_explicit_parents_are_rejected(self):
        for name in ('../escape', '/absolute', 'node_modules/../escape', 'node_modules/a//b',
                     'node_modules/a/./b', 'node_modules/a\\b', 'node_modules/line\nbreak',
                     'node_modules/new-parent/file.js', 'scripts/host.mjs'):
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                dependencies.archive_members(*self.fixture.archive(self.fixture.entries() + [entry(name)]))

    def test_unsafe_types_duplicate_paths_and_modes_are_rejected(self):
        bad_entries = [entry('node_modules/fixture/index.js'),
                       entry('node_modules/fixture/hard', kind='hardlink', target='node_modules/fixture/index.js'),
                       entry('node_modules/fixture/device', kind='device'),
                       entry('node_modules/fixture/setuid', mode=0o4755),
                       entry('node_modules/fixture/writable', mode=0o666),
                       entry('node_modules/fixture/directory', kind='directory', mode=0o775)]
        for bad in bad_entries:
            with self.subTest(name=bad[0].name), self.assertRaises(RuntimeError):
                dependencies.archive_members(*self.fixture.archive(self.fixture.entries() + [bad]))

    def test_links_cannot_escape_dangle_cycle_or_be_traversed_by_archive_members(self):
        for target in ('../../outside', '/etc/passwd', '../missing', '..\\outside'):
            entries = self.fixture.entries()
            entries[-1] = entry('node_modules/.bin/fixture', kind='symlink', target=target)
            with self.subTest(target=target), self.assertRaises(RuntimeError):
                dependencies.archive_members(*self.fixture.archive(entries))
        cyclic = self.fixture.entries() + [entry('node_modules/.bin/a', kind='symlink', target='b'),
                                          entry('node_modules/.bin/b', kind='symlink', target='a')]
        with self.assertRaisesRegex(RuntimeError, 'cyclic'):
            dependencies.archive_members(*self.fixture.archive(cyclic))
        for reverse in (False, True):
            additions = [entry('node_modules/directory-link', kind='symlink', target='fixture'),
                         entry('node_modules/directory-link/file')]
            with self.subTest(reverse=reverse), self.assertRaisesRegex(RuntimeError, 'traverses'):
                dependencies.archive_members(*self.fixture.archive(self.fixture.entries() + (additions[::-1] if reverse else additions)))

    def test_internal_link_chains_and_directory_prefix_targets_are_supported(self):
        entries = self.fixture.entries() + [entry('node_modules/alias', kind='symlink', target='fixture'),
                                           entry('node_modules/.bin/second', kind='symlink', target='../alias/cli.js')]
        self.assertEqual(len(dependencies.archive_members(*self.fixture.archive(entries))), len(entries))

    def test_long_pax_paths_are_supported_but_unreviewed_pax_metadata_is_not(self):
        long_name = 'node_modules/fixture/' + 'x' * 150 + '.js'
        dependencies.archive_members(*self.fixture.archive(self.fixture.entries() + [entry(long_name, b'long path')]))
        bad = entry('node_modules/fixture/pax.js', b'bad')
        bad[0].pax_headers = {'comment': 'unreviewed'}
        with self.assertRaisesRegex(RuntimeError, 'metadata'):
            dependencies.archive_members(*self.fixture.archive(self.fixture.entries() + [bad]))
        oversized = entry('node_modules/fixture/pax.js', b'bad')
        oversized[0].pax_headers = {'comment': 'x' * 17000}
        with self.assertRaisesRegex(RuntimeError, 'oversized'):
            dependencies.archive_members(*self.fixture.archive(self.fixture.entries() + [oversized]))

    def test_native_qualification_rejects_abi_version_and_platform_mismatches(self):
        _, description = self.fixture.archive()
        identity = {key: description[key] for key in ('platform', 'arch', 'nodeVersion', 'nodeAbi')}
        with patch.object(dependencies, 'execution_identity', return_value=identity):
            dependencies.verify_execution(pathlib.Path('/fixture'), pathlib.Path('/node'), description, 'fixture')
        for changes in ({'nodeVersion': '24.0.0'}, {'nodeAbi': 137}, {'arch': 'arm64'}, {'platform': 'darwin'}):
            with self.subTest(changes=changes), patch.object(dependencies, 'execution_identity', return_value={**identity, **changes}), self.assertRaises(RuntimeError):
                dependencies.verify_execution(pathlib.Path('/fixture'), pathlib.Path('/node'), description, 'fixture')
        with patch.object(dependencies, 'execution_identity', side_effect=subprocess.CalledProcessError(1, 'node')), self.assertRaises(subprocess.CalledProcessError):
            dependencies.verify_execution(pathlib.Path('/fixture'), pathlib.Path('/node'), description, 'fixture')

    def test_builder_uses_the_same_contract_and_does_not_overwrite_output(self):
        source = pathlib.Path(self.directory.name) / 'source'
        source.mkdir()
        (source / 'package.json').write_text(json.dumps(self.fixture.package), encoding='utf-8')
        (source / 'package-lock.json').write_text(json.dumps(self.fixture.lock), encoding='utf-8')
        (source / 'node_modules').mkdir()
        (source / 'node_modules' / 'fixture').mkdir()
        (source / 'node_modules' / 'fixture' / 'package.json').write_text('{"name":"fixture","version":"1.0.0"}', encoding='utf-8')
        (source / 'node_modules' / 'fixture' / 'index.js').write_text('module.exports = 42;', encoding='utf-8')
        output = pathlib.Path(self.directory.name) / 'packed.tgz'
        identity = {'platform': 'linux', 'arch': 'x64', 'nodeVersion': '22.23.2', 'nodeAbi': 127}
        # Only producer native qualification is substituted in this cross-platform
        # fixture. Actual native imports remain required in Linux qualification.
        with patch.object(dependencies, 'execution_identity', return_value=identity):
            description = dependencies.pack_closure(source, output, pathlib.Path('/node'))
            self.assertEqual(dependencies.archive_members(output, description)[0].name, 'node_modules')
            original = output.read_bytes()
            with self.assertRaises(FileExistsError):
                dependencies.pack_closure(source, output, pathlib.Path('/node'))
            self.assertEqual(output.read_bytes(), original)
        self.assertEqual(json.loads(output.with_name(output.name + '.metadata.json').read_text()), description)


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'Real protected extraction requires Linux root')
class ProtectedExtractionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='nova-dependency-fixture-', dir=os.environ.get('QA_PROTECTED_PARENT', '/opt'))
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name)
        self.root.chmod(0o755)
        self.fixture = Fixture(self.root)

    def test_independent_extract_preserves_executable_and_internal_link_with_private_umask(self):
        archive, description = self.fixture.archive()
        target = self.root / 'closure'
        prior = self.root / 'prior'; prior.mkdir()
        saved = prior / 'saved'; saved.write_bytes(b'original dependency'); saved.chmod(0o644)
        old_umask = os.umask(0o077)
        try:
            result = dependencies.stage_closure(archive, target, description)
        finally:
            os.umask(old_umask)
        self.assertEqual(result, target / 'node_modules')
        self.assertEqual((result / '.bin' / 'fixture').resolve(), result / 'fixture' / 'cli.js')
        self.assertEqual((result / 'fixture' / 'cli.js').stat().st_mode & 0o777, 0o755)
        self.assertTrue(all(path.stat().st_nlink == 1 for path in target.rglob('*') if path.is_file() and not path.is_symlink()))
        self.assertEqual(dependencies.stage_closure(archive, target, description), result)
        self.assertEqual(saved.read_bytes(), b'original dependency')

    def test_changed_missing_extra_or_hardlinked_staging_is_never_reused(self):
        for change in ('content', 'missing', 'extra', 'hardlink', 'mode'):
            with self.subTest(change=change):
                archive, description = self.fixture.archive()
                target = self.root / change
                dependencies.stage_closure(archive, target, description)
                path = target / 'node_modules' / 'fixture' / 'index.js'
                if change == 'content': path.write_bytes(b'changed')
                elif change == 'missing': path.unlink()
                elif change == 'extra': (target / 'extra').write_bytes(b'new')
                elif change == 'hardlink': os.link(path, self.root / 'shared-link')
                elif change == 'mode': path.chmod(0o666)
                with self.assertRaises(RuntimeError):
                    dependencies.stage_closure(archive, target, description)
                self.assertTrue(target.exists(), 'Rejected staging must remain available for diagnosis')

    def test_nested_closure_content_verification_never_seeks_gzip_backwards(self):
        entries = self.fixture.entries()
        for number in range(8):
            parent = 'node_modules/fixture/tree-' + str(number)
            entries.extend([entry(parent, kind='directory'),
                            entry(parent + '/first.bin', b'a' * 65536),
                            entry(parent + '/nested', kind='directory'),
                            entry(parent + '/nested/content.bin', b'b' * 65536),
                            entry(parent + '/last.bin', b'c' * 65536)])
        entries.sort(key=lambda item: item[0].name)
        archive, description = self.fixture.archive(entries)
        target = self.root / 'nested-closure'
        dependencies.stage_closure(archive, target, description)
        observations = []
        open_archive = dependencies._archive

        def tracking_archive(path):
            opened = open_archive(path)
            stream = opened.fileobj
            seeks, reads = [], []
            observations.append((seeks, reads))
            original_seek, original_read = stream.seek, stream.read

            def track_seek(offset, whence=0):
                # GzipFile.tell can delegate to seek on newer Python versions;
                # query through the saved original method to avoid recursion.
                before = original_seek(0, os.SEEK_CUR)
                result = original_seek(offset, whence)
                seeks.append((before, original_seek(0, os.SEEK_CUR)))
                return result

            def track_read(size=-1):
                before = original_seek(0, os.SEEK_CUR)
                result = original_read(size)
                reads.append((before, original_seek(0, os.SEEK_CUR), len(result)))
                return result

            stream.seek, stream.read = track_seek, track_read
            return opened

        with patch.object(dependencies, '_archive', side_effect=tracking_archive):
            dependencies.verify_closure(archive, target, description)
        # archive_members separately validates metadata and package versions.
        # The last archive instance is the actual complete file-content pass.
        seeks, reads = observations[-1]
        self.assertGreater(len(seeks), 24)
        self.assertFalse([(before, after) for before, after in seeks if after < before],
                         'Nested package verification must not replay gzip decompression')
        self.assertEqual(sum(length for _, _, length in reads), description['expandedBytes'])
        file_offsets = [member.offset_data for member in dependencies.archive_members(archive, description) if member.isfile()]
        self.assertEqual(file_offsets, sorted(file_offsets))
        # Forward-only reading must still detect a same-length content change.
        damaged = target / 'node_modules/fixture/tree-3/nested/content.bin'
        damaged.write_bytes(b'x' * 65536)
        with self.assertRaisesRegex(RuntimeError, 'content changed'):
            dependencies.verify_closure(archive, target, description)

    def test_redirected_destination_and_unprotected_parent_are_rejected(self):
        archive, description = self.fixture.archive()
        outside = self.root / 'outside'; outside.mkdir()
        redirected = self.root / 'redirect'; redirected.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(RuntimeError):
            dependencies.stage_closure(archive, redirected, description)
        self.assertEqual(list(outside.iterdir()), [])
        parent = self.root / 'writable'; parent.mkdir(); parent.chmod(0o777)
        with self.assertRaises(RuntimeError):
            dependencies.stage_closure(archive, parent / 'target', description)

    def test_legacy_receipt_attests_actual_bytes_without_creating_a_lock(self):
        archive, description = self.fixture.archive()
        target = self.root / 'closure'
        dependencies.stage_closure(archive, target, description)
        retained = target / 'node_modules'
        receipt = dependencies.attest_retained_dependencies(retained)
        self.assertEqual(receipt['sharedFileCount'], 0)
        self.assertFalse((retained / 'package-lock.json').exists())
        dependencies.verify_retained_dependencies(retained, receipt)
        path = retained / 'fixture' / 'index.js'
        os.link(path, self.root / 'legacy-shared')
        with self.assertRaisesRegex(RuntimeError, 'inodes'):
            dependencies.attest_retained_dependencies(retained)
        shared = dependencies.attest_retained_dependencies(retained, allow_existing_hardlinks=True)
        self.assertEqual(shared['sharedFileCount'], 1)
        path.write_bytes(b'changed through shared inode')
        with self.assertRaisesRegex(RuntimeError, 'changed'):
            dependencies.verify_retained_dependencies(retained, shared, allow_existing_hardlinks=True)

    def test_adoption_copies_writable_shared_dependencies_without_mutating_originals(self):
        archive, description = self.fixture.archive()
        source = dependencies.stage_closure(archive, self.root / 'old-release', description)
        source.chmod(0o775)
        original = source / 'fixture' / 'index.js'
        original.chmod(0o664)
        other_release = self.root / 'other-release'; other_release.mkdir()
        os.link(original, other_release / 'shared.js')
        before = dependencies.inspect_retained_dependencies(source)
        original_stat = original.stat()
        self.assertEqual(before['sharedFileCount'], 1)
        with self.assertRaises(RuntimeError):
            dependencies.attest_retained_dependencies(source)
        retained = self.root / 'adopted-node-modules'
        receipt = dependencies.stage_retained_dependencies(source, retained, before)
        self.assertEqual(receipt['source'], before)
        self.assertEqual(receipt['retained']['sharedFileCount'], 0)
        self.assertEqual(dependencies.inspect_retained_dependencies(source), before)
        self.assertEqual(original.stat().st_ino, original_stat.st_ino)
        self.assertEqual(original.stat().st_mode, original_stat.st_mode)
        self.assertEqual(original.stat().st_nlink, 2)
        self.assertNotEqual(original.stat().st_ino, (retained / 'fixture' / 'index.js').stat().st_ino)
        self.assertEqual((retained / 'fixture' / 'index.js').stat().st_mode & 0o777, 0o644)
        self.assertEqual((retained / 'fixture' / 'cli.js').stat().st_mode & 0o777, 0o755)
        self.assertEqual(os.readlink(retained / '.bin' / 'fixture'), '../fixture/cli.js')
        self.assertFalse((retained / 'package-lock.json').exists())
        with self.assertRaisesRegex(RuntimeError, 'already exists'):
            dependencies.stage_retained_dependencies(source, retained, before)

    def test_adoption_refuses_stale_source_receipt_or_copy_failure_and_keeps_original(self):
        archive, description = self.fixture.archive()
        source = dependencies.stage_closure(archive, self.root / 'old-release', description)
        before = dependencies.inspect_retained_dependencies(source)
        original = source / 'fixture' / 'index.js'
        original.write_bytes(b'legitimate later change')
        target = self.root / 'stale'
        with self.assertRaisesRegex(RuntimeError, 'after adoption review'):
            dependencies.stage_retained_dependencies(source, target, before)
        self.assertFalse(target.exists())
        before = dependencies.inspect_retained_dependencies(source)
        target = self.root / 'interrupted'
        with patch.object(dependencies.shutil, 'copyfileobj', side_effect=OSError('synthetic interrupted copy')), self.assertRaises(OSError):
            dependencies.stage_retained_dependencies(source, target, before)
        self.assertTrue(target.exists())
        self.assertEqual(dependencies.inspect_retained_dependencies(source), before)
        with self.assertRaisesRegex(RuntimeError, 'already exists'):
            dependencies.stage_retained_dependencies(source, target, before)


if __name__ == '__main__':
    unittest.main()
