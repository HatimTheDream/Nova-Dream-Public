"""Real file/SQLite catalog proofs; disposable fixtures only."""
import contextlib
import copy
import hashlib
import json
import os
import pathlib
import sqlite3
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'deploy/update-runner'))
import recovery


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def signature(path):
    info = path.stat()
    return {'size': info.st_size, 'mtimeMs': info.st_mtime_ns / 10**6, 'ctimeMs': info.st_ctime_ns / 10**6}


class CatalogFilesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nova-catalog-files-')
        self.root = pathlib.Path(self.temporary.name).resolve()
        self.snapshot, self.live = self.root / 'snapshot', self.root / 'live'
        self.selected = pathlib.Path('selected')
        for directory in (self.snapshot, self.live):
            directory.mkdir()
        self.releases = []
        self.indexes = []
        for side in ('old', 'new'):
            release = self.root / side
            plugins = []
            for plugin_id, directory in [('edition3-worker', 'worker-plugin'), ('edition3-sources', 'source-plugin'),
                                          ('edition3-accounts', 'account-plugin'), ('edition3-workspace', 'module-plugin')]:
                folder = release / 'dist/service/apps/service' / directory
                folder.mkdir(parents=True)
                manifest = {'id': plugin_id, 'configSchema': {'type': 'object'}, 'activation': {'onStartup': True}}
                package = {'name': plugin_id, 'version': '1.0.0' if side == 'old' else '1.0.1', 'type': 'module'}
                (folder / 'openclaw.plugin.json').write_text(json.dumps(manifest, indent=2 if side == 'old' else None))
                (folder / 'package.json').write_text(json.dumps(package, indent=2 if side == 'old' else None))
                (folder / 'index.js').write_text('export default ' + json.dumps(side) + ';')
                plugins.append(self.record(folder, folder, plugin_id, package['version']))
            manifest = {'artifacts': [{'path': file.relative_to(release).as_posix(), 'sha256': sha(file)}
                                      for file in release.rglob('*') if file.is_file()]}
            self.releases.append((release, manifest))
            self.indexes.append({'version': 1, 'warning': 'Generated catalog', 'hostContractVersion': '2026.9.6',
                'compatRegistryVersion': 'a'*64, 'migrationVersion': 1, 'policyHash': 'b'*64,
                'generatedAtMs': 1 if side == 'old' else 2, 'workspaceDir': str(self.live / self.selected),
                'installRecords': {'codex': {'version': '2026.9.6', 'acceptedSurface': ['retained-tool']}},
                'plugins': plugins, 'diagnostics': []})
        relative = self.selected / 'openclaw-runtime/state/npm/projects/openclaw-codex-123456789a/node_modules/@openclaw/codex'
        logical = self.live / relative
        for root in (self.snapshot, self.live):
            physical = root / relative
            (physical / 'dist').mkdir(parents=True)
            for name, value in [('openclaw.plugin.json', json.dumps({'id': 'codex'})),
                                ('package.json', json.dumps({'name': '@openclaw/codex', 'version': '2026.9.6'})),
                                ('dist/index.js', 'export const retained=true;'),
                                ('dist/doctor-contract-api.js', 'export const doctor=true;')]:
                path = physical / name
                path.write_text(value)
                os.utime(path, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))
            record = self.record(logical, physical, 'codex', '2026.9.6')
            record['packageName'] = '@openclaw/codex'
            record['doctorContractHash'] = sha(physical / 'dist/doctor-contract-api.js')
            record['doctorContractFile'] = signature(physical / 'dist/doctor-contract-api.js')
            if root == self.snapshot:
                for field in ('manifestFile', 'doctorContractFile'):
                    record[field]['ctimeMs'] = 123
                record['packageJson']['fileSignature']['ctimeMs'] = 123
            self.indexes[0 if root == self.snapshot else 1]['plugins'].append(record)

    def tearDown(self):
        self.temporary.cleanup()

    def record(self, logical, physical, plugin_id, version):
        return {'pluginId': plugin_id, 'enabled': True, 'rootDir': str(logical),
            'source': str(logical / ('dist/index.js' if plugin_id == 'codex' else 'index.js')),
            'manifestPath': str(logical / 'openclaw.plugin.json'), 'manifestHash': sha(physical / 'openclaw.plugin.json'),
            'manifestFile': signature(physical / 'openclaw.plugin.json'),
            'packageName': plugin_id, 'packageVersion': version,
            'packageJson': {'path': 'package.json', 'hash': sha(physical / 'package.json'),
                            'fileSignature': signature(physical / 'package.json')},
            'contributions': {'tools': ['retained-tool']}, 'startup': {'enabled': True}, 'origin': 'retained'}

    def compare(self, mutation=None, *, context=True):
        values = copy.deepcopy(self.indexes)
        if mutation:
            mutation(values[1])
        with contextlib.closing(sqlite3.connect(':memory:')) as before, contextlib.closing(sqlite3.connect(':memory:')) as after:
            for db, value in zip((before, after), values):
                db.execute('create table config_machine_state(state_key text primary key,value_json text,updated_at_ms integer)')
                db.execute('insert into config_machine_state values(?,?,?)',
                           ('plugins.installedIndex', json.dumps({'revision': value['generatedAtMs'], 'index': value}), value['generatedAtMs']))
                db.execute("insert into config_machine_state values('retained-policy','{}',1)")
            arguments = {'app_releases': self.releases,
                         'workspace_roots': (self.snapshot, self.live, self.live, self.selected)} if context else {}
            recovery.retained_plugin_index(before, after, None, self.root / 'unused', '2026.9.6', '2026.9.6', **arguments)

    def test_real_relocation_formatting_versions_and_copied_ctime_are_file_attested(self):
        before = {str(p): sha(p) for p in self.root.rglob('*') if p.is_file()}
        self.compare()
        self.assertEqual(before, {str(p): sha(p) for p in self.root.rglob('*') if p.is_file()})
        with self.assertRaises(RuntimeError):
            self.compare(context=False)

    def test_policy_capability_order_unknown_and_install_changes_remain_strict(self):
        mutations = [lambda v: v.update(policyHash='c'*64),
            lambda v: v['plugins'][0]['contributions']['tools'].append('unexpected'),
            lambda v: v['plugins'][0].update(enabled=False),
            lambda v: v['plugins'][0].update(unknown=True),
            lambda v: v['plugins'].reverse(), lambda v: v['plugins'].pop(),
            lambda v: v['installRecords']['codex'].update(version='other'),
            lambda v: v['plugins'][-1].update(rootDir=str(self.root / 'unrelated'))]
        for number, mutation in enumerate(mutations):
            with self.subTest(case=number), self.assertRaises(RuntimeError):
                self.compare(mutation)

    def test_forged_hash_signature_path_and_package_identity_are_rejected(self):
        mutations = [lambda v: v['plugins'][0].update(manifestHash='c'*64),
            lambda v: v['plugins'][0]['manifestFile'].update(size=1),
            lambda v: v['plugins'][0]['manifestFile'].update(ctimeMs=1),
            lambda v: v['plugins'][0]['manifestFile'].update(mtimeMs=1),
            lambda v: v['plugins'][0]['manifestFile'].update(unknown=1),
            lambda v: v['plugins'][0].update(manifestFile=None),
            lambda v: v['plugins'][0]['packageJson'].update(path='../package.json'),
            lambda v: v['plugins'][0].update(packageVersion='forged'),
            lambda v: v['plugins'][-1]['doctorContractFile'].update(ctimeMs=1),
            lambda v: v['plugins'][-1]['packageJson']['fileSignature'].update(mtimeMs=1)]
        for number, mutation in enumerate(mutations):
            with self.subTest(case=number), self.assertRaises(RuntimeError):
                self.compare(mutation)

    def test_candidate_artifact_bytes_cannot_change_behind_metadata(self):
        root, _ = self.releases[1]
        (root / 'dist/service/apps/service/worker-plugin/index.js').write_text('changed')
        with self.assertRaisesRegex(RuntimeError, 'verified candidate'):
            self.compare()

    def test_even_candidate_bound_manifest_semantics_cannot_silently_change(self):
        root, manifest = self.releases[1]
        file = root / 'dist/service/apps/service/worker-plugin/openclaw.plugin.json'
        value = json.loads(file.read_text());value['activation']['onStartup'] = False
        file.write_text(json.dumps(value))
        for artifact in manifest['artifacts']:
            if artifact['path'] == file.relative_to(root).as_posix():
                artifact['sha256'] = sha(file)
        self.indexes[1]['plugins'][0].update(manifestHash=sha(file), manifestFile=signature(file))
        with self.assertRaisesRegex(RuntimeError, 'JSON semantics'):
            self.compare()

    def test_copied_package_bytes_and_entrypoint_remain_exact(self):
        plugin = self.indexes[1]['plugins'][-1]
        (pathlib.Path(plugin['rootDir']) / 'dist/index.js').write_text('changed')
        with self.assertRaisesRegex(RuntimeError, 'retained content hash'):
            self.compare()

    @unittest.skipIf(os.name == 'nt', 'Linux symlink qualification')
    def test_symlinked_artifact_is_rejected(self):
        file = self.releases[1][0] / 'dist/service/apps/service/worker-plugin/index.js'
        target = self.root / 'redirect.js';target.write_bytes(file.read_bytes())
        file.unlink();file.symlink_to(target)
        with self.assertRaises(RuntimeError):
            self.compare()


if __name__ == '__main__':
    unittest.main()
