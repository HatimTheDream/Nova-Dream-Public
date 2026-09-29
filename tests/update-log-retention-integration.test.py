"""Closed Linux recovery -> active Codex identity -> retention qualification.

Only the synthetic executable's digest is replaced; SQLite copying, source
identity checks, schema checks, runtime path admission and row comparisons run.
No application process, provider, service or production workspace is accessed.
"""
import contextlib
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'deploy' / 'update-runner'))
import recovery
import codex_log_retention as retention

START = retention.RETENTION_SECONDS + 1000
END = START + 10


@unittest.skipUnless(sys.platform == 'linux', 'Requires real Linux closed SQLite copies and runtime file identity.')
class LogRetentionIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nova-retention-integration-')
        self.root = Path(self.temporary.name).resolve()
        assert self.root.is_relative_to(Path(tempfile.gettempdir()).resolve())
        self.addCleanup(self.temporary.cleanup)
        self.snapshot, self.live = self.root / 'snapshot', self.root / 'live'
        self.selected = Path('selected')
        native = self.selected / 'openclaw-runtime'
        self.agent = native / 'state' / 'agents' / 'main' / 'agent' / 'openclaw-agent.sqlite'
        self.shared = native / 'state' / 'state' / 'openclaw.sqlite'
        self.logs = self.agent.parent / 'codex-home' / 'logs_2.sqlite'
        self.receipts = native / 'assignment-receipts' / 'receipts.sqlite'
        self.active = {self.agent, self.shared}
        self.reports = []

        self.create_database(self.logs, '''
            create table logs(id integer primary key,ts integer,ts_nanos integer,level text,target text,
                feedback_log_body text,module_path text,file text,line integer,thread_id text,process_uuid text,estimated_bytes integer);
            create table _sqlx_migrations(version integer,description text,installed_on text,success integer,checksum blob,execution_time integer);
            insert into _sqlx_migrations values(1,'retained','synthetic',1,x'1234',1);
            insert into logs values(1,999,0,'INFO','fixture','old log',null,null,null,null,null,20);
            insert into logs values(2,1011,0,'INFO','fixture','retained log',null,null,null,null,null,30);
        ''')
        self.create_database(self.receipts, '''
            pragma user_version=2;
            create table identity(id text,host_id text);
            create table outcomes(attempt_id text,bytes integer,payload blob);
            create table receipts(attempt_id text,epoch text,payload blob);
            insert into identity values('fixture','fixture');
            insert into outcomes values('saved',2,x'1234');
            insert into receipts values('saved','fixture',x'5678');
        ''')
        self.create_database(self.agent, 'create table session_nodes(id text primary key,entry_json text);')
        self.create_database(self.shared, 'create table config_machine_state(state_key text,value_json text,updated_at_ms integer);')

        modules = self.live / native / 'state' / 'npm' / 'projects' / 'openclaw-codex-0123456789' / 'node_modules'
        installed = modules / '@openclaw' / 'codex'
        for path, name, version in (
            (installed, '@openclaw/codex', '2026.9.6'),
            (modules / '@openai' / 'codex', '@openai/codex', '0.155.1'),
            (modules / '@openai' / 'codex-linux-x64', '@openai/codex', '0.155.1-linux-x64')):
            path.mkdir(parents=True)
            (path / 'package.json').write_text(json.dumps(dict(name=name, version=version)))
        self.binary = modules / '@openai' / 'codex-linux-x64' / 'vendor' / 'x86_64-unknown-linux-musl' / 'bin' / 'codex'
        self.binary.parent.mkdir(parents=True)
        with self.binary.open('wb') as stream:
            stream.truncate(retention.CODEX_BINARY_BYTES)
        record = dict(source='npm', spec='@openclaw/codex@2026.9.6', resolvedSpec='@openclaw/codex@2026.9.6',
            version='2026.9.6', resolvedVersion='2026.9.6', resolvedName='@openclaw/codex',
            installPath=str(installed), integrity='sha512-Zml4dHVyZQ==')
        self.index = dict(revision=1, index=dict(version=1, warning='', hostContractVersion='2026.9.6',
            compatRegistryVersion='a' * 64, migrationVersion=1, policyHash='b' * 64, generatedAtMs=1,
            installRecords={'codex': record}, plugins=[], diagnostics=[]))
        self.write_index()
        for relative in (self.logs, self.receipts, self.agent, self.shared):
            target = self.snapshot / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(self.live / relative, target)
        self.scratch = self.root / 'scratch'
        self.scratch.mkdir(mode=0o700)
        original_digest = hashlib.file_digest
        self.binary_hash_calls = 0

        def synthetic_binary_digest(stream, algorithm, **kwargs):
            if isinstance(stream.name, (str, bytes)) and Path(stream.name) == self.binary:
                self.binary_hash_calls += 1
                return SimpleNamespace(hexdigest=lambda: retention.CODEX_BINARY_SHA256)
            return original_digest(stream, algorithm, **kwargs)
        self.digest_patch = patch.object(retention.hashlib, 'file_digest', side_effect=synthetic_binary_digest)
        self.digest_patch.start()
        self.addCleanup(self.digest_patch.stop)

    def create_database(self, relative, script):
        path = self.live / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        with contextlib.closing(sqlite3.connect(path)) as connection, connection:
            connection.executescript(script)

    def write_index(self):
        with contextlib.closing(sqlite3.connect(self.live / self.shared)) as connection, connection:
            connection.execute('delete from config_machine_state')
            connection.execute('insert into config_machine_state values(?,?,?)',
                               ('plugins.installedIndex', json.dumps(self.index), 1))

    def change_logs(self, sql):
        with contextlib.closing(sqlite3.connect(self.live / self.logs)) as connection, connection:
            connection.executescript(sql)

    def verify(self, window=(START, END), from_version='2026.9.6'):
        with recovery.verification_scratch(self.scratch):
            return recovery.retained_embedded_databases(self.snapshot, self.live, self.selected, self.active,
                from_version, '2026.9.6', log_retention_window=window, log_retention_reports=self.reports)

    def sqlite_identity(self):
        return {(side, relative): recovery.sqlite_source_identity(root / relative)
                for side, root in (('before', self.snapshot), ('after', self.live))
                for relative in (self.logs, self.receipts, self.shared)}

    def test_same_engine_pruning_requires_active_identity_and_preserves_sources(self):
        self.change_logs("delete from logs where id=1; insert into logs values(3,865002,0,'INFO','fixture','new',null,null,null,null,null,10);")
        before = self.sqlite_identity()
        self.assertEqual(self.verify(), {self.logs, self.receipts})
        self.assertEqual(self.binary_hash_calls, 1)
        self.assertEqual(len(self.reports), 1)
        self.assertEqual(self.reports[0]['removedRows'], 1)
        self.assertEqual(self.reports[0]['companion']['binarySha256'], retention.CODEX_BINARY_SHA256)
        self.assertEqual(self.sqlite_identity(), before)

    def test_without_durable_window_deletion_remains_blocked(self):
        self.change_logs('delete from logs where id=1')
        with self.assertRaises(RuntimeError):
            self.verify(window=None)
        self.assertEqual(self.binary_hash_calls, 0)
        self.assertEqual(self.reports, [])

    def test_unattested_active_runtime_cannot_qualify_age_deletion(self):
        self.change_logs('delete from logs where id=1')
        self.index['index']['installRecords']['codex']['resolvedVersion'] = 'unreviewed'
        self.write_index()
        with self.assertRaises(RuntimeError):
            self.verify()
        self.assertEqual(self.binary_hash_calls, 0)
        self.assertEqual(self.reports, [])

    def test_changed_retained_log_is_not_explained_by_age_retention(self):
        self.change_logs("delete from logs where id=1; update logs set feedback_log_body='changed' where id=2")
        with self.assertRaisesRegex(RuntimeError, 'complete log row changed'):
            self.verify()
        self.assertEqual(self.reports, [])

    def test_nonlog_saved_receipt_still_requires_exact_equality(self):
        self.change_logs('delete from logs where id=1')
        with contextlib.closing(sqlite3.connect(self.live / self.receipts)) as connection, connection:
            connection.execute('delete from receipts')
        with self.assertRaisesRegex(RuntimeError, 'Retained embedded work'):
            self.verify()

    def test_engine_migration_does_not_receive_same_engine_exception(self):
        self.change_logs('delete from logs where id=1')
        with self.assertRaises(RuntimeError):
            self.verify(from_version='2026.9.2')
        self.assertEqual(self.binary_hash_calls, 0)
        self.assertEqual(self.reports, [])

    def test_append_only_still_works_without_runtime_attestation(self):
        self.index['index']['installRecords']['codex']['resolvedVersion'] = 'unreviewed'
        self.write_index()
        self.change_logs("insert into logs values(3,865002,0,'INFO','fixture','new',null,null,null,null,null,10)")
        self.assertEqual(self.verify(), {self.logs, self.receipts})
        self.assertEqual(self.binary_hash_calls, 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
