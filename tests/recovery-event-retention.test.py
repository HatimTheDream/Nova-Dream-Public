"""Synthetic closed-copy proofs for pinned native startup event retention."""
import contextlib
import hashlib
import json
import pathlib
import sqlite3
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'deploy/update-runner'))
import recovery

START = 2000000000000
END = START + 20000
CUTOFF = START - 2592000000
SELECTED = pathlib.Path('selected')
RELATIVE = SELECTED / 'openclaw-runtime/state/state/openclaw.sqlite'


@contextlib.contextmanager
def pair():
    with contextlib.closing(sqlite3.connect(':memory:')) as before, contextlib.closing(sqlite3.connect(':memory:')) as after:
        for db in (before, after):
            db.executescript(recovery.NATIVE_EVENT_RETENTION_SQL)
        yield before, after


def audit(db, sequence, occurred):
    db.execute('insert into audit_events(sequence,event_id,source_id,source_sequence,occurred_at,kind,action,status,actor_type,actor_id) '
               'values(?,?,?,?,?,?,?,?,?,?)', (sequence, 'e'+str(sequence), 's'+str(sequence), sequence, occurred,
                                              'run', 'agent.run.finished', 'completed', 'user', 'synthetic'))


def event(db, sequence, occurred, key='session'):
    db.execute('insert into session_state_events(sequence,session_key,agent_id,kind,actor_type,occurred_at,summary) '
               'values(?,?,?,?,?,?,?)', (sequence, key, 'agent', 'created', 'user', occurred, 'saved metadata'))


def fixture(before, after):
    for db in (before, after):
        audit(db, 1, CUTOFF-1)
        audit(db, 2, END)
        event(db, 1, CUTOFF-1)
        event(db, 2, END)
        db.execute('insert into session_state_heads values(?,?,?,?,?)', ('session', 'agent', 2, 0, 1))
    after.execute('delete from audit_events where sequence=1')
    after.execute('delete from session_state_events where sequence=1')
    after.execute('update session_state_heads set pruned_max_sequence=1,updated_at=?', (START+5000,))


def qualify(before, after, **options):
    args = dict(relative=RELATIVE, selected=SELECTED, runtime_root='/unused', startup_window=(START/1000, END/1000))
    args.update(options)
    with patch.object(recovery, 'attest_native_event_retention') as attest:
        result = recovery.retained_native_event_history(before, after, **args)
    return result, attest.call_count


class RetentionTests(unittest.TestCase):
    def test_exact_age_prune_preserves_survivors_and_head(self):
        with pair() as (before, after):
            fixture(before, after)
            result, calls = qualify(before, after)
            self.assertEqual(result, {'audit_events', 'session_state_events', 'session_state_heads'})
            self.assertEqual(calls, 1)
            self.assertEqual(after.execute('select summary from session_state_events').fetchone(), ('saved metadata',))

    def test_unchanged_tables_keep_original_path_without_runtime_prerequisite(self):
        with pair() as (before, after):
            self.assertEqual(qualify(before, after, startup_window=None, runtime_root=None), (frozenset(), 0))

    def test_complete_repeated_audit_batches_not_arbitrary_expired_subset(self):
        with pair() as (before, after):
            for db in (before, after):
                for i in range(1, 2051): audit(db, i, CUTOFF-100-i)
            after.execute('delete from audit_events where sequence>1')
            with self.assertRaisesRegex(RuntimeError, 'complete settled'): qualify(before, after)
            after.execute('delete from audit_events')
            self.assertEqual(len(qualify(before, after)[0]), 3)

    def test_cutoff_is_strict_and_boundary_ambiguity_refuses(self):
        for occurred in (CUTOFF, CUTOFF+1, END-2592000000-1):
            with self.subTest(occurred=occurred), pair() as (before, after):
                fixture(before, after)
                for db in (before, after): db.execute('update audit_events set occurred_at=? where sequence=2', (occurred,))
                with self.assertRaisesRegex(RuntimeError, 'boundary'): qualify(before, after)

    def test_expiry_at_exact_zero_width_cutoff_is_retained(self):
        with pair() as (before, after):
            for db in (before, after):
                audit(db, 1, CUTOFF-1)
                audit(db, 2, CUTOFF)
            after.execute('delete from audit_events where sequence=1')
            qualify(before, after, startup_window=(START/1000, START/1000))
            after.execute('delete from audit_events where sequence=2')
            with self.assertRaisesRegex(RuntimeError, 'complete settled'): qualify(before, after, startup_window=(START/1000, START/1000))

    def test_unexpired_deletion_and_changed_audit_content_refuse(self):
        for statement in ('delete from audit_events where sequence=2', "update audit_events set action='different' where sequence=2",
                          'delete from session_state_events where sequence=2', "update session_state_events set summary='lost' where sequence=2"):
            with self.subTest(statement=statement), pair() as (before, after):
                fixture(before, after)
                after.execute(statement)
                with self.assertRaises(RuntimeError): qualify(before, after)

    def test_intermediate_insert_even_when_removed_refuses(self):
        for table in ('audit', 'session'):
            with self.subTest(table=table), pair() as (before, after):
                fixture(before, after)
                if table == 'audit': audit(after, 3, CUTOFF-1)
                else: event(after, 3, CUTOFF-1)
                after.execute('delete from '+('audit_events' if table=='audit' else 'session_state_events')+' where sequence=3')
                with self.assertRaisesRegex(RuntimeError, 'intermediate insert'): qualify(before, after)

    def test_wrong_head_watermark_time_or_saved_field_refuses(self):
        for field, value in [('pruned_max_sequence', 2), ('updated_at', END+1), ('updated_at', START-1), ('last_sequence', 3)]:
            with self.subTest(field=field, value=value), pair() as (before, after):
                fixture(before, after)
                after.execute('update session_state_heads set '+field+'=?', (value,))
                with self.assertRaises(RuntimeError): qualify(before, after)

    def test_existing_watermark_does_not_allow_timestamp_refresh(self):
        with pair() as (before, after):
            fixture(before, after)
            before.execute('update session_state_heads set pruned_max_sequence=1')
            with self.assertRaisesRegex(RuntimeError, 'retained head'): qualify(before, after)
            after.execute('update session_state_heads set updated_at=1')
            qualify(before, after)

    def test_global_sequence_cap_and_watermarks(self):
        with pair() as (before, after):
            values = [(i, 'a' if i % 2 else 'b', 'agent', 'created', 'user', END, 'metadata') for i in range(1, 50003)]
            for db in (before, after):
                db.executemany('insert into session_state_events(sequence,session_key,agent_id,kind,actor_type,occurred_at,summary) values(?,?,?,?,?,?,?)', values)
                db.executemany('insert into session_state_heads values(?,?,?,?,?)', [('a','agent',50001,0,1),('b','agent',50002,0,1)])
            after.execute('delete from session_state_events where sequence<=2')
            after.execute("update session_state_heads set pruned_max_sequence=case session_key when 'a' then 1 else 2 end,updated_at=?", (START+1,))
            qualify(before, after)
            after.execute('delete from session_state_events where sequence=3')
            with self.assertRaisesRegex(RuntimeError, 'global-count'): qualify(before, after)

    def test_missing_or_added_head_refuses(self):
        with pair() as (before, after):
            fixture(before, after)
            after.execute('delete from session_state_heads')
            with self.assertRaisesRegex(RuntimeError, 'heads were'): qualify(before, after)

    def test_changed_schema_or_trigger_refuses(self):
        for statement in ('alter table audit_events add column unexpected TEXT',
                          'create trigger extra after delete on audit_events begin select 1; end'):
            with self.subTest(statement=statement), pair() as (before, after):
                fixture(before, after)
                for db in (before, after): db.execute(statement)
                with self.assertRaisesRegex(RuntimeError, 'schema|trigger'): qualify(before, after)

    def test_wrong_namespace_missing_or_nonfinite_window_refuses(self):
        for options in ({'relative': pathlib.Path('other/openclaw.sqlite')}, {'startup_window': None},
                        {'startup_window': (float('nan'), 2)}, {'startup_window': (3, 2)},
                        {'startup_window': (START/1000, START/1000 + 3601)}):
            with self.subTest(options=options), pair() as (before, after):
                fixture(before, after)
                with self.assertRaises(RuntimeError): qualify(before, after, **options)

    def test_permission_tables_remain_in_retained_contract(self):
        for name in ('audit_events','session_state_events','session_state_heads','audit_identity_keys','operator_approval_standing_grants','device_auth_tokens'):
            self.assertIn(name, recovery.NATIVE_RETAINED_TABLES)
            self.assertNotIn(name, recovery.NATIVE_TRANSIENT_TABLES)


class RuntimeAuthorityTests(unittest.TestCase):
    def test_source_hash_version_and_redirect_are_checked(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary).resolve() / 'openclaw-2026.9.8-123456abcdef/node_modules/openclaw'
            (root/'dist').mkdir(parents=True)
            (root/'package.json').write_text(json.dumps({'name':'openclaw','version':'2026.9.8'}))
            (root/'dist/proof.mjs').write_bytes(b'fixed source')
            pins = {'proof.mjs': hashlib.sha256(b'fixed source').hexdigest()}
            # Synthetic source bytes need no privileged filesystem placement.
            # Only this fixture omits the production POSIX ownership predicate.
            with patch.dict(recovery.NATIVE_EVENT_RETENTION_SOURCES, pins, clear=True), patch.object(recovery, 'os', SimpleNamespace(name='fixture')):
                recovery.attest_native_event_retention(root)
                (root/'dist/proof.mjs').write_bytes(b'changed source')
                with self.assertRaisesRegex(RuntimeError, 'implementation'): recovery.attest_native_event_retention(root)
                (root/'dist/proof.mjs').write_bytes(b'fixed source')
                (root/'package.json').write_text(json.dumps({'name':'openclaw','version':'2026.9.6'}))
                with self.assertRaisesRegex(RuntimeError, 'identity'): recovery.attest_native_event_retention(root)
            with self.assertRaisesRegex(RuntimeError, 'outside'): recovery.attest_native_event_retention(root/'dist')


if __name__ == '__main__': unittest.main()
