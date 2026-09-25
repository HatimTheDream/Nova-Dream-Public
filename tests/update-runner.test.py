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
        archive, expansion = self.runtime_archive()
        runtime = {'format': 1, 'fromVersion': '2026.9.2', 'toVersion': '2026.9.6', 'archiveBytes': archive.stat().st_size,
                   'archiveSha256': hashlib.sha256(archive.read_bytes()).hexdigest(), **expansion,
                   'nodeVersion': '24.21.0', 'nodeSha256': 'd' * 64}
        instance.from_engine, instance.to_engine = runtime['fromVersion'], runtime['toVersion']
        instance.pair, instance.release = {'runtime': runtime}, {'runtimeBundle': {'bytes': runtime['archiveBytes'], 'sha256': runtime['archiveSha256']}}
        instance.bundle, instance.runtime_root = self.root, self.root
        instance.agent = types.SimpleNamespace(is_symlink=lambda: True)
        instance.agent_node = types.SimpleNamespace(is_symlink=lambda: True, distinct=True)
        with patch.object(driver, 'protected'):
            instance.validate_runtime()
            instance.release['runtimeBundle']['sha256'] = 'e' * 64
            with self.assertRaises(RuntimeError):
                instance.validate_runtime()
            instance.release.pop('runtimeBundle')
            with self.assertRaises(RuntimeError):
                instance.validate_runtime()

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
        instance.migrate_runtime = lambda: (_ for _ in ()).throw(RuntimeError('migration rejected'))
        instance.switch = lambda path: actions.append('app-pointer')
        instance.restore_prior = lambda: actions.append('restore-engine-node-and-workspace')
        with patch.object(driver, 'snapshot_closed'), patch.object(driver, 'saved_state'), patch.object(driver, 'inventory', return_value=({}, {})), patch.object(driver.shutil, 'disk_usage', return_value=types.SimpleNamespace(free=10 ** 12)):
            instance.run()
        self.assertEqual(actions, ['stop', 'select-new-engine-and-node', 'restore-engine-node-and-workspace'])
        self.assertTrue(instance.switch_attempted)

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
