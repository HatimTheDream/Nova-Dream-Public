"""Bounded local Zod materialization; no npm, network or native execution.

The JS caller first authenticates the accepted installation and signed pair.
This fixed worker independently rechecks its exact pair/archive/candidate inputs.
An OS file lock serializes writers; complete directories are promoted atomically.
"""
import argparse, base64, contextlib, hashlib, io, json, os, pathlib, re, stat, sys, tarfile, types
P = pathlib.Path
PARSER_SHA = 'e7f2617ed8d05b7d83da62e857822b737ff3a1c47b6704af5d3e1783e043b290'
MAX = 128 * 1024**2
VERSION = '4.4.3'

def need(value, code):
    if not value:
        raise RuntimeError(code)

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def identity(s):
    return s.st_dev, s.st_ino, s.st_mode, s.st_nlink, s.st_size, s.st_mtime_ns, s.st_ctime_ns

def canonical(path):
    p = P(path)
    need(p.is_absolute() and p.resolve(strict=True) == p, 'feed-dependency-path-not-canonical')
    for q in (p, *p.parents):
        need(not q.is_symlink(), 'feed-dependency-redirected-path')
    return p

def read_file(path, maximum=MAX):
    p = canonical(path)
    before = p.lstat()
    need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= maximum,
         'feed-dependency-file-not-independent')
    with p.open('rb') as stream:
        opened = os.fstat(stream.fileno())
        # Windows fd/path ctime differs; each identity is checked separately.
        need(identity(opened)[:-1] == identity(before)[:-1], 'feed-dependency-open-changed')
        raw = stream.read(maximum + 1)
        need(identity(os.fstat(stream.fileno())) == identity(opened), 'feed-dependency-descriptor-changed')
    need(len(raw) == before.st_size and identity(p.lstat()) == identity(before), 'feed-dependency-file-changed')
    return raw

def read(ref, maximum=MAX):
    need(set(ref) == {'path', 'sha256'} and re.fullmatch('[a-f0-9]{64}', ref['sha256']), 'feed-dependency-reference-invalid')
    raw = read_file(ref['path'], maximum)
    need(sha(raw) == ref['sha256'], 'feed-dependency-reference-changed')
    return raw

def encode(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()

def safe_name(name):
    parts = name.split('/')
    need(parts and all(re.fullmatch('[A-Za-z0-9_@+.-]+', p) and p not in ('.', '..')
         and not p.endswith(('.', ' ')) and not re.fullmatch(r'(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?', p)
         for p in parts), 'feed-dependency-member-path-invalid')
    return parts

def candidate_snapshot(base):
    root = canonical(base['directory'])
    need(base['manifest']['path'] == str(root / 'dist/candidate.json'), 'feed-dependency-manifest-path-changed')
    package_raw, manifest_raw = read_file(root / 'package.json'), read(base['manifest'])
    need(sha(package_raw + manifest_raw) == base['candidateId'], 'feed-dependency-candidate-changed')
    manifest = json.loads(manifest_raw)
    result = {'package.json': sha(package_raw), 'package-lock.json': sha(read_file(root / 'package-lock.json')),
              'dist/candidate.json': sha(manifest_raw)}
    for entry in manifest['artifacts']:
        name = entry['path']; safe_name(name)
        need(name.startswith(('dist/client/', 'dist/service/', 'dist/desktop/')) and name not in result,
             'feed-dependency-candidate-member-invalid')
        result[name] = sha(read_file(root / name))
        need(result[name] == entry['sha256'], 'feed-dependency-candidate-artifact-changed')
    return result, json.loads(package_raw), manifest

def load_parser(reference):
    raw = read(reference, 2 * 1024**2)
    need(sha(raw) == PARSER_SHA, 'feed-dependency-maintained-parser-changed')
    module = types.ModuleType('retained_feed_archive_parser')
    module.__file__ = reference['path']
    exec(compile(raw, module.__file__, 'exec'), module.__dict__)
    return module

def prepare(request):
    need(set(request) == {'format', 'base', 'pair', 'archive', 'metadata', 'helper', 'workDirectory'}
         and request['format'] == 1, 'feed-dependency-request-invalid')
    base = request['base']; root = canonical(base['directory'])
    work = canonical(request['workDirectory'])
    need(work == root.parent / ('retained-feed-' + base['candidateId']), 'feed-dependency-work-scope-changed')
    snapshot, package, manifest = candidate_snapshot(base)
    pair, description = json.loads(read(request['pair'])), json.loads(read(request['metadata']))
    need(pair['candidateId'] == base['candidateId'] and package['version'] == manifest['version']
         and pair['applicationDependencies'] == description, 'feed-dependency-accepted-pair-changed')
    lock_raw = read_file(root / 'package-lock.json'); lock = json.loads(lock_raw)
    need(sha(lock_raw) == description['packageLockSha256'], 'feed-dependency-candidate-lock-changed')
    need(package.get('dependencies', {}).get('zod') == VERSION
         and lock.get('packages', {}).get('node_modules/zod', {}).get('version') == VERSION,
         'feed-dependency-zod-version-unsupported')
    raw = read(request['archive'])
    need(request['archive']['sha256'] == description['archiveSha256']
         and len(raw) == description['archiveBytes'], 'feed-dependency-accepted-archive-changed')
    parser = load_parser(request['helper'])
    validated = parser.archive_members(request['archive']['path'], description)
    # Parse the exact already-hashed bytes with the same maintained bounded parser.
    files, directories, names, expanded = {}, set(), set(), 0
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz', tarinfo=parser.DependencyTarInfo) as archive:
        members = archive.getmembers()
        need([(x.name, x.type, x.size, x.linkname, x.pax_headers) for x in members]
             == [(x.name, x.type, x.size, x.linkname, x.pax_headers) for x in validated], 'feed-dependency-archive-pass-changed')
        need(archive.extractfile('package.json').read() == read_file(root / 'package.json')
             and archive.extractfile('package-lock.json').read() == lock_raw, 'feed-dependency-archive-source-changed')
        for member in members:
            if member.name != 'node_modules/zod' and not member.name.startswith('node_modules/zod/'):
                continue
            relative = member.name.removeprefix('node_modules/zod').lstrip('/')
            need(member.isfile() or member.isdir(), 'feed-dependency-zod-link-forbidden')
            if not relative:
                need(member.isdir(), 'feed-dependency-zod-root-invalid'); continue
            safe_name(relative)
            need(relative.casefold() not in names, 'feed-dependency-case-collision')
            names.add(relative.casefold())
            need(len(names) <= 2000, 'feed-dependency-zod-member-limit')
            if member.isdir():
                directories.add(relative); continue
            need(member.size <= 2 * 1024**2 and P(relative).suffix.lower() not in
                 ('.node', '.exe', '.dll', '.so', '.dylib', '.cmd', '.bat', '.ps1', '.sh'), 'feed-dependency-noninert-member')
            data = archive.extractfile(member).read(member.size + 1)
            need(len(data) == member.size, 'feed-dependency-short-member')
            expanded += len(data); need(expanded <= 8 * 1024**2, 'feed-dependency-zod-expansion-limit')
            files[relative] = data
    zod = json.loads(files.get('package.json', b'{}'))
    need(zod.get('name') == 'zod' and zod.get('version') == VERSION and not zod.get('dependencies')
         and not zod.get('optionalDependencies'), 'feed-dependency-zod-closure-invalid')
    for name in files:
        directories.update(str(p).replace('\\', '/') for p in P(name).parents if str(p) != '.')
    return root, work, snapshot, files, directories

@contextlib.contextmanager
def owned_lock(work):
    path = work / 'writer.lock'
    try:
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        need(read_file(path, 1) in (b'', b'0'), 'feed-dependency-lock-invalid')
        fd = os.open(path, os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0))
    stream = os.fdopen(fd, 'r+b')
    try:
        if os.name == 'nt':
            import msvcrt
            stream.seek(0); msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        stream.seek(0); stream.write(b'0'); stream.flush(); os.fsync(stream.fileno())
        yield
    finally:
        stream.close()

def inspect_tree(root, files, directories, partial=False):
    canonical(root)
    seen, seen_directories = set(), set()
    for path in root.rglob('*'):
        canonical(path); relative = path.relative_to(root).as_posix(); info = path.lstat()
        if stat.S_ISDIR(info.st_mode):
            need(relative in directories, 'feed-dependency-unexpected-directory'); seen_directories.add(relative); continue
        need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'feed-dependency-nonregular-output')
        name = relative[:-5] if partial and relative.endswith('.part') else relative
        need(name in files and name not in seen, 'feed-dependency-unexpected-output'); seen.add(name)
        data = read_file(path, 2 * 1024**2)
        need(data == files[name] if name == relative else files[name].startswith(data), 'feed-dependency-output-corrupt')
    if not partial:
        need(seen == set(files) and seen_directories == directories, 'feed-dependency-output-incomplete')

def completed_output_reuse(request, prior, root, work, snapshot, files, directories, *, checkpoint=lambda _: None):
    # A relocated operator checkout may name the same pinned parser elsewhere.
    # Only an already complete output can be reused; never adopt partial work.
    try:
        owner = json.loads(prior)
    except (ValueError, UnicodeError):
        raise RuntimeError('feed-dependency-operation-conflict') from None
    need(isinstance(owner, dict) and set(owner) == set(request) and encode(owner) == prior,
         'feed-dependency-operation-conflict')
    need({k: v for k, v in owner.items() if k != 'helper'} ==
         {k: v for k, v in request.items() if k != 'helper'}, 'feed-dependency-operation-conflict')
    for helper in (owner['helper'], request['helper']):
        need(isinstance(helper, dict) and set(helper) == {'path', 'sha256'}
             and helper['sha256'] == PARSER_SHA, 'feed-dependency-maintained-parser-changed')
        read(helper, 2 * 1024**2)
    modules = canonical(root / 'node_modules'); destination = canonical(modules / 'zod')
    need(not os.path.lexists(work / 'zod-staging'), 'feed-dependency-reuse-staging-present')
    need(set(p.name for p in modules.iterdir()) == {'zod'}, 'feed-dependency-other-modules-present')
    paths = (root, work, modules, destination)
    identities = [identity(p.stat()) for p in paths]
    inspect_tree(destination, files, directories)
    checkpoint('completed-output-verified')
    need(read_file(work / 'owner.json', 65536) == prior, 'feed-dependency-owner-corrupt')
    for helper in (owner['helper'], request['helper']):
        read(helper, 2 * 1024**2)
    need(candidate_snapshot(request['base'])[0] == snapshot, 'feed-dependency-candidate-mutated')
    inspect_tree(destination, files, directories)
    need(not os.path.lexists(work / 'zod-staging'), 'feed-dependency-reuse-staging-present')
    need(set(p.name for p in modules.iterdir()) == {'zod'}, 'feed-dependency-other-modules-present')
    need(identities == [identity(canonical(p).stat()) for p in paths], 'feed-dependency-reuse-directory-changed')
    return {'format': 1, 'candidateId': request['base']['candidateId'], 'archiveSha256': request['archive']['sha256'],
            'destination': str(destination), 'version': VERSION, 'files': len(files),
            'bytes': sum(map(len, files.values())), 'materialized': True, 'candidateUnchanged': True,
            'completedOutputReused': True, 'retainedOwnerSha256': sha(prior)}

def materialize(request, *, checkpoint=lambda _: None):
    root, work, snapshot, files, directories = prepare(request)
    with owned_lock(work):
        # A request cannot take over a staging tree created for other inputs.
        marker = work / 'owner.json'; expected = encode(request)
        if marker.exists():
            prior = read_file(marker, 65536)
            if not expected.startswith(prior):
                return completed_output_reuse(request, prior, root, work, snapshot, files, directories,
                                              checkpoint=checkpoint)
        else: prior = b''
        if prior != expected:
            with marker.open('ab' if marker.exists() else 'xb') as stream:
                stream.write(expected[len(prior):]); stream.flush(); os.fsync(stream.fileno())
        need(read_file(marker, 65536) == expected, 'feed-dependency-owner-corrupt')
        modules = canonical(root / 'node_modules')
        need(set(p.name for p in modules.iterdir()) <= {'zod'}, 'feed-dependency-other-modules-present')
        destination = modules / 'zod'; stage = work / 'zod-staging'
        need(not destination.is_symlink() and not stage.is_symlink(), 'feed-dependency-redirected-output')
        if destination.exists():
            inspect_tree(destination, files, directories)
        else:
            if stage.exists(): inspect_tree(stage, files, directories, partial=True)
            else: stage.mkdir(mode=0o700)
            for directory in sorted(directories, key=lambda x: (x.count('/'), x)):
                (stage / directory).mkdir(mode=0o700, exist_ok=True)
            for name, raw in sorted(files.items()):
                target = stage / name; part = target.with_name(target.name + '.part')
                if target.exists():
                    need(read_file(target, 2 * 1024**2) == raw, 'feed-dependency-output-corrupt'); continue
                offset = len(read_file(part, 2 * 1024**2)) if part.exists() else 0
                if part.exists(): need(raw.startswith(read_file(part, 2 * 1024**2)), 'feed-dependency-partial-corrupt')
                with part.open('ab' if part.exists() else 'xb') as stream:
                    stream.write(raw[offset:]); stream.flush(); os.fsync(stream.fileno())
                checkpoint('file-written')
                need(read_file(part, 2 * 1024**2) == raw, 'feed-dependency-staged-file-corrupt')
                part.rename(target)
            inspect_tree(stage, files, directories)
            need(candidate_snapshot(request['base'])[0] == snapshot, 'feed-dependency-candidate-mutated')
            checkpoint('before-promote')
            stage.rename(destination)
            checkpoint('after-promote')
        inspect_tree(destination, files, directories)
        need(candidate_snapshot(request['base'])[0] == snapshot, 'feed-dependency-candidate-mutated')
        return {'format': 1, 'candidateId': request['base']['candidateId'], 'archiveSha256': request['archive']['sha256'],
                'destination': str(destination), 'version': VERSION, 'files': len(files),
                'bytes': sum(map(len, files.values())), 'materialized': True, 'candidateUnchanged': True}

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--request-base64', required=True); parser.add_argument('--request-sha', required=True)
    parser.add_argument('--plan', action='store_true'); args = parser.parse_args()
    need(len(args.request_base64) <= 12000, 'feed-dependency-request-too-large')
    raw = base64.b64decode(args.request_base64, validate=True)
    need(base64.b64encode(raw).decode() == args.request_base64 and sha(raw) == args.request_sha, 'feed-dependency-request-changed')
    value = json.loads(raw)
    if args.plan:
        root, work, snapshot, files, directories = prepare(value)
        marker = work / 'owner.json'
        if marker.exists():
            prior = read_file(marker, 65536)
            if not encode(value).startswith(prior):
                completed_output_reuse(value, prior, root, work, snapshot, files, directories)
        print(json.dumps({'passed': True, 'readOnly': True}))
    else:
        print(json.dumps(materialize(value)))
