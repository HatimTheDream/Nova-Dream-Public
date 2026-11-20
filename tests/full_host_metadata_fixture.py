"""Read the exact standalone metadata program emitted by the normal JS host adapter."""
import ast
import base64
import hashlib
import json
import subprocess


def frozen_host_metadata(app):
    script = r"""import {buildFullHostProgram} from './scripts/release-delivery-full-host.mjs';
const wire = buildFullHostProgram('metadata-stage.py', {});
const encoded = wire.match(/v=json\.loads\(base64\.b64decode\('([^']+)'/)[1];
process.stdout.write(Buffer.from(encoded, 'base64'));"""
    result = subprocess.run(['node', '--input-type=module', '-e', script], cwd=app,
                            capture_output=True, timeout=20, check=True)
    envelope = json.loads(result.stdout)
    raw = base64.b64decode(envelope['source'], validate=True)
    if hashlib.sha256(raw).hexdigest() != envelope['sha256']:
        raise AssertionError('Generated host source SHA changed')
    tree = ast.parse(raw)
    families = next(ast.literal_eval(node.value) for node in tree.body
                    if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)
                    and node.targets[0].id == 'FROZEN_SAME_SCHEMA60_FAMILIES')
    current = {name: hashlib.sha256((app/'deploy'/'update-runner'/name).read_bytes()).hexdigest()
               for name in families[0]}
    if current not in families:
        raise AssertionError('Native helper sources have no registered same-schema family')
    return tree, current
