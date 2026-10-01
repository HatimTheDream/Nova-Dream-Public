"""Read an existing hosted workspace key for closed recovery verification.

The driver must first attest the prior candidate and protect the supplied Node,
credential, release and recovery paths. This module neither creates keys nor
opens an application Store. The one session-bindings verifier authenticates the
returned key against the selected closed database's existing key-check record.
"""
import json
import os
import pathlib
import re
import stat
import subprocess

from recovery import bounded_json, digest, require, selected_workspace


UNWRAP = r'''
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const input=JSON.parse(readFileSync(0,'utf8'));
const {ServerKeyProtector}=await import(pathToFileURL(input.module));
let key;
try {
 key=await new ServerKeyProtector(input.credential,input.workspace).unwrap(Buffer.from(input.wrapped,'base64'));
 if(!Buffer.isBuffer(key)||key.length!==32)throw Error('Invalid protected workspace key');
 await new Promise((resolve,reject)=>process.stdout.write(key,error=>error?reject(error):resolve()));
} finally {key?.fill(0);}
'''


def read_workspace_key(workspace, credential, node, prior_release):
    """Return a bytearray for private stdin use; caller must zero it in finally.

    Use only the existing server-secret wrapper. An absent/unreadable wrapper
    never falls back to another key or silently creates an empty workspace.
    """
    workspace, credential, node, prior_release = map(pathlib.Path, (workspace, credential, node, prior_release))
    require(all(path.is_absolute() and path.resolve(strict=True) == path for path in (workspace, credential, node, prior_release)),
            'Workspace key verification paths must be direct and absolute.')
    require(not credential.is_relative_to(workspace) and not credential.is_relative_to(prior_release),
            'Keep the wrapping credential outside the workspace and release.')
    info = credential.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_size == 32 and info.st_nlink == 1 and not info.st_mode & 0o077
            and (not hasattr(os, 'geteuid') or info.st_uid == 0),
            'The wrapping credential must remain a private root-owned 32-byte regular file.')
    selected, _ = selected_workspace(workspace, closed=True)
    wrapper_path = selected / 'workspace-key.json'
    wrapper = bounded_json(wrapper_path, 16384)
    require(wrapper.get('format') == 1 and type(wrapper.get('format')) is int
            and wrapper.get('application') == 'private.novadream.edition3.preview'
            and wrapper.get('provider') == 'server-secret' and isinstance(wrapper.get('wrapped'), str)
            and re.fullmatch(r'[A-Za-z0-9+/]+={0,2}', wrapper['wrapped']),
            'The selected workspace lacks its existing hosted key wrapper.')
    relative = 'dist/service/apps/service/server-key.js'
    module = prior_release / relative
    require(module.resolve(strict=True) == module and module.is_file(), 'The reviewed server key implementation was redirected.')
    manifest_path = prior_release / 'dist/candidate.json'
    manifest = bounded_json(manifest_path, 4 * 1024 * 1024)
    artifacts = manifest.get('artifacts')
    require(isinstance(artifacts, list) and len(artifacts) <= 5000, 'The prior candidate artifact manifest is invalid.')
    matches = [item for item in artifacts if isinstance(item, dict) and item.get('path') == relative]
    require(len(matches) == 1 and digest(module) == matches[0].get('sha256'),
            'The server key implementation differs from the verified prior candidate.')
    retained = {path: digest(path) for path in (credential, wrapper_path, manifest_path, module)}
    request = {'module': str(module), 'credential': str(credential), 'workspace': str(selected), 'wrapped': wrapper['wrapped']}
    environment = {name: os.environ[name] for name in ('SystemRoot', 'SYSTEMROOT') if name in os.environ}
    environment['NODE_DISABLE_COMPILE_CACHE'] = '1'
    result = subprocess.run([str(node), '--input-type=module', '-e', UNWRAP], input=json.dumps(request).encode(),
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=environment, timeout=18, check=False)
    require(all(digest(path) == expected for path, expected in retained.items()),
            'Protected workspace key inputs changed during verification.')
    require(result.returncode == 0 and len(result.stdout) == 32, 'The existing hosted workspace key could not be unlocked.')
    return bytearray(result.stdout)
