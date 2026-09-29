"""Synthetic SQLite retention checks; no service, files or private records."""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('codex_log_retention', ROOT / 'deploy' / 'update-runner' / 'codex_log_retention.py')
retention = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retention)

START = retention.RETENTION_SECONDS + 1000
END = retention.RETENTION_SECONDS + 1010
SCHEMA = '''create table logs(
    id integer primary key, ts integer, ts_nanos integer, level text,
    target text, feedback_log_body text, module_path text, file text,
    line integer, thread_id text, process_uuid text, estimated_bytes integer
)'''


def row(identity, timestamp, **changes):
    values = dict(zip(retention.LOG_COLUMNS, (identity, timestamp, 7, 'INFO', 'synthetic',
        'private fixture payload', None, None, None, None, None, 40)))
    values.update(changes)
    return tuple(values[column] for column in retention.LOG_COLUMNS)


@contextlib.contextmanager
def database(rows=(), schema=SCHEMA):
    with contextlib.closing(sqlite3.connect(':memory:')) as connection:
        connection.execute(schema)
        if rows:
            connection.executemany('insert into logs values(?,?,?,?,?,?,?,?,?,?,?,?)', rows)
        connection.commit()
        yield connection


class CodexLogRetentionTests(unittest.TestCase):
    def compare(self, old, new, start=START, end=END):
        with database(old) as before, database(new) as after:
            # Running under SQLite query-only proves the qualifier does not
            # need record/schema writes or a synthetic replacement database.
            before.execute('pragma query_only=on')
            after.execute('pragma query_only=on')
            return retention.qualify_logs(before, after, start, end)

    def test_complete_old_prefix_is_qualified_with_new_logs(self):
        result = self.compare([row(1, 998), row(2, 999), row(3, 1011)],
                              [row(3, 1011), row(4, START + 2)])
        self.assertEqual((result['removedRows'], result['retainedRows'], result['addedRows']), (2, 1, 1))
        self.assertEqual((result['cutoffFirst'], result['cutoffLast']), (1000, 1010))
        self.assertEqual(result['rule'], 'codex-0.155.1-startup-10-days')
        self.assertEqual(len(result['retainedCompleteRowsSha256']), 64)
        self.assertNotIn('private fixture payload', json.dumps(result))
        self.assertNotIn('synthetic', json.dumps(result))

    def test_existing_append_only_behavior_does_not_require_pruning(self):
        result = self.compare([row(1, 0)], [row(1, 0), row(2, START)])
        self.assertEqual(result['rule'], 'append-only')
        self.assertEqual((result['removedRows'], result['retainedRows'], result['addedRows']), (0, 1, 1))

    def test_empty_database_and_all_expired_rows_are_supported(self):
        self.assertEqual(self.compare([], [])['beforeRows'], 0)
        self.assertEqual(self.compare([row(1, 999)], [])['removedRows'], 1)

    def test_every_retained_column_is_protected(self):
        changes = dict(ts=1012, ts_nanos=8, level='ERROR', target='changed', feedback_log_body='changed',
                       module_path='changed', file='changed', line=8, thread_id='changed', process_uuid='changed',
                       estimated_bytes=41)
        for column, value in changes.items():
            with self.subTest(column=column), self.assertRaisesRegex(RuntimeError, 'complete log row changed'):
                self.compare([row(1, 999), row(2, 1011)], [row(2, 1011, **{column: value})])

    def test_typed_payload_and_null_values_are_not_conflated(self):
        for old, new in [('1', b'1'), (None, 'None'), ('a\x00b', 'ab')]:
            with self.subTest(old=old), self.assertRaisesRegex(RuntimeError, 'complete log row changed'):
                self.compare([row(1, 1011, feedback_log_body=old)], [row(1, 1011, feedback_log_body=new)])

    def test_reused_id_is_not_treated_as_pruning_and_append(self):
        with self.assertRaisesRegex(RuntimeError, 'complete log row changed'):
            self.compare([row(1, 999)], [row(1, START)])

    def test_removing_a_recent_row_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, 'exact startup age'):
            self.compare([row(1, 1011), row(2, 1020)], [row(2, 1020)])

    def test_removals_must_be_the_complete_timestamp_prefix(self):
        for kept in (998, 999):
            with self.subTest(kept=kept), self.assertRaisesRegex(RuntimeError, 'exact startup age'):
                self.compare([row(1, 999), row(2, kept), row(3, 1011)], [row(2, kept), row(3, 1011)])

    def test_strict_timestamp_boundary_and_actual_window_are_respected(self):
        result = self.compare([row(1, 999), row(2, 1000)], [row(2, 1000)], START, START)
        self.assertEqual((result['cutoffFirst'], result['cutoffLast']), (1000, 1000))
        with self.assertRaisesRegex(RuntimeError, 'exact startup age'):
            self.compare([row(1, 1000)], [], START, START)
        with self.assertRaisesRegex(RuntimeError, 'exact startup age'):
            self.compare([row(1, 999), row(2, 1000)], [row(2, 1000)], START + 20, END + 20)

    def test_a_single_cutoff_must_explain_the_entire_deletion(self):
        # Both deleted records are individually age-eligible somewhere in the
        # window, but no cutoff can delete the newer one and keep the middle.
        with self.assertRaisesRegex(RuntimeError, 'exact startup age'):
            self.compare([row(1, 999), row(2, 1003), row(3, 1005)], [row(2, 1003)])

    def test_invalid_windows_are_rejected_even_without_deletions(self):
        cases = [(True, END), (START, False), (float(START), END), ('1', END), (None, END),
                 (END, START), (0, 1), (-1, 1), (START, START + 3601),
                 (retention.MAX_TIMESTAMP_SECONDS, retention.MAX_TIMESTAMP_SECONDS + 1)]
        for start, end in cases:
            with self.subTest(start=start, end=end), self.assertRaisesRegex(RuntimeError, 'startup window'):
                self.compare([], [], start, end)

    def test_invalid_timestamps_are_rejected(self):
        for timestamp in (-1, None, 'invalid', retention.MAX_TIMESTAMP_SECONDS + 1):
            with self.subTest(timestamp=timestamp), self.assertRaisesRegex(RuntimeError, 'identity or timestamp'):
                self.compare([row(1, timestamp)], [row(1, timestamp)])

    def test_schema_version_columns_and_identity_are_reviewed(self):
        with database() as before, database() as after:
            after.execute('pragma user_version=1')
            with self.assertRaisesRegex(RuntimeError, 'database version'):
                retention.qualify_logs(before, after, START, END)
        for schema in (SCHEMA.replace('id integer primary key', 'id integer'),
                       SCHEMA.replace('estimated_bytes integer', 'estimated_bytes integer, extra text'),
                       SCHEMA.replace('ts_nanos integer', 'unexpected integer')):
            with self.subTest(schema=schema), database(schema=schema) as before, database(schema=schema) as after:
                with self.assertRaisesRegex(RuntimeError, 'columns or identity'):
                    retention.qualify_logs(before, after, START, END)

    def test_schema_drift_is_rejected_before_row_comparison(self):
        for schema in (SCHEMA.replace('line integer', 'line text'), SCHEMA.replace('level text', "level text default 'INFO'")):
            with self.subTest(schema=schema), database() as before, database(schema=schema) as after:
                with self.assertRaisesRegex(RuntimeError, 'schema changed'):
                    retention.qualify_logs(before, after, START, END)
        with database() as before, database() as after:
            after.execute('create index new_log_index on logs(ts)')
            with self.assertRaisesRegex(RuntimeError, 'schema changed'):
                retention.qualify_logs(before, after, START, END)

    def test_row_count_limit_applies_to_both_databases(self):
        many = [row(index, START) for index in range(4)]
        with patch.object(retention, 'MAX_LOG_ROWS', 3):
            for old, new in ((many, []), ([], many)):
                with self.subTest(before=len(old)), self.assertRaisesRegex(RuntimeError, 'bounded row count'):
                    self.compare(old, new)

    def test_payload_memory_limit_counts_encoded_and_combined_columns(self):
        with patch.object(retention, 'MAX_LOG_ROW_BYTES', 256):
            for value in (row(1, START, feedback_log_body='x' * 257),
                          row(1, START, feedback_log_body='\U0001f680' * 80),
                          row(1, START, target='x' * 120, feedback_log_body='y' * 120)):
                with self.subTest(length=len(str(value))), self.assertRaisesRegex(RuntimeError, 'memory bound'):
                    self.compare([value], [value])

    def test_input_records_and_schema_are_unchanged(self):
        with database([row(1, 999), row(2, 1011)]) as before, database([row(2, 1011)]) as after:
            old = (list(before.iterdump()), list(after.iterdump()))
            retention.qualify_logs(before, after, START, END)
            self.assertEqual(old, (list(before.iterdump()), list(after.iterdump())))


@contextlib.contextmanager
def runtime_fixture():
    with tempfile.TemporaryDirectory(prefix='nova-log-retention-') as temporary, \
         contextlib.closing(sqlite3.connect(':memory:')) as shared:
        root = Path(temporary).resolve()
        assert root.is_relative_to(Path(tempfile.gettempdir()).resolve()) and root.name.startswith('nova-log-retention-')
        selected = Path('selected')
        project = root / selected / 'openclaw-runtime' / 'state' / 'npm' / 'projects' / 'openclaw-codex-0123456789'
        modules = project / 'node_modules'
        installed = modules / '@openclaw' / 'codex'
        packages = {
            installed / 'package.json': dict(name='@openclaw/codex', version='2026.9.6'),
            modules / '@openai' / 'codex' / 'package.json': dict(name='@openai/codex', version='0.155.1'),
            modules / '@openai' / 'codex-linux-x64' / 'package.json': dict(name='@openai/codex', version='0.155.1-linux-x64'),
        }
        for path, value in packages.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(value), encoding='utf-8')
        binary = modules / '@openai' / 'codex-linux-x64' / 'vendor' / 'x86_64-unknown-linux-musl' / 'bin' / 'codex'
        binary.parent.mkdir(parents=True)
        # Actual synthetic file/size/path; only its digest computation is
        # replaced. Sparse truncation avoids writing or hashing a real binary.
        with binary.open('wb') as stream:
            stream.truncate(retention.CODEX_BINARY_BYTES)
        record = dict(source='npm', spec='@openclaw/codex@2026.9.6', resolvedSpec='@openclaw/codex@2026.9.6',
            version='2026.9.6', resolvedVersion='2026.9.6', resolvedName='@openclaw/codex',
            installPath=str(installed), integrity='sha512-Zml4dHVyZQ==')
        index = dict(version=1, warning='', hostContractVersion='2026.9.6', compatRegistryVersion='a' * 64,
            migrationVersion=1, policyHash='b' * 64, generatedAtMs=1, installRecords={'codex': record},
            plugins=[], diagnostics=[])
        value = dict(revision=1, index=index)
        shared.execute('create table config_machine_state(state_key text, value_json text, updated_at_ms integer)')

        def save():
            shared.execute('delete from config_machine_state')
            shared.execute('insert into config_machine_state values(?,?,?)', ('plugins.installedIndex', json.dumps(value), 1))
            shared.commit()
        save()
        fixture = SimpleNamespace(root=root, selected=selected, shared=shared, record=record, value=value,
            packages=packages, binary=binary, save=save)
        with patch.object(retention.hashlib, 'file_digest', return_value=SimpleNamespace(
                hexdigest=lambda: retention.CODEX_BINARY_SHA256)) as digest:
            fixture.digest = digest
            yield fixture


@unittest.skipUnless(sys.platform == 'linux', 'Managed Linux runtime attestation requires POSIX file identity and links.')
class CodexRuntimeAttestationTests(unittest.TestCase):
    def attest(self, fixture):
        return retention.attest_runtime(fixture.root, fixture.selected, fixture.shared)

    def test_selected_runtime_packages_and_actual_binary_path_are_bound(self):
        with runtime_fixture() as fixture:
            proof = self.attest(fixture)
            self.assertEqual(proof['codexVersion'], '0.155.1')
            self.assertEqual(proof['binarySha256'], retention.CODEX_BINARY_SHA256)
            self.assertEqual(len(proof['packageSha256']), 3)
            self.assertNotIn(str(fixture.root), json.dumps(proof))
            self.assertEqual(Path(fixture.digest.call_args.args[0].name), fixture.binary)
            fixture.record['acceptedSurfaceHash'] = retention.CODEX_SURFACE
            fixture.save()
            self.assertEqual(self.attest(fixture), proof)

    def test_unreviewed_install_record_and_paths_are_refused(self):
        with runtime_fixture() as fixture:
            original = dict(fixture.record)
            changes = [('source', 'path'), ('spec', '@openclaw/codex@latest'), ('resolvedVersion', '2026.9.7'),
                ('resolvedName', '@other/codex'), ('sourcePath', '/unreviewed'), ('integrity', 'not-an-integrity'),
                ('acceptedSurfaceHash', 'c' * 64), ('installPath', str(fixture.root / 'outside')),
                ('installPath', original['installPath'] + '/../../@openclaw/codex')]
            for key, value in changes:
                with self.subTest(key=key, value=value):
                    fixture.record.clear(); fixture.record.update(original); fixture.record[key] = value; fixture.save()
                    with self.assertRaises(RuntimeError):
                        self.attest(fixture)
            self.assertEqual(fixture.digest.call_count, 0)

    def test_each_package_version_and_executable_identity_is_enforced(self):
        with runtime_fixture() as fixture:
            for path, original in fixture.packages.items():
                with self.subTest(package=path.parent.name):
                    path.write_text(json.dumps({**original, 'version': 'unreviewed'}), encoding='utf-8')
                    with self.assertRaisesRegex(RuntimeError, 'reviewed version'):
                        self.attest(fixture)
                    path.write_text(json.dumps(original), encoding='utf-8')
            fixture.digest.return_value = SimpleNamespace(hexdigest=lambda: '0' * 64)
            with self.assertRaisesRegex(RuntimeError, 'reviewed retention policy'):
                self.attest(fixture)
            with fixture.binary.open('r+b') as stream:
                stream.truncate(1)
            with self.assertRaisesRegex(RuntimeError, 'size changed'):
                self.attest(fixture)

    def test_plugin_index_is_bounded_unique_and_revision_bound(self):
        with runtime_fixture() as fixture:
            with patch.object(retention, 'MAX_INDEX_BYTES', 32), self.assertRaisesRegex(RuntimeError, 'exceeds its bound'):
                self.attest(fixture)
            fixture.value['revision'] = 2; fixture.save()
            with self.assertRaisesRegex(RuntimeError, 'revision is invalid'):
                self.attest(fixture)
            fixture.value['revision'] = 1; fixture.save()
            fixture.shared.execute('insert into config_machine_state select * from config_machine_state')
            with self.assertRaisesRegex(RuntimeError, 'ambiguous'):
                self.attest(fixture)

    def test_selected_directory_cannot_escape_workspace(self):
        with runtime_fixture() as fixture:
            for selected in (Path('..'), fixture.root):
                with self.subTest(selected=selected), self.assertRaisesRegex(RuntimeError, 'selected runtime authority'):
                    retention.attest_runtime(fixture.root, selected, fixture.shared)

    def test_actual_redirected_executable_is_refused(self):
        with runtime_fixture() as fixture:
            original = fixture.binary.with_name('original')
            fixture.binary.rename(original)
            try:
                os.symlink(original, fixture.binary)
            except (OSError, NotImplementedError):
                original.rename(fixture.binary)
                self.skipTest('Creating file symlinks requires host permission; Linux runs this case.')
            with self.assertRaisesRegex(RuntimeError, 'redirected'):
                self.attest(fixture)
            self.assertEqual(fixture.digest.call_count, 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
