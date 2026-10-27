"""Explicit Windows observations for the unchanged retained-row comparator.

Snapshot bytes and recorded source identities have distinct roles. This module
does not capture, start, stop, restore or grant execution authority.
"""
import base64
import json
import hashlib
import uuid
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
        self.deadline = min(now + 900, deadline) if deadline is not None else now + 300
        self.captures = (before, after)
        self.images = tuple(Path(value['destinationRoot']) for value in self.captures)
        self.source_root = Path(before['sourceRoot'])
        self.catalog_runtime_root = Path(catalog_runtime_root) if catalog_runtime_root is not None else None
        self.derivation = configuration_derivation
        self.app_releases = app_releases
        self.external_observations = {}
        require(before.get('format')==after.get('format') and before.get('format') in (1,2,3),
                'Local endpoint capture representations must match.')
        require(type(startup_window) in (tuple, list) and len(startup_window) == 2
                and all(type(v) in (int, float) and math.isfinite(v) for v in startup_window)
                and 0 <= startup_window[0] <= startup_window[1]
                and startup_window[1] - startup_window[0] <= 300000,
                'Local startup window must be a finite original epoch-millisecond interval.')
        self.startup_window = tuple(startup_window)
        require(before['sourceRoot'] == after['sourceRoot']
                and before['canonicalSourceRoot'] == after['canonicalSourceRoot']
                and self.source_root.is_absolute(), 'Local captures must bind the same original source root.')
        if before['format'] in (2,3):
            require(before['vendorRoot']==after['vendorRoot'] and before['canonicalVendorRoot']==after['canonicalVendorRoot'],
                    'Local captures must bind the same authenticated vendor root.')
        require(self.images[0] != self.images[1]
                and all(p.is_absolute() and p != self.source_root
                        and not p.is_relative_to(self.source_root)
                        and not self.source_root.is_relative_to(p) for p in self.images),
                'Local comparison images must be distinct from the original source.')
        require(before['endedEpochMs'] <= startup_window[0] <= startup_window[1] <= after['startedEpochMs'],
                'Local captures do not bracket the original startup window.')
        for value in self.captures:
            self.validate_capture(value)
        # The maintained native comparator qualifies the complete endpoint
        # namespace and referenced state. Global transient cache-junction equality
        # was an extra local gate, not part of that startup contract. Pre-start
        # clone equality and pristine return remain separate exact comparisons.

    def validate_capture(self, value):
        if value.get('format') in (2,3):
            capture.verify_capture_content(value,self.deadline)
            return
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
        for value in self.captures:
            if value.get('format') not in (2,3):continue
            for role in ('root','vendor'):
                image=capture.graph_image_root(value,role)
                if path.is_relative_to(image):
                    return self._graph_location(value,role,path.relative_to(image).as_posix())
        value=self.captures[1]
        if value.get('format') in (2,3):
            for role in ('root','vendor'):
                source=capture.graph_source_root(value,role)
                if path.is_relative_to(source):
                    return self._graph_location(value,role,path.relative_to(source).as_posix())
            return None
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

    def _graph_location(self,value,role,name):
        try:
            physical_role,key,_=capture.graph_resolve(value,role,name)
        except capture.CaptureRefused as error:
            if str(error) in ('logical-member-not-captured','logical-member-not-in-observed-directory'):
                return None
            raise
        return value,capture.graph_image_root(value,physical_role),key,physical_role

    def image_path(self, path):
        path = Path(path)
        found = self.locate(path)
        if found is not None:return found[1]/capture._relative(found[2])
        # Missing members under an admitted source still map into its immutable
        # view; optional-file checks must never fall back to the original tree.
        for value in reversed(self.captures):
            if value.get('format') not in (2,3):continue
            for role in ('root','vendor'):
                source=capture.graph_source_root(value,role)
                if path.is_relative_to(source):return capture.graph_image_root(value,role)/path.relative_to(source)
        return path

    def entry(self, path):
        found = self.locate(path)
        if found is not None and len(found)==4:
            return found[0]['physicalEntries'][found[3]][found[2]]
        require(found is not None and found[2] in found[0]['entries'],
                'Local source identity is absent from the complete capture.')
        return found[0]['entries'][found[2]]

    def glob(self,root,pattern):
        root=Path(root);found=self.locate(root)
        if found is None or len(found)!=4:
            image=self.image_path(root)
            yield from (root/p.relative_to(image) for p in image.rglob(pattern))
            return
        value,_,key,role=found;base=capture._relative(key)
        for name,_,_,row in capture.graph_logical_rows(value,role,key,deadline=self.deadline):
            if name==key:continue
            relative=capture._relative(name).relative_to(base)
            if relative.match(pattern):yield root/relative

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

    def native_capture_owner_paths(self, root, selected, engine_version):
        """Recognize only the captured official Windows empty staging lease.

        These are process ownership tokens, not application databases. The full
        capture, content, security, alias and return checks still retain them.
        No SQLite connection or original-source read occurs here.
        """
        if engine_version != '2026.9.8' or any(v.get('format') not in (2,3) for v in self.captures):
            return set()
        root, selected = Path(root), Path(selected)
        require(root in self.images and not selected.is_absolute() and '..' not in selected.parts,
                'Windows capture lease image/selection is unbound.')
        cached = getattr(self, '_capture_lease_paths', {})
        key = selected.as_posix()
        if key in cached:
            return set(cached[key][self.images.index(root)])
        prefix = selected / 'openclaw-runtime/state/tmp/plugin-captures'
        generations = []
        for value in self.captures:
            rows = value['physicalEntries']['root']
            parent = rows.get(prefix.as_posix())
            found = {}
            if parent is not None:
                require(parent['kind'] == 'directory' and len(parent['members']) <= 1000,
                        'Windows capture lease parent is not an ordinary bounded directory.')
                for name in parent['members']:
                    try:
                        canonical = str(uuid.UUID(name)) == name
                    except ValueError:
                        canonical = False
                    if not canonical:
                        continue  # Remains in the exact static SQLite map.
                    owner = (prefix / name / 'owner.sqlite').as_posix()
                    if owner in rows:
                        found[name] = owner
            generations.append(found)
        if not any(generations):
            return set()
        # Preserve complete replacement; retired native generations may also
        # remain beside exactly one new active lease, under the checks below.
        replaced = all(len(v) == 1 for v in generations) and set(generations[0]).isdisjoint(generations[1])
        retained = (len(generations[0]) == 1 and len(generations[1]) == 2
                    and set(generations[0]) < set(generations[1]))
        require(replaced or retained, 'Windows capture lease rotation is outside the qualified shape.')
        active_generations = generations
        if retained:
            new_name = next(iter(set(generations[1]) - set(generations[0])))
            active_generations = [generations[0], {new_name: generations[1][new_name]}]
        host = self.derivation.get('hostResult', {}) if isinstance(self.derivation, dict) else {}
        identity = host.get('nativeIdentity', {})
        require(host.get('kind') == 'local-native-retained-host-result'
                and all(host.get(k) is True for k in ('ready', 'passed', 'closed'))
                and host.get('originalOwnerRetained') is False
                and Path(host.get('workspaceRoot', '')) == self.source_root
                and all(type(host.get(k)) is int for k in ('startedEpochMs', 'endedEpochMs'))
                and tuple(host.get(k) for k in ('startedEpochMs', 'endedEpochMs')) == self.startup_window
                and type(identity.get('pid')) is int and identity['pid'] > 0
                and identity['pid'] in host.get('observedNativePids', [])
                and identity.get('version') == engine_version
                and type(identity.get('startedAt')) is int
                and self.startup_window[0] <= identity['startedAt'] <= self.startup_window[1]
                and type(host.get('observer', {}).get('pid')) is int and host['observer']['pid'] > 0,
                'Windows capture lease needs the original closed native host.')
        for name, value in (('operationId', host.get('operationId')),
                            ('epoch', identity.get('epoch')), ('generation', identity.get('generation'))):
            require(type(value) is str and str(uuid.UUID(value)) == value,
                    'Windows capture lease host identity is malformed: ' + name)
        require(self.catalog_runtime_root is not None
                and all(Path(v['vendorRoot']) == self.catalog_runtime_root for v in self.captures),
                'Windows capture lease producer root is unbound.')
        producers = {
            'dist/sqlite-staging-token-CcxeaYVw.mjs': (4495, '640abcf7ec6e84134f752e94c9c49b8d4d1eea55d0416b4f0102e722ff89702f'),
            'dist/plugin-source-capture-directory-CsjPVlzr.mjs': (20448, 'bb59fd7c7b721a67fce0201e8f6bd250a66c84bc055d06d0ce645ecf18b25f79'),
            'dist/plugin-source-capture-path-L0n-8p-6.mjs': (1011, '2b5c87c781d8299882aa5ca90d66f8f20eda194a84cd3b73224f2fdd8163d7cf'),
        }

        def ordinary(value, role, name, kind):
            row = value['physicalEntries'][role].get(name)
            require(row is not None and row['kind'] == kind and row.get('sameHandleStable') is True,
                    'Windows capture lease requires an ordinary captured member.')
            info, obs = row['information'], row['nativeObservations']
            require(info['reparseTag'] == 0 and not info['attributes'] & 0x400
                    and info['links'] == 1 and info['deletePending'] is False
                    and info['directory'] == (kind == 'directory')
                    and info['fileIndex64'] > 0 and int(info['fileId128Hex'], 16) > 0
                    and obs.get('handleClosed') is True and obs['before'] == info == obs['after']
                    and obs['ownerGroupDaclBeforeBase64'] == row['security']['ownerGroupDaclBase64']
                    == obs['ownerGroupDaclAfterBase64'] and row['security']['saclNotRequested'] is True,
                    'Windows capture lease native identity/security/handle closure changed.')
            require(row['streams'] == [] if kind == 'directory' else
                    len(row['streams']) == 1 and row['streams'][0]['name'] == '::$DATA'
                    and row['streams'][0]['bytes'] == info['size'] == row['bytes'],
                    'Windows capture lease has an unsupported stream.')
            return row

        def native_id(row):
            i = row['information']
            return tuple(i[k] for k in ('volumeSerial32', 'volumeSerial64', 'fileIndex64', 'fileId128Hex'))

        endpoint_paths, ancestry, families = [], [], []
        native = selected / 'openclaw-runtime'
        ancestor_names = [selected, native, native / 'state', native / 'state/tmp', prefix]
        for index, (value, generation) in enumerate(zip(self.captures, active_generations)):
            require(value.get('complete') is True and value.get('allHandlesClosed') is True,
                    'Windows capture lease needs complete closed captures.')
            for name, expected in producers.items():
                row = ordinary(value, 'vendor', name, 'file')
                require((row['bytes'], row['sha256']) == expected,
                        'Windows capture lease captured producer is not the qualified source.')
            parents = [ordinary(value, 'root', name.as_posix(), 'directory') for name in ancestor_names]
            require(all(row['security'] == parents[0]['security'] for row in parents),
                    'Windows capture lease ancestor protection changed.')
            ancestry.append(parents)
            owner_name = next(iter(generation.values()))
            directory_name = str(Path(owner_name).parent.as_posix())
            directory = ordinary(value, 'root', directory_name, 'directory')
            owner = ordinary(value, 'root', owner_name, 'file')
            journal_name = owner_name + '-journal'
            journal = ordinary(value, 'root', journal_name, 'file')
            require(directory['security'] == parents[0]['security']
                    and owner['security'] == journal['security']
                    and set(n for n in directory['members'] if n.startswith('owner.sqlite'))
                    == {'owner.sqlite', 'owner.sqlite-journal'},
                    'Windows capture lease protection or exact SQLite family changed.')
            require(owner['bytes'] == 0 and owner['information']['allocationBytes'] == 0
                    and owner['sha256'] == hashlib.sha256(b'').hexdigest()
                    and journal['bytes'] == 512 and journal['information']['allocationBytes'] == 512,
                    'Windows capture lease is not the qualified empty marker.')
            journal_path = capture.graph_image_root(value, 'root') / journal_name
            with journal_path.open('rb') as stream:
                payload = stream.read(513)
            expected = bytearray(512)
            expected[20:24] = (512).to_bytes(4, 'big')
            expected[24:28] = (4096).to_bytes(4, 'big')
            require(len(payload) == 512 and hashlib.sha256(payload).hexdigest() == journal['sha256'],
                    'Windows capture journal image disagrees with the closed capture.')
            expected[12:16] = payload[12:16]  # SQLite header checksum nonce only.
            require(payload == expected, 'Windows capture lease journal contains unqualified data.')
            for row in (directory, owner, journal):
                created = row['information']['creation100ns']
                lower, upper = (116444736000000000 + value * 10000 for value in self.startup_window)
                require(type(created) is int and (116444736000000000 <= created <= lower if index == 0 else
                        lower <= created <= upper),
                        'Windows capture lease generation is outside its owner window.')
            families.append((directory, owner, journal))
            endpoint_paths.append({Path(owner_name)})
        require(all(native_id(a) == native_id(b) and a['security'] == b['security']
                    for a, b in zip(*ancestry)), 'Windows capture lease ancestry identity changed.')
        require(all(native_id(a) != native_id(b) and a['security'] == b['security']
                    for a, b in zip(*families)), 'Windows capture lease generation identity/protection did not rotate.')
        if retained:
            before, after = self.captures
            old_name = next(iter(generations[0]))
            old_owner_name = generations[0][old_name]
            old_directory_name = (prefix / old_name).as_posix()
            retired_directory = ordinary(after, 'root', old_directory_name, 'directory')
            retired_owner = ordinary(after, 'root', old_owner_name, 'file')
            ordinary(before, 'root', (prefix / old_name / 'captures').as_posix(), 'directory')
            for component in ('captures', 'native'):
                created_child = ordinary(after, 'root', (prefix / new_name / component).as_posix(), 'directory')
                require(116444736000000000 + self.startup_window[0] * 10000
                        <= created_child['information']['creation100ns']
                        <= 116444736000000000 + self.startup_window[1] * 10000,
                        'Windows new capture child is outside its owner window.')
            old_directory, old_owner, _ = families[0]
            active_directory = families[1][0]
            require(set(ancestry[0][-1]['members']) == set(generations[0])
                    and set(ancestry[1][-1]['members']) == set(generations[1])
                    and set(old_directory['members']) == {'captures', 'native', 'owner.sqlite', 'owner.sqlite-journal'}
                    and set(retired_directory['members']) == {'native', 'owner.sqlite'}
                    and set(active_directory['members']) == {'captures', 'native', 'owner.sqlite', 'owner.sqlite-journal'},
                    'Windows retired capture lease has extra or missing objects.')
            lower, upper = (116444736000000000 + value * 10000 for value in self.startup_window)
            def retained_identity(old, current, content_changed=False):
                a, b = old['information'], current['information']
                changed = {'access100ns', 'write100ns', 'change100ns'}
                if content_changed:
                    changed |= {'size', 'allocationBytes'}
                require(set(a) == set(b) and all(a[name] == b[name] for name in a if name not in changed)
                        and old['security'] == current['security'],
                        'Windows retired capture lease identity or protection changed.')
                require(all(a[name] == b[name] or a[name] <= b[name] and lower <= b[name] <= upper
                            for name in ('access100ns', 'write100ns', 'change100ns')),
                        'Windows retired capture lease mutation left its original host window.')
            retained_identity(old_directory, retired_directory)
            retained_identity(old_owner, retired_owner, content_changed=True)
            native_name = (prefix / old_name / 'native').as_posix()
            old_native = ordinary(before, 'root', native_name, 'directory')
            retired_native = ordinary(after, 'root', native_name, 'directory')
            retained_identity(old_native, retired_native)
            require(old_native['members'] == retired_native['members'],
                    'Windows retired capture native roster changed.')
            require(retired_owner['bytes'] == retired_owner['information']['size']
                    == retired_owner['information']['allocationBytes'] == 4096,
                    'Windows retired capture token is not one qualified empty page.')
            with (capture.graph_image_root(after, 'root') / old_owner_name).open('rb') as stream:
                payload = stream.read(4097)
            # Exact empty retirement page from qualified SQLite 3.53.3 COMMIT:
            # no schema, cells, freelist or application data.
            expected = bytearray(4096)
            expected[:16] = b'SQLite format 3\x00'
            expected[16:18] = (4096).to_bytes(2, 'big')
            expected[18:24] = bytes((1, 1, 0, 64, 32, 32))
            for offset, value in ((24, 1), (28, 1), (60, 1), (92, 1), (96, 3053003)):
                expected[offset:offset+4] = value.to_bytes(4, 'big')
            expected[100] = 13
            expected[105:107] = (4096).to_bytes(2, 'big')
            require(len(payload) == 4096 and hashlib.sha256(payload).hexdigest() == retired_owner['sha256']
                    and payload == expected,
                    'Windows retired capture token contains unqualified schema or data.')
            # Only these validated tokens leave the application SQLite map.
            # Their native subtree and all other retained-state checks remain.
            endpoint_paths[1].add(Path(old_owner_name))
        cached[key] = endpoint_paths
        self._capture_lease_paths = cached
        return set(endpoint_paths[self.images.index(root)])

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
