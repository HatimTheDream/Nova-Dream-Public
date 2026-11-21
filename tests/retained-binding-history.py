"""Run by session-bindings-verifier.test.mjs against its encrypted schema-60 store."""
import contextlib
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy/update-runner'))
import hosted_retained_configuration as hosted
import recovery


def exercise(store, config, key_file, node):
    scope = {'format': 1, 'kind': 'schema-60-same-runtime', 'schemaVersion': 60,
             'apiVersion': 1, 'agentVersion': '2026.9.8'}
    assertions = unittest.TestCase()
    current = json.loads(config.read_bytes())
    bindings = current['plugins']['entries']['edition3-workspace']['config']['sessionBindings']
    a, b, c, d = bindings
    key = key_file.read_bytes()
    with tempfile.TemporaryDirectory(dir=store.parent) as directory, contextlib.ExitStack() as contexts:
        returned_root = Path(directory).resolve()
        contexts.enter_context(recovery.hosted_same_schema_qualification(scope, store, returned_root))
        if os.name == 'nt':
            # This fixture is private to the calling test; Windows has no POSIX mode-0700 directory.
            token = recovery._VERIFICATION_SCRATCH.set(returned_root)
            contexts.callback(recovery._VERIFICATION_SCRATCH.reset, token)
        else:
            contexts.enter_context(recovery.verification_scratch(returned_root))

        def compare(prior, returned=current, path=config):
            hosted.verify_same_schema_bindings(store, Path('.'), prior, returned, path, node, key)

        for prior in (bindings, [a, c, d], [b, d], []):
            compare(prior)
        for prior in ([c, b], [a, a], [dict(a, unexpected=True)], [dict(a, nativeId=3)],
                      [dict(a, nativeKey='unadmitted')], [dict(a, nativeId=b['nativeId'])]):
            with assertions.assertRaisesRegex(RuntimeError, 'prior session bindings|duplicate session binding'):
                compare(prior)
        stale = copy.deepcopy(current)
        stale['plugins']['entries']['edition3-workspace']['config']['sessionBindings'] = [a, c, d]
        stale_path = returned_root / 'stale-returned.json'
        stale_path.write_text(json.dumps(stale))
        with assertions.assertRaisesRegex(RuntimeError, 'failed selected-store derivation'):
            compare([a], stale, stale_path)
        with assertions.assertRaisesRegex(RuntimeError, 'returned configuration changed'):
            compare([a], stale, config)

        # A previously admitted historical file cannot be replaced with even a valid subset.
        relative = Path('openclaw-runtime/openclaw.json')
        prior_path = store / relative
        prior_path.parent.mkdir()
        prior_path.write_text(json.dumps(current))
        source = {'format': 1, 'kind': 'same-schema-closed-prior-source', 'candidateId': 'a'*64,
                  'workspaceEpoch': 'fixture-epoch', 'sourceRoot': str(store), 'sourceClosed': True,
                  'sourceIdentity': [store.stat().st_dev, store.stat().st_ino], 'manifestSha256': 'b'*64,
                  'configuration': hosted.file_reference(prior_path),
                  'logicalNativeRoot': str(returned_root / relative.parent)}
        prior_path.write_text(json.dumps(stale))
        prior_authority = {'candidateId': source['candidateId'], 'releaseRoot': str(store),
                           'dependencyRoot': str(store), 'dependencyFiles': {}, 'source': {}}
        # Isolate the outer host privilege check and use the original, authenticated source document.
        with patch.object(hosted.sys, 'platform', 'linux'), patch.object(hosted.os, 'geteuid', return_value=0, create=True), \
             patch.object(hosted, 'document', return_value=source), \
             assertions.assertRaisesRegex(RuntimeError, 'prior source configuration or logical native root changed'):
            hosted.derive_same_schema_configuration(store, returned_root, Path('.'), node=node,
                app_releases=[None, None], session_binding_key=key, startup_window=(1, 2),
                catalog_runtime_root=store, authority={'priorBuilder': prior_authority})
    print('PASS  retained schema-60 session binding history and strict returned-store verification')


if __name__ == '__main__':
    exercise(*(Path(value).resolve(strict=True) for value in sys.argv[1:]))
