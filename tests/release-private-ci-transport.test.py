"""Exercise the actual read-only transport contracts with synthetic API responses."""
import copy
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
import urllib.error
import zipfile
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('private_ci_transport', ROOT / 'scripts/release-artifact-primitives.py')
M = importlib.util.module_from_spec(spec); spec.loader.exec_module(M)


class PrivateTransportTests(unittest.TestCase):
    def setUp(self):
        self.prefix = '/repos/HatimTheDream/Nova-Dream'
        self.selected = {'sourceCommit': 'a' * 40, 'runId': 123, 'runAttempt': 2}
        self.repo = {'id': 42, 'full_name': 'HatimTheDream/Nova-Dream', 'private': True}
        self.run = {'id': 123, 'run_attempt': 2, 'head_sha': 'a' * 40, 'event': 'push', 'head_branch': 'main',
                    'status': 'completed', 'conclusion': 'success', 'name': M.REPOS['Nova-Dream'][3],
                    'repository': copy.deepcopy(self.repo), 'head_repository': copy.deepcopy(self.repo), 'workflow_id': 7}
        self.workflow = {'id': 7, 'path': M.REPOS['Nova-Dream'][2], 'name': self.run['name']}
        self.jobs = {'total_count': 2, 'jobs': []}
        for name, identity, names in (('quality', 10, M.REQUIRED_STEPS[:2]), ('release', 11, M.PRIVATE_PRODUCER_STEPS)):
            self.jobs['jobs'].append({'id': identity, 'name': name, 'run_id': 123, 'head_sha': 'a' * 40,
                'status': 'completed', 'conclusion': 'success', 'started_at': '2026-10-19T20:00:00Z',
                'completed_at': '2026-10-19T20:05:00Z', 'steps': [
                    {'number': i + 1, 'name': step, 'status': 'completed', 'conclusion': 'success'} for i, step in enumerate(names)]})
        self.release = {'id': 80, 'tag_name': 'nova-v2.9.6', 'target_commitish': 'a' * 40, 'draft': False, 'prerelease': False}
        self.gitref = {'object': {'type': 'commit', 'sha': 'a' * 40}}
        self.raw = b'synthetic full ZIP bytes, no archive verifier claim'
        stem = 'nova-ci-' + 'a' * 40 + '-run-123-attempt-2'
        self.assets = [self.asset(81, stem + '.zip', self.raw), self.asset(82, stem + '.transport.json', b'{}')]
        self.bound = {name: {'sha256': str(index) * 64} for index, name in enumerate(
            (M.PRIVATE_PRODUCER, M.PRIVATE_PRIMITIVES, 'scripts/retain-ci-candidate.py', 'workflow'), 1)}
        self.calls = []

    def asset(self, identity, name, raw):
        return {'id': identity, 'name': name, 'size': len(raw), 'state': 'uploaded', 'digest': 'sha256:' + M.sha(raw),
                'url': 'https://api.github.com' + self.prefix + '/releases/assets/' + str(identity),
                'created_at': '2026-10-19T20:01:00Z', 'updated_at': '2026-10-19T20:02:00Z',
                'uploader': {'login': 'github-actions[bot]', 'type': 'Bot'}}

    def api(self, path, token):
        self.assertEqual(token, 'synthetic-token')
        self.calls.append(path)
        routes = {self.prefix: self.repo,
                  self.prefix + '/actions/runs/123/attempts/2': self.run,
                  self.prefix + '/actions/workflows/7': self.workflow,
                  self.prefix + '/actions/runs/123/attempts/2/jobs?per_page=100': self.jobs,
                  self.prefix + '/releases/tags/nova-v2.9.6': self.release,
                  self.prefix + '/git/ref/tags/nova-v2.9.6': self.gitref,
                  self.prefix + '/releases/80/assets?per_page=100': self.assets}
        self.assertIn(path, routes)
        return copy.deepcopy(routes[path])

    def collect(self):
        with patch.object(M, 'api', side_effect=self.api):
            return M.exact_private_release(self.selected, '2.9.6', 'synthetic-token')

    def manifest(self, snapshot):
        return {'format': 1, 'kind': 'private-ci-release-artifact', 'repository': snapshot['repository'],
            'sourceCommit': self.selected['sourceCommit'], 'version': '2.9.6', 'run': snapshot['run'],
            'qualityJob': snapshot['qualityJob'], 'producerJob': snapshot['producerJob'],
            'producer': {'path': M.PRIVATE_PRODUCER, 'sha256': '1' * 64, 'primitivesSha256': '2' * 64,
                         'retainerSha256': '3' * 64, 'workflowSha256': '4' * 64}, 'release': snapshot['release'],
            'archive': {'name': self.assets[0]['name'], 'bytes': len(self.raw), 'sha256': M.sha(self.raw)},
            'ciSourceSha256': M.sha(b'producer'), 'buildOrigin': 'same-run-release-job', 'deliveryQualification': False}

    def test_exact_success_binds_distinct_quality_and_producer_without_actions_artifact_lookup(self):
        value = self.collect()
        self.assertEqual(value['qualityJob']['id'], 10)
        self.assertEqual(value['producerJob']['id'], 11)
        self.assertEqual(value['assets']['archive']['id'], 81)
        self.assertFalse(any('/artifacts' in path for path in self.calls))
        self.assertEqual(len(self.calls), 7)

    def test_failed_or_wrong_run_never_reads_assets(self):
        for field, value in [('status', 'in_progress'), ('conclusion', 'failure'), ('head_sha', 'b' * 40),
                             ('run_attempt', 1), ('event', 'workflow_dispatch'), ('head_branch', 'feature')]:
            with self.subTest(field=field):
                original = self.run[field]; self.run[field] = value; self.calls.clear()
                with self.assertRaisesRegex(RuntimeError, 'private-ci-run-not-successful'): self.collect()
                self.assertFalse(any('/assets?' in path for path in self.calls)); self.run[field] = original
        self.run['head_repository']['id'] = 99
        with self.assertRaisesRegex(RuntimeError, 'private-ci-run-not-successful'): self.collect()

    def test_public_repository_and_wrong_workflow_are_refused(self):
        self.repo['private'] = False
        with self.assertRaisesRegex(RuntimeError, 'private-ci-repository'): self.collect()
        self.repo['private'] = True; self.workflow['path'] = '.github/workflows/other.yml'
        with self.assertRaisesRegex(RuntimeError, 'private-ci-workflow'): self.collect()

    def test_both_jobs_and_every_required_step_must_pass(self):
        for job in self.jobs['jobs']:
            for field, bad in [('conclusion', 'failure'), ('status', 'in_progress'), ('head_sha', 'b' * 40), ('run_id', 999)]:
                with self.subTest(job=job['name'], field=field):
                    previous = job[field]; job[field] = bad
                    with self.assertRaisesRegex(RuntimeError, 'private-ci-jobs-not-successful'): self.collect()
                    job[field] = previous
            for step in job['steps']:
                step['conclusion'] = 'skipped'
                with self.assertRaisesRegex(RuntimeError, 'private-ci-required-step'): self.collect()
                step['conclusion'] = 'success'
        self.jobs['jobs'][1]['id'] = 10
        with self.assertRaisesRegex(RuntimeError, 'private-ci-job-identity'): self.collect()

    def test_incomplete_or_ambiguous_jobs_cannot_pass(self):
        self.jobs['total_count'] = 3
        with self.assertRaisesRegex(RuntimeError, 'private-ci-jobs-not-successful'): self.collect()
        self.jobs['jobs'].append(copy.deepcopy(self.jobs['jobs'][1]))
        with self.assertRaisesRegex(RuntimeError, 'private-ci-job-ambiguous'): self.collect()

    def test_source_release_and_lightweight_tag_must_match_exact_commit(self):
        for field, bad in [('target_commitish', 'main'), ('tag_name', 'nova-v2.9.5'), ('draft', True), ('prerelease', True)]:
            previous = self.release[field]; self.release[field] = bad
            with self.assertRaisesRegex(RuntimeError, 'private-ci-release-identity'): self.collect()
            self.release[field] = previous
        self.gitref['object']['type'] = 'tag'
        with self.assertRaisesRegex(RuntimeError, 'private-ci-tag-identity'): self.collect()

    def test_assets_require_exact_names_digest_bot_and_producer_lifetime(self):
        for field, bad in [('digest', None), ('state', 'starter'), ('size', M.PRIVATE_ZIP_MAXIMUM + 1),
                           ('url', 'https://example.invalid/file'), ('uploader', {'login': 'owner', 'type': 'User'})]:
            previous = self.assets[0][field]; self.assets[0][field] = bad
            with self.assertRaisesRegex(RuntimeError, 'private-ci-asset-identity'): self.collect()
            self.assets[0][field] = previous
        for field, bad in [('created_at', '2026-10-19T19:00:00Z'), ('updated_at', '2026-10-19T20:06:00Z')]:
            previous = self.assets[0][field]; self.assets[0][field] = bad
            with self.assertRaisesRegex(RuntimeError, 'private-ci-asset-job-time'): self.collect()
            self.assets[0][field] = previous
        self.assets.append(copy.deepcopy(self.assets[0]))
        with self.assertRaisesRegex(RuntimeError, 'private-ci-asset-ambiguous'): self.collect()

    def test_partial_final_assets_and_incomplete_listing_never_pass(self):
        transport = self.assets.pop()
        with self.assertRaisesRegex(RuntimeError, 'private-ci-asset-ambiguous'): self.collect()
        self.assets.append(transport)
        self.assets.extend(copy.deepcopy(self.assets[0]) for _ in range(98))
        with self.assertRaisesRegex(RuntimeError, 'private-ci-assets-incomplete'): self.collect()

    def test_private_zip_member_expansion_bound_is_checked_before_extracting(self):
        raw = io.BytesIO()
        with zipfile.ZipFile(raw, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('app.tgz', b'x' * 33)
            archive.writestr('app.tgz.metadata.json', b'{}')
            archive.writestr('ci-source.json', b'{}')
        with tempfile.TemporaryDirectory(prefix='nova-private-zip-limit-') as temporary:
            output = pathlib.Path(temporary)
            with self.assertRaisesRegex(RuntimeError, 'Unsafe or oversized ZIP member'):
                M.extract_zip(raw.getvalue(), output, maximum=32)
            self.assertEqual(list(output.iterdir()), [])

    def test_manifest_binds_producer_git_bytes_and_every_identity(self):
        snapshot = self.collect(); value = self.manifest(snapshot)
        self.assertEqual(M.validate_private_transport(json.dumps(value).encode(), snapshot, self.bound, self.selected,
                                                     '2.9.6', b'producer'), value)
        for path, bad in [(('sourceCommit',), 'b' * 40), (('run', 'attempt'), 3), (('qualityJob', 'id'), 12),
                           (('producerJob', 'id'), 10), (('repository', 'private'), False), (('archive', 'sha256'), '0' * 64),
                           (('producer', 'sha256'), '0' * 64), (('producer', 'primitivesSha256'), '0' * 64),
                           (('producer', 'retainerSha256'), '0' * 64), (('producer', 'workflowSha256'), '0' * 64),
                           (('buildOrigin',), 'quality-job'), (('deliveryQualification',), True)]:
            changed = copy.deepcopy(value); parent = changed
            for key in path[:-1]: parent = parent[key]
            parent[path[-1]] = bad
            with self.subTest(path=path), self.assertRaisesRegex(RuntimeError, 'private-ci-transport-binding'):
                M.validate_private_transport(json.dumps(changed).encode(), snapshot, self.bound, self.selected, '2.9.6')
        with self.assertRaisesRegex(RuntimeError, 'private-ci-producer-receipt-changed'):
            M.validate_private_transport(json.dumps(value).encode(), snapshot, self.bound, self.selected, '2.9.6', b'changed')

    def test_actual_publisher_transport_function_matches_collector_contract(self):
        definition = importlib.util.spec_from_file_location('actual_private_ci_publisher', ROOT / 'scripts/publish-ci-release-artifact.py')
        publisher = importlib.util.module_from_spec(definition); definition.loader.exec_module(publisher)
        snapshot = self.collect()
        identity = {'commit': self.selected['sourceCommit'], 'runId': 123, 'attempt': 2}
        hashes = {'sha256': '1' * 64, 'primitivesSha256': '2' * 64, 'retainerSha256': '3' * 64, 'workflowSha256': '4' * 64}
        archive = {'name': self.assets[0]['name'], 'bytes': len(self.raw), 'sha256': M.sha(self.raw)}
        manifest = publisher.transport(identity, (self.repo, self.run, *self.jobs['jobs']), self.release, '2.9.6', hashes, archive, M.sha(b'producer'))
        self.assertEqual(M.validate_private_transport(publisher.encoded(manifest), snapshot, self.bound, self.selected,
                                                     '2.9.6', b'producer'), manifest)

    def test_download_redirect_never_forwards_api_credentials_and_hashes_full_bytes(self):
        seen = []
        class Response(io.BytesIO):
            status = 200
        class Opener:
            def open(inner, request, timeout):
                seen.append(request)
                if len(seen) == 1:
                    raise urllib.error.HTTPError(request.full_url, 302, 'redirect',
                        {'Location': 'https://release-assets.githubusercontent.com/example?signed=not-persisted'}, None)
                return Response(self.raw)
        with patch.object(M.urllib.request, 'build_opener', return_value=Opener()):
            result = M.download_release_asset(self.assets[0], 'synthetic-secret', M.PRIVATE_ZIP_MAXIMUM)
        self.assertEqual(result, self.raw)
        self.assertEqual(seen[0].get_header('Authorization'), 'Bearer synthetic-secret')
        self.assertIsNone(seen[1].get_header('Authorization'))
        self.assertEqual(seen[0].get_method(), 'GET'); self.assertEqual(seen[1].get_method(), 'GET')

    def test_download_rejects_untrusted_redirect_short_hash_and_oversized_body(self):
        class Response(io.BytesIO): status = 200
        for raw in (self.raw[:-1], b'x' * len(self.raw), self.raw + b'x'):
            opener = type('Opener', (), {'open': lambda *args, **kwargs: Response(raw)})()
            with patch.object(M.urllib.request, 'build_opener', return_value=opener), self.assertRaisesRegex(RuntimeError, 'private-ci-download-(corrupt|oversize)'):
                M.download_release_asset(self.assets[0], 'synthetic-secret', M.PRIVATE_ZIP_MAXIMUM)
        opener = type('Opener', (), {'open': lambda *args, **kwargs: (_ for _ in ()).throw(
            urllib.error.HTTPError('https://api.github.com', 302, 'redirect', {'Location': 'https://example.invalid/private'}, None))})()
        with patch.object(M.urllib.request, 'build_opener', return_value=opener), self.assertRaisesRegex(RuntimeError, 'private-ci-download-origin'):
            M.download_release_asset(self.assets[0], 'synthetic-secret', M.PRIVATE_ZIP_MAXIMUM)

    def test_read1_deadline_rejects_dribbling_body(self):
        class Response(io.BytesIO): status = 200
        response = Response(self.raw)
        opener = type('Opener', (), {'open': lambda *args, **kwargs: response})()
        with patch.object(M.urllib.request, 'build_opener', return_value=opener), patch.object(M.time, 'monotonic', side_effect=[0, 1, 121]), \
             self.assertRaisesRegex(RuntimeError, 'private-ci-download-deadline'):
            M.download_release_asset(self.assets[0], 'synthetic-secret', M.PRIVATE_ZIP_MAXIMUM)
        self.assertTrue(response.closed)


if __name__ == '__main__': unittest.main()
