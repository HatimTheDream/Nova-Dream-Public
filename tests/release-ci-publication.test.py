"""Private CI publication boundaries using local files and fake GitHub responses."""
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('ci_publisher', ROOT / 'scripts/publish-ci-release-artifact.py')
P = importlib.util.module_from_spec(spec); spec.loader.exec_module(P)
COMMIT = 'a' * 40
IDENTITY = {'commit': COMMIT, 'runId': 123, 'attempt': 1, 'repositoryId': 50}


def completed_step(name): return {'name': name, 'status': 'completed', 'conclusion': 'success'}


def api_fixture():
    prefix = '/repos/' + P.REPOSITORY
    quality = {'id': 101, 'name': 'quality', 'run_id': 123, 'head_sha': COMMIT,
               'status': 'completed', 'conclusion': 'success', 'steps': list(map(completed_step, P.QUALITY_STEPS))}
    producer = {'id': 102, 'name': 'release', 'run_id': 123, 'head_sha': COMMIT, 'status': 'in_progress',
                'conclusion': None, 'steps': [*map(completed_step, P.PRODUCER_STEPS),
                                            {'name': P.PUBLISH_STEP, 'status': 'in_progress', 'conclusion': None}]}
    run = {'id': 123, 'run_attempt': 1, 'head_sha': COMMIT, 'event': 'push', 'head_branch': 'main',
           'name': P.WORKFLOW_NAME, 'repository': {'id': 50}, 'head_repository': {'id': 50},
           'workflow_id': 10, 'status': 'in_progress'}
    return {prefix: {'id': 50, 'full_name': P.REPOSITORY, 'private': True},
            prefix + '/actions/runs/123/attempts/1': run,
            prefix + '/actions/workflows/10': {'id': 10, 'path': P.WORKFLOW, 'name': P.WORKFLOW_NAME},
            prefix + '/actions/runs/123/attempts/1/jobs?per_page=100': {'total_count': 2, 'jobs': [quality, producer]},
            prefix + '/releases/tags/nova-v2.9.6': {'id': 200, 'tag_name': 'nova-v2.9.6', 'target_commitish': COMMIT,
                                                  'draft': False, 'prerelease': False},
            prefix + '/git/ref/tags/nova-v2.9.6': {'object': {'type': 'commit', 'sha': COMMIT}},
            prefix + '/releases/200/assets?per_page=100': []}


def assets_fixture():
    stem = 'nova-ci-' + COMMIT + '-run-123'
    intent = {'name': stem + '.intent.json', 'bytes': 100, 'sha256': '1' * 64}
    specs = [{'name': stem + '-attempt-1.zip', 'bytes': 1000, 'sha256': '2' * 64},
             {'name': stem + '-attempt-1.transport.json', 'bytes': 500, 'sha256': '3' * 64}]
    return intent, specs


def asset(spec, number):
    return {'id': number, 'name': spec['name'], 'size': spec['bytes'], 'digest': 'sha256:' + spec['sha256'],
            'state': 'uploaded', 'uploader': {'login': 'github-actions[bot]', 'type': 'Bot'}}


class Publication(unittest.TestCase):
    def clock(self):
        value = [0.0]
        return value, lambda: value[0], lambda seconds: value.__setitem__(0, value[0] + seconds)

    def test_pending_producer_step_admission_wait_is_read_only_and_bounded(self):
        records = api_fixture(); value, clock, sleep = self.clock(); timeouts = []; polls = 0
        jobs_path = '/repos/' + P.REPOSITORY + '/actions/runs/123/attempts/1/jobs?per_page=100'
        def get(path, timeout):
            nonlocal polls
            timeouts.append(timeout); result = copy.deepcopy(records[path])
            if path == jobs_path:
                polls += 1
                if polls == 1: result['jobs'][1]['steps'][-2] = {'name': P.PRODUCER_STEPS[-1], 'status': 'in_progress', 'conclusion': None}
                elif polls == 2: result['jobs'][1]['steps'].pop()
            return result
        facts = P.wait_context(IDENTITY, get, clock=clock, sleep=sleep)
        self.assertEqual(facts[3]['id'], 102); self.assertEqual(polls, 3); self.assertEqual(value[0], 4)
        self.assertTrue(all(0 < timeout <= 5 for timeout in timeouts))

    def test_pending_provenance_deadline_does_not_reset(self):
        records = api_fixture(); value, clock, sleep = self.clock()
        jobs_path = '/repos/' + P.REPOSITORY + '/actions/runs/123/attempts/1/jobs?per_page=100'
        records[jobs_path]['jobs'][1]['steps'][-1]['status'] = 'pending'
        with self.assertRaisesRegex(RuntimeError, 'read-deadline'):
            P.wait_context(IDENTITY, lambda path, timeout: records[path], clock=clock, sleep=sleep)
        self.assertEqual(value[0], 30)

    def test_failed_step_or_changed_job_during_wait_refuses_immediately(self):
        jobs_path = '/repos/' + P.REPOSITORY + '/actions/runs/123/attempts/1/jobs?per_page=100'
        for conclusion in ('failure', 'cancelled', 'skipped'):
            records = api_fixture(); value, clock, sleep = self.clock()
            records[jobs_path]['jobs'][1]['steps'][-2].update(status='completed', conclusion=conclusion)
            with self.subTest(conclusion=conclusion), self.assertRaises(RuntimeError):
                P.wait_context(IDENTITY, lambda path, timeout: records[path], clock=clock, sleep=sleep)
            self.assertEqual(value[0], 0)
        for failed_index in (-2, -1):
            records = api_fixture(); value, clock, sleep = self.clock()
            steps = records[jobs_path]['jobs'][1]['steps']
            steps[0].update(status='in_progress', conclusion=None)
            steps[failed_index].update(status='completed', conclusion='failure')
            with self.subTest(mixed_failed_index=failed_index), self.assertRaises(RuntimeError) as caught:
                P.wait_context(IDENTITY, lambda path, timeout: records[path], clock=clock, sleep=sleep)
            self.assertNotIsInstance(caught.exception, P.ProvenancePending)
            self.assertEqual(value[0], 0)
        records = api_fixture(); value, clock, sleep = self.clock(); polls = 0
        def get(path, timeout):
            nonlocal polls
            result = copy.deepcopy(records[path])
            if path == jobs_path:
                polls += 1
                if polls == 1: result['jobs'][1]['steps'].pop()
                else: result['jobs'][1]['id'] = 103
            return result
        with self.assertRaisesRegex(RuntimeError, 'changed-while-waiting'):
            P.wait_context(IDENTITY, get, clock=clock, sleep=sleep)
        self.assertEqual(polls, 2); self.assertEqual(value[0], 2)

    def test_later_attempt_cannot_publish_even_when_remote_namespace_is_empty(self):
        P.write_attempt(IDENTITY, False)
        for attempt in (2, 3, 99):
            identity = {**IDENTITY, 'attempt': attempt}
            with self.subTest(attempt=attempt), self.assertRaisesRegex(RuntimeError, 'observation-only'):
                P.write_attempt(identity, False)
            P.write_attempt(identity, True)

    def test_readiness_alarm_is_disarmed_and_original_handler_restored(self):
        for outcome in ('success', 'failure', 'deadline'):
            records = api_fixture(); events = []; handlers = []; original = object()
            fake = types.SimpleNamespace(ITIMER_REAL=0, SIGALRM=14, getitimer=lambda _: (0.0, 0.0),
                                         getsignal=lambda _: original,
                                         setitimer=lambda which, seconds: events.append(('timer', seconds)))
            def set_handler(which, handler): handlers.append(handler); events.append(('handler', handler))
            fake.signal = set_handler
            def get(path, timeout):
                if outcome == 'deadline': handlers[0](14, None)
                if outcome == 'failure': raise RuntimeError('explicit-provenance-failure')
                return records[path]
            with self.subTest(outcome=outcome), patch.object(P, 'signal', fake):
                if outcome == 'success': P.wait_context(IDENTITY, get)
                else:
                    with self.assertRaises(RuntimeError): P.wait_context(IDENTITY, get)
            self.assertEqual(events[-2:], [('timer', 0), ('handler', original)])
            self.assertTrue(0 < events[1][1] <= 30)

    def test_trusted_main_environment_rejects_pr_manual_public_and_wrong_job(self):
        env = {'GITHUB_REPOSITORY': P.REPOSITORY, 'GITHUB_EVENT_NAME': 'push', 'GITHUB_REF': 'refs/heads/main',
               'GITHUB_JOB': 'release', 'GITHUB_WORKFLOW': P.WORKFLOW_NAME,
               'GITHUB_WORKFLOW_REF': P.REPOSITORY + '/' + P.WORKFLOW + '@refs/heads/main',
               'GITHUB_SHA': COMMIT, 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_REPOSITORY_ID': '50'}
        self.assertEqual(P.environment(env), IDENTITY)
        for field, value in [('GITHUB_EVENT_NAME', 'workflow_dispatch'), ('GITHUB_EVENT_NAME', 'pull_request'),
                             ('GITHUB_REF', 'refs/heads/feature'), ('GITHUB_JOB', 'quality'),
                             ('GITHUB_REPOSITORY', P.REPOSITORY + '-Public'), ('GITHUB_RUN_ATTEMPT', '0'),
                             ('GITHUB_SHA', 'A' * 40), ('GITHUB_WORKFLOW_REF', 'untrusted')]:
            with self.subTest(field=field, value=value), self.assertRaises(RuntimeError):
                P.environment({**env, field: value})

    def test_actual_job_identity_and_completed_quality_are_required(self):
        records = api_fixture(); P.context(IDENTITY, records.__getitem__)
        jobs_path = '/repos/' + P.REPOSITORY + '/actions/runs/123/attempts/1/jobs?per_page=100'
        for side, field, value in [(0, 'status', 'in_progress'), (0, 'conclusion', 'failure'),
                                    (1, 'status', 'completed'), (1, 'id', 101), (1, 'conclusion', 'failure'),
                                    (1, 'head_sha', 'b' * 40), (1, 'run_id', 456)]:
            changed = copy.deepcopy(records); changed[jobs_path]['jobs'][side][field] = value
            with self.subTest(side=side, field=field), self.assertRaises(RuntimeError):
                P.context(IDENTITY, changed.__getitem__)
        changed = copy.deepcopy(records); changed[jobs_path]['total_count'] = 3
        with self.assertRaises(RuntimeError): P.context(IDENTITY, changed.__getitem__)
        changed = copy.deepcopy(records); changed[jobs_path]['jobs'][1]['steps'][0]['conclusion'] = 'failure'
        with self.assertRaises(RuntimeError): P.context(IDENTITY, changed.__getitem__)
        changed = copy.deepcopy(records); changed[jobs_path]['jobs'][1]['status'] = 'completed'
        P.context(IDENTITY, changed.__getitem__, observe=True)

    def test_exact_release_and_complete_asset_enumeration(self):
        records = api_fixture(); P.release_identity('2.9.6', IDENTITY, records.__getitem__)
        with self.assertRaisesRegex(RuntimeError, 'release-version'):
            P.release_identity('../main', IDENTITY, records.__getitem__)
        prefix = '/repos/' + P.REPOSITORY
        for field, value in [('target_commitish', 'b' * 40), ('draft', True), ('prerelease', True), ('id', 0)]:
            changed = copy.deepcopy(records); changed[prefix + '/releases/tags/nova-v2.9.6'][field] = value
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                P.release_identity('2.9.6', IDENTITY, changed.__getitem__)
        changed = copy.deepcopy(records); changed[prefix + '/releases/200/assets?per_page=100'] = [{}] * 100
        with self.assertRaises(RuntimeError): P.release_identity('2.9.6', IDENTITY, changed.__getitem__)
        changed = copy.deepcopy(records); changed[prefix + '/git/ref/tags/nova-v2.9.6']['object']['type'] = 'tag'
        with self.assertRaises(RuntimeError): P.release_identity('2.9.6', IDENTITY, changed.__getitem__)

    def candidate(self, directory):
        raw = b'canonical-app\x00\x1a\r\n'
        metadata = {'archiveBytes': len(raw), 'archiveSha256': P.sha(raw)}
        values = {'app.tgz': raw, 'app.tgz.metadata.json': P.encoded(metadata), 'ci-source.json': P.encoded({'application': metadata})}
        for name, value in values.items(): (directory / name).write_bytes(value)
        return values

    def test_exact_candidate_files_zip_and_binary_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve(); directory = base / 'candidate'; directory.mkdir()
            values = self.candidate(directory); actual, _, _ = P.candidate_files(directory)
            self.assertEqual(actual, values)
            first = P.build_zip(actual, base / 'first.zip'); second = P.build_zip(actual, base / 'second.zip')
            self.assertEqual(first, second)
            with zipfile.ZipFile(base / 'first.zip') as zipped:
                self.assertEqual(set(zipped.namelist()), set(P.FILES))
                for name, value in values.items(): self.assertEqual(zipped.read(name), value)
            (directory / 'unexpected.log').write_bytes(b'not a candidate')
            with self.assertRaisesRegex(RuntimeError, 'exact-three'): P.candidate_files(directory)

    def test_storage_limit_and_linked_file_refused_before_effect(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve(); directory = base / 'candidate'; directory.mkdir(); self.candidate(directory)
            (directory / 'app.tgz').write_bytes(b'X' * (P.MAX_ZIP + 1))
            with self.assertRaises(RuntimeError): P.candidate_files(directory)
            (directory / 'app.tgz').write_bytes(b'original'); os.link(directory / 'app.tgz', base / 'linked')
            with self.assertRaisesRegex(RuntimeError, 'bounded-ordinary'): P.candidate_files(directory)

    def test_fresh_publication_has_three_single_posts_and_stable_final_ids(self):
        intent, specs = assets_fixture(); stored = []; calls = []
        def upload(spec):
            calls.append(spec['name']); row = asset(spec, len(stored) + 1); stored.append(row); return row
        result = P.publish_once(specs, intent, lambda: copy.deepcopy(stored), upload, lambda *_: self.fail('Fresh upload owns its own readback'))
        self.assertEqual(calls, [intent['name'], *[s['name'] for s in specs]])
        self.assertEqual(result, {name: i + 1 for i, name in enumerate(calls)})
        downloads = []
        P.publish_once(specs, intent, lambda: copy.deepcopy(stored), lambda _: self.fail('No replay'),
                       lambda a, s: downloads.append(a['id']))
        self.assertEqual(downloads, [1, 2, 3])

    def test_uncertain_post_at_each_phase_never_reposts_reserved_run(self):
        for fail_at in (1, 2, 3):
            intent, specs = assets_fixture(); stored = []; calls = []
            def upload(spec):
                calls.append(spec['name']); row = asset(spec, len(stored) + 1); stored.append(row)
                if len(calls) == fail_at: raise TimeoutError('Simulated lost response after remote acceptance')
                return row
            with self.subTest(fail_at=fail_at), self.assertRaises(TimeoutError):
                P.publish_once(specs, intent, lambda: copy.deepcopy(stored), upload, lambda *_: None)
            before = list(calls)
            if fail_at < 3:
                with self.assertRaisesRegex(RuntimeError, 'incomplete-observe-only'):
                    P.publish_once(specs, intent, lambda: copy.deepcopy(stored), lambda _: self.fail('Repeated POST'), lambda *_: None)
            else:
                P.publish_once(specs, intent, lambda: copy.deepcopy(stored), lambda _: self.fail('Repeated POST'), lambda *_: None)
            self.assertEqual(calls, before)

    def test_readback_failure_or_wrong_metadata_never_causes_write(self):
        intent, specs = assets_fixture(); stored = [asset(s, i + 1) for i, s in enumerate([intent, *specs])]
        for field, value in [('state', 'starter'), ('digest', None), ('size', 999), ('id', 0),
                             ('uploader', {'login': 'owner', 'type': 'User'})]:
            changed = copy.deepcopy(stored); changed[1][field] = value
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                P.publish_once(specs, intent, lambda: changed, lambda _: self.fail('Write after reservation'), lambda *_: None)
        def failed_readback(*_): raise RuntimeError('complete-readback-mismatch')
        with self.assertRaisesRegex(RuntimeError, 'readback-mismatch'):
            P.publish_once(specs, intent, lambda: stored, lambda _: self.fail('Write after failed readback'), failed_readback)

    def test_new_run_extra_assets_and_unreserved_partial_refused(self):
        intent, specs = assets_fixture(); valid = [asset(s, i + 1) for i, s in enumerate([intent, *specs])]
        other = asset({'name': 'nova-ci-another-run.intent.json', 'bytes': 1, 'sha256': 'f' * 64}, 99)
        for stored in ([valid[1]], [*valid, other], [other]):
            with self.assertRaises(RuntimeError):
                P.publish_once(specs, intent, lambda: stored, lambda _: self.fail('Unexpected POST'), lambda *_: None)
        with self.assertRaisesRegex(RuntimeError, 'cannot-create'):
            P.publish_once(specs, intent, lambda: [], lambda _: self.fail('Observe POST'), lambda *_: None, observe=True)
        oversized = copy.deepcopy(valid); oversized[1]['size'] = P.MAX_ZIP + 2 * P.MAX_CONTROL
        with self.assertRaisesRegex(RuntimeError, 'one-bounded-candidate'):
            P.publish_once(specs, intent, lambda: oversized, lambda _: self.fail('Over-budget POST'), lambda *_: None)
        next_attempt = copy.deepcopy(specs)
        for row in next_attempt: row['name'] = row['name'].replace('-attempt-1', '-attempt-2')
        with self.assertRaises(RuntimeError):
            P.publish_once(next_attempt, intent, lambda: valid, lambda _: self.fail('New-attempt replay'), lambda *_: None)

    def test_final_asset_replacement_refused(self):
        intent, specs = assets_fixture(); stored = [asset(s, i + 1) for i, s in enumerate([intent, *specs])]; reads = 0
        def refresh():
            nonlocal reads
            reads += 1; result = copy.deepcopy(stored)
            if reads > 1: result[1]['id'] = 999
            return result
        with self.assertRaisesRegex(RuntimeError, 'asset-id-changed'):
            P.publish_once(specs, intent, refresh, lambda _: self.fail('Unexpected POST'), lambda *_: None)

    def test_transport_explicitly_binds_distinct_producing_job_and_source_hashes(self):
        records = api_fixture(); facts = P.context(IDENTITY, records.__getitem__)
        release, _ = P.release_identity('2.9.6', IDENTITY, records.__getitem__)
        hashes = {k: str(i) * 64 for i, k in enumerate(('sha256', 'retainerSha256', 'workflowSha256', 'primitivesSha256'), 1)}
        value = P.transport(IDENTITY, facts, release, '2.9.6', hashes, {'name': 'candidate.zip', 'bytes': 50, 'sha256': 'a' * 64}, 'b' * 64)
        self.assertEqual(value['qualityJob'], {'id': 101, 'name': 'quality'})
        self.assertEqual(value['producerJob'], {'id': 102, 'name': 'release'})
        self.assertEqual(value['buildOrigin'], 'same-run-release-job'); self.assertFalse(value['deliveryQualification'])
        self.assertEqual(value['producer'], {'path': 'scripts/publish-ci-release-artifact.py', **hashes})
        self.assertLess(len(P.encoded(value)), P.MAX_CONTROL)

    def test_workflow_keeps_quality_read_only_and_public_storage_bounded(self):
        private = ROOT.parent / '.github/workflows/nova-release.yml'
        if private.exists():
            text = private.read_text(); quality, release = text.split('\n  release:', 1)
            self.assertIn('permissions:\n  contents: read', quality)
            self.assertNotIn('contents: write', quality); self.assertNotIn('actions/upload-artifact', quality)
            self.assertEqual(text.count('npm run quality'), 1)
            self.assertIn('needs: quality', release); self.assertIn('actions: read', release)
            self.assertIn("github.event_name == 'push' && github.ref == 'refs/heads/main'", release)
            self.assertIn('persist-credentials: false', release); self.assertIn('ref: ${{ github.sha }}', release)
            self.assertIn('timeout-minutes: 10', release)
            self.assertLess(release.index('Build the exact delivery candidate'), release.index('Publish the verified application archive'))
        else:
            text = (ROOT / '.github/workflows/quality.yml').read_text()
            self.assertIn('retention-days: 1', text); self.assertNotIn('retention-days: 7', text)
            self.assertIn('--maximum-bytes 16777216 --maximum-files 3', text)
            for name in ('Retain the canonical hosted build', 'Check bounded public candidate storage', 'Upload the verified application archive'):
                section = text.split('- name: ' + name + '\n', 1)[1].split('\n      - ', 1)[0]
                self.assertIn("github.event_name == 'push' && github.ref == 'refs/heads/main'", section)


if __name__ == '__main__': unittest.main(verbosity=2)
