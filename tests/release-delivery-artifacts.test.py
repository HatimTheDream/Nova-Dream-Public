"""No Git, credentials, network, runtime launch or host effects."""
import importlib.util
import io
import json
import os
import pathlib
import tempfile
import threading
import types
import unittest
import uuid
import zipfile
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parent.parent
definition = importlib.util.spec_from_file_location('delivery_artifacts', ROOT / 'scripts/release-delivery-artifacts.py')
D = importlib.util.module_from_spec(definition); definition.loader.exec_module(D)


class ArtifactProducerTests(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory(prefix='nova-delivery-artifacts-')
        self.addCleanup(temporary.cleanup)
        key = str(uuid.uuid4()); root = pathlib.Path(temporary.name).resolve() / ('delivery-artifacts-' + key)
        executable = ROOT / 'scripts/release-delivery-artifacts.py'
        tool = {'path': str(executable), 'sha256': D.C.sha(executable.read_bytes())}
        request = {'format': 1, 'operationId': str(uuid.uuid4()), 'key': key, 'inputSha256': 'a' * 64, 'version': '2.3.1', 'buildVersion': '1.0.288',
                   'sources': {}, 'ci': {}, 'outputDirectory': str(root), 'helperHashes': {n: D.C.sha((ROOT / 'scripts' / n).read_bytes()) for n in ('release-delivery-artifacts.py', 'release-artifact-primitives.py')},
                   'tools': {'git': tool, 'node': tool, 'python': tool, 'ciNodeSha256': 'f' * 64, 'nodeToolchain': {'nodeVersion': '22.23.2', 'platform': 'win32', 'arch': 'x64'}}}
        bound = {'scripts/update-app-archive.py': {'sha256': 'b' * 64}, 'scripts/candidate.mjs': {'sha256': 'c' * 64},
                 D.C.PRIVATE_PRODUCER: {'sha256': '1' * 64}, D.C.PRIVATE_PRIMITIVES: {'sha256': '2' * 64},
                 'scripts/retain-ci-candidate.py': {'sha256': '3' * 64}, 'workflow': {'sha256': '4' * 64}}
        zips = {}
        for side, repo, commit in [('private', 'Nova-Dream', 'd' * 40), ('public', 'Nova-Dream-Public', 'e' * 40)]:
            request['sources'][side] = {'repository': 'HatimTheDream/' + repo, 'commit': commit, 'root': str(ROOT)}
            request['ci'][side] = {'sourceCommit': commit, 'runId': 123 if side == 'private' else 124, 'runAttempt': 1}
            archive = b'synthetic archive; actual verification is explicitly mocked in this orchestration test'
            metadata = {'format': 1, 'version': '2.3.1', 'buildVersion': '1.0.288', 'schemaVersion': 1, 'apiVersion': 1, 'candidateId': 'a' * 64,
                        'archiveBytes': len(archive), 'archiveSha256': D.C.sha(archive), 'expandedBytes': 1, 'fileCount': 1, 'packageLockSha256': 'b' * 64}
            receipt = {'format': 1, 'kind': 'canonical-ci-built-candidate', 'sourceCommit': commit, 'repository': 'HatimTheDream/' + repo,
                       'runId': str(request['ci'][side]['runId']), 'runAttempt': '1', 'toolchain': {'nodeVersion': '22.23.2', 'platform': 'linux', 'arch': 'x64'},
                       'nodeSha256': 'f' * 64, 'packagerSha256': 'b' * 64, 'candidateVerifierSha256': 'c' * 64, 'application': metadata, 'rebuilt': False, 'deliveryQualification': False}
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, 'w') as archive_file:
                for name, raw in {'app.tgz': archive, 'app.tgz.metadata.json': json.dumps(metadata).encode(), 'ci-source.json': json.dumps(receipt).encode()}.items():
                    archive_file.writestr(name, raw)
            zips[repo] = stream.getvalue()
        def frozen(repo, commit, git, **kwargs):
            path = root / ('frozen-source-' + repo + '-' + commit)
            if not path.exists(): path.mkdir()
            return path, bound
        def exact(repo, selected, token):
            self.assertEqual(token, 'synthetic-token-never-external')
            raw = zips[repo]
            return '/repos/HatimTheDream/' + repo, {'workflow_id': 1}, {'id': 2}, [], {'id': selected['runId'], 'size_in_bytes': len(raw), 'digest': 'sha256:' + D.C.sha(raw)}
        def verify(source, bounds, output, metadata, node, **kwargs):
            path = output / 'verified-application'
            if not kwargs['verify_existing']: path.mkdir()
            return {'id': metadata['candidateId']}
        return request, zips, frozen, exact, verify

    def private_fixture(self):
        request, zips, frozen, exact, verify = self.fixture()
        request['ci']['private'].update(transport='private-release-asset', releaseId=80)
        selected = request['ci']['private']; commit = selected['sourceCommit']
        stem = f'nova-ci-{commit}-run-{selected["runId"]}-attempt-1'
        raw = zips['Nova-Dream']
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            source_hash = D.C.sha(archive.read('ci-source.json'))
        snapshot = {'repository': {'id': 42, 'fullName': 'HatimTheDream/Nova-Dream', 'private': True},
                    'run': {'id': selected['runId'], 'attempt': 1, 'workflowId': 7,
                            'workflowPath': '.github/workflows/nova-release.yml', 'event': 'push', 'branch': 'main'},
                    'qualityJob': {'id': 10, 'name': 'quality'}, 'producerJob': {'id': 11, 'name': 'release'},
                    'release': {'id': 80, 'tag': 'nova-v2.3.1', 'targetCommitish': commit}, 'assets': {}}
        manifest = {'format': 1, 'kind': 'private-ci-release-artifact', 'repository': snapshot['repository'],
                    'sourceCommit': commit, 'version': '2.3.1', 'run': snapshot['run'],
                    'qualityJob': snapshot['qualityJob'], 'producerJob': snapshot['producerJob'],
                    'producer': {'path': D.C.PRIVATE_PRODUCER, 'sha256': '1' * 64, 'primitivesSha256': '2' * 64,
                                 'retainerSha256': '3' * 64, 'workflowSha256': '4' * 64}, 'release': snapshot['release'],
                    'archive': {'name': stem + '.zip', 'bytes': len(raw), 'sha256': D.C.sha(raw)},
                    'ciSourceSha256': source_hash, 'buildOrigin': 'same-run-release-job', 'deliveryQualification': False}
        transport_raw = json.dumps(manifest).encode()
        for role, identity, name, content in [('archive', 81, stem + '.zip', raw), ('transport', 82, stem + '.transport.json', transport_raw)]:
            snapshot['assets'][role] = {'id': identity, 'name': name, 'size': len(content), 'digest': 'sha256:' + D.C.sha(content)}
        return request, zips, frozen, exact, verify, snapshot, transport_raw

    def test_private_release_collection_and_observe_preserve_true_ids_and_three_member_receipt(self):
        request, zips, frozen, exact, verify, snapshot, transport_raw = self.private_fixture()
        runtime = types.SimpleNamespace(returncode=0, stdout=json.dumps(request['tools']['nodeToolchain']).encode())
        with patch.object(D.subprocess, 'run', return_value=runtime), patch.object(D.C, 'frozen_source', side_effect=frozen) as source, \
             patch.object(D.C, 'exact_run', side_effect=exact) as actions_api, patch.object(D.C, 'exact_private_release', return_value=snapshot) as release_api, \
             patch.object(D.C, 'download_release_asset', side_effect=lambda asset, *_: transport_raw if asset['id'] == 82 else zips['Nova-Dream']) as release_download, \
             patch.object(D.C, 'download_zip', return_value=zips['Nova-Dream-Public']) as actions_download, patch.object(D.C, 'verify_application', side_effect=verify):
            first = D.collect(request, token_provider=lambda _: 'synthetic-token-never-external')
            second = D.collect(request, observe=True, token_provider=lambda _: self.fail('No observation credentials'))
            self.assertEqual(first, second)
            private = first['output']['repositories']['private']
            self.assertNotIn('artifactId', private); self.assertEqual(private['releaseAssetId'], 81)
            self.assertEqual(private['transport']['releaseId'], 80)
            self.assertEqual(private['transport']['buildOrigin'], 'same-run-release-job')
            self.assertEqual(first['output']['repositories']['public']['artifactId'], 124)
            self.assertEqual(actions_api.call_count, 1); self.assertEqual(actions_download.call_count, 1)
            self.assertEqual(release_api.call_count, 1); self.assertEqual(release_download.call_count, 2)
            self.assertEqual([call.kwargs['private_release'] for call in source.call_args_list].count(True), 2)
            transport = pathlib.Path(private['transport']['receipt']['path']); transport.write_bytes(b'changed')
            with self.assertRaisesRegex(RuntimeError, 'private-ci-retained-transport-corrupt'):
                D.collect(request, observe=True, token_provider=lambda _: self.fail('No observation credentials'))
            self.assertEqual(release_download.call_count, 2)

    def test_wrong_private_manifest_preserves_partial_and_never_fetches_archive_or_replays(self):
        request, zips, frozen, exact, verify, snapshot, transport_raw = self.private_fixture()
        manifest = json.loads(transport_raw); manifest['producer']['sha256'] = '0' * 64
        changed = json.dumps(manifest).encode()
        runtime = types.SimpleNamespace(returncode=0, stdout=json.dumps(request['tools']['nodeToolchain']).encode())
        with patch.object(D.subprocess, 'run', return_value=runtime), patch.object(D.C, 'frozen_source', side_effect=frozen), \
             patch.object(D.C, 'exact_run', side_effect=exact), patch.object(D.C, 'exact_private_release', return_value=snapshot), \
             patch.object(D.C, 'download_release_asset', return_value=changed) as release_download, \
             patch.object(D.C, 'download_zip', return_value=zips['Nova-Dream-Public']), patch.object(D.C, 'verify_application', side_effect=verify):
            with self.assertRaisesRegex(RuntimeError, 'private-ci-transport-binding'):
                D.collect(request, token_provider=lambda _: 'synthetic-token-never-external')
            self.assertEqual(release_download.call_count, 1)
            output = pathlib.Path(request['outputDirectory'])
            self.assertTrue((output / 'private/transport.json').is_file())
            self.assertFalse((output / 'private/artifact.zip').exists())
            self.assertFalse((output / 'result.json').exists())
            with self.assertRaises(FileExistsError):
                D.collect(request, token_provider=lambda _: self.fail('No replay credential'))
            self.assertEqual(release_download.call_count, 1)

    def test_public_cannot_select_private_transport(self):
        request, *_ = self.fixture(); request['ci']['public']['transport'] = 'private-release-asset'
        runtime = types.SimpleNamespace(returncode=0, stdout=json.dumps(request['tools']['nodeToolchain']).encode())
        with patch.object(D.subprocess, 'run', return_value=runtime), self.assertRaisesRegex(RuntimeError, 'artifact-transport-selection'):
            D.collect(request, token_provider=lambda _: self.fail('No credential for wrong route'))

    def test_original_complete_collection_observes_without_redownload_or_credentials(self):
        request, zips, frozen, exact, verify = self.fixture()
        runtime = types.SimpleNamespace(returncode=0, stdout=json.dumps(request['tools']['nodeToolchain']).encode())
        with patch.object(D.subprocess, 'run', return_value=runtime), patch.object(D.C, 'frozen_source', side_effect=frozen), patch.object(D.C, 'exact_run', side_effect=exact) as api, \
             patch.object(D.C, 'download_zip', side_effect=lambda prefix, *_: zips[prefix.split('/')[-1]]) as download, patch.object(D.C, 'verify_application', side_effect=verify), \
             patch.object(D.C, 'extract_zip', wraps=D.C.extract_zip) as extract:
            first = D.collect(request, token_provider=lambda _: 'synthetic-token-never-external')
            second = D.collect(request, observe=True, token_provider=lambda _: self.fail('Observe must not request credentials'))
            self.assertEqual(first, second); self.assertEqual(api.call_count, 2); self.assertEqual(download.call_count, 2)
            self.assertEqual(extract.call_count, 2)
            archive = pathlib.Path(second['output']['repositories']['private']['archive']['path']); archive.write_bytes(b'corrupt')
            with self.assertRaisesRegex(RuntimeError, 'retained-archive-corrupt'):
                D.collect(request, observe=True, token_provider=lambda _: self.fail('No credentials'))
            self.assertEqual(download.call_count, 2)
            self.assertEqual(extract.call_count, 2)

    def test_repository_preparation_overlaps_and_result_order_is_stable(self):
        request, zips, frozen, exact, verify = self.fixture()
        runtime = types.SimpleNamespace(returncode=0, stdout=json.dumps(request['tools']['nodeToolchain']).encode())
        together = threading.Barrier(2); thread_ids = set(); lock = threading.Lock()
        original_cwd, original_environment = pathlib.Path.cwd(), dict(os.environ)
        def download(prefix, *_):
            with lock: thread_ids.add(threading.get_ident())
            together.wait(timeout=5)
            return zips[prefix.split('/')[-1]]
        with patch.object(D.subprocess, 'run', return_value=runtime), patch.object(D.C, 'frozen_source', side_effect=frozen), \
             patch.object(D.C, 'exact_run', side_effect=exact), patch.object(D.C, 'download_zip', side_effect=download), \
             patch.object(D.C, 'verify_application', side_effect=verify), patch.object(D.os, 'chdir', side_effect=AssertionError('global cwd mutation')):
            result = D.collect(request, token_provider=lambda _: 'synthetic-token-never-external')
        self.assertEqual(len(thread_ids), 2)
        self.assertEqual(list(result['output']['repositories']), ['private', 'public'])
        self.assertEqual(pathlib.Path.cwd(), original_cwd); self.assertEqual(dict(os.environ), original_environment)
        outputs = [pathlib.Path(row['applicationDirectory']) for row in result['output']['repositories'].values()]
        self.assertNotEqual(outputs[0].parent, outputs[1].parent)

    def test_failure_waits_for_peer_and_partial_output_never_replays(self):
        request, zips, frozen, exact, verify = self.fixture()
        runtime = types.SimpleNamespace(returncode=0, stdout=json.dumps(request['tools']['nodeToolchain']).encode())
        public_entered, release_public, finished = threading.Event(), threading.Event(), threading.Event()
        caught = []
        def download(prefix, *_):
            if prefix.endswith('/Nova-Dream'):
                if not public_entered.wait(5): raise TimeoutError('peer did not start')
                raise RuntimeError('retained-archive-corrupt')
            public_entered.set()
            if not release_public.wait(5): raise TimeoutError('fixture peer was not released')
            return zips['Nova-Dream-Public']
        def run():
            try: D.collect(request, token_provider=lambda _: 'synthetic-token-never-external')
            except Exception as error: caught.append(error)
            finally: finished.set()
        output = pathlib.Path(request['outputDirectory'])
        with patch.object(D.subprocess, 'run', return_value=runtime), patch.object(D.C, 'frozen_source', side_effect=frozen), \
             patch.object(D.C, 'exact_run', side_effect=exact), patch.object(D.C, 'download_zip', side_effect=download) as downloader, \
             patch.object(D.C, 'verify_application', side_effect=verify), patch.object(D.C, 'extract_zip', wraps=D.C.extract_zip) as extract:
            worker = threading.Thread(target=run); worker.start()
            try:
                self.assertTrue(public_entered.wait(5)); self.assertFalse(finished.wait(.05))
                self.assertFalse((output / 'result.json').exists())
            finally:
                release_public.set(); worker.join(10)
            self.assertFalse(worker.is_alive()); self.assertEqual(len(caught), 1)
            self.assertEqual(str(caught[0]), 'retained-archive-corrupt')
            self.assertTrue((output / 'public/verified-application').is_dir())
            self.assertFalse((output / 'result.json').exists())
            before = {str(p.relative_to(output)): p.read_bytes() for p in output.rglob('*') if p.is_file()}
            with self.assertRaises(RuntimeError) as observed:
                D.collect(request, observe=True, token_provider=lambda _: self.fail('No observation credentials'))
            self.assertEqual(D.failure_result(observed.exception)['state'], 'uncertain')
            with self.assertRaises(FileExistsError):
                D.collect(request, token_provider=lambda _: self.fail('Never replay an exclusive output'))
            self.assertEqual(downloader.call_count, 2); self.assertEqual(extract.call_count, 1)
            self.assertEqual(before, {str(p.relative_to(output)): p.read_bytes() for p in output.rglob('*') if p.is_file()})

    def test_uncertain_peer_is_not_hidden_by_other_repository_refusal(self):
        request, _, frozen, exact, verify = self.fixture()
        runtime = types.SimpleNamespace(returncode=0, stdout=json.dumps(request['tools']['nodeToolchain']).encode())
        def download(prefix, *_):
            if prefix.endswith('/Nova-Dream'): raise RuntimeError('retained-archive-corrupt')
            raise TimeoutError('synthetic private response details must not escape')
        with patch.object(D.subprocess, 'run', return_value=runtime), patch.object(D.C, 'frozen_source', side_effect=frozen), \
             patch.object(D.C, 'exact_run', side_effect=exact), patch.object(D.C, 'download_zip', side_effect=download) as downloads, \
             patch.object(D.C, 'verify_application', side_effect=verify):
            with self.assertRaises(TimeoutError) as failed:
                D.collect(request, token_provider=lambda _: 'synthetic-token-never-external')
            self.assertEqual(downloads.call_count, 2)
        result = D.failure_result(failed.exception)
        self.assertEqual(result['state'], 'uncertain'); self.assertNotIn('private response', json.dumps(result))
        self.assertFalse((pathlib.Path(request['outputDirectory']) / 'result.json').exists())

    def test_lost_terminal_response_observes_original_without_extraction(self):
        request, zips, frozen, exact, verify = self.fixture()
        runtime = types.SimpleNamespace(returncode=0, stdout=json.dumps(request['tools']['nodeToolchain']).encode())
        write = D.C.write_json
        def lose_response(path, value):
            result = write(path, value)
            if path.name == 'result.json': raise ConnectionError('synthetic lost terminal response')
            return result
        with patch.object(D.subprocess, 'run', return_value=runtime), patch.object(D.C, 'frozen_source', side_effect=frozen), \
             patch.object(D.C, 'exact_run', side_effect=exact) as api, \
             patch.object(D.C, 'download_zip', side_effect=lambda prefix, *_: zips[prefix.split('/')[-1]]) as downloads, \
             patch.object(D.C, 'verify_application', side_effect=verify), patch.object(D.C, 'extract_zip', wraps=D.C.extract_zip) as extract, \
             patch.object(D.C, 'write_json', side_effect=lose_response):
            with self.assertRaises(ConnectionError): D.collect(request, token_provider=lambda _: 'synthetic-token-never-external')
            retained = D.collect(request, observe=True, token_provider=lambda _: self.fail('No observation credentials'))
            self.assertEqual(retained['state'], 'completed'); self.assertEqual(retained['externalId'], request['key'])
            self.assertEqual(api.call_count, 2); self.assertEqual(downloads.call_count, 2); self.assertEqual(extract.call_count, 2)

    def test_invalid_peer_binding_stops_before_either_worker_or_credentials(self):
        request, *_ = self.fixture(); request['ci']['public']['sourceCommit'] = '0' * 40
        runtime = types.SimpleNamespace(returncode=0, stdout=json.dumps(request['tools']['nodeToolchain']).encode())
        with patch.object(D.subprocess, 'run', return_value=runtime), patch.object(D.C, 'frozen_source') as frozen, \
             patch.object(D.C, 'exact_run') as api, patch.object(D.C, 'download_zip') as download:
            with self.assertRaisesRegex(RuntimeError, 'ci-source-binding-changed'):
                D.collect(request, token_provider=lambda _: self.fail('Both bindings must pass before credentials'))
            frozen.assert_not_called(); api.assert_not_called(); download.assert_not_called()

    def test_partial_original_output_is_preserved_and_never_replayed(self):
        request, *_ = self.fixture(); output = pathlib.Path(request['outputDirectory']); output.mkdir()
        (output / 'partial.txt').write_text('preserve original worker output')
        runtime = types.SimpleNamespace(returncode=0, stdout=json.dumps(request['tools']['nodeToolchain']).encode())
        with patch.object(D.subprocess, 'run', return_value=runtime), patch.object(D.C, 'download_zip') as download:
            with self.assertRaises((RuntimeError, FileNotFoundError)):
                D.collect(request, observe=True, token_provider=lambda _: self.fail('No credential request'))
            self.assertTrue((output / 'partial.txt').exists()); download.assert_not_called()

    def test_changed_helper_fails_before_tool_or_network_invocation(self):
        request, *_ = self.fixture(); request['helperHashes']['release-artifact-primitives.py'] = '0' * 64
        with patch.object(D.subprocess, 'run') as process, patch.object(D.C, 'download_zip') as download:
            with self.assertRaisesRegex(RuntimeError, 'artifact-helper-changed'): D.collect(request)
            process.assert_not_called(); download.assert_not_called()

    def test_maintained_zip_parser_rejects_added_path_before_extraction(self):
        request, *_ = self.fixture(); root = pathlib.Path(request['outputDirectory']); root.mkdir()
        raw = io.BytesIO()
        with zipfile.ZipFile(raw, 'w') as archive:
            archive.writestr('../escape', b'bad')
        with self.assertRaisesRegex(RuntimeError, 'exactly the three'):
            D.C.extract_zip(raw.getvalue(), root)
        self.assertEqual(list(root.iterdir()), [])

    def test_positive_integrity_refusal_is_distinct_from_an_unavailable_response(self):
        failure = D.failure_result(RuntimeError('retained-archive-corrupt'))
        self.assertEqual(failure['state'], 'failed'); self.assertEqual(failure['reason'], 'retained-archive-corrupt')
        for error in (RuntimeError('credential-provider-unavailable'), TimeoutError('private sensitive timeout details'), FileNotFoundError('private path')):
            value = D.failure_result(error)
            self.assertEqual(value['state'], 'uncertain'); self.assertEqual(value['reason'], 'original-artifact-collection-unverified')


if __name__ == '__main__': unittest.main()
