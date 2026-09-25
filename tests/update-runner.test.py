"""Synthetic runner checks. No host service, credentials or old helpers run.

Linux adds real rsync/cp metadata and independent-inode coverage. Other systems
exercise bounded admission, saved SQLite data, receipt and orchestration rules.
"""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'deploy' / 'update-runner'))
if sys.platform != 'linux':
    sys.modules['fcntl'] = types.SimpleNamespace()
import recovery
spec = importlib.util.spec_from_file_location('update_driver', ROOT / 'deploy' / 'update-runner' / 'install.py')
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


def fixture_database(path, schema=55):
    path.parent.mkdir(parents=True, exist_ok=True)
    with contextlib.closing(sqlite3.connect(path)) as connection, connection:
        connection.executescript('''
            create table entities(id text primary key, revision integer, payload blob);
            create table history(cursor integer primary key);
            create table blobs(id text primary key, payload blob);
            create table blob_refs(entity_id text, blob_id text);
            create table service_records(id text primary key);
            create table receipts(id text primary key,payload blob);
            create table meta(key text primary key,value blob);
            insert into meta values('epoch','96b84a4e-172a-4481-8038-74663d28a6fc');
            insert into entities values('saved',1,x'010203');
            insert into history values(1);
            insert into blobs values('attachment',x'040506');
            insert into blob_refs values('saved','attachment');
            insert into service_records values('receipt');
        ''')
        connection.execute('pragma user_version=' + str(schema))
    (path.parent / 'workspace.identity').write_bytes(b'synthetic identity')
    (path.parent / 'workspace-key.json').write_bytes(b'synthetic key only')
    (path.parent / 'edition3.identity').write_bytes(b'private.novadream.edition3.preview\n')


def fixture_native(root):
    fixture_database(root / 'workspace.sqlite')
    native = root / 'openclaw-runtime'
    native.mkdir()
    (native / 'edition3-runtime.identity').write_bytes(b'edition3-owned-gateway\n')


def fixture_embedded_databases(root):
    fixture_native(root)
    native = root / 'openclaw-runtime'
    agent = native / 'state' / 'agents' / 'main' / 'agent'
    agent.mkdir(parents=True)
    with contextlib.closing(sqlite3.connect(agent / 'openclaw-agent.sqlite')) as connection:
        connection.executescript('pragma user_version=19; create table session_nodes(id text primary key,entry_json text);')
    paths = {}
    for name, (version, tables) in recovery.EMBEDDED_DATABASES.items():
        path = native / 'assignment-receipts' / name if name == 'receipts.sqlite' else agent / 'codex-home' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with contextlib.closing(sqlite3.connect(path)) as connection, connection:
            connection.execute('pragma user_version=' + str(version))
            for table, columns in tables.items():
                connection.execute('create table "' + table + '" (' + ','.join('"' + column + '" blob' for column in columns.split()) + ')')
            if '_sqlx_migrations' in tables:
                connection.execute("insert into _sqlx_migrations values(1,'retained migration',1,1,x'010203',5)")
        paths[name] = path.relative_to(root)
    with contextlib.closing(sqlite3.connect(root / paths['state_5.sqlite'])) as connection, connection:
        connection.execute("insert into threads(id,title,first_user_message) values('thread','Saved title','Exact original writing — café')")
    with contextlib.closing(sqlite3.connect(root / paths['receipts.sqlite'])) as connection, connection:
        connection.executescript("insert into identity values('local','original-host');insert into receipts values('attempt','epoch',x'010203');insert into outcomes values('attempt',3,x'040506');")
    with contextlib.closing(sqlite3.connect(root / paths['logs_2.sqlite'])) as connection, connection:
        connection.execute("insert into logs(id,feedback_log_body) values(1,'Retained log')")
    return paths


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nova-update-runner-fixture-')
        self.root = pathlib.Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def test_capacity_counts_candidate_snapshot_restore_reserve_and_rejects_shared_live_inode(self):
        entry = {'kind': 'file', 'size': 100, 'sha256': 'a', 'mode': 0o600}
        source = {'file': entry}
        inodes = {'file': {'device': 1, 'inode': 1, 'allocated': 4096}}
        old = {'file': {**entry, 'sha256': 'b'}}
        old_inodes = {'file': {'device': 1, 'inode': 2, 'allocated': 4096}}
        minimum = recovery.RESERVE + 2 * recovery.ALLOWANCE + 4096 + 4096 + 512
        self.assertEqual(recovery.capacity(source, inodes, old, old_inodes, minimum, 512)['requiredFreeBytes'], minimum)
        with self.assertRaises(recovery.InsufficientStorage):
            recovery.capacity(source, inodes, old, old_inodes, minimum - 1, 512)
        with self.assertRaises(RuntimeError):
            recovery.capacity(source, inodes, old, inodes, minimum, 512)

    def test_saved_sqlite_records_blobs_schemas_and_keys_survive(self):
        before, live = self.root / 'snapshot', self.root / 'live'
        fixture_database(before / 'workspace.sqlite')
        fixture_database(before / 'dormant' / 'workspace.sqlite', 53)
        shutil.copytree(before, live)
        self.assertEqual(len(recovery.saved_state(before, live, restored=True)), 2)
        with contextlib.closing(sqlite3.connect(live / 'workspace.sqlite')) as connection, connection:
            connection.execute("update entities set revision=2,payload=x'070809'")
            connection.execute('insert into history values(2)')
        with self.assertRaises(RuntimeError):
            recovery.saved_state(before, live)
        with contextlib.closing(sqlite3.connect(live / 'workspace.sqlite')) as connection, connection:
            connection.execute("update entities set revision=1,payload=x'010203'")
            connection.execute('delete from history where cursor=2')
        with contextlib.closing(sqlite3.connect(live / 'dormant' / 'workspace.sqlite')) as connection, connection:
            connection.execute('pragma user_version=55')
        with self.assertRaises(RuntimeError):
            recovery.saved_state(before, live)
        with self.assertRaises(RuntimeError):
            recovery.saved_state(before, live, restored=True)
        with contextlib.closing(sqlite3.connect(live / 'workspace.sqlite')) as connection, connection:
            connection.execute("update blobs set payload=x'00'")
        with self.assertRaises(RuntimeError):
            recovery.saved_state(before, live)

    def retained_wal_database(self):
        source, snapshot = self.root / 'source.sqlite', self.root / 'snapshot' / 'retained.sqlite'
        snapshot.parent.mkdir()
        with contextlib.closing(sqlite3.connect(source)) as writer:
            writer.execute('pragma journal_mode=WAL')
            writer.execute('pragma wal_autocheckpoint=0')
            writer.execute('create table retained(value text)')
            writer.execute("insert into retained values('committed only in WAL')")
            writer.commit()
            for suffix in ('', '-wal', '-shm'):
                shutil.copyfile(pathlib.Path(str(source) + suffix), pathlib.Path(str(snapshot) + suffix))
        return snapshot

    def test_closed_sqlite_reads_committed_wal_without_changing_retained_files(self):
        snapshot = self.retained_wal_database()
        expected = recovery.sqlite_source_identity(snapshot)
        self.assertGreater(pathlib.Path(str(snapshot) + '-wal').stat().st_size, 0)
        with contextlib.closing(recovery.database(snapshot, True)) as connection:
            scratch = connection.database_path.parent
            self.assertEqual(connection.execute('select value from retained').fetchall(), [('committed only in WAL',)])
            self.assertEqual(connection.execute('pragma quick_check').fetchone()[0], 'ok')
            with self.assertRaises(sqlite3.OperationalError):
                connection.execute("insert into retained values('forbidden')")
            self.assertEqual(recovery.sqlite_source_identity(snapshot), expected)
        self.assertFalse(scratch.exists())
        self.assertEqual(recovery.sqlite_source_identity(snapshot), expected)

    def test_closed_sqlite_rejects_changed_evidence_and_cleans_private_copy(self):
        snapshot = self.retained_wal_database()
        connection = recovery.database(snapshot, True)
        scratch = connection.database_path.parent
        self.assertEqual(connection.execute('select count(*) from retained').fetchone()[0], 1)
        with pathlib.Path(str(snapshot) + '-wal').open('ab') as changed:
            changed.write(b'changed after copy')
        with self.assertRaisesRegex(RuntimeError, 'evidence changed during verification'):
            connection.close()
        self.assertFalse(scratch.exists())

    def test_closed_sqlite_rejects_truncated_or_corrupt_committed_wal(self):
        snapshot = self.retained_wal_database()
        wal = pathlib.Path(str(snapshot) + '-wal')
        original = wal.read_bytes()
        corrupted = bytearray(original)
        corrupted[-1] ^= 1
        page_size = int.from_bytes(original[8:12], 'big')
        for changed in (original[:-1], original[:-(page_size + 24)], corrupted):
            with self.subTest(size=len(changed)):
                wal.write_bytes(changed)
                with self.assertRaisesRegex(RuntimeError, 'WAL'):
                    recovery.database(snapshot, True)
        wal.write_bytes(original)
        pathlib.Path(str(snapshot) + '-shm').unlink()
        with contextlib.closing(recovery.database(snapshot, True)) as connection:
            self.assertEqual(connection.execute('select value from retained').fetchall(), [('committed only in WAL',)])

    def test_closed_uncheckpointed_journal_and_missing_saved_history_fail(self):
        before, live = self.root / 'snapshot', self.root / 'live'
        fixture_database(before / 'workspace.sqlite')
        shutil.copytree(before, live)
        journal = before / 'workspace.sqlite-wal'
        journal.write_bytes(b'not checkpointed')
        with self.assertRaises(RuntimeError):
            recovery.saved_state(before, live)
        journal.unlink()
        with contextlib.closing(sqlite3.connect(live / 'workspace.sqlite')) as connection, connection:
            connection.execute('delete from history')
        with self.assertRaises(RuntimeError):
            recovery.saved_state(before, live)

    def test_domain_service_records_stay_exact_while_owned_transport_receipts_can_change(self):
        before, live = self.root / 'snapshot', self.root / 'live'
        fixture_database(before / 'workspace.sqlite')
        with contextlib.closing(sqlite3.connect(before / 'workspace.sqlite')) as connection, connection:
            connection.execute('drop table service_records')
            connection.execute('create table service_records(id text primary key, revision integer, payload blob)')
            connection.executemany('insert into service_records values(?,1,?)', [('accounts:item:saved', b'account bytes'), ('gateway:device-token:fixture-generation', b'token'), ('update:native-lease:job', b'lease')])
        shutil.copytree(before, live)
        with contextlib.closing(sqlite3.connect(live / 'workspace.sqlite')) as connection, connection:
            connection.execute("update service_records set revision=2,payload=x'00' where id like 'gateway:%' or id like 'update:native-lease:%'")
        recovery.saved_state(before, live)
        with contextlib.closing(sqlite3.connect(live / 'workspace.sqlite')) as connection, connection:
            connection.execute("update service_records set revision=2,payload=x'00' where id like 'accounts:%'")
        with self.assertRaises(RuntimeError):
            recovery.saved_state(before, live)

    def test_native_sqlite_messages_and_session_payloads_cannot_be_rewritten(self):
        before, live = self.root / 'snapshot', self.root / 'live'
        fixture_native(before)
        relative = pathlib.Path('openclaw-runtime/state/agents/main/agent/openclaw-agent.sqlite')
        old = before / relative
        old.parent.mkdir(parents=True)
        with contextlib.closing(sqlite3.connect(old)) as connection, connection:
            connection.executescript("pragma user_version=19; create table session_nodes(id text primary key,entry_json text); insert into session_nodes values('session','saved context'); create table transcript_events(id text primary key,payload blob); insert into transcript_events values('message',x'010203');")
        shutil.copytree(before, live)
        recovery.native_saved_state(before, live)
        with contextlib.closing(sqlite3.connect(live / relative)) as connection, connection:
            connection.execute("update transcript_events set payload=x'00'")
        with self.assertRaises(RuntimeError):
            recovery.native_saved_state(before, live)

    def test_native_explicit_coverage_preserves_project_content_and_rejects_unknown_tables_before_stop(self):
        before, live = self.root / 'snapshot', self.root / 'live'
        fixture_native(before)
        relative = pathlib.Path('openclaw-runtime/state/state/openclaw.sqlite')
        old = before / relative
        old.parent.mkdir(parents=True)
        with contextlib.closing(sqlite3.connect(old)) as connection, connection:
            connection.executescript("pragma user_version=15; create table projects(id text primary key,payload text); insert into projects values('saved','original'); create table state_leases(id text primary key,pid integer); insert into state_leases values('lease',1);")
        shutil.copytree(before, live)
        with contextlib.closing(sqlite3.connect(live / relative)) as connection, connection:
            connection.execute('update state_leases set pid=2')
        recovery.native_preflight(live)
        recovery.native_saved_state(before, live)
        with contextlib.closing(sqlite3.connect(live / relative)) as connection, connection:
            connection.execute("update projects set payload='changed'")
        with self.assertRaises(RuntimeError):
            recovery.native_saved_state(before, live)
        with contextlib.closing(sqlite3.connect(live / relative)) as connection, connection:
            connection.execute('create table unreviewed_work(id text primary key)')
        with self.assertRaises(RuntimeError):
            recovery.native_preflight(live)

    def test_native_reconnect_metadata_does_not_allow_account_or_scope_rewrites(self):
        before, live = self.root / 'snapshot', self.root / 'live'
        fixture_native(before)
        relative = pathlib.Path('openclaw-runtime/state/state/openclaw.sqlite')
        old = before / relative
        old.parent.mkdir(parents=True)
        tokens = {'operator': {'role': 'operator', 'token': 'synthetic', 'scopes': ['read'], 'lastUsedAtMs': 1, 'unknownField': 'preserved'}}
        with contextlib.closing(sqlite3.connect(old)) as connection, connection:
            connection.executescript("pragma user_version=15; create table device_pairing_paired(id text primary key,scopes_json text,tokens_json text,last_seen_at_ms integer,last_seen_reason text,remote_ip text);")
            connection.execute("insert into device_pairing_paired values('device','read',?,1,'connect','127.0.0.1')", (json.dumps(tokens),))
        shutil.copytree(before, live)
        tokens['operator']['lastUsedAtMs'] = 2
        with contextlib.closing(sqlite3.connect(live / relative)) as connection, connection:
            connection.execute("update device_pairing_paired set last_seen_at_ms=2,last_seen_reason='device-token-auth',tokens_json=?", (json.dumps(tokens),))
        recovery.native_saved_state(before, live)
        tokens['operator']['unknownField'] = 'changed'
        with contextlib.closing(sqlite3.connect(live / relative)) as connection, connection:
            connection.execute("update device_pairing_paired set tokens_json=?", (json.dumps(tokens),))
        with self.assertRaises(RuntimeError):
            recovery.native_saved_state(before, live)
        tokens['operator']['unknownField'] = 'preserved'
        with contextlib.closing(sqlite3.connect(live / relative)) as connection, connection:
            connection.execute("update device_pairing_paired set scopes_json='write',tokens_json=?", (json.dumps(tokens),))
        with self.assertRaises(RuntimeError):
            recovery.native_saved_state(before, live)

    def test_native_selection_binds_actual_workspace_epoch_and_preserves_inactive_database_bytes(self):
        before, live = self.root / 'snapshot', self.root / 'live'
        fixture_native(before)
        recovery_id = 'bb1be57f-a0e3-4c40-b630-e187a3182b2c'
        selected = before / 'recovered-workspaces' / recovery_id
        fixture_native(selected)
        (before / 'workspace-selection.json').write_text(json.dumps({'format': 1, 'recoveryId': recovery_id}))
        (selected / 'recovery-complete.json').write_text(json.dumps({'jobId': recovery_id, 'sourceHash': 'c' * 64}))
        inactive = before / 'openclaw-runtime' / 'fixture.sqlite'
        inactive.write_bytes(b'unreadable archive fixture; preserve exact bytes')
        current = selected / 'openclaw-runtime/state/state/openclaw.sqlite'
        current.parent.mkdir(parents=True)
        with contextlib.closing(sqlite3.connect(current)) as connection, connection:
            connection.executescript('pragma user_version=15; create table user_profiles(id text primary key,name text);')
        epoch = '96b84a4e-172a-4481-8038-74663d28a6fc'
        actual_selected, actual_epoch, paths = recovery.native_preflight(before, epoch)
        self.assertEqual(actual_selected, selected.relative_to(before))
        self.assertEqual(actual_epoch, epoch)
        self.assertEqual(paths, {current.relative_to(before)})
        with self.assertRaises(RuntimeError):
            recovery.native_preflight(before, recovery_id)
        shutil.copytree(before, live)
        recovery.native_saved_state(before, live, epoch)
        (live / inactive.relative_to(before)).write_bytes(b'changed inactive content')
        with self.assertRaises(RuntimeError):
            recovery.native_saved_state(before, live, epoch)

    def test_active_embedded_databases_keep_complete_rows_and_allow_only_appended_logs(self):
        before, live = self.root / 'snapshot', self.root / 'live'
        paths = fixture_embedded_databases(before)
        shutil.copytree(before, live)
        with contextlib.closing(sqlite3.connect(live / paths['goals_1.sqlite'])) as connection:
            connection.executescript('pragma page_size=8192; vacuum;')
        self.assertNotEqual(recovery.digest(before / paths['goals_1.sqlite']), recovery.digest(live / paths['goals_1.sqlite']))
        with contextlib.closing(sqlite3.connect(live / paths['logs_2.sqlite'])) as connection, connection:
            connection.execute("insert into logs(id,feedback_log_body) values(2,'New boot log')")
        recovery.native_preflight(live)
        recovery.native_saved_state(before, live)
        mutations = [
            ('logs_2.sqlite', "update logs set feedback_log_body='Rewritten history' where id=1"),
            ('logs_2.sqlite', 'delete from logs where id=1'),
            ('state_5.sqlite', "update threads set first_user_message='Changed writing'"),
            ('state_5.sqlite', "insert into threads(id,title) values('extra','Unadmitted thread')"),
            ('receipts.sqlite', "update receipts set payload=x'ff'"),
            ('queue_1.sqlite', "insert into queued_items(id,payload_json) values('new','{}')"),
            ('memories_1.sqlite', "insert into stage1_outputs(thread_id,raw_memory) values('new','Changed memory')"),
            ('goals_1.sqlite', "insert into thread_goals(thread_id,objective) values('new','Changed goal')"),
            ('logs_2.sqlite', "update _sqlx_migrations set checksum=x'ff'"),
        ]
        for name, sql in mutations:
            with self.subTest(database=name, mutation=sql):
                with contextlib.closing(sqlite3.connect(live / paths[name])) as connection:
                    connection.execute('begin')
                    connection.execute(sql)
                    connection.commit()
                with self.assertRaisesRegex(RuntimeError, 'Retained embedded'):
                    recovery.native_saved_state(before, live)
                shutil.copyfile(before / paths[name], live / paths[name])

    def test_embedded_schema_and_location_changes_never_expand_the_static_exclusion(self):
        before, live = self.root / 'snapshot', self.root / 'live'
        paths = fixture_embedded_databases(before)
        extra = before / paths['state_5.sqlite'].parent / 'state_6.sqlite'
        extra.write_bytes(b'Unreviewed static store')
        archive = before / 'openclaw-runtime' / 'archive' / 'logs_2.sqlite'
        archive.parent.mkdir(); archive.write_bytes(b'Closed archive stays exact')
        shutil.copytree(before, live)
        for relative in (extra.relative_to(before), archive.relative_to(before)):
            with self.subTest(relative=str(relative)):
                (live / relative).write_bytes(b'Changed static bytes')
                with self.assertRaisesRegex(RuntimeError, 'inactive database'):
                    recovery.native_saved_state(before, live)
                shutil.copyfile(before / relative, live / relative)
        for sql in ('create table unreviewed(id text)', 'alter table threads add column unknown text', 'pragma user_version=1'):
            with self.subTest(schema=sql):
                with contextlib.closing(sqlite3.connect(live / paths['state_5.sqlite'])) as connection:
                    connection.executescript(sql)
                with self.assertRaises(RuntimeError):
                    recovery.native_preflight(live)
                with self.assertRaises(RuntimeError):
                    recovery.native_saved_state(before, live)
                shutil.copyfile(before / paths['state_5.sqlite'], live / paths['state_5.sqlite'])
        (live / paths['goals_1.sqlite']).unlink()
        with self.assertRaisesRegex(RuntimeError, 'embedded database set changed'):
            recovery.native_saved_state(before, live)

    def test_reviewed_codex_migrations_keep_nonempty_attachments_and_every_saved_column(self):
        before, live = self.root / 'before', self.root / 'live'
        paths = fixture_embedded_databases(before)
        with contextlib.closing(sqlite3.connect(before / paths['state_5.sqlite'])) as connection, connection:
            connection.execute('create index idx_thread_artifacts_thread_created_id on thread_artifacts(thread_id,created_at,id)')
            connection.execute("insert into thread_artifacts values('attachment','thread','file','identity','Exact saved attachment',123)")
        shutil.copytree(before, live)
        active = recovery.native_scope(before)[2]
        recovery.retained_embedded_databases(before, live, pathlib.Path('.'), active, '2026.9.2', '2026.9.6')
        recovery.retained_embedded_databases(before, live, pathlib.Path('.'), active, '2026.9.6', '2026.9.6')
        for name, migrations in recovery.CODEX_SQL_MIGRATIONS.items():
            with contextlib.closing(sqlite3.connect(live / paths[name])) as connection, connection:
                for version, description, checksum, sql in migrations:
                    connection.executescript(sql)
                    connection.execute('insert into _sqlx_migrations values(?,?,?,?,?,?)',
                                       (version, description, '2026-09-25T00:00:00Z', 1, bytes.fromhex(checksum), 123))
        args = (before, live, pathlib.Path('.'), active, '2026.9.2', '2026.9.6')
        recovery.retained_embedded_databases(*args)
        with self.assertRaises(RuntimeError):
            recovery.retained_embedded_databases(before, live, pathlib.Path('.'), active, '2026.9.6', '2026.9.6')
        future = self.root / 'future';shutil.copytree(live, future)
        recovery.retained_embedded_databases(live, future, pathlib.Path('.'), active, '2026.9.6', '2026.9.6')
        with contextlib.closing(sqlite3.connect(live / paths['state_5.sqlite'])) as connection:
            recovery.embedded_schema(connection, 'state_5.sqlite', '2026.9.6')
            with self.assertRaises(RuntimeError):recovery.embedded_schema(connection, 'state_5.sqlite', '2026.9.2')
        cases = [
            ('state_5.sqlite', "update threads set title='Changed writing'"),
            ('state_5.sqlite', "update thread_attachments set payload='Changed attachment'"),
            ('state_5.sqlite', "delete from thread_attachments"),
            ('state_5.sqlite', "update threads set originator='unreviewed'"),
            ('state_5.sqlite', "update threads set daybreak_enabled=1"),
            ('state_5.sqlite', "update _sqlx_migrations set checksum=x'ff' where version=55"),
            ('state_5.sqlite', "create table unreviewed(id text)"),
            ('memories_1.sqlite', "update consolidation_progress set max_thread_count=1"),
        ]
        for name, statement in cases:
            with self.subTest(database=name, statement=statement):
                with contextlib.closing(sqlite3.connect(live / paths[name])) as connection, connection:
                    connection.execute(statement)
                with self.assertRaises(RuntimeError):recovery.retained_embedded_databases(*args)
                shutil.copyfile(future / paths[name], live / paths[name])
        with contextlib.closing(sqlite3.connect(future / paths['state_5.sqlite'])) as connection, connection:
            connection.execute("update threads set originator='changed after install'")
        with self.assertRaises(RuntimeError):
            recovery.retained_embedded_databases(live, future, pathlib.Path('.'), active, '2026.9.6', '2026.9.6')

    def test_quarantine_cache_never_changes_quarantine_decisions_or_admits_other_paths(self):
        before, live = self.root / 'before', self.root / 'live'
        before.mkdir();live.mkdir()
        agent = pathlib.Path('openclaw-runtime/state/agents/main/agent/openclaw-agent.sqlite')
        path = live / 'openclaw-runtime/state/state/openclaw-quarantine.sqlite';path.parent.mkdir(parents=True)
        schema = '''pragma user_version=2;
            CREATE TABLE quarantined_databases (path TEXT NOT NULL PRIMARY KEY,kind TEXT NOT NULL,reason TEXT NOT NULL,quarantined_at INTEGER NOT NULL,writer_app_version TEXT,verified_generation TEXT) STRICT;
            CREATE TABLE agent_integrity_verifications (path TEXT NOT NULL PRIMARY KEY,dev TEXT NOT NULL,ino TEXT NOT NULL,app_version TEXT NOT NULL,verified_at INTEGER NOT NULL,clean_close INTEGER NOT NULL CHECK (clean_close IN (0, 1))) STRICT;'''
        # Match the pinned writer's whitespace; constraints/types are otherwise
        # validated by the production schema comparison, not just column names.
        schema = schema.replace('(path', '( path').replace('verified_generation TEXT)', 'verified_generation TEXT )').replace('(0, 1)))', '(0, 1)) )').replace(',', ', ')
        with contextlib.closing(sqlite3.connect(path)) as db, db:
            db.executescript(schema)
            db.execute('insert into agent_integrity_verifications values(?,?,?,?,?,?)', (str(live / agent), '1', '2', '2026.9.6', 123, 0))
        args = (before, live, pathlib.Path('.'), {agent}, '2026.9.2', '2026.9.6')
        self.assertEqual(recovery.retained_quarantine_cache(*args), {path.relative_to(live)})
        old = before / path.relative_to(live);old.parent.mkdir(parents=True);shutil.copyfile(path, old)
        with contextlib.closing(sqlite3.connect(path)) as db, db:
            db.execute('update agent_integrity_verifications set verified_at=124,clean_close=1')
        recovery.retained_quarantine_cache(before, live, pathlib.Path('.'), {agent}, '2026.9.6', '2026.9.6')
        for statement, restore in [
            ("insert into quarantined_databases values('/saved','agent','corrupt',1,'2026.9.6',null)", 'delete from quarantined_databases'),
            ("update agent_integrity_verifications set path='/unrelated'", "update agent_integrity_verifications set path=" + "'" + str(live / agent).replace("'", "''") + "'")]:
            with contextlib.closing(sqlite3.connect(path)) as db, db:db.execute(statement)
            with self.assertRaises(RuntimeError):recovery.retained_quarantine_cache(*args)
            with contextlib.closing(sqlite3.connect(path)) as db, db:db.execute(restore)

    def test_embedded_closed_wal_is_read_from_a_copy_and_live_sidecars_are_qualified_logically(self):
        source, before, live = self.root / 'source', self.root / 'snapshot', self.root / 'live'
        paths = fixture_embedded_databases(source)
        with contextlib.closing(sqlite3.connect(source / paths['logs_2.sqlite'])) as writer:
            writer.executescript("pragma journal_mode=wal;pragma wal_autocheckpoint=0;insert into logs(id,feedback_log_body) values(2,'Committed retained WAL log');")
            shutil.copytree(source, before)
        shutil.copytree(before, live)
        original = {str(path.relative_to(before)): path.read_bytes() for path in before.rglob('*.sqlite*')}
        with contextlib.closing(sqlite3.connect(live / paths['logs_2.sqlite'])) as writer:
            writer.executescript("pragma wal_autocheckpoint=0;insert into logs(id,feedback_log_body) values(3,'New live WAL log');")
            recovery.native_saved_state(before, live)
        self.assertEqual(original, {str(path.relative_to(before)): path.read_bytes() for path in before.rglob('*.sqlite*')})

    def test_native_boot_metadata_keeps_primary_schema_accounts_and_actual_config_exact(self):
        before, live = self.root / 'snapshot', self.root / 'live'
        fixture_native(before)
        relative = pathlib.Path('openclaw-runtime/state/state/openclaw.sqlite')
        (before / relative).parent.mkdir(parents=True)
        config_relative = pathlib.Path('openclaw-runtime/openclaw.json')
        config = {'browser': {'extraArgs': ['--proxy-server=http://127.0.0.1:12345', '--disable-quic']},
                  'plugins': {'entries': {'edition3-workspace': {'config': {'token': 'a' * 64, 'authority': 'retained'}}}},
                  'tools': {'web': {'search': {'provider': 'retained', 'apiKey': 'synthetic-original'}}}}
        (before / config_relative).write_text(json.dumps(config))
        fingerprint = '\n'.join(['2026.9.2', '3', '2026-09-05T15:22:41.651Z', 'a' * 43, 'b' * 43, 'c' * 64])
        observation = {'hash': recovery.digest(before / config_relative), 'bytes': (before / config_relative).stat().st_size, 'ctimeMs': 1, 'mtimeMs': 1, 'ino': '1',
                       'observedAt': '2026-01-01T00:00:00Z', 'mode': 0o600, 'gatewayMode': 'local', 'permissions': 'retained', 'unknownField': {'keep': True}}
        with contextlib.closing(sqlite3.connect(before / relative)) as connection, connection:
            connection.executescript('''pragma user_version=15;
                create table schema_meta(meta_key text primary key,role text,schema_version integer,app_version text,created_at integer,updated_at integer);
                create table config_health_entries(config_path text primary key,last_known_good_json text,last_promoted_good_json text,last_observed_suspicious_signature text,updated_at_ms integer);
                create table user_profiles(id text primary key,name text);
                insert into schema_meta values('primary','global',15,'2026.9.2',1,1);
                insert into user_profiles values('original-account','retained');''')
            connection.executemany('insert into schema_meta values(?,\'global\',3,?,1,1)', [(key, fingerprint) for key in ('startup-migrations', 'state-migrations')])
            connection.execute('insert into config_health_entries values(?,?,?,null,1)', (str(live / config_relative), json.dumps(observation), json.dumps(observation)))
        shutil.copytree(before, live)
        config['browser']['extraArgs'][0] = '--proxy-server=http://127.0.0.1:4321'
        config['plugins']['entries']['edition3-workspace']['config']['token'] = 'd' * 64
        (live / config_relative).write_text(json.dumps(config))
        updated = {**observation, 'hash': recovery.digest(live / config_relative), 'bytes': (live / config_relative).stat().st_size, 'ctimeMs': 2, 'mtimeMs': 2, 'ino': '2', 'observedAt': '2026-01-02T00:00:00Z'}
        self.assertNotEqual(observation['bytes'], updated['bytes'], 'The permitted proxy port changes the exact config byte count.')
        current_fingerprint = '\n'.join(fingerprint.split('\n')[:3] + ['d' * 43, 'e' * 43, 'f' * 64])
        with contextlib.closing(sqlite3.connect(live / relative)) as connection, connection:
            connection.execute("update schema_meta set app_version=?,updated_at=2 where meta_key in ('startup-migrations','state-migrations')", (current_fingerprint,))
            connection.execute('update config_health_entries set last_known_good_json=?,last_promoted_good_json=?,updated_at_ms=2', (json.dumps(updated), json.dumps(updated)))
        recovery.native_saved_state(before, live)
        good_db, good_config = (live / relative).read_bytes(), (live / config_relative).read_bytes()
        for sql, args in [
            ("update schema_meta set app_version='different' where meta_key='primary'", ()),
            ("update schema_meta set app_version=? where meta_key='startup-migrations'", (current_fingerprint.replace('2026.9.2', '2026.9.6'),)),
            ("update schema_meta set role='other-owner' where meta_key='state-migrations'", ()),
            ("update user_profiles set name='changed account'", ()),
            ('update config_health_entries set last_known_good_json=?', (json.dumps({**updated, 'hash': '0' * 64}),)),
            ('update config_health_entries set last_known_good_json=?', (json.dumps({**updated, 'bytes': updated['bytes'] + 1}),)),
            ('update config_health_entries set last_known_good_json=?', (json.dumps({**updated, 'bytes': True}),)),
            ('update config_health_entries set last_known_good_json=?', (json.dumps({**updated, 'mode': 0o644}),)),
            ('update config_health_entries set last_known_good_json=?', (json.dumps({**updated, 'gatewayMode': 'remote'}),)),
            ('update config_health_entries set last_known_good_json=?', (json.dumps({**updated, 'unknownField': {'keep': False}}),)),
            ("update config_health_entries set last_observed_suspicious_signature='changed'", ()),
        ]:
            with self.subTest(sql=sql):
                with contextlib.closing(sqlite3.connect(live / relative)) as connection, connection:
                    connection.execute(sql, args)
                with self.assertRaises(RuntimeError):
                    recovery.native_saved_state(before, live)
                (live / relative).write_bytes(good_db)
        for mutate in (
            lambda value: value['tools']['web']['search'].update(apiKey='different credential'),
            lambda value: value['browser']['extraArgs'].__setitem__(0, '--proxy-server=http://outside.example:54321'),
            lambda value: value['browser']['extraArgs'].pop(),
            lambda value: value['plugins']['entries']['edition3-workspace']['config'].update(authority='changed'),
        ):
            changed = json.loads(good_config); mutate(changed)
            (live / config_relative).write_text(json.dumps(changed))
            with self.assertRaisesRegex(RuntimeError, 'configuration or account'):
                recovery.native_saved_state(before, live)
        (live / config_relative).write_bytes(good_config)

    def test_official_companion_config_normalization_preserves_model_and_permissions(self):
        before, after = self.root / 'before-config', self.root / 'after-config'
        for root in (before, after):
            (root / 'openclaw-runtime').mkdir(parents=True)
        original = {'agents': {'entries': {'main': {}}, 'defaults': {'model': {'primary': 'retained-model'}}},
                    'plugins': {'load': {'paths': ['/retained-module']}, 'entries': {'codex': {'enabled': True}}},
                    'tools': {'profile': 'coding'}, 'meta': {'lastTouchedVersion': '2026.9.2'}}
        changed = json.loads(json.dumps(original))
        del changed['agents']['entries']
        changed['meta'] = {'lastTouchedVersion': '2026.9.6', 'migrations': {'modelPolicyAllowlist': True, 'utilityModelSeparation': True}}
        (before / 'openclaw-runtime/openclaw.json').write_text(json.dumps(original))
        target = after / 'openclaw-runtime/openclaw.json'
        target.write_text(json.dumps(changed))
        recovery.native_runtime_configuration(before, after, pathlib.Path('.'), '2026.9.2', '2026.9.6')
        with self.assertRaises(RuntimeError):
            recovery.native_runtime_configuration(before, after, pathlib.Path('.'), '2026.9.2', '2026.9.2')
        for section, field, value in [('tools', 'profile', 'full'), ('plugins', 'load', {'paths': ['/unreviewed-module']})]:
            rejected = json.loads(json.dumps(changed))
            rejected[section][field] = value
            target.write_text(json.dumps(rejected))
            with self.assertRaises(RuntimeError):
                recovery.native_runtime_configuration(before, after, pathlib.Path('.'), '2026.9.2', '2026.9.6')
        changed['agents']['defaults']['model']['primary'] = 'different-model'
        target.write_text(json.dumps(changed))
        with self.assertRaises(RuntimeError):
            recovery.native_runtime_configuration(before, after, pathlib.Path('.'), '2026.9.2', '2026.9.6')

    def test_native_migration_checkpoint_requires_the_verified_target_runtime_build(self):
        executable = self.root / 'runtime' / 'node' / 'bin' / 'node'
        package = self.root / 'runtime' / 'node_modules' / 'openclaw'
        (package / 'dist').mkdir(parents=True)
        (package / 'package.json').write_text(json.dumps({'version': '2026.9.6'}))
        build = '2026-09-19T18:19:30.000Z'
        (package / 'dist' / 'build-info.json').write_text(json.dumps({'builtAt': build}))
        with contextlib.closing(sqlite3.connect(':memory:')) as before, contextlib.closing(sqlite3.connect(':memory:')) as after:
            schema = 'create table schema_meta(meta_key text primary key,role text,schema_version integer,app_version text,created_at integer,updated_at integer)'
            old = '\n'.join(['2026.9.2', '3', '2026-09-05T15:22:41.651Z', 'a' * 43, 'b' * 43, 'c' * 64])
            target = '\n'.join(['2026.9.6', '3', build, 'd' * 43, 'e' * 43, 'f' * 64])
            for connection, fingerprint in ((before, old), (after, target)):
                connection.execute(schema)
                connection.execute("insert into schema_meta values('startup-migrations','global',3,?,1,1)", (fingerprint,))
            args = (before, after, {'schema_meta'}, {'verified': True}, '2026.9.2', '2026.9.6', executable)
            replacements = recovery.native_boot_replacements(*args)
            self.assertEqual(recovery.native_projected_rows(before, 'schema_meta'), recovery.native_projected_rows(after, 'schema_meta', replacements))
            for changed in (target.replace(build, '2026-09-20T00:00:00.000Z'), target.replace('2026.9.6', '2026.9.7'), target.replace('\n3\n', '\n4\n')):
                after.execute('update schema_meta set app_version=?', (changed,))
                with self.assertRaises(RuntimeError):
                    recovery.native_boot_replacements(*args)

    def archive(self, names):
        path = self.root / 'app.tgz'
        with tarfile.open(path, 'w:gz') as archive:
            for name, kind in names:
                info = tarfile.TarInfo(name)
                info.type = kind
                info.size = 1 if kind == tarfile.REGTYPE else 0
                if kind == tarfile.SYMTYPE:
                    info.linkname = '/untrusted'
                archive.addfile(info, io.BytesIO(b'x') if info.size else None)
        return path

    def test_archive_rejects_traversal_links_duplicate_and_unreviewed_scripts(self):
        instance = driver.Driver(self.root / 'request.json')
        for names in [[('../escape', tarfile.REGTYPE)], [('dist/link', tarfile.SYMTYPE)], [('package.json', tarfile.REGTYPE)] * 2,
                      [('scripts/arbitrary.mjs', tarfile.REGTYPE)], [('dist/./file', tarfile.REGTYPE)]]:
            instance.archive = self.archive(names)
            with self.assertRaises(RuntimeError):
                instance.archive_members()
        instance.archive = self.archive([('package.json', tarfile.REGTYPE), ('dist/client/index.html', tarfile.REGTYPE)])
        self.assertEqual(len(instance.archive_members()), 2)

    def instance(self):
        instance = driver.Driver(self.root / 'request.json')
        instance.from_engine = instance.to_engine = instance.active_engine = '2026.9.2'
        instance.job_id = '34104484-7465-4b71-acf8-0e390a17aa42'
        instance.target_id, instance.prior_id = 'b' * 64, 'a' * 64
        instance.prior = self.root / 'prior'
        instance.current = types.SimpleNamespace(resolve=lambda strict: instance.prior)
        instance.release = {'compatibility': {'fromNovaVersion': '1.12.11'}, 'recovery': {'readinessTimeoutSeconds': 3}}
        instance.acceptance = lambda *args: {'health': {'status': 'ready'}, 'accounts': [], 'epoch': 'saved-epoch'}
        instance.verify_configuration = lambda: None
        return instance

    def test_unchanged_receipt_is_private_per_attempt_and_never_claims_restore(self):
        instance = self.instance()
        with patch.object(driver, 'candidate'), patch.object(driver, 'sync_dir'), patch.object(recovery, 'sync_dir'), patch.object(os, 'O_NOFOLLOW', getattr(os, 'O_NOFOLLOW', 0), create=True):
            instance.result('unchanged')
        result = json.loads((self.root / 'result.json').read_bytes())
        self.assertEqual(result['outcome'], 'unchanged')
        self.assertTrue(result['unchangedVerified'])
        self.assertTrue(result['healthVerified'])
        self.assertEqual(result['reasonCode'], 'preflight_failed')
        self.assertNotIn('savedWorkVerified', result)
        self.assertNotIn('recoveryVerified', result)

    def test_unchanged_requires_no_stop_switch_or_workspace_mutation_and_fresh_health(self):
        for field in ('stop_attempted', 'switch_attempted', 'switched', 'workspace_mutated'):
            instance = self.instance()
            setattr(instance, field, True)
            with self.assertRaises(RuntimeError):
                instance.result('unchanged')
        instance = self.instance()
        instance.acceptance = lambda *args: (_ for _ in ()).throw(RuntimeError('unknown health'))
        with patch.object(driver, 'candidate'), patch.object(driver.time, 'monotonic', side_effect=[0, 1, 4]), patch.object(driver.time, 'sleep'), self.assertRaises(RuntimeError):
            instance.result('unchanged')
        self.assertFalse((self.root / 'result.json').exists())

    def test_unresponsive_active_app_is_not_stopped_by_generic_recovery(self):
        instance = self.instance()
        instance.target = self.root / 'target'
        instance.pair = {}
        calls = []
        instance.require_stopped = lambda: (_ for _ in ()).throw(RuntimeError('active'))
        instance.acceptance = lambda *args: (_ for _ in ()).throw(RuntimeError('unknown native activity'))
        instance.service = lambda action: calls.append(action)
        with self.assertRaises(RuntimeError):
            instance.guarded_stop()
        self.assertEqual(calls, [])

    def test_reviewed_unresponsive_startup_requires_exact_artifacts_process_and_socket(self):
        instance = self.instance()
        instance.target = self.root / 'target'
        instance.node = self.root / 'node'
        instance.settings = {'serviceName': 'synthetic.service'}
        hashes = {name: 'c' * 64 for name in driver.STARTUP_FILES}
        instance.pair = {'startupBarrier': {'format': 1, 'prior': hashes, 'target': hashes}}
        instance.launched = {'candidateId': instance.prior_id, 'notBeforeTicks': 50}
        instance.controller_hold = lambda: None
        environ = b'E3_UPDATE_SOCKET=/run/nova-update/control.sock\0'
        fields = [b'S'] + [b'0'] * 18 + [b'100']
        process_stat = b'123 (synthetic) ' + b' '.join(fields)
        class ProcessFile:
            def __init__(self, name=''):
                self.name = name
            def __truediv__(self, name):
                return ProcessFile(name)
            def open(self, mode):
                return io.BytesIO(process_stat if self.name == 'stat' else environ)
            def resolve(self, strict=True):
                return instance.node if self.name == 'exe' else instance.prior
        manifest = {'artifacts': [{'path': name, 'sha256': value} for name, value in hashes.items()]}
        with patch.object(driver, 'candidate', return_value=manifest), patch.object(driver, 'pathlib', types.SimpleNamespace(Path=lambda _: ProcessFile())), patch.object(driver.subprocess, 'check_output', return_value='123\n'):
            instance.qualify_started_barrier(instance.prior, instance.prior_id, '1.13.0')
            environ = b'E3_UPDATE_SOCKET=/tmp/untrusted.sock\0'
            with self.assertRaises(RuntimeError):
                instance.qualify_started_barrier(instance.prior, instance.prior_id, '1.13.0')

    def test_retained_native_transcripts_may_append_but_cannot_lose_old_bytes(self):
        instance = self.instance()
        instance.recovery, instance.data = self.root / 'recovery', self.root / 'live'
        fixture_native(instance.recovery / 'workspace')
        fixture_native(instance.data)
        native = pathlib.Path('openclaw-runtime/state/sessions')
        original = instance.recovery / 'workspace' / native / 'session.jsonl'
        original.parent.mkdir(parents=True)
        original.write_bytes(b'{"saved":true}\n')
        current = instance.data / native / original.name
        current.parent.mkdir(parents=True)
        current.write_bytes(original.read_bytes() + b'{"new":true}\n')
        instance.retained_native()
        current.write_bytes(b'{"saved":false}\n')
        with self.assertRaises(RuntimeError):
            instance.retained_native()

    def test_exact_app_and_native_barrier_are_required_by_acceptance(self):
        instance = driver.Driver(self.root / 'request.json')
        instance.active_engine = '2026.9.2'
        instance.job_id, instance.client_candidate = 'job', 'a' * 64
        health = {'status': 'ready', 'candidateId': 'a' * 64, 'version': '1.13.0', 'schemaVersion': 55, 'apiVersion': 1}
        guard = {'candidateId': 'a' * 64, 'heldFor': 'job', 'maintenanceHeld': True, 'nativeSuspended': True, 'blockers': [], 'epoch': 'epoch'}
        responses = {'health': health, 'software-update/acceptance': guard, 'assistant/service': {'id': 'openclaw', 'state': 'ready', 'version': '2026.9.2'},
                     'assistant/state': {'connection': {'state': 'ready', 'modelAuthReady': True, 'grantedScopes': ['operator.read', 'operator.write']}}, 'accounts': {'accounts': []}}
        instance.api = lambda path, session=False: responses[path]
        instance.controller_hold = lambda: None
        self.assertEqual(instance.acceptance('a' * 64, '1.13.0')['epoch'], 'epoch')
        for key, value in [('nativeSuspended', False), ('heldFor', 'different-job'), ('maintenanceHeld', False), ('blockers', [{'code': 'voice'}])]:
            before = guard[key]
            guard[key] = value
            with self.assertRaises(RuntimeError):
                instance.acceptance('a' * 64, '1.13.0')
            guard[key] = before
        # An engine-only update has the same app identity throughout. Its phase,
        # not candidate equality, selects the expected live engine version.
        instance.active_engine = '2026.9.6'
        with self.assertRaises(RuntimeError):
            instance.acceptance('a' * 64, '1.13.0')
        responses['assistant/service']['version'] = '2026.9.6'
        instance.acceptance('a' * 64, '1.13.0')

    def test_held_acceptance_defers_cold_models_only_with_a_durable_post_resume_gate(self):
        for post_resume_gate in [True, False]:
            with self.subTest(post_resume_gate=post_resume_gate):
                instance = driver.Driver(self.root / 'request.json')
                instance.active_engine = '2026.9.6'
                instance.job_id, instance.client_candidate = 'job', 'a' * 64
                health = {'status': 'ready', 'candidateId': 'a' * 64, 'version': '1.13.2', 'schemaVersion': 55, 'apiVersion': 1}
                guard = {'candidateId': 'a' * 64, 'heldFor': 'job', 'maintenanceHeld': True, 'nativeSuspended': True, 'blockers': [], 'epoch': 'epoch', 'resumeReadinessRequired': post_resume_gate}
                connection = {'state': 'ready', 'modelAuthReady': False, 'grantedScopes': ['operator.read', 'operator.write']}
                responses = {'health': health, 'software-update/acceptance': guard,
                             'assistant/service': {'id': 'openclaw', 'state': 'ready', 'version': '2026.9.6'},
                             'assistant/state': {'connection': connection}, 'accounts': {'accounts': []}}
                calls = []
                def api(path, session=False):
                    self.assertFalse(session, 'Catalog refresh must be a read.')
                    calls.append(path)
                    if path == 'assistant/models':
                        raise AssertionError('Suspended OpenClaw forbids model catalog RPCs')
                    return responses[path]
                instance.api = api
                instance.controller_hold = lambda: calls.append('controller-hold')
                if post_resume_gate:
                    self.assertEqual(instance.acceptance('a' * 64, '1.13.2')['epoch'], 'epoch')
                else:
                    with self.assertRaisesRegex(RuntimeError, 'cannot verify cold model access'):
                        instance.acceptance('a' * 64, '1.13.2')
                self.assertEqual(calls[:5], ['health', 'software-update/acceptance', 'controller-hold', 'assistant/service', 'assistant/state'])
                self.assertNotIn('assistant/models', calls)
                # An old app's actual warm authentication remains sufficient.
                connection['modelAuthReady'] = True
                self.assertEqual(instance.acceptance('a' * 64, '1.13.2')['epoch'], 'epoch')
                for scopes in [[], ['operator.read'], ['operator.write']]:
                    connection['grantedScopes'] = scopes
                    with self.assertRaisesRegex(RuntimeError, 'not authenticated'):
                        instance.acceptance('a' * 64, '1.13.2')
                connection['grantedScopes'] = ['operator.read', 'operator.write']
                for change in [('guard', 'nativeSuspended', False), ('agent', 'version', 'unreviewed')]:
                    row = guard if change[0] == 'guard' else responses['assistant/service']
                    original, row[change[1]] = row[change[1]], change[2]
                    calls.clear()
                    with self.assertRaises(RuntimeError):
                        instance.acceptance('a' * 64, '1.13.2')
                    self.assertNotIn('assistant/models', calls)
                    row[change[1]] = original

    def test_cold_legacy_readiness_is_accepted_only_for_this_runners_restored_prior_pair(self):
        instance = self.instance()
        del instance.acceptance
        instance.release['compatibility']['fromNovaVersion'] = '1.13.2'
        instance.client_candidate = instance.prior_id
        instance.before = {'accounts': [], 'epoch': 'saved-epoch'}
        instance.stop_attempted = instance.workspace_mutated = True
        instance.launched = {'candidateId': instance.prior_id, 'notBeforeTicks': 100}
        connection = {'state': 'ready', 'modelAuthReady': False, 'grantedScopes': ['operator.read', 'operator.write']}
        guard = {'candidateId': instance.prior_id, 'heldFor': instance.job_id, 'maintenanceHeld': True,
                 'nativeSuspended': True, 'blockers': [], 'epoch': 'saved-epoch'}
        health = {'status': 'ready', 'candidateId': instance.prior_id, 'version': '1.13.2', 'schemaVersion': 55, 'apiVersion': 1}
        agent = {'id': 'openclaw', 'state': 'ready', 'version': '2026.9.2'}
        responses = {'health': health, 'software-update/acceptance': guard, 'assistant/service': agent,
                     'assistant/state': {'connection': connection}, 'accounts': {'accounts': []}}
        calls = []
        def api(path, session=False):
            calls.append(path)
            self.assertNotEqual(path, 'assistant/models', 'Cold native catalog remains inaccessible while suspended.')
            return responses[path]
        instance.api = api
        instance.controller_hold = lambda: calls.append('controller-hold')
        # The original preflight and target readiness remain strict, even with
        # all rollback facts present. Compatibility requires the explicit path.
        with self.assertRaisesRegex(RuntimeError, 'cannot verify cold model access'):
            instance.acceptance(instance.prior_id, '1.13.2')
        self.assertEqual(instance.wait_acceptance(instance.prior_id, '1.13.2', restored_prior=True)['epoch'], 'saved-epoch')
        self.assertFalse(connection['modelAuthReady'], 'Readiness was not fabricated.')
        self.assertFalse((self.root / 'result.json').exists(), 'Acceptance alone cannot publish a restored outcome.')
        for field, changed in [('stop_attempted', False), ('workspace_mutated', False), ('before', None),
                               ('launched', None), ('launched', {'candidateId': instance.target_id}), ('active_engine', '2026.9.6')]:
            original = getattr(instance, field); setattr(instance, field, changed)
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                instance.acceptance(instance.prior_id, '1.13.2', restored_prior=True)
            setattr(instance, field, original)
        for row, field, changed in [(guard, 'heldFor', 'other-job'), (guard, 'nativeSuspended', False),
                                    (guard, 'maintenanceHeld', False), (guard, 'blockers', [{'code': 'active-work'}]),
                                    (connection, 'state', 'disconnected'), (connection, 'grantedScopes', ['operator.read']),
                                    (connection, 'grantedScopes', ['operator.write']), (agent, 'version', '2026.9.6')]:
            original = row[field]; row[field] = changed
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                instance.acceptance(instance.prior_id, '1.13.2', restored_prior=True)
            row[field] = original
        with self.assertRaises(RuntimeError):
            instance.acceptance(instance.prior_id, '1.13.2', require_idle=False, restored_prior=True)
        original_current = instance.current
        instance.current = types.SimpleNamespace(resolve=lambda strict: self.root / 'other-app')
        with self.assertRaises(RuntimeError):
            instance.acceptance(instance.prior_id, '1.13.2', restored_prior=True)
        instance.current = original_current
        for row, field, changed in [(guard, 'epoch', 'different-epoch'), (responses['accounts'], 'accounts', [{'id': 'changed', 'provider': 'google', 'state': 'connected', 'scopes': []}])]:
            original = row[field]; row[field] = changed
            with patch.object(driver.time, 'monotonic', side_effect=[0, 1, 4]), patch.object(driver.time, 'sleep'), self.assertRaises(RuntimeError):
                instance.wait_acceptance(instance.prior_id, '1.13.2', restored_prior=True)
            row[field] = original
        self.assertIn('controller-hold', calls)

    def runtime_archive(self, additional=()):
        archive = self.root / 'runtime.tgz'
        entries = [('node/bin/node', b'node'), ('node_modules/openclaw/package.json', b'{}'),
                   ('node_modules/openclaw/openclaw.mjs', b'export{}'), ('package.json', b'{}'), ('package-lock.json', b'{}')]
        with tarfile.open(archive, 'w:gz') as output:
            for name, content in [*entries, *additional]:
                member = tarfile.TarInfo(name)
                if isinstance(content, str):
                    member.type, member.linkname = tarfile.SYMTYPE, content
                    output.addfile(member)
                else:
                    member.size = len(content)
                    output.addfile(member, io.BytesIO(content))
        return archive, {'fileCount': len(entries) + len(additional), 'expandedBytes': sum(len(value) for _, value in [*entries, *additional] if isinstance(value, bytes))}

    def companion_entries(self):
        root = 'companions/codex/'
        return [(root + 'package-lock.json', b'{}'), (root + 'node_modules/openclaw', '../../../node_modules/openclaw'),
                (root + 'node_modules/@openclaw/codex/package.json', b'{}'),
                (root + 'node_modules/@openclaw/codex/openclaw.plugin.json', b'{}'),
                (root + 'node_modules/@openai/codex/package.json', b'{}'),
                (root + 'node_modules/@openai/codex-linux-x64/package.json', b'{}'),
                (root + 'node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex', b'binary')]

    def test_offline_runtime_archive_bounds_and_internal_links(self):
        archive, description = self.runtime_archive([('node_modules/.bin/openclaw', '../openclaw/openclaw.mjs')])
        self.assertEqual(len(driver.runtime_members(archive, description)), 6)
        for extra in [[('../outside', b'bad')], [('node_modules/link', '../../outside')],
                      [('node_modules/link', '/outside')], [('node_modules/link', 'openclaw'), ('node_modules/link/file', b'bad')],
                      [('node/bin/node', b'duplicate')]]:
            archive, description = self.runtime_archive(extra)
            with self.assertRaises(RuntimeError):
                driver.runtime_members(archive, description)
        archive, description = self.runtime_archive()
        description['expandedBytes'] += 1
        with self.assertRaises(RuntimeError):
            driver.runtime_members(archive, description)

    def test_runtime_archive_must_match_signed_bytes_and_hash(self):
        instance = self.instance()
        archive, expansion = self.runtime_archive(self.companion_entries())
        runtime = {'format': 1, 'fromVersion': '2026.9.2', 'toVersion': '2026.9.6', 'archiveBytes': archive.stat().st_size,
                   'archiveSha256': hashlib.sha256(archive.read_bytes()).hexdigest(), **expansion,
                   'nodeVersion': '24.21.0', 'nodeSha256': 'd' * 64,
                   'companion': {'pluginVersion': '2026.9.6', 'codexVersion': '0.155.1', 'packageLockSha256': 'b' * 64, 'binarySha256': 'c' * 64}}
        instance.from_engine, instance.to_engine = runtime['fromVersion'], runtime['toVersion']
        instance.pair, instance.release = {'runtime': runtime}, {'runtimeBundle': {'bytes': runtime['archiveBytes'], 'sha256': runtime['archiveSha256']}}
        instance.bundle, instance.runtime_root = self.root, self.root
        instance.agent = types.SimpleNamespace(is_symlink=lambda: True)
        instance.agent_node = types.SimpleNamespace(is_symlink=lambda: True, distinct=True)
        with patch.object(driver, 'protected'):
            instance.validate_runtime()
            runtime['companion']['codexVersion'] = '0.153.4'
            with self.assertRaises(RuntimeError):
                instance.validate_runtime()
            runtime['companion']['codexVersion'] = '0.155.1'
            instance.release['runtimeBundle']['sha256'] = 'e' * 64
            with self.assertRaises(RuntimeError):
                instance.validate_runtime()
            instance.release.pop('runtimeBundle')
            with self.assertRaises(RuntimeError):
                instance.validate_runtime()

    def test_runtime_companion_must_be_complete_and_confined(self):
        archive, description = self.runtime_archive(self.companion_entries())
        description['companion'] = {}
        self.assertEqual(len(driver.runtime_members(archive, description)), 12)
        for entries in [self.companion_entries()[:-1], [*self.companion_entries(), ('companions/other/payload', b'bad')],
                        [(name, '../../../../outside' if isinstance(value, str) else value) for name, value in self.companion_entries()]]:
            with self.subTest(entries=entries):
                archive, description = self.runtime_archive(entries)
                description['companion'] = {}
                with self.assertRaises(RuntimeError):
                    driver.runtime_members(archive, description)

    def test_existing_runtime_allocation_credit_requires_full_verification(self):
        instance = self.instance()
        instance.runtime = {'expandedBytes': 100000, 'fileCount': 12}
        instance.runtime_target = self.root / 'runtime'
        with patch.object(instance, 'verify_staged_runtime') as verify:
            self.assertEqual(instance.runtime_storage_required(), 100000 + 12 * 4096)
            verify.assert_not_called()
            instance.runtime_target.mkdir()
            self.assertEqual(instance.runtime_storage_required(), 0)
            verify.assert_called_once()
            verify.side_effect = RuntimeError('Retained payload differs')
            with self.assertRaises(RuntimeError):
                instance.runtime_storage_required()
        self.assertFalse(instance.stop_attempted or instance.switch_attempted or instance.workspace_mutated)

    @unittest.skipUnless(sys.platform == 'linux', 'POSIX umask and directory traversal modes')
    def test_runtime_staging_repairs_only_a_validated_parent_under_private_umask(self):
        for existing in [False, True]:
            with self.subTest(existing=existing):
                instance = self.instance()
                instance.runtime_archive, description = self.runtime_archive()
                instance.runtime_archive_members = driver.runtime_members(instance.runtime_archive, description)
                instance.runtime = description
                instance.runtime_target = self.root / ('retained' if existing else 'fresh') / 'runtime'
                if existing:instance.runtime_target.parent.mkdir(mode=0o700)
                checks = []
                def protected(path, directory=False):
                    self.assertEqual(path, instance.runtime_target.parent)
                    checks.append(path)
                instance.verify_staged_runtime = lambda: self.assertEqual(instance.runtime_target.parent.stat().st_mode & 0o777, 0o755)
                previous = os.umask(0o077)
                try:
                    with patch.object(driver, 'protected', side_effect=protected), patch.object(driver, 'sync_dir'):
                        instance.stage_runtime()
                finally:os.umask(previous)
                self.assertEqual(checks, [instance.runtime_target.parent])
                self.assertEqual(instance.runtime_target.parent.stat().st_mode & 0o777, 0o755)
                instance.runtime_target.parent.chmod(0o700)
                with patch.object(driver, 'protected', side_effect=RuntimeError('Untrusted parent')):
                    with self.assertRaises(RuntimeError):instance.stage_runtime()
                self.assertEqual(instance.runtime_target.parent.stat().st_mode & 0o777, 0o700)

    def test_staged_node_is_checked_as_service_user_before_migration(self):
        instance = self.instance()
        instance.settings = {'serviceUser': 'synthetic'}
        instance.target_agent_node = self.root / 'node' / 'bin' / 'node'
        instance.runtime = {'nodeVersion': '24.21.0'}
        user = types.SimpleNamespace(pw_uid=321, pw_gid=654, pw_dir=str(self.root))
        with patch.dict(sys.modules, {'pwd': types.SimpleNamespace(getpwnam=lambda name: user)}), patch.object(driver.subprocess, 'check_output', return_value='v24.21.0\n') as child:
            instance.verify_runtime_execution()
            args, kwargs = child.call_args
            self.assertEqual(args[0], [str(instance.target_agent_node), '--version'])
            self.assertEqual((kwargs['user'], kwargs['group'], kwargs['extra_groups']), (321, 654, []))
            self.assertEqual(set(kwargs['env']), {'PATH', 'HOME', 'LANG', 'NODE_DISABLE_COMPILE_CACHE'})
            child.side_effect = PermissionError('Synthetic untraversable parent')
            with self.assertRaises(PermissionError):instance.verify_runtime_execution()
        self.assertFalse(instance.stop_attempted or instance.switch_attempted or instance.workspace_mutated)

    def test_staged_codex_is_checked_as_service_user_before_migration(self):
        instance = self.instance()
        instance.settings = {'serviceUser': 'synthetic'}
        instance.target_agent_node = self.root / 'node'
        instance.target_codex_binary = self.root / 'codex'
        instance.runtime = {'nodeVersion': '24.21.0', 'companion': {'codexVersion': '0.155.1'}}
        user = types.SimpleNamespace(pw_uid=321, pw_gid=654, pw_dir=str(self.root))
        with patch.dict(sys.modules, {'pwd': types.SimpleNamespace(getpwnam=lambda name: user)}), patch.object(driver.subprocess, 'check_output', side_effect=['v24.21.0\n', 'codex-cli 0.155.1\n']) as child:
            instance.verify_runtime_execution()
            args, kwargs = child.call_args
            self.assertEqual(args[0], [str(instance.target_codex_binary), '--version'])
            self.assertEqual((kwargs['user'], kwargs['group'], kwargs['extra_groups']), (321, 654, []))
            child.side_effect = ['v24.21.0\n', 'codex-cli 0.153.4\n']
            with self.assertRaises(RuntimeError):
                instance.verify_runtime_execution()
        self.assertFalse(instance.stop_attempted or instance.switch_attempted or instance.workspace_mutated)

    def test_migration_rejects_ambiguous_or_released_workshop_history(self):
        with contextlib.closing(sqlite3.connect(':memory:')) as connection:
            connection.executescript('''create table skill_workshop_proposals(workspace_dir text,owner_agent_id text,claim_released_time text);
                create table skill_workshop_collection_reviews(workspace_dir text);
                insert into skill_workshop_proposals values('/saved','agent',null);
                insert into skill_workshop_collection_reviews values('/saved');''')
            tables = {'skill_workshop_proposals', 'skill_workshop_collection_reviews'}
            recovery.migration_preflight(connection, tables)
            connection.execute("insert into skill_workshop_proposals values('/saved','other',null)")
            with self.assertRaises(RuntimeError):
                recovery.migration_preflight(connection, tables)
            connection.execute("delete from skill_workshop_proposals where owner_agent_id='other'")
            connection.execute("update skill_workshop_proposals set claim_released_time='released'")
            with self.assertRaises(RuntimeError):
                recovery.migration_preflight(connection, tables)

    def test_migration_retains_old_columns_and_exact_binary_memory_vectors(self):
        with contextlib.closing(sqlite3.connect(':memory:')) as before, contextlib.closing(sqlite3.connect(':memory:')) as after:
            before.executescript("create table memory_index_chunks(id text,embedding text,content text);insert into memory_index_chunks values('saved','[0.25,-2.5]','retained');")
            after.executescript('create table memory_index_chunks(chunk_rowid integer,id text,embedding blob,content text);')
            after.execute('insert into memory_index_chunks values(1,?,?,?)', ('saved', recovery.embedding_bytes('[0.25,-2.5]'), 'retained'))
            args = (before, after, {'memory_index_chunks'}, self.root / 'before', self.root / 'after', None)
            recovery.migrated_native_rows(*args)
            after.execute("update memory_index_chunks set content='lost'")
            with self.assertRaises(RuntimeError):
                recovery.migrated_native_rows(*args)
            for invalid in ('[NaN]', '[true]', '{"x":1}', 'not-json'):
                with self.assertRaises((RuntimeError, ValueError)):
                    recovery.embedding_bytes(invalid)

    def test_migration_registry_changes_only_the_reviewed_agent_schema_version(self):
        with contextlib.closing(sqlite3.connect(':memory:')) as before, contextlib.closing(sqlite3.connect(':memory:')) as after:
            for connection, version in ((before,19),(after,23)):
                connection.execute('create table agent_databases(agent_id text,path text,schema_version integer,last_seen_at integer,size_bytes integer)')
                connection.execute('insert into agent_databases values(?,?,?,?,?)',('main','../agents/main/agent/openclaw-agent.sqlite',version,version,version))
            args=(before,after,{'agent_databases'},self.root/'before',self.root/'after',None)
            recovery.migrated_native_rows(*args)
            after.execute('update agent_databases set schema_version=24')
            with self.assertRaises(RuntimeError):recovery.migrated_native_rows(*args)

    def test_migration_allows_only_proven_index_and_validation_metadata_changes(self):
        with contextlib.closing(sqlite3.connect(':memory:')) as before, contextlib.closing(sqlite3.connect(':memory:')) as after:
            schema = '''create table memory_index_sources(id integer,path text,source text,hash text,mtime integer,size integer);
                create table memory_index_chunks(id text,path text,source text);
                create table memory_index_chunk_provenance(chunk_id text);
                create table memory_index_state(id integer,revision integer);
                create table session_nodes(session_key text,entry_json text,entry_valid integer);
                create table schema_meta(meta_key text,role text,schema_version integer,app_version text,created_at integer,updated_at integer);'''
            for connection in (before, after):
                connection.executescript(schema)
                connection.executescript("insert into memory_index_sources values(1,'MEMORY.md','memory','retained-hash',4,9);insert into memory_index_chunks values('c','MEMORY.md','memory');insert into memory_index_state values(1,2);insert into session_nodes values('saved','{\"status\":\"done\"}',0);insert into schema_meta values('primary','global',15,'2026.9.2',10,10);")
            after.executescript("update memory_index_sources set hash='';insert into memory_index_chunk_provenance values('c');update memory_index_state set revision=3;update session_nodes set entry_valid=1;update schema_meta set schema_version=18,updated_at=11;")
            tables={'memory_index_sources','memory_index_state','session_nodes','schema_meta'}
            args=(before,after,tables,self.root/'old-openclaw.sqlite',self.root/'openclaw.sqlite',None)
            recovery.migrated_native_rows(*args)
            for mutation, restore in [
                    ("update memory_index_sources set hash='replacement'", "update memory_index_sources set hash=''"),
                    ("update memory_index_sources set size=8", "update memory_index_sources set size=9"),
                    ("update memory_index_state set revision=1", "update memory_index_state set revision=3"),
                    ("update session_nodes set entry_valid=-1", "update session_nodes set entry_valid=1"),
                    ("update session_nodes set entry_json='{}'", "update session_nodes set entry_json='{\"status\":\"done\"}'"),
                    ("update schema_meta set app_version='2026.9.7'", "update schema_meta set app_version='2026.9.2'")]:
                after.execute(mutation)
                with self.assertRaises(RuntimeError):recovery.migrated_native_rows(*args)
                after.execute(restore)

    def test_plugin_index_rebuild_retains_every_other_record_and_exact_codex_surface(self):
        runtime = self.root / 'runtime'
        node = runtime / 'node' / 'bin' / 'node'
        node.parent.mkdir(parents=True); node.write_bytes(b'synthetic node')
        package = runtime / 'companions' / 'codex' / 'node_modules' / '@openclaw' / 'codex'
        engine = runtime / 'node_modules' / 'openclaw'
        for path in (package, engine):
            path.mkdir(parents=True)
            (path / 'package.json').write_text('{"version":"2026.9.6"}')
        tools = ['codex_endpoint_probe', 'codex_plugins', 'codex_session_interrupt', 'codex_session_read',
                 'codex_session_send', 'codex_sessions_list', 'codex_threads']
        surface = {'channels': [], 'providers': ['codex'], 'tools': tools,
                   'contracts': ['mediaUnderstandingProviders: codex', 'migrationProviders: codex']
                       + ['tools: ' + name for name in tools] + ['webSearchProviders: codex'],
                   'hooks': [], 'mcpServers': [], 'cliCommands': ['codex'], 'cliBackends': [], 'skills': [], 'dangerousConfigFlags': []}
        old = {'revision': 100, 'index': {'version': 1, 'warning': 'Generated catalog', 'hostContractVersion': '2026.9.2',
               'compatRegistryVersion': 'a' * 64, 'migrationVersion': 1, 'policyHash': 'b' * 64, 'generatedAtMs': 99,
               'workspaceDir': '/saved/workspace', 'installRecords': {'codex': {'source': 'npm', 'version': '2026.9.2'},
               'retained-plugin': {'source': 'path', 'installPath': '/saved/plugin', 'opaque': {'retained': True}}},
               'plugins': [{'pluginId': 'bundled', 'packageVersion': '2026.9.2'}], 'diagnostics': []}}
        new = json.loads(json.dumps(old)); new['revision'] = 200
        new['index'].update(hostContractVersion='2026.9.6', compatRegistryVersion='c' * 64, generatedAtMs=199,
                            refreshReason='source-changed', plugins=[{'pluginId': 'bundled', 'packageVersion': '2026.9.6'}])
        new['index']['installRecords']['codex'] = {'source': 'path', 'sourcePath': str(package), 'installPath': str(package),
            'version': '2026.9.6', 'installedAt': '2026-09-25T03:34:49.714Z', 'acceptedSurface': surface,
            'acceptedSurfaceHash': driver.CODEX_SURFACE, 'acceptedSurfaceAt': '2026-09-25T03:34:49.711Z'}
        with contextlib.closing(sqlite3.connect(':memory:')) as before, contextlib.closing(sqlite3.connect(':memory:')) as after:
            for connection, value in ((before, old), (after, new)):
                connection.execute('create table config_machine_state(state_key text primary key,value_json text,updated_at_ms integer)')
                connection.execute('insert into config_machine_state values(?,?,?)', ('plugins.installedIndex', json.dumps(value), value['revision']))
                connection.execute("insert into config_machine_state values('retained-setting','{\"exact\":true}',7)")
                stamp, updated = ('2026-09-25T00:00:00.000Z', 1790294400000) if connection is before else ('2026-09-25T00:00:01.000Z', 1790294401000)
                connection.execute('insert into config_machine_state values(?,?,?)', ('config.lastTouchedAt', json.dumps(stamp), updated))
            args = (before, after, {'config_machine_state'}, self.root / 'before', self.root / 'after', node)
            recovery.migrated_native_rows(*args)
            after.execute("update config_machine_state set value_json='\"not-a-timestamp\"' where state_key='config.lastTouchedAt'")
            with self.assertRaises(RuntimeError):recovery.migrated_native_rows(*args)
            after.execute('update config_machine_state set value_json=? where state_key=?', (json.dumps('2026-09-25T00:00:01.000Z'), 'config.lastTouchedAt'))
            mutations = [
                lambda v: v['index']['installRecords']['retained-plugin'].update(opaque={'retained': False}),
                lambda v: v['index']['installRecords'].pop('retained-plugin'),
                lambda v: v['index']['installRecords']['codex'].update(source='npm'),
                lambda v: v['index']['installRecords']['codex'].update(installPath='/other/codex'),
                lambda v: v['index']['installRecords']['codex'].update(version='2026.9.7'),
                lambda v: v['index']['installRecords']['codex'].update(unreviewed=True),
                lambda v: v['index']['installRecords']['codex']['acceptedSurface']['tools'].append('unreviewed-tool'),
                lambda v: v['index']['installRecords']['codex'].update(installedAt=123),
                lambda v: v['index'].update(unreviewed=True),
                lambda v: v['index'].update(workspaceDir='/other/workspace'),
                lambda v: v.update(revision=True),
                lambda v: v.update(revision=50),
            ]
            for mutation in mutations:
                value = json.loads(json.dumps(new)); mutation(value)
                after.execute('update config_machine_state set value_json=?,updated_at_ms=? where state_key=?',
                              (json.dumps(value), value['revision'], 'plugins.installedIndex'))
                with self.assertRaises(RuntimeError):recovery.migrated_native_rows(*args)
            after.execute('update config_machine_state set value_json=?,updated_at_ms=200 where state_key=?',
                          (json.dumps(new), 'plugins.installedIndex'))
            for statement, restore in [
                ("update config_machine_state set value_json='{}' where state_key='retained-setting'", "update config_machine_state set value_json='{\"exact\":true}' where state_key='retained-setting'"),
                ("insert into config_machine_state values('new-unreviewed-setting','{}',8)", "delete from config_machine_state where state_key='new-unreviewed-setting'")]:
                after.execute(statement)
                with self.assertRaises(RuntimeError):recovery.migrated_native_rows(*args)
                after.execute(restore)
            with self.assertRaises(RuntimeError):recovery.migrated_native_rows(*args[:-1], None)

    def test_unchanged_plugin_index_needs_no_runtime_but_other_machine_rows_stay_exact(self):
        with contextlib.closing(sqlite3.connect(':memory:')) as before, contextlib.closing(sqlite3.connect(':memory:')) as after:
            for connection in (before, after):
                connection.executescript("create table config_machine_state(state_key text primary key,value_json text,updated_at_ms integer);insert into config_machine_state values('saved','exact',1);")
            recovery.retained_plugin_index(before, after, None)
            after.execute("update config_machine_state set updated_at_ms=2")
            with self.assertRaises(RuntimeError):recovery.retained_plugin_index(before, after, None)

    @unittest.skipUnless(shutil.which('node'), 'Node required for native zstd transcript verification')
    def test_migrated_zstd_transcript_keeps_original_bytes_and_identity(self):
        node = shutil.which('node')
        before_path, after_path = self.root / 'before.sqlite', self.root / 'after.sqlite'
        payload = '{"saved":"' + 'history ' * 300 + '"}'
        compressed = subprocess.check_output([node, '--input-type=module', '-e',
            "import{zstdCompressSync}from'node:zlib';process.stdout.write(zstdCompressSync(Buffer.from(process.argv[1])));", payload])
        with contextlib.closing(sqlite3.connect(before_path)) as before, contextlib.closing(sqlite3.connect(after_path)) as after:
            before.execute('create table transcript_events(session_id text,seq integer,event_json text,created_at integer)')
            before.execute('insert into transcript_events values(?,?,?,?)', ('saved', 1, payload, 100))
            before.commit()
            after.execute('create table transcript_events(session_id text,seq integer,event_json text,created_at integer,event_zstd blob,event_utf8_bytes integer,navigation_json text)')
            after.execute('insert into transcript_events values(?,?,?,?,?,?,?)', ('saved', 1, None, 100, compressed, len(payload.encode()), '{}'))
            after.commit()
            self.assertEqual(recovery.transcript_hashes(before_path, node), recovery.transcript_hashes(after_path, node))
            after.execute('update transcript_events set seq=2')
            after.commit()
            self.assertNotEqual(recovery.transcript_hashes(before_path, node), recovery.transcript_hashes(after_path, node))

    def test_initial_idle_wait_allows_transient_account_activity_but_never_a_persistent_blocker(self):
        class AfterInitialAcceptance(Exception):
            pass
        for perpetual in [False, True]:
            with self.subTest(perpetual=perpetual):
                instance = self.instance()
                calls, stages, clock = [], [], [0]
                instance.validate = lambda: None
                def acceptance(*args):
                    calls.append(args)
                    if perpetual or len(calls) == 1:
                        raise RuntimeError('Live work is not verified idle.')
                    return {'health': {'status': 'ready'}, 'accounts': [], 'epoch': 'saved-epoch'}
                def stage(value):
                    stages.append(value)
                    raise AfterInitialAcceptance()
                instance.acceptance, instance.stage = acceptance, stage
                instance.stage_app = lambda: self.fail('Initial readiness must precede staging.')
                instance.service = instance.switch = lambda *_: self.fail('No service or pointer change is allowed.')
                with patch.object(driver.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(driver.time, 'sleep', side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)):
                    with self.assertRaises(RuntimeError if perpetual else AfterInitialAcceptance):
                        instance.run()
                self.assertEqual(stages, [] if perpetual else ['preparing'])
                self.assertEqual(len(calls), 3 if perpetual else 2)
                self.assertFalse(instance.stop_attempted or instance.switch_attempted or instance.workspace_mutated)

    def test_pre_stop_idle_wait_keeps_guard_and_retained_accounts_and_epoch(self):
        for changed in [None, 'accounts', 'epoch']:
            with self.subTest(changed=changed):
                instance = self.instance()
                instance.release['manifestExpiresAt'] = 9999999999999
                instance.recovery, instance.restore = self.root / 'recovery', self.root / 'restore'
                instance.validate = lambda: None
                calls, actions, clock = [], [], [0]
                accepted = {'health': {'status': 'ready'}, 'accounts': [('saved', 'google')], 'epoch': 'saved-epoch'}
                def acceptance(*args):
                    calls.append(args)
                    if len(calls) == 2:
                        raise RuntimeError('Live work is not verified idle.')
                    if changed and len(calls) > 1:
                        return {**accepted, changed: [] if changed == 'accounts' else 'different-epoch'}
                    return accepted
                instance.acceptance = acceptance
                instance.stage = lambda value: None
                instance.stage_app = lambda: actions.append('stage-app')
                instance.result = lambda outcome: actions.append(outcome)
                instance.verify_configuration = lambda: (_ for _ in ()).throw(RuntimeError('Stop synthetic check before service mutation.'))
                instance.service = instance.switch = lambda *_: self.fail('Synthetic check must never stop or switch.')
                with patch.object(driver.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(driver.time, 'sleep', side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)):
                    instance.run()
                self.assertEqual(actions, ['stage-app', 'unchanged'])
                self.assertEqual(len(calls), 4 if changed else 3)
                self.assertEqual(instance.recovery.exists(), changed is None)
                if instance.recovery.exists():instance.recovery.rmdir()
                self.assertFalse(instance.stop_attempted or instance.switch_attempted or instance.workspace_mutated)

    def test_unchanged_receipt_waits_for_transient_account_activity_without_relaxing_mutation_checks(self):
        instance = self.instance()
        calls, clock = [], [0]
        def acceptance(*args):
            calls.append(args)
            if len(calls) == 1:raise RuntimeError('Live work is not verified idle.')
            return {'health': {'status': 'ready'}, 'accounts': [], 'epoch': 'saved-epoch'}
        instance.acceptance = acceptance
        with patch.object(driver, 'candidate'), patch.object(driver, 'sync_dir'), patch.object(recovery, 'sync_dir'), patch.object(os, 'O_NOFOLLOW', getattr(os, 'O_NOFOLLOW', 0), create=True), patch.object(driver.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(driver.time, 'sleep', side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)):
            instance.result('unchanged')
        self.assertEqual(len(calls), 2)
        self.assertTrue(json.loads((self.root / 'result.json').read_bytes())['unchangedVerified'])

    def test_driver_preflight_failure_does_not_stop_and_stop_failure_never_claims_unchanged(self):
        def setup(fail):
            instance = self.instance()
            instance.recovery = self.root / ('recovery-' + fail)
            instance.restore = self.root / ('restore-' + fail)
            instance.release['manifestExpiresAt'] = 9999999999999
            instance.validate = lambda: None
            instance.stage = lambda value: None
            actions = []
            instance.result = lambda outcome: actions.append(outcome)
            instance.stage_app = lambda: (_ for _ in ()).throw(RuntimeError('capacity')) if fail == 'preflight' else None
            def service(action):
                actions.append(action)
                if action == 'stop':
                    raise RuntimeError('stop uncertain')
            instance.service = service
            instance.wait_acceptance = lambda *args: None
            return instance, actions
        preflight, actions = setup('preflight')
        preflight.run()
        self.assertEqual(actions, ['unchanged'])
        self.assertEqual(preflight.preflight_reason, 'preflight_failed')
        storage, actions = setup('storage')
        storage.stage_app = lambda: (_ for _ in ()).throw(recovery.InsufficientStorage('synthetic private detail'))
        storage.run()
        self.assertEqual(actions, ['unchanged'])
        self.assertEqual(storage.preflight_reason, 'insufficient_storage')
        stopping, actions = setup('stop')
        with self.assertRaises(RuntimeError):
            stopping.run()
        self.assertEqual(actions, ['stop', 'start'])
        self.assertTrue(stopping.stop_attempted)

    def test_pointer_switch_uncertainty_uses_original_restore_and_never_repeats_activation(self):
        instance = self.instance()
        instance.recovery, instance.restore = self.root / 'recovery', self.root / 'restore'
        instance.recovery_root = self.root
        instance.data, instance.baseline, instance.target = self.root / 'data', self.root / 'baseline', self.root / 'target'
        instance.config_files = []
        instance.release.update(manifestExpiresAt=9999999999999, novaVersion='1.13.0')
        instance.validate = instance.stage_app = instance.require_stopped = lambda: None
        instance.stage = lambda value: None
        actions = []
        instance.service = lambda action: actions.append(action)
        instance.switch = lambda path: (_ for _ in ()).throw(RuntimeError('pointer sync uncertain'))
        instance.restore_prior = lambda: actions.append('paired-restore')
        with patch.object(driver, 'snapshot_closed'), patch.object(driver, 'saved_state'), patch.object(driver, 'inventory', return_value=({}, {})), patch.object(driver.shutil, 'disk_usage', return_value=types.SimpleNamespace(free=10 ** 12)):
            instance.run()
        self.assertEqual(actions, ['stop', 'paired-restore'])
        self.assertTrue(instance.switch_attempted)

    def test_engine_only_migration_failure_restores_pair_even_without_an_app_pointer_change(self):
        instance = self.instance()
        instance.target_id = instance.prior_id
        instance.target = instance.prior
        instance.recovery, instance.restore = self.root / 'recovery', self.root / 'restore'
        instance.recovery_root = self.root
        instance.data, instance.baseline = self.root / 'data', self.root / 'baseline'
        instance.config_files = []
        instance.release.update(manifestExpiresAt=9999999999999, novaVersion='1.13.0')
        instance.validate = instance.stage_app = instance.require_stopped = lambda: None
        instance.stage = lambda value: None
        actions = []
        instance.service = lambda action: actions.append(action)
        instance.switch_runtime = lambda: actions.append('select-new-engine-and-node')
        failure_reason = 'Retained native config observation content changed.'
        instance.migrate_runtime = lambda: (_ for _ in ()).throw(RuntimeError(failure_reason))
        instance.switch = lambda path: actions.append('app-pointer')
        instance.restore_prior = lambda: actions.append('restore-engine-node-and-workspace')
        with patch.object(driver, 'snapshot_closed'), patch.object(driver, 'saved_state'), patch.object(driver, 'inventory', return_value=({}, {})), patch.object(driver.shutil, 'disk_usage', return_value=types.SimpleNamespace(free=10 ** 12)), patch.object(os, 'O_NOFOLLOW', getattr(os, 'O_NOFOLLOW', 0), create=True), patch.object(recovery, 'sync_dir'):
            instance.run()
        self.assertEqual(actions, ['stop', 'select-new-engine-and-node', 'restore-engine-node-and-workspace'])
        self.assertTrue(instance.switch_attempted)
        self.assertEqual(json.loads((self.root / 'failure.json').read_bytes()), {'errorType': 'RuntimeError', 'reason': failure_reason})

    def test_failure_receipt_never_exports_dynamic_error_text_or_prevents_recovery(self):
        instance = self.instance()
        path = self.root / 'failure.json'
        for error in (RuntimeError('Private credential: synthetic-secret'), ValueError('Private command: synthetic-secret')):
            with patch.object(os, 'O_NOFOLLOW', getattr(os, 'O_NOFOLLOW', 0), create=True), patch.object(recovery, 'sync_dir'):
                instance.record_failure(error)
            receipt = json.loads(path.read_bytes())
            self.assertEqual(receipt, {'errorType': type(error).__name__, 'reason': 'The update failed before acceptance.'})
            path.unlink()
        with patch.object(driver, 'write_json', side_effect=OSError('No receipt space')):
            instance.record_failure(RuntimeError('Expected live candidate is not ready.'))
        self.assertFalse(path.exists())

    @unittest.skipUnless(sys.platform == 'linux' and pathlib.Path('/usr/bin/rsync').exists(), 'Requires Linux rsync/cp metadata support; no host service is used.')
    def test_linux_closed_snapshot_and_independent_restore_preserve_sparse_links_and_xattrs(self):
        data, baseline, recovery_root = self.root / 'live', self.root / 'baseline', self.root / 'recovery'
        data.mkdir()
        fixture_database(data / 'workspace.sqlite')
        (data / 'attachment').write_bytes(b'kept bytes')
        os.link(data / 'attachment', data / 'hardlink')
        (data / 'relative').symlink_to('attachment')
        os.setxattr(data / 'attachment', 'user.nova-fixture', b'kept metadata')
        with (data / 'sparse').open('wb') as output:
            output.write(b'first')
            output.seek(4 * 1024 ** 2)
            output.write(b'last')
        subprocess.run(['/usr/bin/cp', '-a', '--reflink=auto', '--', str(data), str(baseline)], check=True)
        recovery_root.mkdir()
        snapshot = recovery_root / 'workspace'
        recovery.snapshot_closed(data, snapshot, baseline, lambda: None)
        (data / 'failed-only').write_bytes(b'keep failed candidate evidence')
        restored = self.root / 'restored'
        recovery.prepare_independent(snapshot, restored, data, lambda: None)
        self.assertEqual(recovery.inventory(snapshot)[0], recovery.inventory(restored)[0])
        self.assertTrue(recovery.inode_ids(recovery.inventory(snapshot)[1]).isdisjoint(recovery.inode_ids(recovery.inventory(restored)[1])))
        (restored / 'attachment').write_bytes(b'new live change')
        self.assertEqual((snapshot / 'attachment').read_bytes(), b'kept bytes')
        self.assertTrue((data / 'failed-only').exists())


if __name__ == '__main__':
    unittest.main()
