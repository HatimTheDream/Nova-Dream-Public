"""Closed Linux schema55-to60 configuration derivation; never starts a runtime.

The installer/isolated producer must first verify its actual closed owner and
pass the original receipt chain and previously attested dependency inventory.
This helper rechecks those immutable inputs and invokes the maintained builders.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys


def require(value, message):
    if not value:
        raise RuntimeError(message)


def file_reference(path):
    path = Path(path)
    require(path.is_file() and not path.is_symlink() and 0 < path.stat().st_size <= 1024 * 1024,
            'The original startup receipt is outside its finite regular-file bound.')
    data = path.read_bytes()
    return {'path': str(path), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def document(ref):
    require(type(ref) is dict and set(ref) == {'path', 'bytes', 'sha256'}
            and type(ref['bytes']) is int and 0 < ref['bytes'] <= 1024 * 1024
            and type(ref['sha256']) is str and re.fullmatch('[a-f0-9]{64}', ref['sha256']),
            'The original closed-startup document reference is invalid.')
    path = Path(ref['path'])
    info = path.lstat()
    require(path.is_absolute() and path.resolve(strict=True) == path and stat.S_ISREG(info.st_mode)
            and info.st_nlink == 1 and info.st_uid == os.geteuid() and not info.st_mode & 0o022
            and info.st_size == ref['bytes'], 'The original closed-startup document is not protected.')
    raw = path.read_bytes()
    identity = lambda value: (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid,
                              value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
    require(hashlib.sha256(raw).hexdigest() == ref['sha256'] and identity(path.lstat()) == identity(info),
            'The original closed-startup document changed.')
    return json.loads(raw)


def closed_authority(authority, *, candidate_id, epoch, window):
    require(type(authority) is dict and set(authority) == {'format', 'kind', 'candidateId', 'workspaceEpoch',
                'started', 'ready', 'closed', 'dependencyRoot', 'dependencyFiles', 'nodeSha256'}
            and authority['format'] == 1 and authority['kind'] == 'hosted-closed-configuration-authority'
            and authority['candidateId'] == candidate_id and authority['workspaceEpoch'] == epoch,
            'Configuration derivation lacks its exact closed startup authority.')
    started, ready, closed = (document(authority[name]) for name in ('started', 'ready', 'closed'))
    require(all(type(value) is dict for value in (started, ready, closed))
            and started.get('candidateId') == ready.get('candidateId') == candidate_id
            and started.get('epoch') == ready.get('epoch') == epoch
            and closed.get('owningServiceFullyStopped') is True
            and closed.get('readyReceiptSha256', closed.get('readySha256')) == authority['ready']['sha256']
            and (ready.get('startedSha256') is None or ready['startedSha256'] == authority['started']['sha256'])
            and type(started.get('startedAtSeconds')) is int and type(ready.get('readyAtSeconds')) is int
            and type(closed.get('closedAtSeconds')) is int
            and started['startedAtSeconds'] <= ready['readyAtSeconds'] <= closed['closedAtSeconds']
            and tuple(window) == (started['startedAtSeconds'], closed['closedAtSeconds'])
            and 0 <= window[1] - window[0] <= 3600,
            'Configuration derivation changed the genuine settled startup chain.')


def attest_builder_closure(release, manifest, dependency_root, dependency_files):
    """Complete compiled service plus Zod; never infer a five-file closure."""
    import recovery as r
    release, dependency_root = Path(release), Path(dependency_root)
    require(release.resolve(strict=True) == release and dependency_root.resolve(strict=True) == dependency_root
            and (release / 'node_modules').resolve(strict=True) == dependency_root,
            'The configuration builder dependency selector changed.')
    expected = {item['path']: item['sha256'] for item in manifest['artifacts'] if item['path'].startswith('dist/service/')}
    require(0 < len(expected) <= 20000 and type(dependency_files) is dict and 0 < len(dependency_files) <= 20000,
            'The complete configuration builder source closure is unavailable.')
    files = {}
    for root in (release / 'dist/service', dependency_root / 'zod'):
        require(root.resolve(strict=True) == root and root.is_dir(), 'Configuration builder closure root changed.')
        for path in root.rglob('*'):
            require(not path.is_symlink() and (path.is_file() or path.is_dir()), 'Configuration builder closure contains a redirect.')
            if path.is_file():
                require(path.stat().st_size <= 32 * 1024 * 1024 and len(files) < 40000,
                        'Configuration builder source exceeds its reviewed bound.')
                files[path] = {'size': path.stat().st_size, 'sha256': r.digest(path)}
    service = {path.relative_to(release).as_posix(): value['sha256'] for path, value in files.items() if path.is_relative_to(release / 'dist/service')}
    dependencies = {path.relative_to(dependency_root).as_posix(): value for path, value in files.items() if path.is_relative_to(dependency_root / 'zod')}
    require(service == expected and dependencies == dependency_files,
            'The compiled configuration builder or physically attested Zod closure changed.')
    return files


def attest_new_workspaces(before, after):
    """Only the two exact empty generations created by the maintained target."""
    for name in ('direct-workspace', 'direct-workspace.identity', 'direct-workspace-v2',
                 'direct-workspace-v2.identity', 'group-workspace', 'group-workspace.identity'):
        require(not os.path.lexists(before / name), 'The schema55 baseline already contains unqualified dedicated workspace state.')
    require(not os.path.lexists(after / 'direct-workspace') and not os.path.lexists(after / 'direct-workspace.identity'),
            'The fresh schema55 transition created an unreviewed legacy workspace.')
    owner = after.lstat()
    for name, marker_bytes in (('direct-workspace-v2', b'edition3-direct-workspace-v2\n'),
                               ('group-workspace', b'edition3-group-workspace\n')):
        folder, marker = after / name, after / (name + '.identity')
        folder_info, marker_info = folder.lstat(), marker.lstat()
        require(folder.resolve(strict=True) == folder and stat.S_ISDIR(folder_info.st_mode)
                and marker.resolve(strict=True) == marker and stat.S_ISREG(marker_info.st_mode)
                and marker_info.st_nlink == 1 and marker_info.st_size == len(marker_bytes)
                and marker.read_bytes() == marker_bytes and not any(folder.iterdir())
                and all((info.st_uid, info.st_gid) == (owner.st_uid, owner.st_gid) and not info.st_mode & 0o022
                        for info in (folder_info, marker_info))
                and stat.S_IMODE(marker_info.st_mode) == 0o600,
                'The maintained dedicated workspace is not the exact owned empty generation.')


# Public openclaw@2026.9.8 package release files, verified against npm dist.integrity.
_HOSTED_CONFIG = Path('/etc/nova-update/config.json')
_RUNTIME_ROOT = Path('/opt/nova/runtime')
_OPENCLAW_FILES = {
    'openclaw.mjs': (24881, 'aa8606ca0d62ff133ef5b7bd2323ec8ff3f8eb384404399cd5e742918d63b0a1'),
    'package.json': (145254, 'd2e734563bfb126d273beeb1e2cc5d4525b4d59efe00fdfec50a39b427524f56'),
}


def _authority_identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _authority_file(path, maximum):
    from install import protected
    protected(path)
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as stream:
        identity = _authority_identity(os.fstat(stream.fileno()))
        require(identity[6] <= maximum, 'Runtime authority file exceeds its bound.')
        data = stream.read(maximum + 1)
        require(len(data) == identity[6] and identity == _authority_identity(os.fstat(stream.fileno()))
                == _authority_identity(path.lstat()), 'Runtime authority changed during verification.')
    return data, identity


def retained_runtime_entry(before, physical_package):
    """Preserve the configured spelling while authenticating its installed package."""
    from install import protected, protected_selector
    raw_host, host_identity = _authority_file(_HOSTED_CONFIG, 65536)
    host = json.loads(raw_host)
    root, physical = _RUNTIME_ROOT, Path(physical_package)
    require(host.get('runtimeDirectory') == str(root) and physical.is_relative_to(root)
            and physical != root, 'Runtime package is outside the protected configured root.')
    protected(root, True)
    protected(physical, True)
    configured = host.get('agentDirectory')
    entry = physical / 'openclaw.mjs'
    selector_identity = None
    if configured == str(physical):
        name = str(entry)
    else:
        selector = root / 'openclaw'
        name = str(selector / 'openclaw.mjs')
        require(configured == str(selector) and protected_selector(selector, root, True) == physical
                and Path(name).resolve(strict=True) == entry and Path(name).samefile(entry),
                'The configured runtime selector differs from its protected package.')
        selector_identity = _authority_identity(selector.lstat())
    entries = before.get('plugins', {}).get('entries', {})
    require(isinstance(entries, dict), 'Invalid original account plugin registry.')
    if 'edition3-accounts' not in entries:
        # The existing builder can add the account plugin at the physical package
        # location. An alias spelling needs a retained entry to corroborate it.
        require(configured == str(physical), 'An aliased runtime needs its retained account entry.')
    else:
        account = entries['edition3-accounts']
        config = account.get('config') if isinstance(account, dict) else None
        require(isinstance(config, dict) and config.get('runtimeEntry') == name,
                'The retained account runtime entry disagrees with the protected host configuration.')
    files = {}
    for filename, (length, digest) in _OPENCLAW_FILES.items():
        raw, identity = _authority_file(physical / filename, length)
        require(len(raw) == length and hashlib.sha256(raw).hexdigest() == digest,
                'The configured OpenClaw 2026.9.8 package or entry bytes changed.')
        if filename == 'package.json':
            package = json.loads(raw)
            require(package.get('name') == 'openclaw' and package.get('version') == '2026.9.8',
                    'The configured package or runtime version differs.')
        files[filename] = identity
    return name, (host_identity, hashlib.sha256(raw_host).hexdigest(), selector_identity, files)


def derive_configuration(snapshot, live, selected, *, node, app_releases, session_binding_key,
                         startup_window, catalog_runtime_root, authority):
    import recovery as r
    scope = r.current_application_transition()
    require(sys.platform == 'linux' and os.geteuid() == 0 and scope is not None
            and scope['beforeRoot'] == Path(snapshot) and scope['afterRoot'] == Path(live)
            and scope['restored'] is False and scope['toSchemaVersion'] == 60,
            'Hosted configuration derivation requires the explicit target comparison phase.')
    require(type(app_releases) in (tuple, list) and len(app_releases) == 2
            and isinstance(session_binding_key, (bytes, bytearray)) and len(session_binding_key) == 32,
            'Hosted derivation needs both admitted applications and the original protected workspace key.')
    release, manifest = app_releases[1]
    release, executable = Path(release), Path(node)
    raw_package, raw_manifest = (release / 'package.json').read_bytes(), (release / 'dist/candidate.json').read_bytes()
    candidate_id = hashlib.sha256(raw_package + raw_manifest).hexdigest()
    require(json.loads(raw_manifest) == manifest and manifest.get('schemaVersion') == 60 and manifest.get('apiVersion') == 1
            and executable.resolve(strict=True) == executable and r.digest(executable) == authority.get('nodeSha256'),
            'The actual configuration derivation candidate or platform executable changed.')
    _, epoch = r.selected_workspace(snapshot, closed=True)
    closed_authority(authority, candidate_id=candidate_id, epoch=epoch, window=startup_window)
    closure = attest_builder_closure(release, manifest, authority['dependencyRoot'], authority['dependencyFiles'])
    relative = selected / 'openclaw-runtime/openclaw.json'
    old_path, new_path = Path(snapshot) / relative, Path(live) / relative
    before, after = (r.bounded_json(path, 4 * 1024 * 1024) for path in (old_path, new_path))
    native_root = Path(live) / selected / 'openclaw-runtime'
    attest_new_workspaces(Path(snapshot) / selected / 'openclaw-runtime', native_root)
    ids = ('edition3-direct', 'edition3-group')
    require(all(name not in before.get('agents', {}).get('entries', {}) for name in ids)
            and 'edition3-direct-agent' not in before.get('plugins', {}).get('entries', {})
            and 'edition3-direct-agent' not in before.get('plugins', {}).get('allow', []),
            'The schema55 baseline has unqualified dedicated agent authority.')
    old_bridge = before.get('plugins', {}).get('entries', {}).get('edition3-workspace', {}).get('config', {})
    bridge = after.get('plugins', {}).get('entries', {}).get('edition3-workspace', {}).get('config', {})
    require(type(bridge) is dict and bridge.get('url') == old_bridge.get('url')
            and type(bridge.get('url')) is str and re.fullmatch(r'http://127\.0\.0\.1:[0-9]{1,5}/workspace', bridge['url'])
            and type(bridge.get('token')) is str and re.fullmatch('[a-f0-9]{64}', bridge['token']),
            'The generated module bridge changed its retained endpoint or token contract.')
    bindings = bridge.get('sessionBindings')
    require(type(bindings) is list and len(bindings) <= 100000, 'Generated session bindings are missing.')
    r.verified_session_bindings(snapshot, selected, new_path, executable, session_binding_key)
    arguments = after.get('browser', {}).get('extraArgs', [])
    match = re.fullmatch(r'--proxy-server=(http://127\.0\.0\.1:([0-9]{1,5}))', arguments[0]) if arguments and type(arguments[0]) is str else None
    require(match is not None and 0 < int(match[2]) < 65536, 'Generated browser proxy is outside the retained contract.')
    runtime_entry, runtime_authority = retained_runtime_entry(before, catalog_runtime_root)
    payload = {'before': before, 'after': after, 'bridge': {name: bridge[name] for name in ('url', 'token')},
        'proxy': match[1], 'epoch': epoch, 'releaseRoot': str(release), 'nativeRoot': str(native_root),
        'runtimeEntry': runtime_entry, 'sessionBindings': bindings}
    script = Path(__file__).with_name('local-retained-configuration.mjs')
    call = subprocess.run([str(executable), str(script), '--hosted-schema-55-to-60'],
        input=json.dumps(payload).encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env={'PATH': str(executable.parent) + ':/usr/bin:/bin', 'NODE_DISABLE_COMPILE_CACHE': '1'}, timeout=30)
    require(call.returncode == 0 and len(call.stdout) <= 4 * 1024 * 1024,
            'The maintained hosted configuration derivation refused the actual target.')
    require(json.loads(call.stdout) == after, 'Retained native configuration or permissions changed.')
    require(all(path.stat().st_size == value['size'] and r.digest(path) == value['sha256'] for path, value in closure.items()),
            'The complete builder closure changed during derivation.')
    require(retained_runtime_entry(before, catalog_runtime_root) == (runtime_entry, runtime_authority),
            'The protected runtime selector or package changed during derivation.')
    closed_authority(authority, candidate_id=candidate_id, epoch=epoch, window=startup_window)
    return {'path': str(new_path), 'hashes': [r.digest(old_path), r.digest(new_path)],
            'byteSizes': [old_path.stat().st_size, new_path.stat().st_size]}
