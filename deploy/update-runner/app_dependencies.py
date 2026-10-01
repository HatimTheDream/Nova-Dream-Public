"""Bounded, signed offline application dependencies; never installs on the host.

The producer and installer share this archive contract. A closure is independent
of prior releases, contains no Node executable, and is verified with the exact
application Node runtime before a release can select it. No code runs on import.
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tarfile

ARCHIVE_MAXIMUM = 512 * 1024 ** 2
EXPANDED_MAXIMUM = 2 * 1024 ** 3
MEMBER_MAXIMUM = 200000
JSON_MAXIMUM = 16 * 1024 ** 2
FIELDS = frozenset(('format', 'archiveBytes', 'archiveSha256', 'expandedBytes',
                    'fileCount', 'packageLockSha256', 'dependencyGraphSha256',
                    'platform', 'arch', 'nodeVersion', 'nodeAbi'))


class DependencyTarInfo(tarfile.TarInfo):
    """Bound extension headers before tarfile allocates their payload buffers."""
    def _proc_member(self, archive):
        count = getattr(archive, '_dependency_header_count', 0) + 1
        archive._dependency_header_count = count
        require(count <= MEMBER_MAXIMUM * 2, 'Too many dependency archive headers.')
        if self.type == tarfile.XHDTYPE:
            require(0 < self.size <= 16384 and not getattr(archive, '_dependency_pax_pending', False),
                    'Dependency archive has oversized or chained metadata headers.')
            archive._dependency_pax_pending = True
            try:
                result = super()._proc_member(archive)
            finally:
                archive._dependency_pax_pending = False
            require(set(result.pax_headers) <= {'path', 'linkpath'}, 'Unreviewed dependency archive metadata.')
            return result
        require(self.type in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE, tarfile.SYMTYPE),
                'Special dependency archive header is not supported.')
        return super()._proc_member(archive)


def _archive(path):
    return tarfile.open(path, 'r:gz', tarinfo=DependencyTarInfo)


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    with pathlib.Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def parse_json(raw):
    def pairs(entries):
        result = {}
        for key, value in entries:
            require(key not in result, 'Dependency JSON contains duplicate keys.')
            result[key] = value
        return result
    require(len(raw) <= JSON_MAXIMUM, 'Dependency metadata exceeds its bound.')
    return json.loads(raw, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(RuntimeError('Nonfinite dependency metadata.')))


def dependency_graph_sha256(lock):
    """Root version/build edits do not disguise changes to installed packages."""
    require(isinstance(lock, dict) and lock.get('lockfileVersion') in (2, 3)
            and isinstance(lock.get('packages'), dict), 'A complete npm lockfile is required.')
    packages = lock['packages']
    require('' in packages and isinstance(packages[''], dict), 'The lockfile root package is missing.')
    require(all(isinstance(key, str) and isinstance(value, dict) for key, value in packages.items()),
            'The lockfile package graph is malformed.')
    encoded = json.dumps({key: value for key, value in packages.items() if key}, sort_keys=True,
                         ensure_ascii=True, separators=(',', ':'), allow_nan=False).encode('ascii')
    return hashlib.sha256(encoded).hexdigest()


def validate_description(description, signed_bundle=None):
    require(isinstance(description, dict) and set(description) == FIELDS,
            'The application dependency description is malformed.')
    require(type(description['format']) is int and description['format'] == 1
            and description['platform'] == 'linux' and description['arch'] in ('x64', 'arm64')
            and isinstance(description['nodeVersion'], str)
            and re.fullmatch(r'[1-9][0-9]*\.[0-9]+\.[0-9]+', description['nodeVersion'])
            and type(description['nodeAbi']) is int and 1 <= description['nodeAbi'] <= 10000,
            'Application dependencies identify an unsupported runtime.')
    for key, bound in (('archiveBytes', ARCHIVE_MAXIMUM), ('expandedBytes', EXPANDED_MAXIMUM),
                       ('fileCount', MEMBER_MAXIMUM)):
        require(type(description[key]) is int and 0 < description[key] <= bound,
                'Application dependencies exceed their reviewed bound.')
    for key in ('archiveSha256', 'packageLockSha256', 'dependencyGraphSha256'):
        require(isinstance(description[key], str) and re.fullmatch('[a-f0-9]{64}', description[key]),
                'Application dependency identity is malformed.')
    if signed_bundle is not None:
        require(isinstance(signed_bundle, dict)
                and type(signed_bundle.get('bytes')) is int
                and description['archiveBytes'] == signed_bundle['bytes']
                and description['archiveSha256'] == signed_bundle.get('sha256'),
                'Application dependencies differ from the signed release.')


def _name(name):
    require(isinstance(name, str) and 0 < len(name) <= 4096 and '\\' not in name
            and not any(ord(character) < 32 for character in name)
            and all(part not in ('', '.', '..') for part in name.split('/'))
            and not pathlib.PurePosixPath(name).is_absolute(), 'Unsafe application dependency path.')
    parts = name.split('/')
    require(parts[0] == 'node_modules' or name in ('package.json', 'package-lock.json'),
            'Application dependency archive contains an unrelated entry.')
    return parts


def _link_destination(name, target):
    require(target and len(target) <= 4096 and '\\' not in target
            and not any(ord(character) < 32 for character in target)
            and not pathlib.PurePosixPath(target).is_absolute(), 'Dependency link is not internal.')
    parts = name.split('/')[:-1]
    for part in target.split('/'):
        if part == '..':
            require(len(parts) > 1, 'Dependency link escaped node_modules.')
            parts.pop()
        elif part not in ('', '.'):
            parts.append(part)
    require(parts and parts[0] == 'node_modules', 'Dependency link escaped node_modules.')
    return '/'.join(parts)


def _validate_members(members):
    entries, directories, links = {}, set(), {}
    for member in members:
        parts = _name(member.name)
        require(member.name not in entries and not member.islnk()
                and (member.isfile() or member.isdir() or member.issym()),
                'Duplicate or special application dependency entry.')
        require(member.size >= 0 and (member.isfile() or member.size == 0),
                'Non-file dependency entry contains data.')
        allowed_modes = (0o777,) if member.issym() else ((0o755,) if member.isdir() else (0o644, 0o755))
        require(member.mode in allowed_modes, 'Unsafe application dependency mode.')
        entries[member.name] = member
        directories.update('/'.join(parts[:index]) for index in range(1, len(parts)))
        if member.isdir():
            directories.add(member.name)
        if member.issym():
            require(member.name.startswith('node_modules/'), 'Metadata cannot be a dependency link.')
            links[member.name] = _link_destination(member.name, member.linkname)
    require({'package.json', 'package-lock.json', 'node_modules'} <= set(entries)
            and entries['package.json'].isfile() and entries['package-lock.json'].isfile()
            and entries['node_modules'].isdir(), 'The application dependency closure is incomplete.')
    require(all(name not in entries or entries[name].isdir() for name in directories),
            'Dependency archive traverses a non-directory or symlink.')
    require(directories <= set(entries), 'Dependency archive must explicitly count every directory.')
    known = set(entries) | directories
    # Resolve links through other links, including directory-prefix links, before
    # touching disk. This catches dangling links and cycles in any archive order.
    for name, destination in links.items():
        seen = {name}
        while True:
            components = destination.split('/')
            traversed = next(('/'.join(components[:index]) for index in range(1, len(components) + 1)
                              if '/'.join(components[:index]) in links), None)
            if traversed is None:
                require(destination in known, 'Dependency link has no target in the signed closure.')
                break
            require(traversed not in seen and len(seen) < 40, 'Dependency archive has a cyclic link.')
            seen.add(traversed)
            suffix = components[len(traversed.split('/')):]
            destination = '/'.join([links[traversed], *suffix])
    return entries, directories


def _package_root(name):
    if not name.endswith('/package.json'):
        return None
    parts = name.split('/')[:-1]
    if 'node_modules' not in parts:
        return None
    index = len(parts) - 1 - parts[::-1].index('node_modules')
    package = parts[index + 1:]
    if (len(package) == 1 and not package[0].startswith(('@', '.'))
            or len(package) == 2 and package[0].startswith('@')):
        return '/'.join(parts)
    return None


def _compatible(selectors, selected):
    require(selectors is None or isinstance(selectors, list)
            and all(isinstance(value, str) for value in selectors), 'Malformed dependency platform constraint.')
    if not selectors:
        return True
    return '!' + selected not in selectors and (not any(not value.startswith('!') for value in selectors)
                                                 or selected in selectors or 'any' in selectors)


def _verify_package_graph(archive, entries, lock, description):
    installed = {}
    for name, member in entries.items():
        package_root = _package_root(name)
        if package_root is None:
            continue
        require(member.isfile() and member.size <= JSON_MAXIMUM, 'Installed dependency metadata is not a bounded file.')
        package = parse_json(archive.extractfile(member).read(JSON_MAXIMUM + 1))
        reviewed = lock['packages'].get(package_root)
        require(isinstance(package, dict) and isinstance(reviewed, dict)
                and isinstance(reviewed.get('version'), str) and package.get('version') == reviewed['version']
                and not reviewed.get('link'), 'An installed dependency is absent from or differs from the lockfile.')
        installed[package_root] = package
    for name, reviewed in lock['packages'].items():
        if not name:
            continue
        require(name.startswith('node_modules/'), 'The offline dependency graph contains a workspace outside its closure.')
        if (reviewed.get('dev') or reviewed.get('optional') or reviewed.get('devOptional')
                or not _compatible(reviewed.get('os'), description['platform'])
                or not _compatible(reviewed.get('cpu'), description['arch'])):
            continue
        require(name in installed, 'The offline dependency closure is missing a required locked package: ' + name)
    # Root requirements must be present even if an inconsistent lock wrongly
    # marks their only package optional or development-only.
    root_dependencies = lock['packages'][''].get('dependencies', {})
    require(isinstance(root_dependencies, dict), 'The application dependency requirements are malformed.')
    require(all('node_modules/' + name in installed for name in root_dependencies),
            'The offline dependency closure is missing a direct application dependency.')


def archive_members(archive_path, description):
    validate_description(description)
    archive_path = pathlib.Path(archive_path)
    metadata = archive_path.lstat()
    require(stat.S_ISREG(metadata.st_mode) and not archive_path.is_symlink()
            and metadata.st_size == description['archiveBytes']
            and digest(archive_path) == description['archiveSha256'], 'Application dependency archive changed.')
    members, expanded = [], 0
    with _archive(archive_path) as archive:
        for member in archive:
            expanded += member.size
            require(len(members) < description['fileCount'] and 0 <= expanded <= description['expandedBytes'],
                    'Application dependency expansion exceeded its signed bound.')
            members.append(member)
        require(len(members) == description['fileCount'] and expanded == description['expandedBytes'],
                'Application dependency expansion differs from its signed description.')
        entries, _ = _validate_members(members)
        lock_member = entries['package-lock.json']
        require(lock_member.size <= JSON_MAXIMUM and entries['package.json'].size <= JSON_MAXIMUM,
                'Dependency package metadata exceeds its bound.')
        raw = archive.extractfile(lock_member).read(JSON_MAXIMUM + 1)
        lock = parse_json(raw)
        require(hashlib.sha256(raw).hexdigest() == description['packageLockSha256']
                and dependency_graph_sha256(lock) == description['dependencyGraphSha256'],
                'The archived dependency lock does not match the reviewed graph.')
        package = parse_json(archive.extractfile(entries['package.json']).read(JSON_MAXIMUM + 1))
        require(isinstance(package, dict) and package.get('dependencies') == lock['packages'][''].get('dependencies'),
                'The archived package and lock disagree about application dependencies.')
        _verify_package_graph(archive, entries, lock, description)
    return members


def storage_required(description):
    validate_description(description)
    # Every directory must be an explicit member. Include allocation rounding
    # and directory/symlink storage instead of budgeting logical bytes alone.
    return description['expandedBytes'] + description['fileCount'] * 4096


def _protected(path, directory=False):
    require(sys.platform == 'linux', 'Dependency installation requires the qualified Linux host.')
    info = path.lstat()
    require(info.st_uid == 0 and not path.is_symlink()
            and (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
            and not stat.S_IMODE(info.st_mode) & 0o022, 'Application dependencies are not protected by root.')
    return info


def _protected_ancestors(path):
    require(path.is_absolute(), 'Application dependency destination must be absolute.')
    for parent in reversed(path.parents):
        _protected(parent, True)


def _walk(root):
    result = {}
    pending = [root]
    while pending:
        directory = pending.pop()
        for item in sorted(directory.iterdir()):
            name = item.relative_to(root).as_posix()
            require(len(result) < MEMBER_MAXIMUM, 'Dependency tree exceeds the member bound.')
            result[name] = item
            if stat.S_ISDIR(item.lstat().st_mode) and not item.is_symlink():
                pending.append(item)
    return result


def verify_closure(archive_path, target, description):
    target = pathlib.Path(target)
    _protected_ancestors(target)
    _protected(target, True)
    members = archive_members(archive_path, description)
    entries, directories = _validate_members(members)
    actual = _walk(target)
    require(set(actual) == set(entries) | directories, 'Application dependencies contain missing or unreviewed files.')
    with _archive(archive_path) as archive:
        # A gzip seek backwards replays decompression from its beginning. Walk
        # the reviewed archive order, rather than filesystem directory order,
        # so full content verification stays one forward pass even for deeply
        # nested packages. Every directory is an explicit validated member.
        for member in members:
            name, path = member.name, actual[member.name]
            if member.issym():
                info = path.lstat()
                require(info.st_uid == 0 and path.is_symlink() and os.readlink(path) == member.linkname
                        and path.resolve(strict=True).is_relative_to(target / 'node_modules'),
                        'Staged dependency link changed.')
            elif name in directories:
                info = _protected(path, True)
                require(stat.S_IMODE(info.st_mode) == 0o755, 'Staged dependency directory mode changed.')
            else:
                info = _protected(path)
                require(info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == member.mode
                        and info.st_size == member.size, 'Staged dependency file mode, size or independence changed.')
                with archive.extractfile(member) as stream:
                    require(digest(path) == hashlib.file_digest(stream, 'sha256').hexdigest(),
                            'Staged application dependency content changed.')
    return target / 'node_modules'


def _retained_records(root, *, protected, allow_existing_hardlinks):
    root = pathlib.Path(root)
    _protected_ancestors(root)
    root_info = _protected(root, True) if protected else root.lstat()
    require(stat.S_ISDIR(root_info.st_mode) and not root.is_symlink() and root_info.st_uid == 0,
            'The retained dependency source must be a root-owned real directory.')
    paths = _walk(root)
    require(len(paths) <= MEMBER_MAXIMUM, 'Retained dependencies exceed the member bound.')
    records = [{'path': '.', 'type': 'directory', 'mode': stat.S_IMODE(root_info.st_mode),
                'uid': root_info.st_uid, 'gid': root_info.st_gid}]
    members = []
    base = tarfile.TarInfo('node_modules')
    base.type, base.mode = tarfile.DIRTYPE, 0o755
    members.append(base)
    total, shared = 0, 0
    for name, path in sorted(paths.items()):
        info = path.lstat()
        member = tarfile.TarInfo('node_modules/' + name)
        record = {'path': name, 'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid}
        require(info.st_uid == 0, 'Retained dependency ownership changed.')
        if path.is_symlink():
            member.type, member.mode, member.linkname = tarfile.SYMTYPE, 0o777, os.readlink(path)
            record.update(type='symlink', target=member.linkname)
        elif stat.S_ISDIR(info.st_mode):
            if protected:
                _protected(path, True)
            member.type, member.mode = tarfile.DIRTYPE, 0o755
            record['type'] = 'directory'
        else:
            require(stat.S_ISREG(info.st_mode), 'Retained dependencies contain a special file.')
            if protected:
                _protected(path)
            require(info.st_nlink == 1 or allow_existing_hardlinks,
                    'Retained dependencies still share mutable file inodes.')
            member.size, member.mode = info.st_size, 0o755 if info.st_mode & 0o111 else 0o644
            record.update(type='file', bytes=info.st_size, links=info.st_nlink, sha256=digest(path))
            after = path.lstat()
            require((info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
                    == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
                    'Retained dependency changed while its identity was measured.')
            total += info.st_size
            require(total <= EXPANDED_MAXIMUM, 'Retained dependencies exceed the byte bound.')
            shared += int(info.st_nlink > 1)
        records.append(record)
        members.append(member)
    # Reuse the graph safety rules, adding only synthetic regular metadata
    # headers; no lockfile or package identity is invented or written to disk.
    for name in ('package.json', 'package-lock.json'):
        member = tarfile.TarInfo(name)
        member.mode = 0o644
        members.append(member)
    _validate_members(members)
    for path in paths.values():
        if path.is_symlink():
            require(path.resolve(strict=True).is_relative_to(root), 'Retained dependency link escaped its tree.')
    return records, total, shared


def _retained_receipt(records, total, shared):
    encoded = json.dumps(records, sort_keys=True, ensure_ascii=True, separators=(',', ':')).encode('ascii')
    return {'format': 1, 'treeSha256': hashlib.sha256(encoded).hexdigest(), 'fileCount': len(records) - 1,
            'expandedBytes': total, 'sharedFileCount': shared}


def inspect_retained_dependencies(root):
    """Read-only adoption evidence; does not certify a writable tree as safe."""
    return _retained_receipt(*_retained_records(root, protected=False, allow_existing_hardlinks=True))


def attest_retained_dependencies(root, *, allow_existing_hardlinks=False):
    """Attest actual protected bytes without claiming an absent npm lockfile.

    Adoption may explicitly allow a protected legacy hardlink tree; its link
    counts enter the receipt and must remain unchanged. New target closures
    always require independent regular files. The caller binds this receipt to
    the exact prior candidate and runtime in its separately reviewed adoption.
    """
    return _retained_receipt(*_retained_records(root, protected=True,
                                              allow_existing_hardlinks=allow_existing_hardlinks))


def verify_retained_dependencies(root, receipt, *, allow_existing_hardlinks=False):
    observed = attest_retained_dependencies(root, allow_existing_hardlinks=allow_existing_hardlinks)
    require(observed == receipt, 'The independently attested prior dependency tree changed.')
    return observed


def stage_retained_dependencies(source, target, expected_source_receipt):
    """Prepare an independent copy of reviewed legacy dependency bytes.

    A running-source copy is preparation only. Before using it for rollback the
    caller must stop writers under its adoption lock and recheck both receipts.
    This helper never changes the source, renames a live directory, installs
    packages, fabricates a lockfile, or removes an interrupted destination.
    Selection is a separate reviewed operation after native qualification.
    """
    source, target = pathlib.Path(source), pathlib.Path(target)
    require(not target.is_relative_to(source) and not source.is_relative_to(target),
            'Retained dependency source and destination overlap.')
    _protected_ancestors(target)
    require(not target.exists() and not target.is_symlink(), 'Retained dependency destination already exists.')
    records, total, shared = _retained_records(source, protected=False, allow_existing_hardlinks=True)
    require(_retained_receipt(records, total, shared) == expected_source_receipt,
            'Legacy dependencies changed after adoption review.')
    target.mkdir(mode=0o755)
    target.chmod(0o755)
    expected = []
    for record in sorted(records, key=lambda item: (item['path'].count('/'), item['path'])):
        relative = record['path']
        before, destination = source / relative, target / relative
        normalized = {**record, 'uid': 0, 'gid': 0}
        if record['type'] == 'directory':
            normalized['mode'] = 0o755
            if relative != '.':
                destination.mkdir(mode=0o755)
            destination.chmod(0o755)
        elif record['type'] == 'symlink':
            normalized['mode'] = 0o777
            destination.symlink_to(record['target'])
        else:
            normalized['mode'] = 0o755 if record['mode'] & 0o111 else 0o644
            normalized['links'] = 1
            source_fd = os.open(before, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                source_info = os.fstat(source_fd)
                require(stat.S_ISREG(source_info.st_mode) and source_info.st_size == record['bytes'],
                        'Legacy dependency changed before copying.')
                target_fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, normalized['mode'])
                with os.fdopen(target_fd, 'wb') as output, os.fdopen(os.dup(source_fd), 'rb') as original:
                    shutil.copyfileobj(original, output)
                    output.flush()
                    os.fchmod(output.fileno(), normalized['mode'])
                    os.fsync(output.fileno())
                    target_info = os.fstat(output.fileno())
                    require((target_info.st_dev, target_info.st_ino) != (source_info.st_dev, source_info.st_ino)
                            and target_info.st_nlink == 1, 'Retained dependency copy shares a source inode.')
            finally:
                os.close(source_fd)
        expected.append(normalized)
    # Group inheritance must not give a service account ownership of the new
    # closure. Directories were created by root; normalize gid without touching
    # a symlink target or any original file.
    for path in [target, *_walk(target).values()]:
        os.chown(path, 0, 0, follow_symlinks=False)
    expected.sort(key=lambda item: item['path'])
    target_records, target_total, target_shared = _retained_records(target, protected=True, allow_existing_hardlinks=False)
    target_records.sort(key=lambda item: item['path'])
    require(target_records == expected and target_total == total and target_shared == 0,
            'Retained copy differs from the reviewed source bytes or executable modes.')
    require(inspect_retained_dependencies(source) == expected_source_receipt,
            'Legacy dependencies changed during adoption copying.')
    for path in [*[target / item['path'] for item in reversed(expected) if item['type'] == 'directory'], target.parent]:
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    return {'format': 1, 'source': expected_source_receipt,
            'retained': attest_retained_dependencies(target)}


def stage_closure(archive_path, target, description):
    target = pathlib.Path(target)
    _protected_ancestors(target)
    members = archive_members(archive_path, description)
    if target.exists() or target.is_symlink():
        # A partial interrupted tree is evidence, never a reusable installation.
        return verify_closure(archive_path, target, description)
    target.mkdir(mode=0o755)
    target.chmod(0o755)
    _, directories = _validate_members(members)
    for name in sorted(directories, key=lambda value: (value.count('/'), value)):
        path = target / name
        path.mkdir(mode=0o755, exist_ok=True)
        path.chmod(0o755)
    with _archive(archive_path) as archive:
        for member in members:
            destination = target / member.name
            if member.isdir():
                continue
            if member.issym():
                destination.symlink_to(member.linkname)
                continue
            fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, member.mode)
            with os.fdopen(fd, 'wb') as output, archive.extractfile(member) as source:
                shutil.copyfileobj(source, output)
                output.flush()
                os.fchmod(output.fileno(), member.mode)
                os.fsync(output.fileno())
    result = verify_closure(archive_path, target, description)
    # Ensure every directory entry is durable before a release selects this tree.
    for name in sorted(directories, key=lambda value: value.count('/'), reverse=True):
        fd = os.open(target / name, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    for path in (target, target.parent):
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    return result


# The probe list is reviewed source, not an expression supplied by an archive.
# These operations load native code without starting a shell, reading the live
# workspace, contacting a provider or writing inside retained dependencies.
PROBE = r"""
const {createRequire} = require('node:module');
const req = createRequire(process.cwd() + '/package.json');
(async () => {
  const sharp = req('sharp');
  const image = await sharp({create:{width:1,height:1,channels:4,background:'#000000'}}).png().toBuffer();
  if (!image.length) throw Error('sharp did not render');
  const canvas = req('@napi-rs/canvas').createCanvas(1,1);
  if (!canvas.toBuffer('image/png').length) throw Error('canvas did not render');
  if (typeof req('node-pty').spawn !== 'function') throw Error('node-pty did not load');
  const {DatabaseSync} = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  if (db.prepare('select 42 as answer').get().answer !== 42) throw Error('SQLite did not execute');
  db.close();
  console.log(JSON.stringify({platform:process.platform,arch:process.arch,
    nodeVersion:process.versions.node,nodeAbi:Number(process.versions.modules)}));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
"""


def execution_identity(target, node, service_user=None):
    require(sys.platform == 'linux', 'Dependency execution qualification requires Linux.')
    import pwd
    account = pwd.getpwnam(service_user) if service_user is not None else pwd.getpwuid(os.geteuid())
    require(account.pw_uid != 0, 'Dependency qualification must not execute package code as root.')
    options = {}
    if os.geteuid() == 0:
        options = {'user': account.pw_uid, 'group': account.pw_gid, 'extra_groups': []}
    else:
        require(account.pw_uid == os.geteuid(), 'Dependency qualification cannot assume another user.')
    result = subprocess.run([str(node), '--no-warnings', '-e', PROBE], cwd=target,
                            env={'PATH': str(pathlib.Path(node).parent) + ':/usr/bin:/bin',
                                 'HOME': account.pw_dir, 'LANG': 'C.UTF-8',
                                 'NODE_DISABLE_COMPILE_CACHE': '1'},
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60, check=True, **options)
    require(len(result.stdout) <= 4096 and len(result.stderr) <= 65536, 'Dependency probe output exceeded its bound.')
    identity = parse_json(result.stdout)
    require(isinstance(identity, dict) and set(identity) == {'platform', 'arch', 'nodeVersion', 'nodeAbi'},
            'Dependency runtime probe returned an invalid identity.')
    return identity


def verify_execution(target, node, description, service_user):
    validate_description(description)
    observed = execution_identity(target, node, service_user)
    require(observed == {key: description[key] for key in observed},
            'Application dependencies target a different platform, Node version or native ABI.')
    return observed


def pack_closure(source, output, node, service_user=None):
    """Package a preinstalled Linux tree; npm/build/download is the caller's job."""
    source, output = pathlib.Path(source).resolve(strict=True), pathlib.Path(output).absolute()
    require(not output.is_relative_to(source), 'Dependency output must be outside the source tree.')
    identity = execution_identity(source, node, service_user)
    require(identity['platform'] == 'linux' and identity['arch'] in ('x64', 'arm64'),
            'The dependency closure was not qualified on a supported Linux target.')
    package_paths = [source / 'package.json', source / 'package-lock.json', source / 'node_modules']
    require(all(path.exists() and not path.is_symlink() for path in package_paths)
            and package_paths[0].is_file() and package_paths[1].is_file() and package_paths[2].is_dir(),
            'Select a complete independently installed dependency tree.')
    paths = {path.name: path for path in package_paths}
    paths.update({'node_modules/' + name: path for name, path in _walk(source / 'node_modules').items()})
    require(len(paths) <= MEMBER_MAXIMUM, 'Dependency tree exceeds the member bound.')
    members, expanded = [], 0
    with tarfile.open(output, 'x:gz', format=tarfile.PAX_FORMAT, dereference=False) as archive:
        for name, path in sorted(paths.items()):
            member = archive.gettarinfo(str(path), arcname=name)
            require(not member.islnk(), 'Build dependencies independently; hardlinked inputs are not accepted.')
            member.uid = member.gid = 0
            member.uname = member.gname = ''
            member.mtime = 0
            member.pax_headers = {}
            member.mode = 0o777 if member.issym() else (0o755 if member.isdir() or member.mode & 0o111 else 0o644)
            expanded += member.size
            require(expanded <= EXPANDED_MAXIMUM, 'Dependency tree exceeds the expansion bound.')
            members.append(member)
            if member.isfile():
                with path.open('rb') as stream:
                    archive.addfile(member, stream)
            else:
                archive.addfile(member)
    _validate_members(members)
    lock_raw = package_paths[1].read_bytes()
    description = {'format': 1, 'archiveBytes': output.stat().st_size, 'archiveSha256': digest(output),
                   'expandedBytes': expanded, 'fileCount': len(members),
                   'packageLockSha256': hashlib.sha256(lock_raw).hexdigest(),
                   'dependencyGraphSha256': dependency_graph_sha256(parse_json(lock_raw)), **identity}
    archive_members(output, description)
    metadata = output.with_name(output.name + '.metadata.json')
    with metadata.open('x', encoding='utf-8') as stream:
        json.dump(description, stream, sort_keys=True, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    return description


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    pack = commands.add_parser('pack', help='Package already installed and qualified Linux dependencies.')
    pack.add_argument('source', type=pathlib.Path)
    pack.add_argument('output', type=pathlib.Path)
    pack.add_argument('--node', required=True, type=pathlib.Path)
    pack.add_argument('--service-user', help='Unprivileged probe user when the producer runs as root.')
    args = parser.parse_args()
    print(json.dumps(pack_closure(args.source, args.output, args.node, args.service_user), sort_keys=True))
