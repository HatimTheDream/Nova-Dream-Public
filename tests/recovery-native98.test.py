"""Offline, synthetic saved-content qualification for the exact 9.6→9.8 pair."""
import contextlib
from collections import Counter
import hashlib
import json
import pathlib
import shutil
import sqlite3
import sys
import tempfile
import unittest

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


if __name__ == '__main__': unittest.main()
