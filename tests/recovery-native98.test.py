"""Offline, synthetic saved-content qualification for the exact 9.6→9.8 pair."""
import contextlib
import copy
from collections import Counter
import hashlib
import json
import os
import pathlib
import shutil
import sqlite3
import stat
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'deploy/update-runner'))
import recovery
import codex_log_retention as log_retention

NODE_PATH = os.environ.get('NODE_BINARY') or shutil.which('node')
NODE = pathlib.Path(NODE_PATH).resolve() if NODE_PATH else None
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


class ConfiguredCodexHomeTests(unittest.TestCase):
    # Sanitized metadata shape from a real fresh 9.8 closed startup: both
    # declared owners have five Codex families, but neither native agent DB.
    # This synthetic fixture tests discovery and retention, not startup proof.
    FAMILIES = ('goals_1.sqlite', 'logs_2.sqlite', 'memories_1.sqlite', 'queue_1.sqlite', 'state_5.sqlite')
    CONFIGURATION = {'agents': {'entries': {
        'main': {}, 'edition3-assignment': {'name': 'Synthetic assignment', 'skills': [], 'subagents': {}, 'tools': {}}}}}
    START = log_retention.RETENTION_SECONDS + 1000

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nova-configured-home-')
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name).resolve()
        self.snapshot, self.live = self.root / 'snapshot', self.root / 'live'
        self.snapshot.mkdir()
        (self.snapshot / 'edition3.identity').write_bytes(b'private.novadream.edition3.preview\n')
        with contextlib.closing(sqlite3.connect(self.snapshot / 'workspace.sqlite')) as db, db:
            db.executescript("pragma user_version=55;create table meta(key text,value text);insert into meta values('epoch','11111111-1111-4111-8111-111111111111');")
        native = self.snapshot / 'openclaw-runtime'; native.mkdir()
        (native / 'edition3-runtime.identity').write_bytes(b'edition3-owned-gateway\n')
        (native / 'openclaw.json').write_text(json.dumps(self.CONFIGURATION), encoding='utf-8')
        self.paths = {self.create_family(agent, name) for agent in ('main', 'edition3-assignment') for name in self.FAMILIES}
        self.copy_live()

    def create_family(self, agent, name):
        relative = pathlib.Path('openclaw-runtime/state/agents') / agent / 'agent/codex-home' / name
        path = self.snapshot / relative; path.parent.mkdir(parents=True, exist_ok=True)
        version, tables = recovery.EMBEDDED_DATABASES_98[name]
        with contextlib.closing(sqlite3.connect(path)) as db, db:
            db.execute('pragma user_version=' + str(version))
            for table, columns in tables.items():
                definitions = []
                for column in columns.split():
                    kind = 'BLOB'
                    if table == 'logs':
                        kind = 'INTEGER PRIMARY KEY' if column == 'id' else 'INTEGER' if column in {'ts', 'ts_nanos', 'line', 'estimated_bytes'} else 'TEXT'
                    definitions.append('"' + column + '" ' + kind)
                db.execute('create table "' + table + '" (' + ','.join(definitions) + ')')
            if name == 'state_5.sqlite':
                db.execute("insert into threads(id,title,first_user_message) values('saved','Retained title','Retained writing')")
            if name == 'logs_2.sqlite':
                db.execute("insert into logs(id,ts,feedback_log_body) values(1,?,'Retained log')", (self.START + 1,))
        return relative

    def copy_live(self):
        if self.live.exists():
            assert self.live.resolve(strict=True) == self.live and self.live.parent == self.root
            shutil.rmtree(self.live)
        shutil.copytree(self.snapshot, self.live)

    def configure(self, value):
        for root in (self.snapshot, self.live):
            (root / 'openclaw-runtime/openclaw.json').write_text(json.dumps(value), encoding='utf-8')

    def verify(self, **options):
        recovery.native_saved_state(self.snapshot, self.live, from_version='2026.9.8', **options)

    def test_fresh_configured_homes_without_optional_agent_databases_use_complete_retention(self):
        selected, _, active = recovery.native_scope(self.snapshot, closed=True)
        self.assertEqual(active, set())
        self.assertEqual(recovery.embedded_database_paths(self.snapshot, selected, active, '2026.9.8'), self.paths)
        hashes = {path: recovery.digest(self.snapshot / path) for path in self.paths}
        for path in self.paths:
            if path.name == 'logs_2.sqlite':
                with contextlib.closing(sqlite3.connect(self.live / path)) as db, db:
                    db.execute("insert into logs(id,ts,feedback_log_body) values(2,?,'Startup log')", (self.START + 2,))
        self.verify(log_retention_window=(self.START, self.START + 10))
        self.assertEqual(hashes, {path: recovery.digest(self.snapshot / path) for path in self.paths})

    def test_default_main_and_explicit_main_have_the_same_canonical_scope(self):
        for configuration in ({}, {'agents': {}}, {'agents': {'entries': {'main': {}}}}, {'agents': {'list': [{'id': 'main'}]}}):
            with self.subTest(configuration=configuration):
                self.configure(configuration)
                found = recovery.embedded_database_paths(self.snapshot, pathlib.Path('.'), set(), '2026.9.8')
                self.assertEqual(found, {path for path in self.paths if 'main' in path.parts})
                self.verify()

    def test_explicit_empty_nonmain_and_precedence_rosters_never_add_main(self):
        configurations = [({'agents': {'entries': {}}}, set()),
                          ({'agents': {'list': []}}, set()),
                          ({'agents': {'entries': {}, 'list': [{'id': 'main'}]}}, set()),
                          ({'agents': {'entries': {'edition3-assignment': {}}}}, {'edition3-assignment'}),
                          ({'agents': {'list': [{'id': 'edition3-assignment'}]}}, {'edition3-assignment'})]
        for configuration, owners in configurations:
            with self.subTest(configuration=configuration):
                self.configure(configuration)
                found = recovery.embedded_database_paths(self.snapshot, pathlib.Path('.'), set(), '2026.9.8')
                self.assertEqual(found, {path for path in self.paths if any(owner in path.parts for owner in owners)})
                self.verify()

    def test_unconfigured_nested_and_unknown_families_keep_exact_static_bytes(self):
        inactive = [pathlib.Path('openclaw-runtime/state/agents/dormant/agent/codex-home/state_5.sqlite'),
                    pathlib.Path('openclaw-runtime/state/agents/main/agent/codex-home/archive/state_5.sqlite'),
                    pathlib.Path('openclaw-runtime/state/agents/main/agent/codex-home/unknown.sqlite')]
        for path in inactive:
            source = self.snapshot / path; source.parent.mkdir(parents=True, exist_ok=True); source.write_bytes(b'retained dormant bytes')
        self.copy_live(); self.verify()
        for path in inactive:
            with self.subTest(path=path):
                (self.live / path).write_bytes(b'changed dormant bytes')
                with self.assertRaisesRegex(RuntimeError, 'inactive database'): self.verify()
                (self.live / path).write_bytes(b'retained dormant bytes')

    def test_agent_directory_override_never_admits_target_or_dormant_canonical_home(self):
        target = pathlib.Path('redirected/codex-home/state_5.sqlite')
        path = self.snapshot / target; path.parent.mkdir(parents=True); path.write_bytes(b'retained override')
        self.copy_live()
        self.configure({'agents': {'entries': {'main': {'agentDir': str(self.live / 'redirected')}, 'edition3-assignment': {}}}})
        found = recovery.embedded_database_paths(self.snapshot, pathlib.Path('.'), set(), '2026.9.8')
        self.assertEqual(found, {path for path in self.paths if 'edition3-assignment' in path.parts})
        self.verify()
        for relative in (target, next(path for path in self.paths if 'main' in path.parts)):
            with self.subTest(path=relative):
                original = (self.live / relative).read_bytes(); (self.live / relative).write_bytes(b'changed')
                with self.assertRaisesRegex(RuntimeError, 'inactive database'): self.verify()
                (self.live / relative).write_bytes(original)

    def test_malformed_configuration_and_owner_ids_cannot_expand_scope(self):
        for configuration in ([], {'agents': []}, {'agents': {'entries': []}},
                              {'agents': {'entries': {'../outside': {}}}}, {'agents': {'entries': {'main': None}}},
                              {'agents': {'entries': {'-main': {}}}}, {'agents': {'entries': {'a' * 65: {}}}},
                              {'agents': {'list': [{'id': '../outside'}]}}, {'agents': {'list': [{}]}},
                              {'agents': {'list': [{'id': 'main'}, {'id': 'main'}]}}):
            with self.subTest(configuration=configuration):
                self.configure(configuration)
                with self.assertRaises(RuntimeError):
                    recovery.embedded_database_paths(self.snapshot, pathlib.Path('.'), set(), '2026.9.8')

    def test_family_set_changes_are_refused(self):
        relative = next(path for path in self.paths if path.name == 'queue_1.sqlite')
        (self.live / relative).unlink()
        with self.assertRaisesRegex(RuntimeError, 'embedded database set changed'): self.verify()
        self.copy_live()
        self.create_family('main', 'thread_history_1.sqlite'); self.copy_live()
        (self.snapshot / 'openclaw-runtime/state/agents/main/agent/codex-home/thread_history_1.sqlite').unlink()
        with self.assertRaisesRegex(RuntimeError, 'embedded database set changed'): self.verify()

    def test_newly_discovered_homes_reject_row_loss_and_schema_drift(self):
        for agent in ('main', 'edition3-assignment'):
            relative = pathlib.Path('openclaw-runtime/state/agents') / agent / 'agent/codex-home/state_5.sqlite'
            for sql, message in (("delete from threads where id='saved'", 'Retained embedded'),
                                 ('alter table threads add column unreviewed BLOB', 'unreviewed columns'),
                                 ('create index unreviewed on threads(id)', 'schema definitions')):
                with self.subTest(agent=agent, sql=sql):
                    self.copy_live()
                    with contextlib.closing(sqlite3.connect(self.live / relative)) as db, db: db.execute(sql)
                    with self.assertRaisesRegex(RuntimeError, message): self.verify()

    def test_newly_discovered_logs_keep_actual_window_and_recent_rows_strict(self):
        relative = next(path for path in self.paths if path.name == 'logs_2.sqlite')
        with self.assertRaisesRegex(RuntimeError, 'startup window'):
            self.verify(log_retention_window=(self.START + 1, self.START))
        with contextlib.closing(sqlite3.connect(self.live / relative)) as db, db: db.execute('delete from logs')
        with self.assertRaisesRegex(RuntimeError, 'Retained embedded'): self.verify()
        with self.assertRaisesRegex(RuntimeError, 'exact startup age'):
            self.verify(log_retention_window=(self.START, self.START + 10))

    @unittest.skipUnless(os.name == 'posix', 'Canonical symlink checks require a supported symlink fixture.')
    def test_redirected_configuration_homes_databases_and_sidecars_are_refused(self):
        relative = next(path for path in self.paths if path.name == 'state_5.sqlite')
        for target in (pathlib.Path('openclaw-runtime/openclaw.json'), relative.parent.parent,
                       relative.parent, relative, pathlib.Path(str(relative) + '-wal')):
            with self.subTest(path=target):
                self.copy_live(); path = self.live / target
                if path.exists(): path.rename(path.with_name(path.name + '.original'))
                original = path.with_name(path.name + '.original')
                if not original.exists(): original.write_bytes(b'sidecar fixture')
                path.symlink_to(original, target_is_directory=original.is_dir())
                with self.assertRaises(RuntimeError): self.verify()


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
    def test_exact_retired_token_modes_preserve_sources_and_static_stores(self):
        for mode in (0o600, 0o644):
            root, path = self.fixture(); path.chmod(mode)
            retained = path.parent / 'retained.sqlite'; retained.write_bytes(b'saved writing')
            before = recovery.sqlite_source_identity(path)
            with self.subTest(mode=oct(mode)):
                self.assertEqual(recovery.native_capture_owner_paths(root, self.SELECTED, '2026.9.8'), {self.LEASE})
                self.assertEqual(set(self.static(root, '2026.9.8')), {retained.relative_to(root)})
                self.assertEqual(recovery.sqlite_source_identity(path), before)
                self.assertEqual(list(self.scratch.iterdir()), [])

    @unittest.skipUnless(os.name == 'posix', 'Native host classification requires POSIX ownership/modes')
    def test_readable_retired_token_requires_exact_bytes_size_and_version(self):
        altered = bytearray(self.TOKEN); altered[-1] = 1
        for kind, data, version in (('empty', b'', '2026.9.8'),
                                    ('wrong-size', self.TOKEN[:-1], '2026.9.8'),
                                    ('wrong-bytes', bytes(altered), '2026.9.8'),
                                    ('legacy-version', self.TOKEN, '2026.9.6')):
            root, path = self.fixture(data); path.chmod(0o644)
            with self.subTest(kind=kind), self.assertRaises(RuntimeError):
                recovery.native_capture_owner_paths(root, self.SELECTED, version)

    @unittest.skipUnless(os.name == 'posix', 'Native host classification requires POSIX ownership/modes')
    def test_links_permissions_owners_and_sidecars_are_rejected(self):
        kinds = ('symlink', 'hardlink', 'group-writable', 'other-writable', 'directory-mode', 'root-mode', 'sidecar', 'owner')
        for mode, kind in ((mode, kind) for mode in (0o600, 0o644) for kind in kinds):
            root, path = self.fixture(); path.chmod(mode)
            if kind == 'symlink':
                outside = root / 'outside'; outside.write_bytes(self.TOKEN); path.unlink(); path.symlink_to(outside)
            elif kind == 'hardlink': os.link(path, root / 'alias')
            elif kind == 'group-writable': path.chmod(0o664)
            elif kind == 'other-writable': path.chmod(0o666)
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
                with self.subTest(mode=oct(mode), kind=kind), patch.object(pathlib.Path, 'lstat', changed_owner), self.assertRaises(RuntimeError):
                    recovery.native_capture_owner_paths(root, self.SELECTED, '2026.9.8')
            else:
                with self.subTest(mode=oct(mode), kind=kind), self.assertRaises(RuntimeError):
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


    def staging_family(self, payload=None):
        root, owner = self.fixture(b'')
        journal = owner.with_name(owner.name + '-journal')
        if payload is None:
            # The writer's uncommitted zero-page header includes a random nonce.
            payload = bytes(12) + bytes.fromhex('c1d2e3f4') + bytes.fromhex('000000000000020000001000') + bytes(484)
        journal.write_bytes(payload)
        journal.chmod(0o600)
        return root, owner, journal

    @unittest.skipUnless(os.name == 'posix', 'Native staging families require POSIX ownership/modes')
    def test_header_only_staging_family_remains_fully_static(self):
        before, old, old_journal = self.staging_family()
        after, new, new_journal = self.staging_family()
        application_db = self.LEASE.parent / 'captures' / 'written-work.sqlite'
        for root in (before, after):
            sibling = root / application_db
            sibling.parent.mkdir()
            sibling.write_bytes(b'other saved data')
        self.assertEqual(recovery.native_capture_owner_paths(after, self.SELECTED, '2026.9.8'), set())
        old_map = self.static(before, '2026.9.8')
        self.assertEqual(old_map, self.static(after, '2026.9.8'))
        self.assertEqual(set(old_map), {self.LEASE, old_journal.relative_to(before), application_db})
        for path in (old, old_journal):
            role = old_map[path.relative_to(before)]
            self.assertIn(hashlib.sha256(path.read_bytes()).hexdigest(), role)
        (after / application_db).write_bytes(b'changed saved data')
        self.assertNotEqual(old_map, self.static(after, '2026.9.8'))

    @unittest.skipUnless(os.name == 'posix', 'Native staging families require POSIX ownership/modes')
    def test_family_addition_loss_rename_and_changed_nonce_cannot_pass(self):
        for change in ('gained', 'lost', 'lost-journal', 'renamed', 'changed-nonce'):
            before, old, old_journal = self.staging_family()
            after, new, new_journal = self.staging_family()
            if change in ('gained', 'lost'):
                owner, journal = (old, old_journal) if change == 'gained' else (new, new_journal)
                journal.unlink()
                owner.unlink()
            elif change == 'lost-journal':
                new_journal.unlink()
            elif change == 'renamed':
                new.parent.rename(new.parent.with_name('22222222-2222-4222-8222-222222222222'))
            else:
                payload = bytearray(new_journal.read_bytes())
                payload[12] ^= 1
                new_journal.write_bytes(payload)
            with self.subTest(change=change):
                self.assertNotEqual(self.static(before, '2026.9.8'), self.static(after, '2026.9.8'))

    @unittest.skipUnless(os.name == 'posix', 'Native staging families require POSIX ownership/modes')
    def test_only_exact_zero_page_header_supported(self):
        for field, offset in [('magic', 0), ('record-count', 11), ('initial-pages', 19),
                              ('sector-size', 23), ('page-size', 27), ('padding', 511)]:
            root, owner, journal = self.staging_family()
            payload = bytearray(journal.read_bytes())
            payload[offset] ^= 1
            journal.write_bytes(payload)
            with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, 'Unreviewed native capture staging journal'):
                self.static(root, '2026.9.8')
        for kind in ('hot-magic', 'short', 'extra-page', 'unknown-main', 'retired-main', 'legacy-version', 'orphan'):
            root, owner, journal = self.staging_family()
            payload = journal.read_bytes()
            if kind == 'hot-magic': journal.write_bytes(bytes.fromhex('d9d505f920a163d7') + payload[8:])
            elif kind == 'short': journal.write_bytes(payload[:-1])
            elif kind == 'extra-page': journal.write_bytes(payload + bytes(4096))
            elif kind == 'unknown-main': owner.write_bytes(b'unknown')
            elif kind == 'retired-main': owner.write_bytes(self.TOKEN)
            elif kind == 'orphan': owner.unlink()
            reason = ('sidecar has no owner' if kind == 'orphan' else 'unexpected sidecar'
                      if kind in ('unknown-main', 'retired-main', 'legacy-version') else 'Unreviewed native capture staging journal')
            with self.subTest(kind=kind), self.assertRaisesRegex(RuntimeError, reason):
                self.static(root, '2026.9.6' if kind == 'legacy-version' else '2026.9.8')
        for suffix in ('-wal', '-shm', '-unrecognized'):
            root, owner, journal = self.staging_family()
            owner.with_name(owner.name + suffix).write_bytes(b'')
            with self.subTest(suffix=suffix), self.assertRaisesRegex(RuntimeError, 'capture (journal companion|lease has an unexpected sidecar)'):
                self.static(root, '2026.9.8')

    @unittest.skipUnless(os.name == 'posix', 'Native staging families require POSIX ownership/modes')
    def test_staging_family_requires_private_unchanged_roles(self):
        for kind in ('journal-readable', 'journal-writable', 'main-readable', 'parent', 'capture-root', 'hardlink'):
            root, owner, journal = self.staging_family()
            if kind == 'journal-readable': journal.chmod(0o644)
            elif kind == 'journal-writable': journal.chmod(0o660)
            elif kind == 'main-readable': owner.chmod(0o644)
            elif kind == 'parent': owner.parent.chmod(0o755)
            elif kind == 'capture-root': owner.parent.parent.chmod(0o755)
            else: os.link(journal, root / 'unexpected-alias')
            with self.subTest(kind=kind), self.assertRaises(RuntimeError):
                self.static(root, '2026.9.8')
        fields = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
        root, owner, journal = self.staging_family()
        for role, field in ((owner, 'st_uid'), (journal, 'st_gid'), (journal, 'st_dev')):
            original = pathlib.Path.lstat
            def changed_role(path, *args, **kwargs):
                info = original(path, *args, **kwargs)
                if path != role:
                    return info
                values = {name: getattr(info, name) for name in fields}
                values[field] += 1
                return SimpleNamespace(**values)
            with self.subTest(role=role.name, field=field), patch.object(pathlib.Path, 'lstat', changed_role):
                with self.assertRaises(RuntimeError):
                    self.static(root, '2026.9.8')
        real_fstat = recovery.os.fstat
        calls = 0
        def changed_after_read(fd):
            nonlocal calls
            info = real_fstat(fd)
            calls += 1
            if calls != 2:
                return info
            values = {name: getattr(info, name) for name in fields}
            values['st_ctime_ns'] += 1
            return SimpleNamespace(**values)
        with patch.object(recovery.os, 'fstat', changed_after_read), self.assertRaisesRegex(RuntimeError, 'staging journal changed'):
            self.static(root, '2026.9.8')
        self.assertEqual(calls, 2)



    @unittest.skipUnless(os.name == 'posix', 'Native staging families require POSIX symlink semantics')
    def test_staging_journal_link_is_rejected_before_open(self):
        root, owner, journal = self.staging_family()
        target = root / 'other-file'
        journal.rename(target)
        journal.symlink_to(target)
        with patch.object(recovery.os, 'open', side_effect=AssertionError('untrusted link was opened')):
            with self.assertRaisesRegex(RuntimeError, 'Unreviewed native capture staging journal'):
                self.static(root, '2026.9.8')


    def closed_capture_fixture(self):
        base, old, oj = self.staging_family()
        live, cur, cj = self.staging_family()
        for workspace in (base / self.SELECTED, live / self.SELECTED):
            with contextlib.closing(sqlite3.connect(workspace/'workspace.sqlite')) as connection:
                connection.executescript("pragma user_version=55; create table meta(key text primary key, value text);"
                    "insert into meta values('epoch','22222222-2222-4222-8222-222222222222');")
        for folder in (old.parent, cur.parent):
            capture = folder / 'captures'
            capture.mkdir(mode=0o700)
            admission = folder / 'native' / 'admission-Ab93xY'
            admission.mkdir(parents=True, mode=0o700)
            data = admission / 'preserved-payload'
            data.write_bytes(b'unchanged synthetic package payload')
            for p in (data, admission, admission.parent, capture):
                os.utime(p, ns=(1_700_000_000_000_000_000,) * 2)
        return base, old, oj, live, cur, cj

    def capture_test_start(self, base, live, *, attempt=1, previous=None):
        epoch = '22222222-2222-4222-8222-222222222222'
        with patch.object(recovery, 'selected_workspace', side_effect=lambda root,*_,**kw: (root/self.SELECTED, epoch)), \
                patch.object(recovery, 'attest_native_writer_sources'):
            return recovery.begin_capture_retention(base, live, epoch, self.root/'vendor',
                ('isolated-synthetic-test', 'a' * 64, attempt), previous)

    def capture_test_close(self, state, first, second, window=None, closure=True, engine='2026.9.8'):
        window = window or (state['observedAtNs'] // 10**9, (time.time_ns() + 999999999) // 10**9)
        evidence = {'start': state, 'owner': state['owner'], 'window': window}
        base, live = state['roots']
        with patch.object(recovery, 'attest_native_writer_sources'):
            recovery.qualify_capture_map(base, live, self.SELECTED, state['epoch'], self.root/'vendor',
                (engine, engine), window, first, second, evidence if closure else None)
        return evidence

    @unittest.skipUnless(os.name == 'posix', 'Closed capture retirement requires POSIX filesystem evidence')
    def test_closed_capture_retires_only_the_proved_owner_and_carries_through_one_restart(self):
        base, old, oj, live, cur, cj = self.closed_capture_fixture()
        initial = self.static(base, '2026.9.8')
        state = self.capture_test_start(base, live)
        cur.write_bytes(self.TOKEN)
        cj.unlink()
        (cur.parent/'captures').rmdir()
        after = self.static(live, '2026.9.8')
        self.assertNotEqual(initial, after)
        first = self.capture_test_close(state, initial, after)
        self.assertEqual(set(first['retired']), {self.LEASE})
        self.assertEqual(first['retired'][self.LEASE]['after']['owner'][1], state['roles'][self.LEASE]['liveBefore']['owner'][1])
        receipt = self.root / 'accepted-first-fixture.json'
        receipt.write_bytes(b'completed through full compare in production caller')
        previous = {'roots': (base, live), 'physical': state['physical'], 'epoch': state['epoch'],
                    'candidate': 'a' * 64, 'attempt': 1, 'runtime': state['runtime'], 'retired': first['retired'],
                    'receipt': (receipt, recovery.digest(receipt))}
        carried = self.capture_test_start(base, live, attempt=2, previous=previous)
        again = self.capture_test_close(carried, initial, after)
        self.assertEqual(again['retired'], first['retired'])
        with self.assertRaisesRegex(RuntimeError, 'first-start proof'):
            self.capture_test_start(base, live, attempt=2)
        receipt.write_bytes(b'wrong first receipt')
        with self.assertRaisesRegex(RuntimeError, 'proof changed'):
            self.capture_test_start(base, live, attempt=2, previous=previous)
        receipt.write_bytes(b'completed through full compare in production caller')
        cur.write_bytes(b'')
        cj.write_bytes(oj.read_bytes())
        cj.chmod(0o600)
        with self.assertRaisesRegex(RuntimeError, 'changed between startups'):
            self.capture_test_start(base, live, attempt=2, previous=previous)

    @unittest.skipUnless(os.name == 'posix', 'Closed capture retirement requires POSIX filesystem evidence')
    def test_capture_retirement_prestart_selection_allows_only_bound_schemas_and_epoch(self):
        base, _, _, live, _, _ = self.closed_capture_fixture()
        db = live / self.SELECTED / 'workspace.sqlite'
        epoch = '22222222-2222-4222-8222-222222222222'
        with contextlib.closing(sqlite3.connect(db)) as connection:
            connection.execute('pragma user_version=60')
        recovery.capture_live_selection(base, live, self.SELECTED, epoch, (55, 60))
        with self.assertRaisesRegex(RuntimeError, 'schema or epoch'):
            recovery.capture_live_selection(base, live, self.SELECTED, epoch, (55,))
        with self.assertRaisesRegex(RuntimeError, 'schema or epoch'):
            recovery.capture_live_selection(base, live, self.SELECTED, 'changed', (55, 60))
        (live / 'workspace-selection.json').write_text('{}')
        with self.assertRaisesRegex(RuntimeError, 'selector was added'):
            recovery.capture_live_selection(base, live, self.SELECTED, epoch, (55,60))


    @unittest.skipUnless(os.name == 'posix', 'Closed capture retirement requires POSIX filesystem evidence')
    def test_closed_capture_denies_missing_proof_wrong_clock_version_or_identity(self):
        for fault in ('no-close', 'other-version', 'past-window', 'late-start', 'rewritten-owner',
                      'wrong-main', 'journal-remains', 'neighbor', 'added-static', 'missing-lease', 'renamed'):
            base, old, oj, live, cur, cj = self.closed_capture_fixture()
            state = self.capture_test_start(base, live)
            initial = self.static(base, '2026.9.8')
            if fault == 'rewritten-owner':
                cur.rename(live / 'old-token-kept-to-prevent-inode-reuse')
            cur.write_bytes(self.TOKEN if fault != 'wrong-main' else b'')
            cj.unlink()
            if fault == 'neighbor':
                (cur.parent/'native/admission-Ab93xY/preserved-payload').write_bytes(b'changed neighboring data')
            if fault == 'added-static':
                (live/'other.sqlite').write_bytes(b'added database')
            if fault == 'missing-lease':
                cur.unlink()
            if fault == 'renamed':
                cur.parent.rename(cur.parent.with_name('33333333-3333-4333-8333-333333333333'))
            if fault == 'journal-remains':
                cj.write_bytes(oj.read_bytes())
                cj.chmod(0o600)
            with self.subTest(fault=fault), self.assertRaises((RuntimeError, FileNotFoundError)):
                after = self.static(live, '2026.9.8')
                clock = state['observedAtNs'] // 10**9
                window = ((clock-20,clock-10) if fault=='past-window' else (clock+180,clock+190)
                          if fault=='late-start' else None)
                self.capture_test_close(state, initial, after, window, closure=fault!='no-close',
                                        engine='2026.9.6' if fault=='other-version' else '2026.9.8')

    @unittest.skipUnless(os.name == 'posix', 'Closed capture retirement requires POSIX filesystem evidence')
    def test_nonempty_capture_or_unknown_neighbor_keeps_only_static_equality(self):
        for kind in ('nonempty-captures','unknown-root'):
            base, old, oj, live, cur, cj = self.closed_capture_fixture()
            for parent in (old.parent, cur.parent):
                path = parent/'captures'/'saved' if kind=='nonempty-captures' else parent/'unrecognized'
                path.write_bytes(b'preserved data')
            with self.subTest(kind=kind):
                self.assertIsNone(self.capture_test_start(base, live))
                self.assertEqual(self.static(base,'2026.9.8'), self.static(live,'2026.9.8'))



    @unittest.skipUnless(os.name == 'posix', 'Hosted driver records require genuine POSIX exclusive receipt I/O')
    def test_hosted_capture_before_start_writes_one_bound_witness(self):
        import install
        base, old, oj, live, cur, cj = self.closed_capture_fixture()
        recovery_root = self.root / 'private-recovery-root'
        recovery_root.mkdir(mode=0o700)
        base.rename(recovery_root / 'workspace')
        driver = install.Driver.__new__(install.Driver)
        driver.recovery, driver.data = recovery_root, live
        driver.prior_agent = self.root / 'vendor'
        driver.from_engine = driver.active_engine = '2026.9.8'
        driver.from_schema, driver.to_schema = 55, 60
        driver.target_id, driver.job_id = 'b' * 64, 'unit-test-lease'
        driver.output = self.root / 'hosted-receipts'
        driver.output.mkdir(mode=0o700)
        epoch = '22222222-2222-4222-8222-222222222222'
        driver.before = {'epoch': epoch}
        with patch.object(recovery, 'selected_workspace', side_effect=lambda root,*_,**kw: (root/self.SELECTED, epoch)), \
                patch.object(recovery, 'attest_native_writer_sources'):
            driver.capture_before_start(driver.target_id, 1)
            with self.assertRaises(FileExistsError):
                driver.capture_before_start(driver.target_id, 1)
        receipt = driver.output / 'startup-1-capture-before.json'
        proof = json.loads(receipt.read_bytes())
        self.assertEqual((proof['jobId'], proof['candidateId'], proof['attempt'], proof['epoch']),
                         (driver.job_id, driver.target_id, 1, epoch))
        self.assertEqual(set(proof['roles']), {str(self.LEASE)})
        self.assertEqual(proof['roles'][str(self.LEASE)]['liveBefore']['owner'][1], cur.lstat().st_ino)



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

    def verify(self, before, after, *, versions=('2026.9.6', '2026.9.8'), **options):
        context = self.context | options
        recovery.retained_plugin_index(before, after, None,
            self.live / self.selected / 'openclaw-runtime/state/state/openclaw.sqlite',
            *versions, **context)

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

    def test_same98_existing_neutral_timestamp_is_qualified_without_mutation(self):
        with pair(self.SQL) as (before, after):
            for db in (before, after): db.execute("insert into config_machine_state values('retained','saved',7)")
            self.insert(before, timestamp=85000)
            self.insert(after, timestamp=105000)
            original = [list(db.execute('select * from config_machine_state')) for db in (before, after)]
            self.verify(before, after, versions=('2026.9.8', '2026.9.8'))
            self.assertEqual([list(db.execute('select * from config_machine_state')) for db in (before, after)], original)
            after.execute("update config_machine_state set value_json='changed' where state_key='retained'")
            with self.assertRaisesRegex(RuntimeError, 'machine configuration changed'):
                self.verify(before, after, versions=('2026.9.8', '2026.9.8'))

    def test_same98_refresh_requires_existing_exact_neutral_content_and_monotonic_time(self):
        values = [self.NEUTRAL, '{"roles":{"saved":"permission"},"identityScopes":null}',
                  '{"roles":null,"identityScopes":["operator.admin"]}',
                  '{"roles":null,"identityScopes":null,"configuredOwnerPolicy":{"id":"saved"}}',
                  '{ "roles":null,"identityScopes":null}',
                  '{"roles":null,"identityScopes":null,"roles":null}']
        for old_value, new_value in ((old, new) for old in values for new in values
                                     if old != self.NEUTRAL or new != self.NEUTRAL):
            with self.subTest(old=old_value, new=new_value), pair(self.SQL) as (before, after):
                self.insert(before, old_value, 85000); self.insert(after, new_value, 105000)
                with self.assertRaises(RuntimeError): self.verify(before, after, versions=('2026.9.8', '2026.9.8'))
        for old_time, new_time in ((-1, 105000), (9007199254740992, 105000), (106000, 105000),
                                   (85000, 99999), (85000, 110001)):
            with self.subTest(old=old_time, new=new_time), pair(self.SQL) as (before, after):
                self.insert(before, timestamp=old_time); self.insert(after, timestamp=new_time)
                with self.assertRaises(RuntimeError): self.verify(before, after, versions=('2026.9.8', '2026.9.8'))
        for invalid in (True, 85000.0, '85000'):
            with self.subTest(old_type=type(invalid)), pair(self.SQL) as (before, after):
                self.insert(before, timestamp=85000); self.insert(after, timestamp=105000)
                original_rows = recovery.rows
                def invalid_previous(connection, table):
                    return Counter({('operator.channelPolicy', self.NEUTRAL, invalid): 1}) if connection is before else original_rows(connection, table)
                with patch.object(recovery, 'rows', invalid_previous), self.assertRaises(RuntimeError):
                    self.verify(before, after, versions=('2026.9.8', '2026.9.8'))

    def test_same98_refresh_requires_closed_selected_configuration_authority(self):
        with pair(self.SQL) as (before, after):
            self.insert(before, timestamp=85000); self.insert(after, timestamp=105000)
            for name in ('startup_window', 'configuration', 'workspace_roots'):
                with self.subTest(missing=name), self.assertRaises(RuntimeError):
                    self.verify(before, after, versions=('2026.9.8', '2026.9.8'), **{name: None})
            for window in ((float('nan'), 110), (100, float('inf')), (110, 100), (106, 110), (100, 104)):
                with self.subTest(window=window), self.assertRaises(RuntimeError):
                    self.verify(before, after, versions=('2026.9.8', '2026.9.8'), startup_window=window)
            for versions in (('2026.9.6', '2026.9.8'), ('2026.9.6', '2026.9.6'), ('2026.9.2', '2026.9.6')):
                with self.subTest(versions=versions), self.assertRaises(RuntimeError): self.verify(before, after, versions=versions)
            changed = self.context['configuration'] | {'hashes': ['0' * 64, self.context['configuration']['hashes'][1]]}
            with self.assertRaises(RuntimeError):
                self.verify(before, after, versions=('2026.9.8', '2026.9.8'), configuration=changed)
            with self.assertRaises(RuntimeError):
                recovery.retained_plugin_index(before, after, None, self.live / 'archived/openclaw.sqlite',
                    '2026.9.8', '2026.9.8', **self.context)
            for root in (self.snapshot, self.live):
                (root / self.relative).write_text('{"gateway":{"roles":{}},"commands":{"ownerAllowFrom":[]}}', encoding='utf-8')
            self.context = self.authority()
            with self.assertRaises(RuntimeError): self.verify(before, after, versions=('2026.9.8', '2026.9.8'))
        for absent in ('before', 'after'):
            with self.subTest(absent=absent), pair(self.SQL) as (before, after):
                self.insert(after if absent == 'before' else before)
                with self.assertRaises(RuntimeError): self.verify(before, after, versions=('2026.9.8', '2026.9.8'))

    def test_same98_saved_state_binds_refresh_authority_and_retains_identity_permissions(self):
        base = pathlib.Path(self.temporary.name).resolve() / 'saved-state'
        snapshot = base / 'snapshot'; snapshot.mkdir(parents=True)
        (snapshot / 'edition3.identity').write_bytes(b'private.novadream.edition3.preview\n')
        with contextlib.closing(sqlite3.connect(snapshot / 'workspace.sqlite')) as db:
            db.executescript("pragma user_version=55;create table meta(key text,value text);insert into meta values('epoch','11111111-1111-4111-8111-111111111111');")
        native = snapshot / 'openclaw-runtime'; native.mkdir()
        (native / 'edition3-runtime.identity').write_bytes(b'edition3-owned-gateway\n')
        (native / 'openclaw.json').write_text('{"gateway":{"auth":{}},"commands":{"ownerAllowFrom":[]}}', encoding='utf-8')
        relative = pathlib.Path('openclaw-runtime/state/state/openclaw.sqlite')
        (snapshot / relative).parent.mkdir(parents=True)
        with contextlib.closing(sqlite3.connect(snapshot / relative)) as db:
            db.executescript('pragma user_version=19;' + self.SQL + recovery.PROFILE_IDENTITIES_98_SQL)
            self.insert(db, timestamp=85000)
            db.execute("insert into user_profile_identities values('channel','saved-subject','saved-profile',null,1,'saved-authorization','{\"saved\":true}')")
            db.commit()
        original_hash = recovery.digest(snapshot / relative)
        live = base / 'live'; shutil.copytree(snapshot, live)
        with contextlib.closing(sqlite3.connect(live / relative)) as db:
            db.execute("update config_machine_state set updated_at_ms=105000 where state_key='operator.channelPolicy'"); db.commit()
        # Exercise the maintained same-engine entry point, not only its projector.
        recovery.native_saved_state(snapshot, live, from_version='2026.9.8', log_retention_window=(100, 110))
        self.assertEqual(recovery.digest(snapshot / relative), original_hash)
        with self.assertRaisesRegex(RuntimeError, 'startup authority'):
            recovery.native_saved_state(snapshot, live, from_version='2026.9.8')
        with contextlib.closing(sqlite3.connect(live / relative)) as db:
            db.execute("update user_profile_identities set authorization_id='changed-authorization'"); db.commit()
        with self.assertRaisesRegex(RuntimeError, 'permissions changed'):
            recovery.native_saved_state(snapshot, live, from_version='2026.9.8', log_retention_window=(100, 110))

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


class CopiedCodexAdmissionsTests(unittest.TestCase):
    """Real disposable copy/restart roles, not a blanket catalog projection."""
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nova-codex-admission-', dir=os.environ.get('QA_PROTECTED_PARENT'))
        self.root = pathlib.Path(self.temporary.name).resolve()
        self.live, self.snapshot, self.trial, self.original = [self.root / value for value in ('live', 'snapshot', 'trial', 'original')]
        self.selected = pathlib.Path('selected')
        self.relative = self.selected / 'openclaw-runtime/state/npm/projects/openclaw-codex-test/node_modules/@openclaw/codex'
        self.package = self.live / self.relative
        self.source_relative = self.relative.parent.parent / '@openai/codex-linux-x64'
        self.source = self.live / self.source_relative
        (self.package / 'dist').mkdir(parents=True)
        (self.source / 'bin').mkdir(parents=True)
        for relative, value in [('openclaw.plugin.json', '{"id":"codex"}'),
                                ('package.json', '{"name":"@openclaw/codex","version":"2026.9.8"}'),
                                ('dist/index.js', 'export const retained=true;'),
                                ('dist/doctor-contract-api.js', 'export const doctor=true;')]:
            path = self.package / relative; path.write_text(value)
            os.utime(path, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))
        for relative, value in [('package.json', '{"name":"native-package"}'), ('bin/tool', 'exact native bytes')]:
            path = self.source / relative; path.write_text(value)
            os.utime(path, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))
        for folder in (self.source, self.source / 'bin'):
            os.utime(folder, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))
        self.capture_relative = self.selected / 'openclaw-runtime/state/tmp/plugin-captures'
        self.old_capture = self.capture_relative / '11111111-1111-4111-8111-111111111111/native/admission-Old123'
        old_admission = self.capture(self.old_capture)
        old_record = {'pluginId': 'codex', 'rootDir': str(self.package), 'source': str(self.package / 'dist/index.js'),
            'manifestPath': str(self.package / 'openclaw.plugin.json'), 'manifestHash': recovery.digest(self.package / 'openclaw.plugin.json'),
            'manifestFile': self.signature(self.package / 'openclaw.plugin.json'), 'packageVersion': '2026.9.8',
            'doctorContractHash': recovery.digest(self.package / 'dist/doctor-contract-api.js'),
            'doctorContractFile': self.signature(self.package / 'dist/doctor-contract-api.js'),
            'packageJson': {'path': 'package.json', 'hash': recovery.digest(self.package / 'package.json'),
                            'fileSignature': self.signature(self.package / 'package.json')},
            'sourceAdmissions': old_admission, 'contributions': {'tools': ['retained']}, 'enabled': True}
        self.old = self.index(old_record, 1)
        shutil.copytree(self.live, self.snapshot)
        shutil.copytree(self.live, self.trial)
        # The maintained pre-start call composes original/snapshot/trial proof.
        self.prestart = (self.snapshot, self.trial, self.live, self.selected)
        recovery.retained_catalog_files([copy.deepcopy(self.old), copy.deepcopy(self.old)], workspace_roots=self.prestart,
                                        engine_version='2026.9.8')
        self.live.rename(self.original); self.trial.rename(self.live)
        self.window = (time.time() - 1, time.time() + 5)
        self.new_capture = self.capture_relative / '22222222-2222-4222-8222-222222222222/native/admission-New123'
        new_record = copy.deepcopy(old_record); new_record['sourceAdmissions'] = self.capture(self.new_capture)
        self.new = self.index(new_record, 2)
        self.roots = (self.snapshot, self.live, self.live, self.selected)

    def tearDown(self):
        self.temporary.cleanup()

    @staticmethod
    def signature(path):
        info = path.stat()
        return {'size': info.st_size, 'mtimeMs': info.st_mtime_ns / 10 ** 6, 'ctimeMs': info.st_ctime_ns / 10 ** 6}

    @staticmethod
    def identity(path):
        info = path.lstat()
        return ':'.join(map(str, (info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns)))

    @staticmethod
    def index(record, revision):
        return {'version': 1, 'warning': '', 'hostContractVersion': '2026.9.8', 'compatRegistryVersion': 'a' * 64,
                'migrationVersion': 1, 'policyHash': 'b' * 64, 'generatedAtMs': revision,
                'installRecords': {}, 'plugins': [record], 'diagnostics': []}

    def capture(self, relative):
        captured = self.live / relative
        (captured / 'content/bin').mkdir(parents=True)
        for guard in (self.live / self.capture_relative, captured.parent.parent, captured.parent, captured, captured / 'content', captured / 'content/bin'):
            guard.chmod(0o700)
        shutil.copyfile(self.source / 'package.json', captured / 'content/package.json')
        os.link(self.source / 'bin/tool', captured / 'content/bin/tool')
        directory_stamp = int(time.time() * 10 ** 9)
        for folder in (captured / 'content', captured / 'content/bin'):
            os.utime(folder, ns=(directory_stamp, directory_stamp))
        members = {}
        for name in ('', 'bin', 'bin/tool', 'package.json'):
            source, current = self.source / name, captured / 'content' / name
            value = {'source': str(source), 'sourceIdentity': self.identity(source),
                     'capturedIdentity': self.identity(current), 'boundaryChecked': name == 'package.json'}
            if source.is_file(): value.update(sizeBytes=source.stat().st_size, contentHash=recovery.digest(source))
            members[name] = value
        artifact = {field: members['bin/tool'][field] for field in ('sourceIdentity', 'capturedIdentity', 'contentHash', 'sizeBytes')}
        artifact.update(namespace=str(captured), capturedPath=str(captured / 'content/bin/tool'))
        return {str(self.package) + '\0': {'signature': 'c' * 64, 'sourceDigest': 'd' * 64,
            'nativeArtifacts': {str(self.source / 'bin/tool'): artifact},
            'nativeNamespaces': {str(captured): {'sourceDirectory': str(self.source), 'capturedRoot': str(captured),
                                               'managed': True, 'members': members}}}}

    def compare(self, mutation=None, *, roots=None, window=None, catalog_runtime_root=None):
        before, after = copy.deepcopy(self.old), copy.deepcopy(self.new)
        if mutation: mutation(after)
        with pair('CREATE TABLE config_machine_state(state_key TEXT,value_json TEXT,updated_at_ms INTEGER);') as (old, new):
            for db, value in ((old, before), (new, after)):
                db.execute('insert into config_machine_state values(?,?,?)',
                           ('plugins.installedIndex', json.dumps({'revision': value['generatedAtMs'], 'index': value}), value['generatedAtMs']))
            recovery.retained_plugin_index(old, new, None, self.live / 'unused', '2026.9.8', '2026.9.8',
                workspace_roots=roots or self.roots, startup_window=self.window if window is None else window,
                catalog_runtime_root=catalog_runtime_root)

    def test_copied_codex_build_forms_require_exact_package_and_complete_admission(self):
        runtime = self.root / 'openclaw-2026.9.8-aaaaaaaaaaaa/node_modules/openclaw'
        runtime.mkdir(parents=True)
        (runtime / 'package.json').write_text('{"name":"openclaw","version":"2026.9.8"}')
        full = {'openclawVersion': '2026.9.8', 'workerEntries': ['./catalog-page.worker.ts']}
        content = json.dumps({'name': '@openclaw/codex', 'version': '2026.9.8', 'openclaw': {'build': full}})
        for root in (self.original, self.snapshot, self.live):
            path = root / self.relative / 'package.json'
            path.write_text(content)
            os.utime(path, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))
        package = {'path': 'package.json', 'hash': recovery.digest(self.original / self.relative / 'package.json'),
                   'fileSignature': self.signature(self.original / self.relative / 'package.json')}
        for value, build in ((self.old, {}), (self.new, full)):
            value['plugins'][0].update(packageBuild=copy.deepcopy(build), packageJson=copy.deepcopy(package),
                                       packageName='@openclaw/codex', origin='global')
        if os.name == 'posix' and os.geteuid() != 0:
            # CI also runs this class in its protected root phase. Here prove
            # that an unprivileged package cannot supply runtime authority.
            with self.assertRaisesRegex(RuntimeError, 'Catalog build runtime is not protected'):
                self.compare(catalog_runtime_root=runtime)
            return
        self.compare(catalog_runtime_root=runtime)
        self.old['plugins'][0]['packageBuild'], self.new['plugins'][0]['packageBuild'] = copy.deepcopy(full), {}
        self.compare(catalog_runtime_root=runtime)
        with self.assertRaises(RuntimeError): self.compare()
        with self.assertRaises(RuntimeError):
            self.compare(lambda value: value['plugins'][0].pop('sourceAdmissions'), catalog_runtime_root=runtime)
        (self.snapshot / self.relative / 'package.json').write_text('{}')
        with self.assertRaises(RuntimeError): self.compare(catalog_runtime_root=runtime)

    def admission(self, value): return next(iter(value['plugins'][0]['sourceAdmissions'].values()))
    def namespace(self, value): return next(iter(self.admission(value)['nativeNamespaces'].values()))

    def test_real_copy_cached_ctime_and_fresh_capture_are_byte_bound_without_mutation(self):
        before = {str(path): (recovery.digest(path), self.identity(path)) for path in self.root.rglob('*') if path.is_file()}
        self.compare()
        self.assertEqual(before, {str(path): (recovery.digest(path), self.identity(path)) for path in self.root.rglob('*') if path.is_file()})
        self.assertEqual(self.old['plugins'][0]['manifestFile'], self.new['plugins'][0]['manifestFile'])
        self.assertNotEqual(self.identity(self.original / self.relative / 'openclaw.plugin.json'),
                            self.identity(self.package / 'openclaw.plugin.json'))

    def test_native_authority_membership_identity_and_paths_remain_strict(self):
        cases = [lambda v: self.admission(v).update(signature='e' * 64),
                 lambda v: self.admission(v).update(sourceDigest='e' * 64),
                 lambda v: self.admission(v).update(unknown=True),
                 lambda v: self.namespace(v).update(managed=False),
                 lambda v: self.namespace(v).update(sourceDirectory=str(self.root)),
                 lambda v: self.namespace(v)['members'].pop('package.json'),
                 lambda v: self.namespace(v)['members']['bin/tool'].update(contentHash='e' * 64),
                 lambda v: self.namespace(v)['members']['bin/tool'].update(sizeBytes=1),
                 lambda v: self.namespace(v)['members']['bin/tool'].update(source=str(self.root / 'outside')),
                 lambda v: self.namespace(v)['members']['bin/tool'].update(sourceIdentity='1:1:33216:18:1:1'),
                 lambda v: self.namespace(v)['members']['bin/tool'].update(capturedIdentity='1:1:33216:18:1:1'),
                 lambda v: self.namespace(v)['members']['package.json'].update(boundaryChecked=False),
                 lambda v: self.namespace(v)['members'].update({'../outside': copy.deepcopy(self.namespace(v)['members']['bin/tool'])}),
                 lambda v: next(iter(self.admission(v)['nativeArtifacts'].values())).update(capturedPath=str(self.root / 'outside')),
                 lambda v: self.admission(v)['nativeArtifacts'].clear(),
                 lambda v: v['plugins'][0]['contributions']['tools'].append('unexpected'),
                 lambda v: v['plugins'][0]['manifestFile'].update(ctimeMs=1),
                 lambda v: v['plugins'][0]['packageJson']['fileSignature'].update(mtimeMs=1)]
        for number, mutation in enumerate(cases):
            with self.subTest(case=number), self.assertRaises((RuntimeError, FileNotFoundError)): self.compare(mutation)

    def test_capture_window_and_cached_ctime_without_proof_are_rejected(self):
        for window in ((), (0, 1), (float('nan'), time.time()), (time.time(), 1)):
            with self.subTest(window=window), self.assertRaises(RuntimeError): self.compare(window=window)
        with self.assertRaises(RuntimeError): self.compare(lambda v: v['plugins'][0].pop('sourceAdmissions'))
        old, new = copy.deepcopy(self.old), copy.deepcopy(self.new)
        old['plugins'][0].pop('sourceAdmissions'); new['plugins'][0].pop('sourceAdmissions')
        with self.assertRaises(RuntimeError):
            recovery.retained_catalog_files([old, new], workspace_roots=self.roots, engine_version='2026.9.8')

    def test_missing_extra_and_changed_physical_native_bytes_are_rejected(self):
        captured = self.live / self.new_capture / 'content'
        extra = captured / 'extra'; extra.write_text('unexpected')
        with self.assertRaises(RuntimeError): self.compare()
        extra.unlink()
        tool = self.source / 'bin/tool'; before = tool.stat(); tool.write_text('mutat native bytes')
        os.utime(tool, ns=(before.st_atime_ns, before.st_mtime_ns))
        # Supply truthful refreshed identities; the unchanged expected hash still rejects bytes.
        def truthful(value):
            for relative, item in self.namespace(value)['members'].items():
                item.update(sourceIdentity=self.identity(self.source / relative), capturedIdentity=self.identity(captured / relative))
            member = self.namespace(value)['members']['bin/tool']
            member.update(sourceIdentity=self.identity(tool), capturedIdentity=self.identity(captured / 'bin/tool'))
            artifact = next(iter(self.admission(value)['nativeArtifacts'].values()))
            artifact.update(sourceIdentity=member['sourceIdentity'], capturedIdentity=member['capturedIdentity'])
        with self.assertRaisesRegex(RuntimeError, 'bytes changed'): self.compare(truthful)

    @unittest.skipIf(os.name == 'nt', 'POSIX symlink redirection guard')
    def test_symlinked_capture_member_is_rejected(self):
        captured = self.live / self.new_capture / 'content/package.json'
        captured.unlink(); captured.symlink_to(self.source / 'package.json')
        with self.assertRaises(RuntimeError): self.compare()

    def reused_capture(self):
        admission = copy.deepcopy(self.admission(self.new))
        previous = str(self.live / self.old_capture)
        value = next(iter(admission['nativeNamespaces'].values()))
        value['capturedRoot'] = previous
        for relative, member in value['members'].items():
            member['sourceIdentity'] = self.identity(self.source / relative)
            member['capturedIdentity'] = self.identity(self.live / self.old_capture / 'content' / relative)
        admission['nativeNamespaces'] = {previous: value}
        artifact = next(iter(admission['nativeArtifacts'].values()))
        artifact.update(namespace=previous, capturedPath=str(self.live / self.old_capture / 'content/bin/tool'),
                        sourceIdentity=value['members']['bin/tool']['sourceIdentity'],
                        capturedIdentity=value['members']['bin/tool']['capturedIdentity'])
        return admission

    def test_reused_namespace_copy_ctime_is_proved_but_refreshed_mtime_needs_closed_window(self):
        def truthful(value): value['plugins'][0]['sourceAdmissions'] = {str(self.package) + '\0': self.reused_capture()}
        self.compare(truthful)  # Same namespace and copied identity, with exact retained mtimes.
        for relative in ('', 'package.json'):
            path = self.live / self.old_capture / 'content' / relative
            before = path.stat()
            os.utime(path, ns=(before.st_atime_ns, 1_600_000_000_000_000_000))
            with self.subTest(member=relative), self.assertRaisesRegex(RuntimeError, 'created during retained startup'):
                self.compare(truthful)
            os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))

    @unittest.skipUnless(os.name == 'posix' and os.geteuid() == 0, 'Direct ownership proof requires isolated Linux root')
    def test_truthful_current_chown_cannot_change_source_or_capture_ownership(self):
        tool = self.source / 'bin/tool'
        os.chown(tool, 1, tool.stat().st_gid)
        def truthful(value):
            member = self.namespace(value)['members']['bin/tool']
            member.update(sourceIdentity=self.identity(tool),
                          capturedIdentity=self.identity(self.live / self.new_capture / 'content/bin/tool'))
            artifact = next(iter(self.admission(value)['nativeArtifacts'].values()))
            artifact.update(sourceIdentity=member['sourceIdentity'], capturedIdentity=member['capturedIdentity'])
        with self.assertRaisesRegex(RuntimeError, 'ownership changed across roles'): self.compare(truthful)


class PackageBuildProjectionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nova-package-build-', dir=os.environ.get('QA_PROTECTED_PARENT'))
        self.root = pathlib.Path(self.temporary.name).resolve()
        self.runtime = self.root / 'openclaw-2026.9.8-aaaaaaaaaaaa/node_modules/openclaw'
        self.package = self.runtime / 'dist/extensions/build-fixture'
        self.package.mkdir(parents=True)
        (self.runtime / 'package.json').write_text(json.dumps({'name': 'openclaw', 'version': '2026.9.8'}))
        self.full = {'bundledDist': True, 'openclawVersion': '2026.9.8',
                     'workerEntries': ['./src/worker.ts'], 'staticAssets': [{'source': './assets/data', 'output': 'assets/data'}]}
        self.set_package(self.full)

    def tearDown(self): self.temporary.cleanup()

    def set_package(self, build):
        path = self.package / 'package.json'
        path.write_text(json.dumps({'name': '@openclaw/build-fixture', 'version': '2026.9.8', 'openclaw': {'build': build}}))
        self.record = {'pluginId': 'build-fixture', 'origin': 'bundled', 'rootDir': str(self.package),
                       'source': str(self.package / 'index.js'), 'manifestPath': str(self.package / 'openclaw.plugin.json'),
                       'packageName': '@openclaw/build-fixture', 'packageVersion': '2026.9.8', 'enabled': True,
                       'contributions': {'tools': ['saved']}, 'packageBuild': copy.deepcopy(build),
                       'packageJson': {'path': 'package.json', 'hash': recovery.digest(path),
                                       'fileSignature': CopiedCodexAdmissionsTests.signature(path)}}

    def compare(self, old_build=None, new_build=None, mutation=None, *, runtime=True, version='2026.9.8'):
        old, new = copy.deepcopy(self.record), copy.deepcopy(self.record)
        old['packageBuild'] = copy.deepcopy({'bundledDist': True} if old_build is None else old_build)
        new['packageBuild'] = copy.deepcopy(self.full if new_build is None else new_build)
        before = CopiedCodexAdmissionsTests.index(old, 1); after = CopiedCodexAdmissionsTests.index(new, 2)
        before['hostContractVersion'] = after['hostContractVersion'] = version
        if mutation: mutation(after)
        with pair('CREATE TABLE config_machine_state(state_key TEXT,value_json TEXT,updated_at_ms INTEGER);') as (left, right):
            for db, value in ((left, before), (right, after)):
                db.execute('insert into config_machine_state values(?,?,?)',
                           ('plugins.installedIndex', json.dumps({'revision': value['generatedAtMs'], 'index': value}), value['generatedAtMs']))
            recovery.retained_plugin_index(left, right, None, self.root / 'unused', version, version,
                                           catalog_runtime_root=self.runtime if runtime is True else runtime or None)

    def test_exact_full_and_cached_forms_in_both_directions_preserve_restart(self):
        if os.name == 'posix' and os.geteuid() != 0:
            with self.assertRaisesRegex(RuntimeError, 'Catalog build runtime is not protected'):
                self.compare()
            return
        before = {str(path): (recovery.digest(path), path.stat().st_mtime_ns) for path in self.root.rglob('*') if path.is_file()}
        self.compare(); self.compare(self.full, {'bundledDist': True}); self.compare(self.full, self.full)
        self.compare({'bundledDist': True}, {'bundledDist': True})
        self.assertEqual(before, {str(path): (recovery.digest(path), path.stat().st_mtime_ns) for path in self.root.rglob('*') if path.is_file()})

    def test_absent_and_false_bundled_dist_are_exact_boolean_projections(self):
        if os.name == 'posix' and os.geteuid() != 0:
            with self.assertRaisesRegex(RuntimeError, 'Catalog build runtime is not protected'):
                self.compare()
            return
        for value in (None, False):
            full = copy.deepcopy(self.full)
            if value is None: del full['bundledDist']
            else: full['bundledDist'] = value
            self.set_package(full)
            projected = {} if value is None else {'bundledDist': value}
            self.compare(projected, full); self.compare(full, projected)

    def test_missing_wrong_runtime_or_other_engine_cannot_qualify(self):
        for runtime in (False, self.root, self.root / 'openclaw-2026.9.8-bbbbbbbbbbbb/node_modules/openclaw'):
            with self.subTest(runtime=runtime), self.assertRaises((RuntimeError, FileNotFoundError)):
                self.compare(runtime=runtime)
        with self.assertRaises(RuntimeError): self.compare(version='2026.9.6')
        (self.runtime / 'package.json').write_text('{"name":"openclaw","version":"2026.9.6"}')
        with self.assertRaises(RuntimeError): self.compare()

    def test_partial_unknown_forged_and_changed_order_metadata_is_rejected(self):
        values = [{}, {'bundledDist': False}, {'bundledDist': 1}, {'bundledDist': True, 'extra': 1},
                  {**self.full, 'openclawVersion': '2026.9.9'},
                  {**self.full, 'workerEntries': ['./src/other.ts']},
                  {**self.full, 'staticAssets': [{'source': './assets/other', 'output': 'assets/data'}]},
                  {**self.full, 'workerEntries': ['./src/worker.ts', './src/other.ts']}]
        for value in values:
            with self.subTest(value=value), self.assertRaises(RuntimeError): self.compare(new_build=value)
        self.set_package({**self.full, 'unknownBuildAuthority': True})
        with self.assertRaises(RuntimeError): self.compare(new_build={**self.full, 'unknownBuildAuthority': True})

    def test_package_identity_hash_signature_path_and_bytes_remain_strict(self):
        for mutation in (lambda v: v['plugins'][0]['packageJson'].update(hash='c' * 64),
                         lambda v: v['plugins'][0]['packageJson'].update(path='../package.json'),
                         lambda v: v['plugins'][0]['packageJson']['fileSignature'].update(mtimeMs=1),
                         lambda v: v['plugins'][0].update(rootDir=str(self.root)),
                         lambda v: v['plugins'][0].update(packageName='forged')):
            with self.subTest(mutation=mutation), self.assertRaises(RuntimeError): self.compare(mutation=mutation)
        (self.package / 'package.json').write_text('{}')
        with self.assertRaises(RuntimeError): self.compare()

    def test_worker_asset_order_and_unrecognized_physical_metadata_are_rejected(self):
        full = {**self.full, 'workerEntries': ['./src/one.ts', './src/two.ts'],
                'staticAssets': [{'source': './one', 'output': 'one'}, {'source': './two', 'output': 'two'}]}
        self.set_package(full)
        for changed in ({**full, 'workerEntries': list(reversed(full['workerEntries']))},
                        {**full, 'staticAssets': list(reversed(full['staticAssets']))}):
            with self.assertRaises(RuntimeError): self.compare(new_build=changed)
        for changed in ({**full, 'workerEntries': ['../../outside']},
                        {**full, 'workerEntries': ['./one'] * 65},
                        {**full, 'staticAssets': [{'source': './one', 'output': '/outside'}]},
                        {**full, 'bundledDist': 1}):
            self.set_package(changed)
            with self.assertRaises(RuntimeError): self.compare(new_build=changed)

    def test_policy_membership_capability_and_diagnostics_remain_strict(self):
        self.record['contributions']['execution'] = {'allowed': True}
        for mutation in (lambda v: v.update(policyHash='c' * 64),
                         lambda v: v['plugins'].append(copy.deepcopy(v['plugins'][0])),
                         lambda v: v['plugins'][0]['contributions']['tools'].append('forged'),
                         lambda v: v['plugins'][0].update(enabled=False),
                         lambda v: v['plugins'][0].update(enabled=1),
                         lambda v: v['plugins'][0]['contributions']['execution'].update(allowed=1),
                         lambda v: v['diagnostics'].append({'message': 'new', 'level': 'warn'})):
            with self.subTest(mutation=mutation), self.assertRaises(RuntimeError): self.compare(mutation=mutation)

    def test_unadmitted_or_app_package_cannot_use_build_projection(self):
        for mutation in (lambda v: v['plugins'][0].update(origin='config'),
                         lambda v: v['plugins'][0].update(pluginId='edition3-worker')):
            with self.assertRaises(RuntimeError): self.compare(mutation=mutation)

    @unittest.skipUnless(os.name == 'posix' and os.geteuid() == 0, 'Physical ownership proof requires isolated Linux root')
    def test_truthful_chown_and_symlink_runtime_are_rejected(self):
        path = self.package / 'package.json'; info = path.stat()
        os.chown(path, 1, info.st_gid)
        self.record['packageJson']['fileSignature'] = CopiedCodexAdmissionsTests.signature(path)
        with self.assertRaisesRegex(RuntimeError, 'not protected'): self.compare()
        os.chown(path, info.st_uid, info.st_gid)
        alias = self.root / 'runtime-alias'; alias.symlink_to(self.runtime, target_is_directory=True)
        with self.assertRaises(RuntimeError): self.compare(runtime=alias)


class CaptureReapingTests(unittest.TestCase):
    def setUp(self):
        self.snapshot, self.live = pathlib.Path('/synthetic/snapshot'), pathlib.Path('/synthetic/live')
        self.role = pathlib.Path('selected/openclaw-runtime/state/tmp/plugin-captures/11111111-1111-4111-8111-111111111111/owner.sqlite')
        self.runtime = pathlib.Path('/synthetic/runtime/openclaw')
        self.root = (self.live / self.role).parent
        self.names = ('admission-Alpha1', 'admission-Beta12')
        self.rows = {'native': self.directory()}
        self.admissions = {}
        for name in self.names:
            prefix = 'native/' + name
            self.rows.update({prefix:self.directory(),prefix+'/content':self.directory(),
                prefix+'/node_modules':self.directory(),
                prefix+'/node_modules/openclaw':{'kind':'symlink','mode':0o777,'uid':999,'gid':986,
                    'xattrs':{},'mtime_ns':100*10**9,'target':str(self.runtime)},
                prefix+'/content/tool':{'kind':'file','mode':0o600,'uid':999,'gid':986,
                    'xattrs':{},'mtime_ns':100*10**9,'sha256':'a'*64,'size':20}})
            namespace = str(self.root/'native'/name)
            members = {'':{'capturedIdentity':f'1:10:{stat.S_IFDIR|0o700}:4096:{100*10**9}:1'},
                'tool':{'capturedIdentity':f'1:11:{stat.S_IFREG|0o600}:20:{100*10**9}:1',
                    'sizeBytes':20,'contentHash':'a'*64}}
            self.admissions[namespace] = {'original':{'managed':True,'capturedRoot':namespace,'members':members},
                'current':str(self.root.parent/'22222222-2222-4222-8222-222222222222/native'/name)}
        self.old = {'coverage':({'uid':999,'gid':986,'mode':0o700,'xattrs':{}},{},'b'*64)}
        self.observed_coverage = copy.deepcopy(self.old['coverage'])
        self.prior = {'journal':None,'owner':(2,40,stat.S_IFREG|0o600,999,986,1,4096,110*10**9,110*10**9),
            'parent':(2,30,stat.S_IFDIR|0o700,999,986,3,4096,110*10**9,110*10**9),
            'hashes':(recovery.CAPTURE_OWNER_RETIRED_SHA256,None),'coverage':self.old['coverage'],'captures':None}
        self.carry = {'source':self.old,'after':self.prior,'firstWindow':(100,110)}
        self.row = {'source':self.old,'liveBefore':self.prior,'carry':self.carry}
        self.namespaces = {pathlib.Path(k).name:v for k,v in self.admissions.items()}
        self.source_hash = 'd'*64

    @staticmethod
    def directory():
        return {'kind':'directory','mode':0o700,'uid':999,'gid':986,'xattrs':{},'mtime_ns':100*10**9}

    def source(self):
        with patch.object(recovery,'capture_context',return_value=(self.observed_coverage,None,self.rows)):
            return recovery.capture_admission_rows(self.snapshot,self.live,self.role,self.runtime,self.admissions,self.old['coverage'])

    def transition(self, remaining, row=None, window=(200,210), corrupt=None):
        current = None
        current_rows = {}
        if remaining is not None:
            current = copy.deepcopy((row or self.row)['liveBefore'] or self.prior)
            current['coverage'] = self.old['coverage'][:2] + ('c'*64,)
            current_rows = {k:copy.deepcopy(v) for k,v in self.rows.items()
                            if k=='native' or k.split('/')[1] in remaining}
            current_rows['native']['mtime_ns'] = window[0]*10**9+1
        if corrupt:
            corrupt(current,current_rows)
        with patch.object(recovery,'attest_native_writer_sources'), \
                patch.object(recovery,'capture_admission_rows',return_value=(self.rows,self.namespaces,self.source_hash)), \
                patch.object(recovery.os.path,'lexists',return_value=remaining is not None), \
                patch.object(recovery,'observe_capture_family',return_value=current), \
                patch.object(recovery,'capture_context',return_value=(self.old['coverage'],None,current_rows)):
            return recovery.qualify_capture_reaping(self.snapshot,self.live,self.role,self.runtime,row or self.row,window,self.admissions)

    def test_complete_source_namespace_is_required(self):
        rows, namespaces, proof = self.source()
        self.assertEqual(rows,self.rows)
        self.assertEqual(set(namespaces),set(self.names))
        self.assertEqual(len(proof),64)

    def test_source_member_and_neighbor_denials(self):
        original = copy.deepcopy((self.rows,self.admissions))
        for fault in ('extra','missing','hash','size','mode','mtime','owner','attrs','link','namespace','unmanaged','coverage'):
            self.rows,self.admissions = copy.deepcopy(original)
            self.observed_coverage = copy.deepcopy(self.old['coverage'])
            member = self.rows['native/'+self.names[0]+'/content/tool']
            if fault=='extra':self.rows['saved-user-file']=self.directory()
            elif fault=='missing':del self.rows['native/'+self.names[0]+'/content/tool']
            elif fault=='hash':member['sha256']='e'*64
            elif fault=='size':member['size']=21
            elif fault=='mode':member['mode']=0o644
            elif fault=='mtime':member['mtime_ns']+=1
            elif fault=='owner':member['uid']=998
            elif fault=='attrs':member['xattrs']={'user.saved':'eA=='}
            elif fault=='link':self.rows['native/'+self.names[0]+'/node_modules/openclaw']['target']='/other'
            elif fault=='namespace':self.admissions={}
            elif fault=='unmanaged':next(iter(self.admissions.values()))['original']['managed']=False
            elif fault=='coverage':self.observed_coverage=self.observed_coverage[:2]+('e'*64,)
            with self.subTest(fault=fault), self.assertRaises(RuntimeError):self.source()

    def test_whole_absence_then_idempotent_absence(self):
        result=self.transition(None)
        self.assertEqual(result['remaining'],[])
        self.assertIsNone(result['after'])
        row={'source':self.old,'liveBefore':None,'carry':result}
        second=self.transition(None,row,window=(300,310))
        self.assertEqual(second['firstWindow'],(100,110))
        self.assertEqual(second['remaining'],[])

    def test_partial_then_whole_absence(self):
        result=self.transition({self.names[0]})
        self.assertEqual(result['remaining'],[self.names[0]])
        row={'source':self.old,'liveBefore':result['after'],'carry':result}
        second=self.transition(None,row,window=(300,310))
        self.assertEqual(second['remaining'],[])
        self.assertEqual(second['sourceAdmissionsSha256'],self.source_hash)

    def test_partial_and_absent_resurrection_refused(self):
        for remaining in ([self.names[0]],[]):
            result=self.transition(set(remaining) if remaining else None)
            row={'source':self.old,'liveBefore':result['after'],'carry':result}
            with self.subTest(remaining=remaining), self.assertRaises(RuntimeError):
                self.transition(set(self.names),row,window=(300,310))

    def test_carried_partial_can_stay_exact(self):
        result=self.transition({self.names[0]})
        row={'source':self.old,'liveBefore':result['after'],'carry':result}
        def retain_metadata(current,rows):
            rows['native']['mtime_ns']=200*10**9+1
        again=self.transition({self.names[0]},row,window=(300,310),corrupt=retain_metadata)
        self.assertEqual(again['remaining'],[self.names[0]])
        self.assertEqual(again['after'],result['after'])

    def test_history_and_source_authority_denials(self):
        for fault in ('missing','wrong-source','wrong-before','future-first','noninteger-clock','wrong-members',
                      'duplicates','forged-hash','hot-owner','inconsistent-absence'):
            row=copy.deepcopy(self.row)
            if fault=='missing':row['carry']=None
            elif fault=='wrong-source':row['carry']['source']={'wrong':True}
            elif fault=='wrong-before':row['carry']['after']={}
            elif fault=='future-first':row['carry']['firstWindow']=(300,310)
            elif fault=='noninteger-clock':row['carry']['firstWindow']=(100.0,110)
            elif fault=='wrong-members':row['carry']['remaining']=['admission-Wrong1']
            elif fault=='duplicates':row['carry']['remaining']=[self.names[0],self.names[0]]
            elif fault=='forged-hash':
                row['carry']['remaining']=list(self.names);row['carry']['sourceAdmissionsSha256']='f'*64
            elif fault=='hot-owner':
                row['liveBefore']['journal']=(1,2);row['carry']['after']=row['liveBefore']
            elif fault=='inconsistent-absence':
                row['carry']['remaining']=[];row['carry']['sourceAdmissionsSha256']=self.source_hash
            with self.subTest(fault=fault), self.assertRaises(RuntimeError):self.transition(None,row)

    def test_surviving_member_and_metadata_denials(self):
        for fault in ('bytes','mode','neighbor','partial-file','owner','idle-time','container','still-referenced'):
            self.namespaces = {pathlib.Path(k).name:copy.deepcopy(v) for k,v in self.admissions.items()}
            if fault=='still-referenced':
                self.namespaces[self.names[1]]['current']=str(self.root/'native'/self.names[1])
            def corrupt(current,rows):
                member=rows['native/'+self.names[0]+'/content/tool']
                if fault=='bytes':member['sha256']='e'*64
                elif fault=='mode':member['mode']=0o644
                elif fault=='neighbor':rows['native/'+self.names[0]+'/unknown']=self.directory()
                elif fault=='partial-file':del rows['native/'+self.names[0]+'/content/tool']
                elif fault=='owner':current['owner']=(2,999,*current['owner'][2:])
                elif fault=='idle-time':rows['native']['mtime_ns']=150*10**9
                elif fault=='container':rows['native']['mode']=0o755
            with self.subTest(fault=fault), self.assertRaises(RuntimeError):
                self.transition({self.names[0]},corrupt=corrupt)

class ExistingAdmissionGateTests(unittest.TestCase):
    def test_normal_catalog_emits_only_complete_qualified_mapping(self):
        case=CopiedCodexAdmissionsTests()
        case.setUp()
        try:
            proofs={}
            recovery.retained_catalog_files([copy.deepcopy(case.old),copy.deepcopy(case.new)],
                workspace_roots=case.roots,engine_version='2026.9.8',startup_window=case.window,capture_proofs=proofs)
            self.assertEqual(set(proofs),{str(case.live/case.old_capture)})
            self.assertEqual(next(iter(proofs.values()))['current'],str(case.live/case.new_capture))
            invalid=copy.deepcopy(case.new)
            receipt=next(iter(invalid['plugins'][0]['sourceAdmissions'].values()))
            next(iter(receipt['nativeNamespaces'].values()))['members']['bin/tool']['contentHash']='f'*64
            denied={}
            with self.assertRaises(RuntimeError):
                recovery.retained_catalog_files([copy.deepcopy(case.old),invalid],workspace_roots=case.roots,
                    engine_version='2026.9.8',startup_window=case.window,capture_proofs=denied)
            self.assertEqual(denied,{})
        finally:
            case.tearDown()

if __name__ == '__main__': unittest.main()
