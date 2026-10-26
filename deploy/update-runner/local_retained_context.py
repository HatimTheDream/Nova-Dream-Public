"""Explicit Windows observations for the unchanged retained-row comparator.

Snapshot bytes and recorded source identities have distinct roles. This module
does not capture, start, stop, restore or grant execution authority.
"""
import base64
import json
import math
from pathlib import Path
import re
import stat
import time

import local_windows_capture as capture


def require(value, message):
    if not value:
        raise RuntimeError(message)


class LocalRetainedContext:
    def __init__(self, before, after, *, node, startup_window, catalog_runtime_root, configuration_derivation, app_releases=None, deadline=None):
        self.node = node
        now = time.monotonic()
        require(deadline is None or type(deadline) in (int, float) and math.isfinite(deadline) and now < deadline,
                'The original local comparison deadline expired.')
        self.deadline = min(now + 300, deadline) if deadline is not None else now + 300
        self.captures = (before, after)
        self.images = tuple(Path(value['destinationRoot']) for value in self.captures)
        self.source_root = Path(before['sourceRoot'])
        self.catalog_runtime_root = Path(catalog_runtime_root) if catalog_runtime_root is not None else None
        self.derivation = configuration_derivation
        self.app_releases = app_releases
        self.external_observations = {}
        require(type(startup_window) in (tuple, list) and len(startup_window) == 2
                and all(type(v) in (int, float) and math.isfinite(v) for v in startup_window)
                and 0 <= startup_window[0] <= startup_window[1]
                and startup_window[1] - startup_window[0] <= 300000,
                'Local startup window must be a finite original epoch-millisecond interval.')
        self.startup_window = tuple(startup_window)
        require(before['sourceRoot'] == after['sourceRoot']
                and before['canonicalSourceRoot'] == after['canonicalSourceRoot']
                and self.source_root.is_absolute(), 'Local captures must bind the same original source root.')
        require(self.images[0] != self.images[1]
                and all(p.is_absolute() and p != self.source_root
                        and not p.is_relative_to(self.source_root)
                        and not self.source_root.is_relative_to(p) for p in self.images),
                'Local comparison images must be distinct from the original source.')
        require(before['endedEpochMs'] <= startup_window[0] <= startup_window[1] <= after['startedEpochMs'],
                'Local captures do not bracket the original startup window.')
        for value in self.captures:
            self.validate_capture(value)
        junction_identity = lambda value: {row['path']: {k: row[k] for k in
            ('rawTarget','canonicalTarget','targetRole','information','security')}
            for row in value['junctions']}
        require(junction_identity(before) == junction_identity(after),
                'Physical junction mapping, full native information or owner/group/DACL changed.')

    def validate_capture(self, value):
        require(type(value) is dict and value.get('format') == 1
                and value.get('kind') == 'local-windows-closed-tree'
                and value.get('complete') is True and value.get('allHandlesClosed') is True
                and value.get('saclNotRequested') is True
                and value.get('primitiveSha256') == capture.PRIMITIVE_SHA256,
                'A complete, closed Windows capture is required; SACL is not claimed.')
        require(type(value['entries']) is dict and 0 < len(value['entries']) <= 100000
                and type(value['junctions']) is list and len(value['junctions']) <= 1024,
                'Local capture roster exceeds its reviewed bounds.')
        native = capture._primitive()  # Pure validation only; no Win32 object.
        for name, row in value['entries'].items():
            capture._relative(name)
            require(row['kind'] in ('file', 'directory') and row.get('sameHandleStable') is True,
                    'Local source row lacks its same-handle capture.')
            info = native.checked_info(row['information'], row['kind'])
            security = row['security']
            require(type(security) is dict and set(security) == {'ownerGroupDaclBase64', 'saclNotRequested'}
                    and security['saclNotRequested'] is True, 'Local security scope changed.')
            native.checked_security(base64.b64decode(security['ownerGroupDaclBase64'], validate=True))
            observations = row['nativeObservations']
            require(observations['before'] == info == observations['after']
                    and observations.get('handleClosed') is True
                    and observations['ownerGroupDaclBeforeBase64'] == security['ownerGroupDaclBase64']
                    == observations['ownerGroupDaclAfterBase64'], 'Local native observations are incomplete or unstable.')
            identity = row['nodeIdentity']
            require(type(identity) is dict and set(identity) == capture.NODE_FIELDS
                    and all(type(v) is str and re.fullmatch('[0-9]{1,40}', v) for v in identity.values())
                    and identity == row['nodeIdentityBefore'], 'Local Node identity must be typed and stable.')
            capture._node_join(identity, info)
            require(stat.S_ISREG(int(identity['mode'])) == (row['kind'] == 'file'),
                    'Local Node file type does not match native authority.')
        for row in value['junctions']:
            require(row['path'] in value['entries'] and row['targetRole'] in ('root', 'vendor')
                    and type(row['rawTarget']) is str and type(row['canonicalTarget']) is str,
                    'Local junction capture is incomplete.')
            capture._info_checked(row['information'], 'junction')
            require(row.get('sameHandleStable') is True, 'Local junction metadata was unstable.')
            security, observations = row['security'], row['nativeObservations']
            require(set(security) == {'ownerGroupDaclBase64','saclNotRequested'}
                    and security['saclNotRequested'] is True, 'Local junction security scope changed.')
            native.checked_security(base64.b64decode(security['ownerGroupDaclBase64'],validate=True))
            require(observations.get('handleClosed') is True
                    and observations['before'] == row['information'] == observations['after']
                    and observations['ownerGroupDaclBeforeBase64'] == security['ownerGroupDaclBase64']
                    == observations['ownerGroupDaclAfterBase64'], 'Physical junction capture is incomplete or unstable.')
        capture.verify_capture_content(value, self.deadline)

    def locate(self, path):
        path = Path(path)
        for value, image in zip(self.captures, self.images):
            if path.is_relative_to(image):
                name = path.relative_to(image).as_posix()
                return value, image, name
        value, image = self.captures[1], self.images[1]
        if path.is_relative_to(self.source_root):
            return value, image, path.relative_to(self.source_root).as_posix()
        # External vendor aliases were materialized into the immutable image.
        found = [(name, row) for name, row in value['entries'].items()
                 if Path(row['physicalPath']) == path]
        if found:
            require(all(row['nodeIdentity'] == found[0][1]['nodeIdentity'] for _, row in found),
                    'Local physical alias identity is ambiguous.')
            return value, image, found[0][0]
        return None

    def image_path(self, path):
        path = Path(path)
        found = self.locate(path)
        return found[1] / capture._relative(found[2]) if found is not None else path

    def entry(self, path):
        found = self.locate(path)
        require(found is not None and found[2] in found[0]['entries'],
                'Local source identity is absent from the complete capture.')
        return found[0]['entries'][found[2]]

    def node_identity(self, path):
        if self.locate(path) is not None:
            return self.entry(path)['nodeIdentity']
        path = Path(path)
        roots = ([Path(row[0]) for row in self.app_releases] if self.app_releases else [])
        if self.catalog_runtime_root is not None:
            roots.append(self.catalog_runtime_root)
        require(self.node is not None and any(path.is_relative_to(root) for root in roots),
                'External Node identity requires a bound application or native source root.')
        result = capture.node_identities(self.node, [str(path)], self.deadline)[str(path)]
        prior = self.external_observations.setdefault(str(path), result)
        require(result == prior, 'External Node source identity changed during comparison.')
        return result

    def source_identity_tuple(self, path):
        value = self.node_identity(path)
        return tuple(int(value[k]) for k in ('dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'))

    def source_security(self, path):
        return self.entry(path)['security']['ownerGroupDaclBase64']

    def processes_retired(self, pids):
        require(self.node is not None and pids, 'Removed Windows process registrations need actual ESRCH observations.')
        return capture.assert_processes_retired(self.node, pids, self.deadline)

    def configuration(self, selected):
        relative = selected / 'openclaw-runtime/openclaw.json'
        paths = [root / relative for root in self.images]
        if self.derivation == {'kind': 'no-managed-native-config'}:
            require(not any(path.exists() for path in paths), 'No-config declaration cannot authorize a managed configuration.')
            return None
        require(type(self.derivation) is dict and self.derivation.get('kind') == 'maintained-local-configuration',
                'Local managed configuration requires maintained builder derivation.')
        # The executable derivation is supplied by the sibling maintained module,
        # not by an expected JSON document or unchecked AFTER configuration.
        from local_retained_configuration import derive_configuration
        return derive_configuration(self, selected)

    def finish(self):
        for value in self.captures:
            capture.verify_capture_content(value, self.deadline)
        if self.external_observations:
            require(capture.node_identities(self.node, list(self.external_observations), self.deadline)
                    == self.external_observations, 'External source identity changed during comparison.')
