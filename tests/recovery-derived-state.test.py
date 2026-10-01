"""Synthetic derivation and allocation checks. No host/workspace access."""
import contextlib
import copy
import json
import os
import pathlib
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'deploy/update-runner'))
import recovery


class DerivedStateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nova-derived-recovery-test-')
        self.root = pathlib.Path(self.temporary.name).resolve()
        self.scratch = self.root / 'scratch'
        self.scratch.mkdir(mode=0o700)
        self.token = recovery._VERIFICATION_SCRATCH.set(self.scratch)

    def tearDown(self):
        recovery._VERIFICATION_SCRATCH.reset(self.token)
        self.temporary.cleanup()

    def compare_index(self, mutation=None, extra=None):
        old = {'revision': 100, 'index': {'version': 1, 'warning': 'Generated catalog',
            'hostContractVersion': '2026.9.6', 'compatRegistryVersion': 'a' * 64,
            'migrationVersion': 1, 'policyHash': 'b' * 64, 'generatedAtMs': 99,
            'workspaceDir': '/retained/workspace', 'refreshReason': 'source-changed',
            'installRecords': {'codex': {'version': '2026.9.6', 'installPath': '/retained/codex',
                                       'acceptedSurface': {'tools': ['retained-tool']}}},
            'plugins': [{'pluginId': 'codex', 'enabled': True}], 'diagnostics': []}}
        new = copy.deepcopy(old)
        new['revision'] = 200
        new['index'].update(generatedAtMs=199, refreshReason='startup')
        if mutation:
            mutation(new)
        with contextlib.closing(sqlite3.connect(':memory:')) as before, contextlib.closing(sqlite3.connect(':memory:')) as after:
            for connection, value, stamp, ms in ((before, old, '2026-09-25T00:00:00.000Z', 1790294400000),
                                                  (after, new, '2026-09-25T00:00:01.000Z', 1790294401000)):
                connection.execute('create table config_machine_state(state_key text primary key,value_json text,updated_at_ms integer)')
                connection.execute('insert into config_machine_state values(?,?,?)', ('plugins.installedIndex', json.dumps(value), value['revision']))
                connection.execute('insert into config_machine_state values(?,?,?)', ('config.lastTouchedAt', json.dumps(stamp), ms))
                connection.execute("insert into config_machine_state values('saved-policy','{\"allow\":false}',7)")
            if extra:
                extra(after)
            recovery.retained_plugin_index(before, after, None, self.root / 'unused', '2026.9.6', '2026.9.6')

    def test_same_engine_generated_catalog_and_audit_times_preserve_effective_content(self):
        self.compare_index()

    def test_same_engine_policy_capability_install_and_unknown_changes_are_rejected(self):
        mutations = [
            lambda v: v['index'].update(policyHash='c' * 64),
            lambda v: v['index'].update(compatRegistryVersion='c' * 64),
            lambda v: v['index'].update(workspaceDir='/other'),
            lambda v: v['index']['plugins'][0].update(enabled=False),
            lambda v: v['index']['installRecords']['codex'].update(installPath='/other'),
            lambda v: v['index']['installRecords']['codex']['acceptedSurface']['tools'].append('unreviewed'),
            lambda v: v['index']['diagnostics'].append({'code': 'new'}),
            lambda v: v['index'].update(unknown=True),
            lambda v: v['index'].update(hostContractVersion='2026.9.7'),
            lambda v: v['index'].update(generatedAtMs=98),
            lambda v: v.update(revision=99),
            lambda v: v.update(revision=True),
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutations.index(mutation)), self.assertRaises(RuntimeError):
                self.compare_index(mutation)

    def test_other_machine_rows_and_invalid_audit_timestamps_remain_strict(self):
        mutations = [
            lambda db: db.execute("update config_machine_state set updated_at_ms=8 where state_key='saved-policy'"),
            lambda db: db.execute("delete from config_machine_state where state_key='saved-policy'"),
            lambda db: db.execute("insert into config_machine_state values('new','{}',1)"),
            lambda db: db.execute("update config_machine_state set value_json='\"invalid\"' where state_key='config.lastTouchedAt'"),
            lambda db: db.execute("update config_machine_state set updated_at_ms=1 where state_key='config.lastTouchedAt'"),
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutations.index(mutation)), self.assertRaises((RuntimeError, ValueError)):
                self.compare_index(extra=mutation)

    def allocation(self, old, new, size=1024**2):
        recovery.retained_sparse_allocation({'file': {'size': size}},
            {'file': {'allocated': old, 'sparse': old < size}}, {'file': {'allocated': new, 'sparse': new < size}})

    def test_small_sparse_rounding_is_accepted_on_both_sides_of_binary_boundary(self):
        self.allocation(1024**2 - 4096, 1024**2)
        self.allocation(4239360, 4243456, size=4239512)
        self.allocation(4096, 8192, size=4 * 1024**2)

    def test_material_allocation_growth_is_rejected_even_if_copy_remains_sparse(self):
        for old, new in ((4096, 1024**2), (4096, 12288), (1024**2-8192, 1024**2)):
            with self.subTest(old=old, new=new), self.assertRaises(RuntimeError):
                self.allocation(old, new)

    def test_aggregate_sparse_rounding_is_bounded(self):
        count = recovery.ALLOWANCE // 4096 + 1
        entries = {str(i): {'size': 1024**2} for i in range(count)}
        source = {name: {'allocated': 4096, 'sparse': True} for name in entries}
        copied = {name: {'allocated': 8192, 'sparse': True} for name in entries}
        with self.assertRaises(RuntimeError):
            recovery.retained_sparse_allocation(entries, source, copied)

    def test_capacity_still_rejects_live_hardlinks_and_insufficient_independent_restore(self):
        entries = {'file': {'kind': 'file', 'size': 4096}}
        source = {'file': {'allocated': 4096, 'device': 1, 'inode': 1}}
        with self.assertRaises(RuntimeError):
            recovery.capacity(entries, source, entries, source, 100 * 1024**3)
        with self.assertRaises(recovery.InsufficientStorage):
            recovery.capacity(entries, source, {}, {}, recovery.RESERVE + 2 * recovery.ALLOWANCE + 4096)

    def binding_fixture(self):
        node = os.environ.get('NODE_BINARY') or shutil.which('node')
        if not node:
            self.skipTest('Node required for real encrypted-store derivation')
        before, after = self.root / 'before', self.root / 'after'
        selected = pathlib.Path('recovered-workspaces/11111111-1111-4111-8111-111111111111')
        key = bytes(range(32))
        script = r'''
import {DatabaseSync} from 'node:sqlite';
import {createCipheriv} from 'node:crypto';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const {before,after,selected,key:hex}=JSON.parse(readFileSync(0,'utf8')),key=Buffer.from(hex,'hex');
function seal(aad,value){const iv=Buffer.alloc(12,3),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(aad));const bytes=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return Buffer.concat([iv,c.getAuthTag(),bytes]);}
for(const root of [before,after]) {
 const selectedDir=join(root,selected);mkdirSync(join(selectedDir,'openclaw-runtime'),{recursive:true});
 writeFileSync(join(root,'workspace-selection.json'),JSON.stringify({format:1,recoveryId:'11111111-1111-4111-8111-111111111111'}));
 writeFileSync(join(selectedDir,'recovery-complete.json'),JSON.stringify({jobId:'11111111-1111-4111-8111-111111111111',sourceHash:'a'.repeat(64)}));
 writeFileSync(join(selectedDir,'edition3.identity'),'private.novadream.edition3.preview\n');
 const db=new DatabaseSync(join(selectedDir,'workspace.sqlite'));
 db.exec('pragma user_version=55;CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE service_records(id TEXT PRIMARY KEY,revision INTEGER,payload BLOB)');
 db.prepare('INSERT INTO meta VALUES(?,?)').run('epoch','22222222-2222-4222-8222-222222222222');
 db.prepare('INSERT INTO meta VALUES(?,?)').run('key-check',seal('key-check','edition3').toString('base64'));
 db.prepare('INSERT INTO service_records VALUES(?,?,?)').run('assistant:conversation:saved',1,seal('service:assistant:conversation:saved',{nativeKey:'retained',nativeId:'33333333-3333-4333-8333-333333333333'}));db.close();
 const bindings=root===before?[]:[{nativeKey:'retained',nativeId:'33333333-3333-4333-8333-333333333333'}];
 writeFileSync(join(selectedDir,'openclaw-runtime/openclaw.json'),JSON.stringify({plugins:{entries:{'edition3-workspace':{config:{sessionBindings:bindings,permission:'read-only'}}}},tools:{search:false}}));
 // An unused outer store must never satisfy a selected-workspace proof.
 const outer=new DatabaseSync(join(root,'workspace.sqlite'));outer.exec('CREATE TABLE unused(id TEXT)');outer.close();
}
'''
        subprocess.run([node, '--input-type=module', '-e', script], input=json.dumps({'before': str(before), 'after': str(after),
                       'selected': str(selected), 'key': key.hex()}).encode(), check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return before, after, selected, key, node

    def test_real_verifier_accepts_regeneration_from_selected_closed_store_without_mutation(self):
        before, after, selected, key, node = self.binding_fixture()
        identities = {str(p): recovery.digest(p) for root in (before, after) for p in root.rglob('*') if p.is_file()}
        recovery.native_runtime_configuration(before, after, selected, '2026.9.6', '2026.9.6',
                                             session_binding_key=key, session_binding_node=node)
        self.assertEqual(identities, {str(p): recovery.digest(p) for root in (before, after) for p in root.rglob('*') if p.is_file()})
        self.assertEqual(list(self.scratch.iterdir()), [])
        with self.assertRaises(RuntimeError):
            recovery.native_runtime_configuration(before, after, selected, '2026.9.6', '2026.9.6')

    def test_binding_integration_rejects_wrong_key_removed_binding_and_unrelated_config(self):
        before, after, selected, key, node = self.binding_fixture()
        arguments = (before, after, selected, '2026.9.6', '2026.9.6')
        with self.assertRaisesRegex(RuntimeError, 'derivation verification'):
            recovery.native_runtime_configuration(*arguments, session_binding_key=b'x'*32, session_binding_node=node)
        path = after / selected / 'openclaw-runtime/openclaw.json'
        original = json.loads(path.read_bytes())
        mutations = [lambda v: v['plugins']['entries']['edition3-workspace']['config'].update(sessionBindings=[]),
                     lambda v: v['plugins']['entries']['edition3-workspace']['config'].update(permission='write'),
                     lambda v: v['tools'].update(search=True)]
        for mutate in mutations:
            value = copy.deepcopy(original); mutate(value); path.write_text(json.dumps(value))
            with self.subTest(mutation=mutations.index(mutate)), self.assertRaises(RuntimeError):
                recovery.native_runtime_configuration(*arguments, session_binding_key=key, session_binding_node=node)

    def test_binding_integration_rejects_wrong_selection_and_unpinned_helper(self):
        before, after, selected, key, node = self.binding_fixture()
        configuration = after / selected / 'openclaw-runtime/openclaw.json'
        with self.assertRaisesRegex(RuntimeError, 'wrong workspace'):
            recovery.verified_session_bindings(before, pathlib.Path('.'), configuration, node, key)
        with patch.object(recovery, 'SESSION_BINDINGS_VERIFIER_SHA256', '0'*64), self.assertRaisesRegex(RuntimeError, 'reviewed implementation'):
            recovery.verified_session_bindings(before, selected, configuration, node, key)


if __name__ == '__main__':
    unittest.main()
