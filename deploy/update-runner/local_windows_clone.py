"""Physical working generations for a closed, captured local Windows workspace.

No import-time native effects, process control, renames, deletion, privilege
adjustment, or SACL access. The lifecycle caller owns stopped-process authority
and every no-replace rename. Expanded comparison images are never activated.
"""
import base64
import codecs
import copy
import ctypes
import hashlib
import json
import os
from pathlib import Path
import stat
import struct
import time

import local_windows_capture as capture

IDENTITY_FIELDS = frozenset(('fileIndex64', 'fileId128Hex'))
TIMES = ('creation100ns', 'access100ns', 'write100ns', 'change100ns')
# Reparse/directory are structural, and accepted only for their declared kind.
ORDINARY_ATTRIBUTES = 0x1 | 0x2 | 0x4 | 0x20 | 0x80 | 0x100 | 0x2000
MOUNT_POINT = 0xA0000003


class CloneRefused(RuntimeError):
    def __init__(self, reason, observations=None):
        super().__init__(reason)
        self.observations = observations or {}
        self.unresolved_handle = self.observations.get('unresolvedHandle') is True


def require(value, reason, observations=None):
    if not value:
        raise CloneRefused(reason, observations)


def _check(deadline):
    capture._check(deadline)


def _error(error):
    return {'type': type(error).__name__, 'message': str(error)[:2048],
            'observations': getattr(error, 'observations', None)}


def _supported(row, kind):
    info = capture._info_checked(row['information'], kind)
    allowed = ORDINARY_ATTRIBUTES | (0x10 if kind != 'file' else 0) | (0x400 if kind == 'junction' else 0)
    require(info['attributes'] & ~allowed == 0 and all(info[k] > 0 for k in TIMES),
            'unsupported-copy-attributes-or-zero-timestamps', {'kind': kind, 'information': info})
    require(row.get('sameHandleStable') is True and type(row['security']) is dict
            and set(row['security']) == {'ownerGroupDaclBase64', 'saclNotRequested'}
            and row['security']['saclNotRequested'] is True,
            'stable-owner-group-dacl-required')
    raw = base64.b64decode(row['security']['ownerGroupDaclBase64'], validate=True)
    capture._primitive().checked_security(raw)
    streams = row['streams']
    require(type(streams) is list and
            ((kind == 'file' and len(streams) == 1 and streams[0]['name'] == '::$DATA'
              and streams[0]['bytes'] == row['bytes'] == info['size']
              and streams[0]['allocationBytes'] == info['allocationBytes']) or
             (kind != 'file' and all(s['name'] == '::$DATA' and s['bytes'] == s['allocationBytes'] == 0
                                     for s in streams))), 'unsupported-copy-streams')
    observed = row['nativeObservations']
    require(observed['before'] == info == observed['after']
            and observed['ownerGroupDaclBeforeBase64'] == row['security']['ownerGroupDaclBase64']
            == observed['ownerGroupDaclAfterBase64'] and observed.get('handleClosed') is True,
            'incomplete-source-handle-observation')
    return info


def _same_metadata(expected, current, independent):
    ignored = IDENTITY_FIELDS if independent else frozenset()
    require(set(expected) == set(current) and all(current[k] == expected[k] for k in expected if k not in ignored),
            'copy-native-metadata-mismatch', {'expected': expected, 'observed': current,
                                             'independentIdentityOnly': independent})
    if independent:
        require(all(current[k] != expected[k] for k in IDENTITY_FIELDS), 'copy-must-have-independent-file-identity')


def _junction_payload(raw):
    """Create only the reviewed absolute drive-letter mount-point target form."""
    require(type(raw) is str and raw.startswith('\\\\?\\') and '\x00' not in raw,
            'exact-extended-drive-junction-target-required')
    plain = raw[4:]
    capture._primitive().canonical_path(plain)
    substitute = codecs.utf_16_le_encode('\\??\\' + plain, 'strict')[0]
    display = codecs.utf_16_le_encode(plain, 'strict')[0]
    body = struct.pack('<HHHH', 0, len(substitute), len(substitute) + 2, len(display))
    body += substitute + b'\0\0' + display + b'\0\0'
    require(len(body) + 8 <= 16384, 'junction-payload-budget-exceeded')
    return struct.pack('<IHH', MOUNT_POINT, len(body), 0) + body


def physical_plan(before_capture, destination, *, limits):
    """Select physical source members; expanded aliases are never working files."""
    require(type(before_capture) is dict and before_capture.get('format') == 1
            and before_capture.get('kind') == 'local-windows-closed-tree'
            and before_capture.get('complete') is True and before_capture.get('allHandlesClosed') is True
            and before_capture.get('saclNotRequested') is True
            and before_capture.get('primitiveSha256') == capture.PRIMITIVE_SHA256,
            'complete-qualified-source-capture-required')
    source, image = (Path(before_capture[k]) for k in ('sourceRoot', 'destinationRoot'))
    target = Path(destination)
    require(source.is_absolute() and image.is_absolute() and target.is_absolute()
            and target.parent == source.parent and target != source
            and not target.is_relative_to(image) and not image.is_relative_to(target),
            'fresh-sibling-working-generation-required')
    require(type(limits) is dict and set(limits) == {'maxEntries', 'maxBytes', 'maxFileBytes', 'maxAliases', 'maxReportBytes'}
            and all(type(v) is int and v > 0 for v in limits.values())
            and limits['maxEntries'] <= 100000 and limits['maxBytes'] <= 64 * 1024**3
            and limits['maxFileBytes'] <= 2 * 1024**3 and limits['maxAliases'] <= 1024
            and limits['maxReportBytes'] <= 256 * 1024**2,
            'bounded-clone-limits-required')
    entries, aliases = before_capture['entries'], before_capture['junctions']
    require(type(entries) is dict and '.' in entries and len(entries) <= limits['maxEntries']
            and type(aliases) is list and len(aliases) <= limits['maxAliases'], 'clone-roster-budget-exceeded')
    # Every logical path below a junction is an expanded image alias. An internal
    # target also has its own ordinary physical path elsewhere in this roster.
    alias_keys = [capture._relative(row['path']) for row in aliases]
    require(len(set(alias_keys)) == len(alias_keys), 'duplicate-junction-path')
    rows = []
    for key, row in entries.items():
        relative = capture._relative(key)
        if any(relative == alias or relative.is_relative_to(alias) for alias in alias_keys):
            continue
        require(Path(row['physicalPath']) == source / relative, 'physical-source-path-mismatch')
        _supported(row, row['kind'])
        rows.append({'key': key, 'kind': row['kind'], 'imagePath': str(image / relative), 'expected': copy.deepcopy(row)})
    ordinary = {row['key']: row for row in rows}
    require('.' in ordinary and ordinary['.']['kind'] == 'directory', 'ordinary-physical-root-required')
    for row in rows:
        relative = capture._relative(row['key'])
        if row['key'] != '.':
            parent = relative.parent.as_posix()
            require(parent in ordinary and ordinary[parent]['kind'] == 'directory', 'physical-parent-missing')
    junctions = []
    for row in aliases:
        relative = capture._relative(row['path'])
        # Nested aliases reached through another alias do not physically belong
        # to this root and must not create duplicate working-generation entries.
        if any(relative != alias and relative.is_relative_to(alias) for alias in alias_keys):
            continue
        require(relative.as_posix() not in ordinary and relative.parent.as_posix() in ordinary
                and Path(row['physicalPath']) == source / relative and row['targetRole'] in ('root', 'vendor'),
                'physical-junction-parent-or-role-mismatch')
        _supported(row, 'junction')
        require(row['canonicalTarget'] == row['rawTarget'][4:], 'junction-target-representation-mismatch')
        if row['targetRole'] == 'root':
            require(Path(row['canonicalTarget']).is_relative_to(source), 'internal-junction-outside-original')
        payload = _junction_payload(row['rawTarget'])
        junctions.append({'key': row['path'], 'kind': 'junction', 'expected': copy.deepcopy(row),
                          'payloadBase64': base64.b64encode(payload).decode('ascii')})
    files = [r for r in rows if r['kind'] == 'file']
    require(all(r['expected']['bytes'] <= limits['maxFileBytes'] for r in files)
            and sum(r['expected']['bytes'] for r in files) <= limits['maxBytes'], 'physical-copy-byte-budget-exceeded')
    require(all(len(str(target / capture._relative(r['key']))) <= 4096 for r in [*rows, *junctions]),
            'bounded-target-path-required')
    # Actual raw evidence is charged incrementally. A fixed per-row guess would
    # reject large supported workspaces before knowing their descriptor sizes.
    require(limits['maxReportBytes'] >= 4 * 1024**2, 'clone-evidence-reserve-unavailable')
    return {'format': 1, 'kind': 'local-windows-physical-copy-plan', 'sourceRoot': str(source),
            'imageRoot': str(image), 'destinationRoot': str(target), 'rows': rows, 'junctions': junctions,
            'limits': dict(limits), 'bytes': sum(r['expected']['bytes'] for r in files)}


class Win32Target:
    """Explicit write handle for a caller-created target; never a source handle."""
    def __init__(self, path, kind, deadline, *, root_finalization=False):
        self.path, self.kind, self.deadline = Path(path), kind, deadline
        self.port = capture._primitive().Win32()
        self.handle, self.closed = None, False
        self.evidence = {'path': str(path), 'kind': kind, 'rootFinalizationOnly': root_finalization}
        self.root_finalization = root_finalization
        p = self.port
        H, D, B, V = ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int32, ctypes.c_void_p
        signatures = [(p.k.SetFileInformationByHandle, [H, ctypes.c_int32, V, D], B),
                      (p.k.DeviceIoControl, [H, D, V, D, V, D, ctypes.POINTER(D), V], B),
                      (p.s.GetSecurityDescriptorOwner, [V, ctypes.POINTER(V), ctypes.POINTER(B)], B),
                      (p.s.GetSecurityDescriptorGroup, [V, ctypes.POINTER(V), ctypes.POINTER(B)], B),
                      (p.s.GetSecurityDescriptorDacl, [V, ctypes.POINTER(B), ctypes.POINTER(V), ctypes.POINTER(B)], B),
                      (p.s.GetSecurityDescriptorControl, [V, ctypes.POINTER(ctypes.c_uint16), ctypes.POINTER(D)], B),
                      (p.s.SetSecurityInfo, [H, ctypes.c_int32, D, V, V, V, V], D)]
        for fn, args, result in signatures:
            fn.argtypes, fn.restype = args, result
        try:
            _check(deadline)
            capture._primitive().canonical_path(str(path))
            access = 0x20180 if root_finalization else 0xe0182  # O/G/DACL writes only on new objects.
            share = 3 if kind == 'directory' else 1
            self.handle = p.call('CreateFileW:owned-target', p.k.CreateFileW,
                (str(path), access, share, None, 3, 0x02200000, None),
                {'path': str(path), 'access': access, 'share': share, 'disposition': 3, 'flags': 0x02200000})
            p.require(self.handle not in (None, ctypes.c_void_p(-1).value), 'CreateFileW:owned-target')
            self.opened = p.info(self.handle)
            capture._info_checked(self.opened, kind)
            capture._identity_join(self.path.lstat(), self.opened, kind)
            self.evidence['openedInformation'] = copy.deepcopy(self.opened)
        except BaseException as error:
            close_error = None
            try:
                self.close()
            except BaseException as exc:
                close_error = _error(exc)
            raise CloneRefused('owned-target-open-refused', {**self.evidence, 'original': _error(error),
                               'closeError': close_error, 'unresolvedHandle': close_error is not None,
                               'apiEvents': p.events}) from error

    def set_security(self, row):
        require(not self.root_finalization and self.kind != 'junction', 'security-only-before-junction-activation')
        expected = row['information']
        require(all(self.opened[k] != expected[k] for k in IDENTITY_FIELDS)
                and all(self.opened[k] == expected[k] for k in ('volumeSerial32', 'volumeSerial64')),
                'security-write-requires-independent-same-volume-object')
        _check(self.deadline)
        p = self.port
        raw = base64.b64decode(row['security']['ownerGroupDaclBase64'], validate=True)
        buffer = ctypes.create_string_buffer(raw)
        p.require(p.call('IsValidSecurityDescriptor:copy', p.s.IsValidSecurityDescriptor,
                         (buffer,), {'bytes': len(raw)}), 'valid-source-security-required')
        require(p.call('GetSecurityDescriptorLength:copy', p.s.GetSecurityDescriptorLength,
                       (buffer,), {'bytes': len(raw)}) == len(raw), 'exact-source-security-length-required')
        owner, group, dacl = ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_void_p()
        defaulted, present = ctypes.c_int32(), ctypes.c_int32()
        control, revision = ctypes.c_uint16(), ctypes.c_uint32()
        for name, fn, args in (
            ('GetSecurityDescriptorOwner', p.s.GetSecurityDescriptorOwner, (buffer, ctypes.byref(owner), ctypes.byref(defaulted))),
            ('GetSecurityDescriptorGroup', p.s.GetSecurityDescriptorGroup, (buffer, ctypes.byref(group), ctypes.byref(defaulted))),
            ('GetSecurityDescriptorDacl', p.s.GetSecurityDescriptorDacl, (buffer, ctypes.byref(present), ctypes.byref(dacl), ctypes.byref(defaulted))),
            ('GetSecurityDescriptorControl', p.s.GetSecurityDescriptorControl, (buffer, ctypes.byref(control), ctypes.byref(revision)))):
            p.require(p.call(name, fn, args, {'securityBytes': len(raw)}), name)
        require(owner.value and group.value and present.value == 1 and dacl.value,
                'explicit-owner-group-nonnull-dacl-required')
        security_info = 7 | (0x80000000 if control.value & 0x1000 else 0x20000000)
        result = p.call('SetSecurityInfo:owned-target', p.s.SetSecurityInfo,
                       (self.handle, 1, security_info, owner, group, dacl, None),
                       {'handle': self.handle, 'scope': 'owner-group-dacl', 'securityInformation': security_info})
        require(result == 0, 'owned-target-security-refused', {'returnCode': result})

    def set_junction(self, payload, raw_target):
        require(not self.root_finalization and self.kind == 'directory', 'fresh-empty-junction-directory-required')
        _check(self.deadline)
        p, returned = self.port, ctypes.c_uint32()
        data = ctypes.create_string_buffer(payload)
        p.require(p.call('FSCTL_SET_REPARSE_POINT:owned-target', p.k.DeviceIoControl,
                  (self.handle, 0x900a4, data, len(payload), None, 0, ctypes.byref(returned), None),
                  {'handle': self.handle, 'bytes': len(payload), 'target': raw_target}), 'FSCTL_SET_REPARSE_POINT')
        self.kind = 'junction'
        require(os.readlink(self.path) == raw_target, 'junction-target-roundtrip-mismatch')
        self.evidence['junctionRawTarget'] = raw_target

    def set_metadata(self, expected):
        _check(self.deadline)
        p, native = self.port, capture._primitive()
        if self.kind == 'file':
            current = p.info(self.handle)
            if current['allocationBytes'] != expected['allocationBytes']:
                require(expected['allocationBytes'] >= expected['size'], 'unsupported-file-allocation')
                allocation = ctypes.c_int64(expected['allocationBytes'])
                p.require(p.call('SetFileInformationByHandle:allocation', p.k.SetFileInformationByHandle,
                    (self.handle, 5, ctypes.byref(allocation), ctypes.sizeof(allocation)),
                    {'handle': self.handle, 'allocationBytes': expected['allocationBytes']}), 'set-allocation')
        value = native.BasicInfo(*(expected[k] for k in TIMES), expected['attributes'])
        p.require(p.call('SetFileInformationByHandle:basic', p.k.SetFileInformationByHandle,
            (self.handle, 0, ctypes.byref(value), ctypes.sizeof(value)),
            {'handle': self.handle, 'information': {k: expected[k] for k in (*TIMES, 'attributes')}}), 'set-basic-information')

    def observe(self):
        _check(self.deadline)
        p = self.port
        streams = capture._Held.streams(self)
        first = self.evidence['before'] = p.info(self.handle)
        capture._info_checked(first, self.kind)
        sec1 = capture._primitive().checked_security(p.security(self.handle))
        self.evidence['ownerGroupDaclBeforeBase64'] = base64.b64encode(sec1).decode('ascii')
        sec2 = capture._primitive().checked_security(p.security(self.handle))
        self.evidence['ownerGroupDaclAfterBase64'] = base64.b64encode(sec2).decode('ascii')
        last = self.evidence['after'] = p.info(self.handle)
        require(first == last and sec1 == sec2, 'owned-target-observation-unstable', self.evidence)
        require(all(first[k] == self.opened[k] for k in ('volumeSerial32', 'volumeSerial64', *IDENTITY_FIELDS)),
                'owned-target-handle-identity-changed')
        capture._identity_join(self.path.lstat(), first, self.kind)
        return {'information': copy.deepcopy(first),
                'security': {'ownerGroupDaclBase64': self.evidence['ownerGroupDaclBeforeBase64'], 'saclNotRequested': True},
                'streams': streams}

    def close(self):
        if self.handle not in (None, ctypes.c_void_p(-1).value) and not self.closed:
            self.closed = True
            self.port.close(self.handle)
            self.evidence['handleClosed'] = True


def _verify_target(port, expected, independent):
    actual = port.observe()
    _same_metadata(expected['information'], actual['information'], independent)
    require(actual['security'] == expected['security'], 'copy-owner-group-dacl-mismatch',
            {'expected': expected['security'], 'observed': actual['security']})
    projection = lambda rows: [(r['name'], r['bytes'], r['allocationBytes']) for r in rows]
    require(projection(actual['streams']) == projection(expected['streams']), 'copy-stream-roster-mismatch')
    return actual


def prepare_working_copy(before_capture, destination, *, node, limits, deadline):
    """Prepare one fresh sibling. No rename or original-source mutation occurs."""
    _check(deadline)
    plan = physical_plan(before_capture, destination, limits=limits)
    capture.verify_capture_content(before_capture, deadline)
    target = Path(plan['destinationRoot'])
    require(target.parent.resolve(strict=True) == target.parent and not os.path.lexists(target),
            'ordinary-fresh-target-parent-required')
    report = {'format': 1, 'kind': 'local-windows-working-copy', 'sourceRoot': plan['sourceRoot'],
              'destinationRoot': str(target), 'startedEpochMs': time.time_ns() // 1000000,
              'entries': {}, 'junctions': [], 'complete': False, 'saclNotRequested': True,
              'independentIdsOnly': True, 'sourceChildrenWritten': False, 'renamesPerformed': False}
    held, ancestors, failure, close_errors = {}, [], None, []
    charged, charge_total, closure_total = {}, 0, 0
    fixed = len(json.dumps(report, ensure_ascii=True, allow_nan=False).encode('utf-8')) + 4096

    def reserve():
        # One new/failed target has <=64 API events, at most two64KiB security
        # read buffers, descriptor copies, bounded4096-char paths and fixed-size
        # native structures. Two MiB covers that entire unfinished observation.
        # Each existing handle also reserves its close event, bounded error and
        # path. These bytes are not silently excluded from the final manifest.
        require(fixed + charge_total + closure_total + 2 * 1024**2 <= limits['maxReportBytes'],
                'clone-evidence-reserve-unavailable', {'chargedBytes': charge_total,
                    'fixedBytes': fixed, 'closureReserveBytes': closure_total, 'maximumBytes': limits['maxReportBytes']})

    def charge(port, row=None):
        nonlocal charge_total, closure_total
        key = str(port.path)
        if key not in charged:
            closure_total += 2560 + 2 * len(json.dumps(key).encode('utf-8'))
        value = {'handle': dict(port.evidence, apiEvents=port.port.events), 'manifestRow': row}
        size = len(json.dumps(value, ensure_ascii=True, allow_nan=False).encode('utf-8')) + len(key.encode('utf-8')) + 64
        charge_total += size - charged.get(key, 0)
        charged[key] = size
        reserve()

    try:
        for path in reversed((target.parent, *target.parent.parents)):
            if path == Path(path.anchor):
                continue
            row = path.lstat()
            require(stat.S_ISDIR(row.st_mode) and not capture._reparse(row), 'ordinary-target-ancestry-required')
            reserve()
            port = capture._Held(path, 'directory', deadline)
            ancestors.append(port)
            capture._identity_join(row, port.evidence['openedInformation'], 'directory')
            charge(port)
        dirs = sorted((r for r in plan['rows'] if r['kind'] == 'directory'),
                      key=lambda r: (len(capture._relative(r['key']).parts), r['key']))
        for row in dirs:
            _check(deadline)
            reserve()
            path = target / capture._relative(row['key'])
            path.mkdir()
            port = Win32Target(path, 'directory', deadline)
            held[row['key']] = port
            port.set_security(row['expected'])  # Empty: never propagates through a junction.
            charge(port)
        for row in (r for r in plan['rows'] if r['kind'] == 'file'):
            _check(deadline)
            reserve()
            path = target / capture._relative(row['key'])
            copied = capture._copy_default(Path(row['imagePath']), path, limits['maxFileBytes'], deadline)
            expected = row['expected']
            require(copied['bytes'] == expected['bytes'] and copied['sha256'] == expected['sha256'], 'copied-source-bytes-mismatch')
            port = Win32Target(path, 'file', deadline)
            held[row['key']] = port
            port.set_security(expected)
            # Read actual destination bytes while its write/delete-denying handle
            # is retained, before final timestamps. No later data read is hidden.
            with path.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            require(digest == expected['sha256'], 'copied-target-bytes-mismatch')
            port.set_metadata(expected['information'])
            report['entries'][row['key']] = {'kind': 'file', 'bytes': expected['bytes'], 'sha256': digest,
                                            **_verify_target(port, expected, True)}
            charge(port, report['entries'][row['key']])
        for row in plan['junctions']:
            _check(deadline)
            reserve()
            path = target / capture._relative(row['key'])
            path.mkdir()
            port = Win32Target(path, 'directory', deadline)
            held[row['key']] = port
            port.set_security(row['expected'])
            port.set_junction(base64.b64decode(row['payloadBase64'], validate=True), row['expected']['rawTarget'])
            port.set_metadata(row['expected']['information'])
            actual = _verify_target(port, row['expected'], True)
            report['junctions'].append({'path': row['key'], 'rawTarget': row['expected']['rawTarget'], **actual})
            charge(port, report['junctions'][-1])
        # All creation, security changes and file reads are complete first.
        for row in reversed(dirs):
            port = held[row['key']]
            reserve()
            port.set_metadata(row['expected']['information'])
            report['entries'][row['key']] = {'kind': 'directory', **_verify_target(port, row['expected'], True)}
            charge(port, report['entries'][row['key']])
        capture.verify_capture_content(before_capture, deadline)
        report['rootInformation'] = copy.deepcopy(report['entries']['.']['information'])
        report['rootSecurity'] = copy.deepcopy(report['entries']['.']['security'])
        report['rootStreams'] = copy.deepcopy(report['entries']['.']['streams'])
    except BaseException as error:
        failure = error
    finally:
        for port in reversed([*ancestors, *held.values()]):
            try:
                port.close()
            except BaseException as error:
                close_errors.append({'path': str(port.path), 'error': _error(error)})
        report['handles'] = [dict(port.evidence, apiEvents=port.port.events) for port in held.values()]
        report['ancestorHandles'] = [dict(port.evidence, apiEvents=port.port.events) for port in ancestors]
        report['allHandlesClosed'] = (not close_errors and not getattr(failure, 'unresolved_handle', False)
            and all(p.evidence.get('handleClosed') for p in [*ancestors, *held.values()]))
        report['unresolvedHandle'] = bool(close_errors) or getattr(failure, 'unresolved_handle', False)
        report['endedEpochMs'] = time.time_ns() // 1000000
    if failure is not None or close_errors:
        report.update(originalError=_error(failure) if failure else None, closeErrors=close_errors)
        raise CloneRefused('working-copy-refused', report) from failure
    _check(deadline)
    require(len(json.dumps(report, ensure_ascii=True, allow_nan=False).encode('utf-8')) <= limits['maxReportBytes'],
            'clone-result-budget-exceeded', report)
    report['complete'] = True
    return report


def finalize_renamed_root(expected_capture_or_clone, root, *, deadline):
    """Restore only the declared root's rename-induced ChangeTime; never children.

    The caller must already have reconciled the no-replace rename and stopped
    owner. Every field except current ChangeTime must match before any write.
    """
    _check(deadline)
    value, root = expected_capture_or_clone, Path(root)
    require(value.get('complete') is True and value.get('allHandlesClosed') is True
            and str(root) == value['sourceRoot'], 'exact-restored-canonical-root-required')
    if value['kind'] == 'local-windows-closed-tree':
        expected = value['entries']['.']
        _supported(expected, 'directory')
    else:
        require(value['kind'] == 'local-windows-working-copy' and value['independentIdsOnly'] is True,
                'qualified-working-copy-root-required')
        expected = {'information': value['rootInformation'], 'security': value['rootSecurity'],
                    'streams': value['rootStreams']}
    port, failure, close_error, result = None, None, None, None
    try:
        port = Win32Target(root, 'directory', deadline, root_finalization=True)
        before = port.observe()
        want, actual = expected['information'], before['information']
        require(set(want) == set(actual) and all(want[k] == actual[k] for k in want if k != 'change100ns')
                and expected['security'] == before['security']
                and [(r['name'], r['bytes'], r['allocationBytes']) for r in expected['streams']]
                    == [(r['name'], r['bytes'], r['allocationBytes']) for r in before['streams']],
                'renamed-root-has-unexplained-change', before)
        # Explicit restoration of the one known rename field, not a timestamp
        # exemption or an attempt to conceal changes in any child/object.
        port.set_metadata(want)
        after = _verify_target(port, expected, False)
        result = {'format': 1, 'kind': 'renamed-root-metadata-finalized', 'root': str(root),
                  'before': before, 'after': after, 'onlyExpectedDifference': 'change100ns',
                  'childrenAccessed': False, 'saclNotRequested': True}
    except BaseException as error:
        failure = error
    finally:
        if port is not None:
            try:
                port.close()
            except BaseException as error:
                close_error = error
    if failure is not None or close_error is not None:
        raise CloneRefused('renamed-root-finalization-refused', {'original': _error(failure) if failure else None,
            'closeError': _error(close_error) if close_error else None,
            'unresolvedHandle': close_error is not None or getattr(failure, 'unresolved_handle', False),
            'observations': port.evidence if port else None,
            'apiEvents': port.port.events if port else None}) from failure
    result.update(allHandlesClosed=True, observations=port.evidence, apiEvents=port.port.events)
    return result
