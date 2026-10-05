"""Retain the canonical CI build; does not rebuild, sign, publish or install."""
import hashlib
import json
import os
import pathlib
import re
import subprocess

from importlib.util import module_from_spec, spec_from_file_location


def main():
    root = pathlib.Path(__file__).resolve().parent.parent
    commit = os.environ['GITHUB_SHA']
    if not re.fullmatch('[a-f0-9]{40}', commit):
        raise RuntimeError('The CI source identity is invalid.')
    actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    if actual != commit:
        raise RuntimeError('The retained build must describe the exact CI checkout.')
    subprocess.run(['git', 'diff', '--quiet', 'HEAD', '--', '.'], cwd=root, check=True)
    node = pathlib.Path(subprocess.check_output(['which', 'node'], text=True).strip()).resolve(strict=True)
    identity = json.loads(subprocess.check_output([str(node), '-e',
        'console.log(JSON.stringify({nodeVersion:process.versions.node,platform:process.platform,arch:process.arch}))'], text=True))
    if identity != {'nodeVersion': '22.23.2', 'platform': 'linux', 'arch': 'x64'}:
        raise RuntimeError('The hosted build requires its qualified Linux Node toolchain.')
    output = pathlib.Path(os.environ['RUNNER_TEMP']).resolve(strict=True) / 'nova-hosted-candidate'
    output.mkdir(mode=0o700)  # Exclusive: keep an uncertain or partial output.
    definition = spec_from_file_location('app_archive', root / 'scripts/update-app-archive.py')
    helper = module_from_spec(definition)
    definition.loader.exec_module(helper)
    metadata = helper.package_app_archive(root, output / 'app.tgz', node)
    receipt = {'format': 1, 'kind': 'canonical-ci-built-candidate',
        'sourceCommit': commit, 'repository': os.environ['GITHUB_REPOSITORY'],
        'runId': os.environ['GITHUB_RUN_ID'], 'runAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
        'toolchain': identity, 'nodeSha256': hashlib.sha256(node.read_bytes()).hexdigest(),
        'packagerSha256': hashlib.sha256((root / 'scripts/update-app-archive.py').read_bytes()).hexdigest(),
        'candidateVerifierSha256': hashlib.sha256((root / 'scripts/candidate.mjs').read_bytes()).hexdigest(),
        'application': metadata, 'rebuilt': False, 'deliveryQualification': False}
    with (output / 'ci-source.json').open('x', encoding='utf-8') as stream:
        json.dump(receipt, stream, sort_keys=True, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    print(json.dumps(receipt, sort_keys=True))


if __name__ == '__main__':
    main()
