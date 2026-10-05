"""Offline, synthetic saved-content qualification for the exact 9.6→9.8 pair."""
import contextlib
from collections import Counter
import hashlib
import json
import os
import pathlib
import shutil
import sqlite3
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'deploy/update-runner'))
import recovery

NODE = pathlib.Path(shutil.which('node')).resolve() if shutil.which('node') else None
AGENT = pathlib.Path('openclaw-agent.sqlite')
SHARED = pathlib.Path('openclaw.sqlite')


@contextlib.contextmanager
def pair(sql):
    with contextlib.closing(sqlite3.connect(':memory:')) as before, contextlib.closing(sqlite3.connect(':memory:')) as after:
        for db in (before, after):
            db.executescript(sql)
        yield before, after


def tables(db):
    return {name for (name,) in db.execute("select name from sqlite_schema where type='table' and name not like 'sqlite_%'")}


SESSION_SQL = '''CREATE TABLE session_nodes (
 session_key TEXT NOT NULL PRIMARY KEY, current_session_id TEXT NOT NULL,
 entry_json TEXT NOT NULL, entry_valid INTEGER NOT NULL DEFAULT 0,
 updated_at INTEGER NOT NULL, unknown_retained TEXT) STRICT;'''


def snapshot_migrate(after, inputs):
    after.execute('ALTER TABLE session_nodes ADD COLUMN snapshot_revision INTEGER NOT NULL DEFAULT 0')
    after.executescript(recovery.SESSION_SNAPSHOTS_98_SQL)
    for key, value in inputs.items():
        # Test oracle deliberately chooses the fixture values, not the verifier's projector.
        hot, snapshots = value
        if snapshots:
            for field, encoded in snapshots:
                after.execute('insert into session_entry_snapshots values(?,?,?)', (key, field, encoded))
            after.execute('update session_nodes set entry_json=?,entry_valid=1 where session_key=?', (hot, key))


class Native98Tests(unittest.TestCase):
    @unittest.skipUnless(NODE, 'Node is required for official JS serialization semantics.')
    def test_split_keeps_nested_unknown_content_nulls_and_js_number_format(self):
        with pair(SESSION_SQL) as (before, after):
            encoded = '{"sessionId":"id","updatedAt":7,"custom":{"x":[true,null,"é"]},"skillsSnapshot":null,"sessionDiffBaseline":{"large":1e+30,"small":1e-7},"systemPromptReport":["saved"]}'
            row = ('key', 'id', encoded, 0, 7, 'unknown column stays')
            for db in (before, after): db.execute('insert into session_nodes values(?,?,?,?,?,?)', row)
            snapshot_migrate(after, {'key': ('{"sessionId":"id","updatedAt":7,"custom":{"x":[true,null,"é"]}}', [
                ('sessionDiffBaseline', '{"large":1e+30,"small":1e-7}'), ('skillsSnapshot', 'null'), ('systemPromptReport', '["saved"]')])})
            recovery.native98_schema_change(before, after, tables(before), tables(after), True)
            recovery.migrated_session_snapshots(before, after, NODE)
            original = after.execute('select * from session_nodes').fetchone()
            for field, value in [('unknown_retained', 'changed'), ('snapshot_revision', 2), ('entry_valid', 0), ('updated_at', 8)]:
                with self.subTest(field=field):
                    after.execute('update session_nodes set '+field+'=?', (value,))
                    with self.assertRaises(RuntimeError): recovery.migrated_session_snapshots(before, after, NODE)
                    after.execute('delete from session_nodes')
                    after.execute('insert into session_nodes values(?,?,?,?,?,?,?)', original)

    @unittest.skipUnless(NODE, 'Node required.')
    def test_invalid_identity_and_no_snapshot_json_keep_exact_original_bytes(self):
        inputs = ['broken {', '{"sessionId":"other","updatedAt":1,"skillsSnapshot":{}}',
                  '{ "sessionId" : "id", "updatedAt":1, "saved": [1,2] }', 'null',
                  '{"sessionId":"id","updatedAt":true,"skillsSnapshot":{}}']
        with pair(SESSION_SQL) as (before, after):
            for index, encoded in enumerate(inputs):
                for db in (before, after): db.execute('insert into session_nodes values(?,?,?,?,?,?)', (str(index), 'id', encoded, -1, 1, 'kept'))
            snapshot_migrate(after, {})
            recovery.migrated_session_snapshots(before, after, NODE)
            after.execute('update session_nodes set entry_valid=1 where session_key="0"')
            with self.assertRaises(RuntimeError): recovery.migrated_session_snapshots(before, after, NODE)

    @unittest.skipUnless(NODE, 'Node required.')
    def test_pending_validity_is_settled_without_changing_saved_json(self):
        with pair(SESSION_SQL) as (before, after):
            for db in (before, after):
                db.execute('insert into session_nodes values(?,?,?,?,?,?)', ('valid', 'id', '{ "sessionId":"id", "updatedAt":1, "saved":[1,2] }', 0, 1, 'kept'))
                db.execute('insert into session_nodes values(?,?,?,?,?,?)', ('invalid', 'id', 'broken {', 0, 1, 'kept'))
            snapshot_migrate(after, {})
            after.execute("update session_nodes set entry_valid=1 where session_key='valid'")
            after.execute("update session_nodes set entry_valid=-1 where session_key='invalid'")
            recovery.migrated_session_snapshots(before, after, NODE)
            after.execute("update session_nodes set entry_valid=1 where session_key='invalid'")
            with self.assertRaises(RuntimeError): recovery.migrated_session_snapshots(before, after, NODE)

    @unittest.skipUnless(NODE, 'Node required.')
    def test_removed_fabricated_or_mutated_snapshots_are_rejected(self):
        for mode in ('removed', 'fabricated', 'changed'):
            with self.subTest(mode=mode), pair(SESSION_SQL) as (before, after):
                for db in (before, after): db.execute('insert into session_nodes values(?,?,?,?,?,?)', ('key', 'id', '{"sessionId":"id","updatedAt":1,"skillsSnapshot":{"secret":"kept"}}', 0, 1, 'kept'))
                snapshot_migrate(after, {'key': ('{"sessionId":"id","updatedAt":1}', [('skillsSnapshot', '{"secret":"kept"}')])})
                if mode == 'removed': after.execute('delete from session_entry_snapshots')
                elif mode == 'fabricated': after.execute('insert into session_entry_snapshots values(?,?,?)', ('fake', 'skillsSnapshot', '{}'))
                else: after.execute('update session_entry_snapshots set value_json=?', ('{"secret":"changed"}',))
                after.execute('update session_nodes set snapshot_revision=1')
                with self.assertRaises(RuntimeError): recovery.migrated_session_snapshots(before, after, NODE)

    def test_unknown_schema_and_weakened_snapshot_trigger_are_rejected(self):
        with pair(SESSION_SQL) as (before, after):
            snapshot_migrate(after, {})
            after.execute('drop trigger session_entry_snapshots_after_delete')
            with self.assertRaisesRegex(RuntimeError, 'schema definitions'): recovery.native98_schema_change(before, after, tables(before), tables(after), True)
        with pair(SESSION_SQL) as (before, after):
            snapshot_migrate(after, {})
            after.execute('create table fabricated(x text)')
            with self.assertRaisesRegex(RuntimeError, 'table set'): recovery.native98_schema_change(before, after, tables(before), tables(after), True)

    def test_nullable_legacy_auth_and_gc_do_not_create_authority(self):
        sql = '''CREATE TABLE user_profile_identities (provider TEXT NOT NULL,subject TEXT NOT NULL,
 profile_id TEXT NOT NULL,canonical_login TEXT,created_at INTEGER NOT NULL,PRIMARY KEY(provider,subject)) STRICT;
CREATE INDEX idx_user_profile_identities_profile_id ON user_profile_identities(profile_id);
CREATE TABLE worktrees(id TEXT PRIMARY KEY,run_end_cleanup_json TEXT) STRICT;'''
        with pair(sql) as (before, after):
            for db in (before, after):
                db.execute("insert into user_profile_identities values('provider','subject','saved-profile','saved-login',7)")
                db.execute("insert into worktrees values('saved-tree','saved cleanup')")
            after.executescript('''ALTER TABLE user_profile_identities ADD COLUMN authorization_id TEXT;
ALTER TABLE user_profile_identities ADD COLUMN authorization_basis_json TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_profile_identities_authorization ON user_profile_identities(authorization_id);
ALTER TABLE worktrees ADD COLUMN gc_protection_json TEXT;''')
            recovery.migrated_native98_rows(before, after, tables(before), tables(after), SHARED, SHARED, None, {})
            for column in ('authorization_id', 'authorization_basis_json'):
                after.execute('update user_profile_identities set '+column+'=?', ('invented',))
                with self.assertRaisesRegex(RuntimeError, 'fabricated authorization'): recovery.migrated_native98_rows(before, after, tables(before), tables(after), SHARED, SHARED, None, {})
                after.execute('update user_profile_identities set '+column+'=NULL')
            after.execute("update user_profile_identities set profile_id='different'")
            with self.assertRaisesRegex(RuntimeError, 'retained work'): recovery.migrated_native98_rows(before, after, tables(before), tables(after), SHARED, SHARED, None, {})

    def test_native_version_markers_remain_exact(self):
        with contextlib.closing(sqlite3.connect(':memory:')) as db:
            db.execute('pragma user_version=18')
            with self.assertRaises(RuntimeError): recovery.native_schema(db, SHARED, '2026.9.8')
            db.execute('pragma user_version=19')
            self.assertEqual(recovery.native_schema(db, SHARED, '2026.9.8'), set())
            with self.assertRaises(RuntimeError): recovery.native_schema(db, SHARED, '2026.9.9')
            db.execute('pragma user_version=24')
            with self.assertRaisesRegex(RuntimeError, 'canonical session snapshots'):
                recovery.native_schema(db, AGENT, '2026.9.8')

    def test_previously_absent_lazy_profile_table_is_exact_and_empty(self):
        with pair('CREATE TABLE worktrees(id TEXT PRIMARY KEY,run_end_cleanup_json TEXT) STRICT;') as (before, after):
            after.execute('alter table worktrees add column gc_protection_json TEXT')
            recovery.migrated_native98_rows(before, after, tables(before), tables(after), SHARED, SHARED, None, {})
            self.assertNotIn('user_profile_identities', tables(after))
        with pair('CREATE TABLE worktrees(id TEXT PRIMARY KEY,run_end_cleanup_json TEXT) STRICT;') as (before, after):
            after.executescript(recovery.PROFILE_IDENTITIES_98_SQL)
            with self.assertRaisesRegex(RuntimeError, 'required additive column'):
                recovery.migrated_native98_rows(before, after, tables(before), tables(after), SHARED, SHARED, None, {})
            after.execute('alter table worktrees add column gc_protection_json TEXT')
            recovery.migrated_native98_rows(before, after, tables(before), tables(after), SHARED, SHARED, None, {})
            after.execute("insert into user_profile_identities values('provider','subject','invented',null,1,null,null)")
            with self.assertRaisesRegex(RuntimeError, 'fabricated profile authority'):
                recovery.migrated_native98_rows(before, after, tables(before), tables(after), SHARED, SHARED, None, {})

    @unittest.skipUnless(NODE, 'Node required.')
    def test_same98_settles_only_pending_validity_and_preserves_all_content(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory).resolve()
            snapshot = base / 'snapshot'; snapshot.mkdir()
            (snapshot / 'edition3.identity').write_bytes(b'private.novadream.edition3.preview\n')
            with contextlib.closing(sqlite3.connect(snapshot / 'workspace.sqlite')) as db:
                db.executescript("pragma user_version=55;create table meta(key text,value text);insert into meta values('epoch','11111111-1111-4111-8111-111111111111');")
            native = snapshot / 'openclaw-runtime'; native.mkdir()
            (native / 'edition3-runtime.identity').write_bytes(b'edition3-owned-gateway\n')
            relative = pathlib.Path('openclaw-runtime/state/agents/main/agent/openclaw-agent.sqlite')
            (snapshot / relative).parent.mkdir(parents=True)
            with contextlib.closing(sqlite3.connect(snapshot / relative)) as db:
                db.executescript('pragma user_version=24;' + SESSION_SQL)
                db.execute('ALTER TABLE session_nodes ADD COLUMN snapshot_revision INTEGER NOT NULL DEFAULT 0')
                db.executescript(recovery.SESSION_SNAPSHOTS_98_SQL)
                db.execute('insert into session_nodes values(?,?,?,?,?,?,?)', ('valid','id','{ "sessionId":"id", "updatedAt":1, "saved":[1,2] }',0,1,'all saved',0))
                db.execute('insert into session_nodes values(?,?,?,?,?,?,?)', ('invalid','id','bad JSON',0,1,'all saved',0))
                db.commit()
            live = base / 'live'; shutil.copytree(snapshot, live)
            def update(sql):
                with contextlib.closing(sqlite3.connect(live / relative)) as db:
                    db.executescript(sql); db.commit()
            # The same verifier checks independent copies before first startup.
            recovery.native_saved_state(snapshot, live, from_version='2026.9.8', node=NODE)
            update("update session_nodes set entry_valid=case session_key when 'valid' then 1 else -1 end")
            recovery.native_saved_state(snapshot, live, from_version='2026.9.8', node=NODE)
            update("update session_nodes set entry_valid=1 where session_key='invalid'")
            with self.assertRaisesRegex(RuntimeError, 'pending validity'):
                recovery.native_saved_state(snapshot, live, from_version='2026.9.8', node=NODE)
            update("update session_nodes set entry_valid=-1 where session_key='invalid';update session_nodes set unknown_retained='mutated' where session_key='valid'")
            with self.assertRaisesRegex(RuntimeError, 'pending validity'):
                recovery.native_saved_state(snapshot, live, from_version='2026.9.8', node=NODE)

    @unittest.skipUnless(NODE, 'Node required.')
    def test_selected_saved_state_upgrade_same_engine_and_paired_old_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory).resolve()
            snapshot = base / 'snapshot'; snapshot.mkdir()
            (snapshot / 'edition3.identity').write_bytes(b'private.novadream.edition3.preview\n')
            with contextlib.closing(sqlite3.connect(snapshot / 'workspace.sqlite')) as db:
                db.executescript("pragma user_version=55;create table meta(key text,value text);insert into meta values('epoch','11111111-1111-4111-8111-111111111111');")
                db.commit()
            native = snapshot / 'openclaw-runtime'; native.mkdir()
            (native / 'edition3-runtime.identity').write_bytes(b'edition3-owned-gateway\n')
            relative = pathlib.Path('openclaw-runtime/state/agents/main/agent/openclaw-agent.sqlite')
            (snapshot / relative).parent.mkdir(parents=True)
            with contextlib.closing(sqlite3.connect(snapshot / relative)) as db:
                db.executescript('pragma user_version=23;' + SESSION_SQL)
                db.execute('insert into session_nodes values(?,?,?,?,?,?)', ('key','id','{"sessionId":"id","updatedAt":1,"skillsSnapshot":{"saved":true}}',0,1,'unknown'))
                db.commit()
            original_hash = recovery.digest(snapshot / relative)
            live = base / 'live'; shutil.copytree(snapshot, live)
            with contextlib.closing(sqlite3.connect(live / relative)) as db:
                snapshot_migrate(db, {'key': ('{"sessionId":"id","updatedAt":1}', [('skillsSnapshot','{"saved":true}')])})
                db.execute('pragma user_version=24'); db.commit()
            recovery.native_saved_state(snapshot, live, from_version='2026.9.6', to_version='2026.9.8', node=NODE)
            self.assertEqual(recovery.digest(snapshot / relative), original_hash)
            same = base / 'same'; shutil.copytree(live, same)
            recovery.native_saved_state(live, same, from_version='2026.9.8', node=NODE)
            with self.assertRaisesRegex(RuntimeError, 'reviewed pair'):
                recovery.native_saved_state(live, snapshot, from_version='2026.9.8', to_version='2026.9.6', node=NODE)
            with contextlib.closing(sqlite3.connect(same / relative)) as db:
                db.execute("insert into session_entry_snapshots values('fake','skillsSnapshot','{}')"); db.commit()
            with self.assertRaisesRegex(RuntimeError, 'Retained native'):
                recovery.native_saved_state(live, same, from_version='2026.9.8', node=NODE)


def embedded_fixture(name):
    db = sqlite3.connect(':memory:')
    for table, columns in recovery.EMBEDDED_DATABASES_96[name][1].items():
        definitions = []
        for column in columns.split():
            kind = 'BLOB' if column == 'checksum' else 'INTEGER' if column in {'version', 'success', 'execution_time'} else 'TEXT'
            definitions.append('"'+column+'" '+kind)
        db.execute('CREATE TABLE "'+table+'" ('+','.join(definitions)+')')
    db.execute('insert into _sqlx_migrations values(55,?,?,1,?,0)', ('previous official', '2026-01-01', b'previous receipt'))
    return db


def apply_embedded(after, name):
    for version, description, checksum, sql in recovery.CODEX_SQL_MIGRATIONS_98[name]:
        after.executescript(sql)
        after.execute('insert into _sqlx_migrations values(?,?,?,1,?,0)', (version, description, '2026-10-01', bytes.fromhex(checksum)))


class Codex158Tests(unittest.TestCase):
    def test_guardian_projection_preserves_explicit_title_and_all_ordinary_content(self):
        with contextlib.closing(embedded_fixture('state_5.sqlite')) as before, contextlib.closing(embedded_fixture('state_5.sqlite')) as after:
            records = [('guardian-auto','{"subagent":{"other":"guardian"}}','Synthetic context',None,'Synthetic context','old preview'),
                       ('guardian-named','{"subagent":{"other":"guardian"}}','My name',None,'Synthetic context','old preview'),
                       ('ordinary','user','Saved title','Saved name','Actual first message','Saved preview')]
            for db in (before, after):
                db.executemany('insert into threads(id,source,title,name,first_user_message,preview) values(?,?,?,?,?,?)', records)
            apply_embedded(after, 'state_5.sqlite')
            recovery.embedded_schema(after, 'state_5.sqlite', '2026.9.8')
            recovery.migrated_embedded98_database(before, after, 'state_5.sqlite')
            self.assertEqual(after.execute("select title,name,preview,first_user_message from threads where id='guardian-named'").fetchone(), ('My name','My name','Approval review',''))
            for field, value in [('title','lost title'),('first_user_message','lost message'),('creator_user_id','new authority')]:
                with self.subTest(field=field):
                    old = after.execute('select '+field+" from threads where id='ordinary'").fetchone()[0]
                    after.execute('update threads set '+field+"=? where id='ordinary'", (value,))
                    with self.assertRaises(RuntimeError): recovery.migrated_embedded98_database(before, after, 'state_5.sqlite')
                    after.execute('update threads set '+field+"=? where id='ordinary'", (old,))

    def test_history_timestamps_default_null_and_complete_payload_stays(self):
        with contextlib.closing(embedded_fixture('thread_history_1.sqlite')) as before, contextlib.closing(embedded_fixture('thread_history_1.sqlite')) as after:
            for db in (before, after): db.execute("insert into thread_items(thread_id,item_id,item_json) values('thread','item','{\"unknown\":\"saved\"}')")
            apply_embedded(after, 'thread_history_1.sqlite')
            recovery.migrated_embedded98_database(before, after, 'thread_history_1.sqlite')
            after.execute('update thread_items set started_at_ms=1')
            with self.assertRaises(RuntimeError): recovery.migrated_embedded98_database(before, after, 'thread_history_1.sqlite')

    def test_migration_checksum_fabrication_is_refused(self):
        with contextlib.closing(embedded_fixture('state_5.sqlite')) as before, contextlib.closing(embedded_fixture('state_5.sqlite')) as after:
            apply_embedded(after, 'state_5.sqlite')
            after.execute('update _sqlx_migrations set checksum=? where version=57', (b'x'*48,))
            with self.assertRaisesRegex(RuntimeError, 'unreviewed SQL'): recovery.migrated_embedded98_database(before, after, 'state_5.sqlite')

    def test_partial_or_unknown_embedded_columns_are_refused(self):
        with contextlib.closing(embedded_fixture('state_5.sqlite')) as db:
            recovery.embedded_schema(db, 'state_5.sqlite', '2026.9.8')
            db.execute('alter table threads add column creator_user_id TEXT')
            with self.assertRaises(RuntimeError): recovery.embedded_schema(db, 'state_5.sqlite', '2026.9.8')


class ProcessLeaseTests(unittest.TestCase):
    # Qualified official empty retirement token; no private workspace/owner data.
    TOKEN_HEADER = bytes.fromhex('53514c69746520666f726d61742033001000010100402020000000010000000100000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001002e95cc')
    TOKEN = TOKEN_HEADER + bytes.fromhex('0d00000000100000') + bytes(3988)
    SELECTED = pathlib.Path('selected-workspace')
    LEASE = SELECTED / 'openclaw-runtime/state/tmp/plugin-captures/11111111-1111-4111-8111-111111111111/owner.sqlite'

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nova-process-lease-test-')
        self.root = pathlib.Path(self.temporary.name).resolve()
        self.scratch = self.root / 'scratch'; self.scratch.mkdir(mode=0o700)
        self.token = recovery._VERIFICATION_SCRATCH.set(self.scratch)
        self.counter = 0

    def tearDown(self):
        recovery._VERIFICATION_SCRATCH.reset(self.token)
        self.temporary.cleanup()

    def fixture(self, data=None):
        self.counter += 1
        root = self.root / str(self.counter)
        native = root / self.SELECTED / 'openclaw-runtime'; native.mkdir(parents=True, mode=0o700)
        capture = native / 'state/tmp/plugin-captures'; capture.mkdir(parents=True, mode=0o700)
        directory = root / self.LEASE.parent; directory.mkdir(mode=0o700)
        path = root / self.LEASE; path.write_bytes(self.TOKEN if data is None else data); path.chmod(0o600)
        return root, path

    def static(self, root, version):
        owners = recovery.native_capture_owner_paths(root, self.SELECTED, version)
        return recovery.static_sqlite_files(root, self.SELECTED, owners)

    def test_qualified_retirement_token_is_read_through_a_copy_without_mutation(self):
        root, path = self.fixture()
        self.assertEqual(hashlib.sha256(self.TOKEN).hexdigest(), recovery.CAPTURE_OWNER_RETIRED_SHA256)
        before = recovery.sqlite_source_identity(path)
        recovery.capture_owner_format(path, '2026.9.8')
        self.assertEqual(recovery.sqlite_source_identity(path), before)
        self.assertEqual(list(self.scratch.iterdir()), [])

    def test_legacy_empty_marker_is_distinct_from_unqualified_database_formats(self):
        root, marker = self.fixture(b'')
        for version in ('2026.9.6', '2026.9.8'):
            recovery.capture_owner_format(marker, version)
        with self.assertRaises(RuntimeError): recovery.capture_owner_format(marker, '2026.9.2')
        root, retired = self.fixture()
        with self.assertRaises(RuntimeError): recovery.capture_owner_format(retired, '2026.9.6')
        active = bytearray(self.TOKEN); active[60:64] = bytes(4)
        retired.write_bytes(active)
        with self.assertRaises(RuntimeError): recovery.capture_owner_format(retired, '2026.9.8')

    def test_nonempty_schema_user_rows_and_altered_empty_bytes_are_rejected(self):
        for sql in ('create table saved(value text)', "create table saved(value text); insert into saved values('retained')"):
            root, path = self.fixture(b'')
            with contextlib.closing(sqlite3.connect(path)) as connection: connection.executescript(sql)
            with self.subTest(sql=sql), self.assertRaises(RuntimeError): recovery.capture_owner_format(path, '2026.9.8')
        root, path = self.fixture()
        altered = bytearray(self.TOKEN); altered[-1] = 1; path.write_bytes(altered)
        with self.assertRaises(RuntimeError): recovery.capture_owner_format(path, '2026.9.8')

    @unittest.skipUnless(os.name == 'posix', 'Native host classification requires POSIX ownership/modes')
    def test_added_retirement_and_removed_legacy_leases_leave_all_other_stores_strict(self):
        before, old = self.fixture(b''); after, new = self.fixture()
        self.assertEqual(self.static(before, '2026.9.6'), self.static(after, '2026.9.8'))
        new.unlink()
        self.assertEqual(self.static(before, '2026.9.6'), self.static(after, '2026.9.8'))
        old.unlink(); new.write_bytes(self.TOKEN); new.chmod(0o600)
        self.assertEqual(self.static(before, '2026.9.6'), self.static(after, '2026.9.8'))
        for root in (before, after): (root / self.LEASE.parent / 'retained.sqlite').write_bytes(b'saved')
        self.assertEqual(self.static(before, '2026.9.6'), self.static(after, '2026.9.8'))
        (after / self.LEASE.parent / 'retained.sqlite').write_bytes(b'changed')
        self.assertNotEqual(self.static(before, '2026.9.6'), self.static(after, '2026.9.8'))

    @unittest.skipUnless(os.name == 'posix', 'Native host classification requires POSIX ownership/modes')
    def test_nested_malformed_nonselected_and_unsupported_namespaces_remain_static(self):
        for relative in (self.LEASE.parent / 'captures/fixture/owner.sqlite',
                         self.LEASE.parent.parent / 'not-a-uuid/owner.sqlite',
                         pathlib.Path('archived-workspace') / self.LEASE.relative_to(self.SELECTED)):
            before, old = self.fixture(); after, new = self.fixture()
            path = after / relative; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(self.TOKEN)
            with self.subTest(path=relative):
                self.assertNotEqual(self.static(before, '2026.9.8'), self.static(after, '2026.9.8'))
                self.assertIn(relative, self.static(after, '2026.9.8'))
        before, old = self.fixture(); after, new = self.fixture(); old.unlink()
        self.assertNotEqual(self.static(before, '2026.9.2'), self.static(after, '2026.9.2'))

    @unittest.skipUnless(os.name == 'posix', 'Native host classification requires POSIX ownership/modes')
    def test_links_permissions_owners_and_sidecars_are_rejected(self):
        for kind in ('symlink', 'hardlink', 'file-mode', 'directory-mode', 'root-mode', 'sidecar', 'owner'):
            root, path = self.fixture()
            if kind == 'symlink':
                outside = root / 'outside'; outside.write_bytes(self.TOKEN); path.unlink(); path.symlink_to(outside)
            elif kind == 'hardlink': os.link(path, root / 'alias')
            elif kind == 'file-mode': path.chmod(0o644)
            elif kind == 'directory-mode': path.parent.chmod(0o755)
            elif kind == 'root-mode': path.parent.parent.chmod(0o755)
            elif kind == 'sidecar': pathlib.Path(str(path) + '-journal').write_bytes(b'')
            if kind == 'owner':
                original = pathlib.Path.lstat
                fields = ('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns')
                def changed_owner(candidate, *args, **kwargs):
                    info = original(candidate, *args, **kwargs)
                    if candidate == path:
                        value = {name: getattr(info, name) for name in fields}; value['st_uid'] += 1
                        return SimpleNamespace(**value)
                    return info
                with patch.object(pathlib.Path, 'lstat', changed_owner), self.assertRaises(RuntimeError):
                    recovery.native_capture_owner_paths(root, self.SELECTED, '2026.9.8')
            else:
                with self.subTest(kind=kind), self.assertRaises(RuntimeError):
                    recovery.native_capture_owner_paths(root, self.SELECTED, '2026.9.8')

    @unittest.skipUnless(os.name == 'posix', 'Native host classification requires POSIX ownership/modes')
    def test_redirected_ancestry_is_rejected_and_full_inventory_retains_capture_files(self):
        root, path = self.fixture()
        native = root / self.SELECTED / 'openclaw-runtime'
        contents = path.parent / 'captures/plugin/source.txt'; contents.parent.mkdir(parents=True); contents.write_bytes(b'captured')
        owners = recovery.native_capture_owner_paths(root, self.SELECTED, '2026.9.8')
        self.assertEqual(owners, {self.LEASE})
        inventory, _ = recovery.inventory(root)
        self.assertIn(self.LEASE.as_posix(), inventory)
        self.assertEqual(inventory[self.LEASE.as_posix()]['sha256'], recovery.CAPTURE_OWNER_RETIRED_SHA256)
        self.assertIn(contents.relative_to(root).as_posix(), inventory)
        moved = root / 'moved-state'; (native / 'state').rename(moved); (native / 'state').symlink_to(moved, target_is_directory=True)
        with self.assertRaises(RuntimeError): recovery.native_capture_owner_paths(root, self.SELECTED, '2026.9.8')


class NeutralChannelPolicyTests(unittest.TestCase):
    SQL = 'CREATE TABLE config_machine_state(state_key TEXT PRIMARY KEY,value_json TEXT NOT NULL,updated_at_ms INTEGER NOT NULL) STRICT;'
    NEUTRAL = '{"roles":null,"identityScopes":null}'

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        base = pathlib.Path(self.temporary.name).resolve()
        self.snapshot, self.live = base / 'snapshot', base / 'live'
        self.selected = pathlib.Path('selected')
        self.relative = self.selected / 'openclaw-runtime/openclaw.json'
        for root in (self.snapshot, self.live):
            path = root / self.relative
            path.parent.mkdir(parents=True)
            path.write_text('{"gateway":{"auth":{}},"commands":{"ownerAllowFrom":[]},"retained":"unchanged"}', encoding='utf-8')
        self.context = self.authority()

    def authority(self):
        return {'workspace_roots': (self.snapshot, self.live, self.live, self.selected),
                'configuration': {'path': str(self.live / self.relative),
                                  'hashes': [recovery.digest(root / self.relative) for root in (self.snapshot, self.live)]},
                'startup_window': (100, 110)}

    def verify(self, before, after, **options):
        context = self.context | options
        recovery.retained_plugin_index(before, after, None,
            self.live / self.selected / 'openclaw-runtime/state/state/openclaw.sqlite',
            '2026.9.6', '2026.9.8', **context)

    def insert(self, db, value=None, timestamp=105000):
        db.execute('insert into config_machine_state values(?,?,?)',
                   ('operator.channelPolicy', self.NEUTRAL if value is None else value, timestamp))

    def test_exact_default_is_qualified_without_changing_either_database_or_other_keys(self):
        with pair(self.SQL) as (before, after):
            for db in (before, after): db.execute("insert into config_machine_state values('retained','saved',7)")
            self.insert(after)
            original = list(after.execute('select * from config_machine_state'))
            self.verify(before, after)
            self.assertEqual(list(after.execute('select * from config_machine_state')), original)
            self.assertIsNone(before.execute("select 1 from config_machine_state where state_key='operator.channelPolicy'").fetchone())
            after.execute("update config_machine_state set value_json='changed' where state_key='retained'")
            with self.assertRaisesRegex(RuntimeError, 'machine configuration changed'): self.verify(before, after)

    def test_permission_owner_nested_unknown_and_noncanonical_policy_values_are_rejected(self):
        values = [
            '{"roles":{"admin":["owner"]},"identityScopes":null}',
            '{"roles":null,"identityScopes":["operator.admin"]}',
            '{"roles":null,"identityScopes":null,"configuredOwnerPolicy":{"id":"new-owner"}}',
            '{"roles":null,"identityScopes":null,"unknown":null}',
            '{"roles":null,"identityScopes":null,"nested":{"roles":null}}',
            '{ "roles":null,"identityScopes":null}',
            '{"roles":null,"identityScopes":null,"roles":null}',
        ]
        for value in values:
            with self.subTest(value=value), pair(self.SQL) as (before, after):
                self.insert(after, value)
                with self.assertRaises(RuntimeError): self.verify(before, after)

    def test_existing_policy_changes_and_removal_stay_exact(self):
        for value in (self.NEUTRAL, '{"roles":{"saved":"permission"},"identityScopes":null}'):
            with self.subTest(value=value), pair(self.SQL) as (before, after):
                for db in (before, after): self.insert(db, value)
                self.verify(before, after, configuration=None, startup_window=None)
                after.execute('update config_machine_state set updated_at_ms=105001')
                with self.assertRaises(RuntimeError): self.verify(before, after)
                after.execute('update config_machine_state set updated_at_ms=105000,value_json=?', (self.NEUTRAL,))
                if value != self.NEUTRAL:
                    with self.assertRaises(RuntimeError): self.verify(before, after)
                after.execute('delete from config_machine_state')
                with self.assertRaises(RuntimeError): self.verify(before, after)

    def test_missing_startup_configuration_or_workspace_authority_is_rejected(self):
        with pair(self.SQL) as (before, after):
            self.insert(after)
            for name in ('startup_window', 'configuration', 'workspace_roots'):
                with self.subTest(missing=name), self.assertRaises(RuntimeError): self.verify(before, after, **{name: None})
            for versions in (('2026.9.8', '2026.9.8'), ('2026.9.6', '2026.9.6'), ('2026.9.2', '2026.9.6')):
                with self.subTest(versions=versions), self.assertRaises(RuntimeError):
                    recovery.retained_plugin_index(before, after, None, self.live / 'openclaw.sqlite', *versions, **self.context)

    def test_invalid_timestamps_or_nonfinite_reversed_and_outside_windows_are_rejected(self):
        with pair(self.SQL) as (before, after):
            self.insert(after)
            for window in ((float('nan'), 110), (100, float('inf')), (110, 100), (-1, 110), (True, 110), (100,), (106, 110), (100, 104)):
                with self.subTest(window=window), self.assertRaises(RuntimeError): self.verify(before, after, startup_window=window)
            for timestamp in (99999, 110001, -1, 9007199254740992):
                after.execute('update config_machine_state set updated_at_ms=?', (timestamp,))
                with self.subTest(timestamp=timestamp), self.assertRaises(RuntimeError): self.verify(before, after)
            for timestamp in (100000, 110000):
                after.execute('update config_machine_state set updated_at_ms=?', (timestamp,))
                self.verify(before, after)
            for timestamp in (True, 105000.0, '105000'):
                with self.subTest(type=type(timestamp)), self.assertRaises(RuntimeError):
                    recovery.retained_neutral_channel_policy(('operator.channelPolicy', self.NEUTRAL, timestamp),
                        self.live / self.selected / 'openclaw-runtime/state/state/openclaw.sqlite',
                        self.context['workspace_roots'], self.context['configuration'], (100, 110))

    def test_non_neutral_retained_permissions_owners_and_wrong_shapes_are_rejected(self):
        values = [{'gateway': {'roles': {}}}, {'gateway': {'auth': {'identityScopes': []}}},
                  {'gateway': {'identityScopes': ['hidden']}}, {'gateway': {'auth': {'roles': {}}}},
                  {'commands': {'ownerAllowFrom': ['owner']}}, {'commands': {'ownerAllowFrom': None}},
                  {'gateway': None}, {'gateway': {'auth': None}}, {'commands': None}]
        for value in values:
            with self.subTest(value=value), pair(self.SQL) as (before, after):
                for root in (self.snapshot, self.live): (root / self.relative).write_text(json.dumps(value), encoding='utf-8')
                self.context = self.authority()
                self.insert(after)
                with self.assertRaises(RuntimeError): self.verify(before, after)

    def test_configuration_hash_and_selected_database_namespace_are_bound(self):
        with pair(self.SQL) as (before, after):
            self.insert(after)
            changed = self.context['configuration'] | {'hashes': ['0' * 64, self.context['configuration']['hashes'][1]]}
            with self.assertRaises(RuntimeError): self.verify(before, after, configuration=changed)
            with self.assertRaises(RuntimeError):
                recovery.retained_plugin_index(before, after, None, self.live / 'archived/openclaw.sqlite',
                    '2026.9.6', '2026.9.8', **self.context)
            with self.assertRaises(RuntimeError):
                self.verify(before, after, workspace_roots=(self.snapshot, self.live, self.snapshot, self.selected))
            (self.snapshot / self.relative).write_text('{}', encoding='utf-8')
            with self.assertRaises(RuntimeError): self.verify(before, after)


if __name__ == '__main__': unittest.main()
