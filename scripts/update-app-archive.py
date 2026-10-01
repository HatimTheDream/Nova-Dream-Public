"""Package a verified built application for the maintained Linux installer.

Includes only candidate-listed dist files, npm metadata, and the two reviewed
host entrypoints. Does not build, install dependencies, sign, publish, or deploy.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
import pathlib
import shutil
import stat
import subprocess
import tarfile

MAXIMUM = 128 * 1024 ** 2
MEMBER_MAXIMUM = 6000


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def regular_bytes(root, name):
    path = root
    for part in pathlib.PurePosixPath(name).parts:
        require(part not in ('', '.', '..'), 'Unsafe application archive path.')
        path = path / part
        require(not path.is_symlink(), 'Application archive inputs cannot traverse symlinks.')
    require(stat.S_ISREG(path.lstat().st_mode), 'Application archive input must be a regular file.')
    require(path.stat().st_size <= MAXIMUM, 'Application archive input exceeds its bound.')
    return path.read_bytes()


def verified_candidate(root, node):
    verifier = pathlib.Path(__file__).with_name('candidate.mjs').resolve()
    program = r"""
const {verifyCandidate}=await import(process.argv[1]);
const {createHash}=await import('node:crypto');
const {id,manifest,bytes}=verifyCandidate(process.argv[2]);
console.log(JSON.stringify({id,version:manifest.version,buildVersion:manifest.buildVersion,
  schemaVersion:manifest.schemaVersion,apiVersion:manifest.apiVersion,
  files:Object.fromEntries([...bytes].map(([path,data])=>[path,createHash('sha256').update(data).digest('hex')]))}));
"""
    result = subprocess.run([str(node), '--input-type=module', '-e', program, verifier.as_uri(), str(root)],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60, check=False)
    require(result.returncode == 0, 'Candidate verification failed; rebuild the complete application first.')
    require(len(result.stdout) <= 2 * 1024 ** 2 and len(result.stderr) <= 65536,
            'Candidate verification output exceeded its bound.')
    return json.loads(result.stdout)


def package_app_archive(source, output, node):
    source_path = pathlib.Path(source).absolute()
    require(source_path.is_dir() and not source_path.is_symlink(), 'Select an actual built application directory.')
    root, output = source_path.resolve(strict=True), pathlib.Path(output).absolute()
    metadata_path = output.with_name(output.name + '.metadata.json')
    require(not output.exists() and not output.is_symlink()
            and not metadata_path.exists() and not metadata_path.is_symlink(), 'Application archive output already exists.')
    require(not output.is_relative_to(root), 'Write the application archive outside its source tree.')
    candidate = verified_candidate(root, node)
    files = {}
    for name, expected in candidate['files'].items():
        require(name == 'package.json' or name == 'dist/candidate.json'
                or name.startswith(('dist/client/', 'dist/service/', 'dist/desktop/')),
                'Candidate contains an unreviewed application path.')
        raw = regular_bytes(root, name)
        require(sha(raw) == expected, 'Candidate bytes changed after verification.')
        files[name] = raw
    for name in ('package-lock.json', 'scripts/host.mjs', 'scripts/candidate.mjs'):
        files[name] = regular_bytes(root, name)
    package, lock = json.loads(files['package.json']), json.loads(files['package-lock.json'])
    require(lock.get('lockfileVersion') in (2, 3) and isinstance(lock.get('packages'), dict),
            'Application archive requires a complete npm lockfile.')
    require(lock.get('name') == package['name'] and lock.get('version') == package['version']
            and lock['packages'].get('', {}).get('version') == package['version']
            and lock['packages'][''].get('dependencies', {}) == package.get('dependencies', {}),
            'Application package and lockfile do not match.')
    directories = {str(parent) for name in files for parent in pathlib.PurePosixPath(name).parents
                   if str(parent) != '.'}
    expanded = sum(map(len, files.values()))
    require(0 < len(files) + len(directories) <= MEMBER_MAXIMUM and expanded <= MAXIMUM,
            'Application archive expansion exceeded the installer bound.')
    with output.open('xb') as raw_output:
        with gzip.GzipFile(filename='', mode='wb', fileobj=raw_output, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as archive:
                for name in sorted(directories | files.keys()):
                    member = tarfile.TarInfo(name)
                    member.uid = member.gid = member.mtime = 0
                    member.uname = member.gname = ''
                    member.type = tarfile.DIRTYPE if name in directories else tarfile.REGTYPE
                    member.mode = 0o755 if name in directories else 0o644
                    member.size = 0 if name in directories else len(files[name])
                    archive.addfile(member, None if name in directories else io.BytesIO(files[name]))
        raw_output.flush()
        os.fsync(raw_output.fileno())
    archive_bytes = output.stat().st_size
    require(0 < archive_bytes <= MAXIMUM, 'Application archive compressed size exceeded its bound.')
    metadata = {key: candidate[key] for key in ('version', 'buildVersion', 'schemaVersion', 'apiVersion')}
    metadata.update(format=1, candidateId=candidate['id'], archiveBytes=archive_bytes,
                    archiveSha256=sha(output.read_bytes()), expandedBytes=expanded,
                    fileCount=len(files) + len(directories), packageLockSha256=sha(files['package-lock.json']))
    with metadata_path.open('x', encoding='utf-8') as stream:
        json.dump(metadata, stream, sort_keys=True, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    return metadata


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=pathlib.Path)
    parser.add_argument('output', type=pathlib.Path)
    parser.add_argument('--node', default=os.environ.get('NODE_BINARY') or shutil.which('node'), required=False)
    args = parser.parse_args()
    require(args.node is not None, 'Pass the verified build Node executable with --node.')
    print(json.dumps(package_app_archive(args.source, args.output, args.node), sort_keys=True))
