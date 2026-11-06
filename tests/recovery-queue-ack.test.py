"""Checks for exact OpenClaw 9.8 acknowledgement expiry; all data is synthetic."""
import json
from pathlib import Path
import sqlite3
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy' / 'update-runner'))
import recovery as r


class QueueExpiry(unittest.TestCase):
    start = 1_800_000_000
    cutoff = start * 1000 - 2_592_000_000
    selected = Path('recovered-workspaces') / 'test'

    def setUp(self):
        self.before = sqlite3.connect(':memory:')
        self.after = sqlite3.connect(':memory:')
        for db in (self.before, self.after):
            self.addCleanup(db.close)
            db.execute(r.NATIVE_QUEUE_ACK_SQL)
        self.old = self.record('expired', self.cutoff - 1)
        self.survivor = self.record('current', self.cutoff + 100_000)
        self.save(self.before, self.survivor)
        self.save(self.after, self.survivor)

    @staticmethod
    def record(identity, stamp):
        document = {'id': identity, 'enqueuedAt': stamp, 'retryCount': 0, 'acknowledgedAt': stamp}
        return dict(queue_name='outbound', id=identity, status='completed', retry_count=0,
                    enqueued_at=stamp, updated_at=stamp, entry_json=json.dumps(document, separators=(',', ':')))

    @staticmethod
    def save(db, row):
        fields = list(row)
        db.execute('insert into delivery_queue_entries (' + ','.join(fields) + ') values (' +
                   ','.join('?' for _ in fields) + ')', [row[name] for name in fields])

    def prove(self):
        r.verify_ordinary_ack_expiry(self.before, self.after, r.rows(self.before, 'delivery_queue_entries'),
                                     r.rows(self.after, 'delivery_queue_entries'), self.start)

    def test_expired_ack_and_exact_survivor(self):
        self.save(self.before, self.old)
        self.prove()

    def test_refuse_cutoff_boundary_or_future(self):
        for stamp in (self.cutoff, self.cutoff + 1, self.start * 1000 + 1, 0, -1):
            with self.subTest(stamp=stamp):
                self.before.execute("delete from delivery_queue_entries where id='expired'")
                self.save(self.before, self.record('expired', stamp))
                with self.assertRaises(RuntimeError):
                    self.prove()

    def test_refuse_unfinished_claim_destination_or_compaction_policy(self):
        for key, values in {
            'status': ['pending', 'failed'], 'entry_kind': ['scheduled'], 'session_key': ['session'],
            'channel': ['channel'], 'target': ['target'], 'account_id': ['account'], 'last_error': ['error'],
            'recovery_state': ['completed_bounded', 'completed_permanent', 'unknown_after_send', 'staging_pending'],
            'last_attempt_at': [1], 'platform_send_started_at': [1], 'failed_at': [1],
            'retry_count': [1], 'updated_at': [self.cutoff - 2],
        }.items():
            for value in values:
                with self.subTest(key=key, value=value):
                    self.before.execute("delete from delivery_queue_entries where id='expired'")
                    self.save(self.before, {**self.old, key: value})
                    with self.assertRaises(RuntimeError):
                        self.prove()

    def test_refuse_unrecognized_document_or_rebound_identity(self):
        canonical = json.loads(self.old['entry_json'])
        texts = [json.dumps({**canonical, k: v}, separators=(',', ':')) for k, v in (
            ('message', 'saved'), ('to', 'target'), ('completionRetention', {}), ('scheduledAt', self.start),
            ('id', 'different'), ('retryCount', False), ('acknowledgedAt', self.cutoff))]
        texts.extend([self.old['entry_json'].replace('{"id":', '{"id":"duplicate","id":'), '{}'])
        for text in texts:
            with self.subTest(text=text):
                self.before.execute("delete from delivery_queue_entries where id='expired'")
                self.save(self.before, {**self.old, 'entry_json': text})
                with self.assertRaises(RuntimeError):
                    self.prove()

    def test_refuse_partial_purge_and_additions(self):
        self.save(self.before, self.old)
        extra = self.record('also-expired', self.cutoff - 5)
        self.save(self.before, extra)
        self.save(self.after, extra)
        with self.assertRaises(RuntimeError):
            self.prove()
        self.after.execute("delete from delivery_queue_entries where id='also-expired'")
        self.save(self.after, self.record('new', self.cutoff + 1))
        with self.assertRaises(RuntimeError):
            self.prove()

    def test_refuse_same_id_in_another_queue_and_changed_survivor(self):
        self.save(self.before, self.old)
        sibling = {**self.old, 'queue_name': 'scheduled', 'status': 'pending'}
        self.save(self.before, sibling)
        self.save(self.after, sibling)
        with self.assertRaises(RuntimeError):
            self.prove()
        for db in (self.before, self.after):
            db.execute("delete from delivery_queue_entries where queue_name='scheduled'")
        self.after.execute("update delivery_queue_entries set target='changed' where id='current'")
        with self.assertRaises(RuntimeError):
            self.prove()

    def test_refuse_schema_and_reference_changes(self):
        self.save(self.before, self.old)
        self.after.execute('alter table delivery_queue_entries add column unrelated TEXT')
        with self.assertRaises(RuntimeError):
            self.prove()
        self.after.execute('alter table delivery_queue_entries drop column unrelated')
        self.before.execute('create table external_reference(q text, i text, foreign key(q,i) references delivery_queue_entries(queue_name,id))')
        with self.assertRaises(RuntimeError):
            self.prove()

    def test_no_expiry_without_a_closed_hosted_role(self):
        self.save(self.before, self.old)
        for window in (None, (self.start, self.start + 94)):
            with self.subTest(window=window), self.assertRaises(RuntimeError):
                r.retained_queue_acknowledgements(self.before, self.after, self.selected /
                    'openclaw-runtime/state/state/openclaw.sqlite', self.selected, None, window)

    def test_equal_rows_keep_existing_containment(self):
        self.save(self.after, self.old)
        r.retained_queue_acknowledgements(self.before, self.after, Path('elsewhere'), self.selected, None, None)


if __name__ == '__main__':
    unittest.main()
