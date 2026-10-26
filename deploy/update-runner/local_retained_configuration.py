"""Complete local configuration derivation from BEFORE and owned observations."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time


def derive_configuration(context, selected):
    import recovery as r
    require = r.require
    spec = context.derivation
    require(set(spec) == {'kind', 'releaseRoot', 'sourceRefs', 'hostResult'},
            'Closed maintained configuration derivation is required.')
    release = Path(spec['releaseRoot'])
    require(context.node is not None and context.app_releases is not None
            and release == Path(context.app_releases[1][0]), 'Configuration builder release is not the admitted candidate.')
    refs = spec['sourceRefs']
    require(type(refs) is list and 0 < len(refs) <= 20000, 'Bounded builder source closure is required.')
    expected = {}
    for ref in refs:
        require(type(ref) is dict and set(ref) == {'path','bytes','sha256'}
                and type(ref['bytes']) is int and 0 <= ref['bytes'] <= 32*1024*1024
                and type(ref['sha256']) is str and re.fullmatch('[a-f0-9]{64}',ref['sha256']),
                'Invalid builder source reference.')
        path = Path(ref['path'])
        require(path.is_relative_to(release) and path not in expected and not path.is_symlink()
                and path.is_file() and path.stat().st_size == ref['bytes']
                and r.digest(path) == ref['sha256'], 'Builder source changed.')
        expected[path] = ref['sha256']
    # Do not accept a five-file list while unbound transitive modules execute.
    folders = [release/'dist/service',release/'node_modules/zod']
    for folder in folders:
        require(folder.is_dir() and not folder.is_symlink(), 'Builder closure folder is missing.')
        actual = {p for p in folder.rglob('*') if p.is_file()}
        require(actual and actual <= set(expected) and all(not p.is_symlink() for p in folder.rglob('*')),
                'Complete compiled and Zod builder closure is required.')
    result = spec['hostResult']
    require(type(result) is dict and result.get('closed') is True and result.get('ready') is True
            and result.get('passed') is True
            and result.get('workspaceRoot') == str(context.source_root)
            and result.get('releaseRoot') == str(release)
            and tuple(result.get(k) for k in ('startedEpochMs','endedEpochMs')) == context.startup_window,
            'Configuration inputs lack the original closed host result.')
    bridge, proxy_record = result['moduleBridge'], result['browserProxy']
    require(type(proxy_record) is dict and set(proxy_record) == {'url','port'}
            and type(proxy_record['port']) is int and 0 < proxy_record['port'] < 65536
            and proxy_record['url'] == 'http://127.0.0.1:' + str(proxy_record['port']),
            'Generated browser endpoint lacks its actual owned listener observation.')
    proxy = proxy_record['url']
    require(type(bridge) is dict and set(bridge) == {'url','token'}
            and bridge['url'] == result['origin'] + '/workspace'
            and re.fullmatch(r'http://127\.0\.0\.1:[0-9]{1,5}', result['origin'])
            and re.fullmatch('[a-f0-9]{64}', bridge['token'])
            and type(proxy) is str and re.fullmatch(r'http://127\.0\.0\.1:[0-9]{1,5}', proxy),
            'Generated local endpoints do not belong to the original host.')
    relative = selected/'openclaw-runtime/openclaw.json'
    old_path, new_path = [image/relative for image in context.images]
    before, after = [r.bounded_json(path,4*1024*1024) for path in (old_path,new_path)]
    key = (context.images[0]/selected/'preview.key').read_bytes()
    require(len(key) == 32, 'The original workspace key is unavailable.')
    selected_before, epoch = r.selected_workspace(context.images[0],closed=True)
    require(selected_before == context.images[0]/selected, 'Configuration source selection changed.')
    bindings = after.get('plugins',{}).get('entries',{}).get('edition3-workspace',{}).get('config',{}).get('sessionBindings')
    require(type(bindings) is list and len(bindings) <= 100000, 'Generated session binding list is unavailable.')
    # Existing exact producer-compatible verifier copies the complete family.
    with tempfile.TemporaryDirectory(prefix='ns-') as temporary:
        require(len(str(Path(temporary)/'workspace.sqlite-wal')) < 240, 'SQLite verification path is too long.')
        token = r._VERIFICATION_SCRATCH.set(Path(temporary))
        try:
            r.verified_session_bindings(context.images[0], selected, new_path, context.node, key)
        finally:
            r._VERIFICATION_SCRATCH.reset(token)
    entry = str(context.catalog_runtime_root/'openclaw.mjs')
    payload = {'before':before,'after':after,'bridge':bridge,'proxy':proxy,'epoch':epoch,
               'releaseRoot':str(release),'nativeRoot':str(context.source_root/selected/'openclaw-runtime'),
               'runtimeEntry':entry,'sessionBindings':bindings}
    script = Path(__file__).with_name('local-retained-configuration.mjs')
    env = {k:v for k,v in os.environ.items() if k.upper() in ('SYSTEMROOT','WINDIR','TEMP','TMP')}
    call = subprocess.run([str(context.node),str(script)],input=json.dumps(payload).encode(),
                          stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,
                          timeout=min(30,max(.001,context.deadline-time.monotonic())),
                          creationflags=getattr(subprocess,'DETACHED_PROCESS',0))
    require(call.returncode == 0 and len(call.stdout) <= 4*1024*1024,
            'Maintained complete configuration derivation failed.')
    derived = json.loads(call.stdout)
    canonical = lambda value: json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False)
    require(canonical(derived) == canonical(after), 'Complete generated native configuration or retained policy changed.')
    require(all(r.digest(path) == expected_hash for path,expected_hash in expected.items()),
            'Builder closure changed during derivation.')
    return {'path':str(context.source_root/relative), 'hashes':[r.digest(old_path),r.digest(new_path)],
            'byteSizes':[old_path.stat().st_size,new_path.stat().st_size]}
