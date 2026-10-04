"""Qualify the exact reviewed Codex startup log-retention lifecycles.

The caller supplies the durably recorded startup window and opens stable
private SQLite copies. This module verifies the selected runtime files and
log rows without modifying records or relaxing any other table's comparison.

Pinned policy: openai/codex, rust-v0.155.1 and rust-v0.158.0,
codex-rs/state/src/runtime/logs.rs (run_logs_startup_maintenance) and
codex-rs/state/src/runtime.rs (runtime initialization).
https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/state/src/runtime/logs.rs
https://github.com/openai/codex/blob/rust-v0.158.0/codex-rs/state/src/runtime/logs.rs
The 0.158.0 logs.rs source SHA256 is
09d10deee494d96f003a091b9f4972a395e20d18d2e5948a04d8f7fb4b41ef9f;
runtime.rs is cc074712e6b22f37f12df1c1af831d97c65536de7c500797246c3c22b695f002.
Startup removes the complete prefix with ts < UTC-now minus ten days. The
separate per-partition insertion limits are intentionally not qualified here.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct

RETENTION_SECONDS = 10 * 86400
MAX_STARTUP_WINDOW_SECONDS = 3600
MAX_LOG_ROWS = 200000
MAX_LOG_ROW_BYTES = 16 * 1024 * 1024
MAX_TIMESTAMP_SECONDS = 4102444800
LOG_COLUMNS = tuple('id ts ts_nanos level target feedback_log_body module_path file line thread_id process_uuid estimated_bytes'.split())
ENGINE_VERSION = '2026.9.6'
CODEX_VERSION = '0.155.1'
CODEX_BINARY_SHA256 = '0753dfe1d8b87a52436deb13eb1c549661ef4c84fee2c5aa688385eebeccb761'
CODEX_BINARY_BYTES = 269273536
CODEX_SURFACE = 'd05cd8ba6d0e24e4e81ec442be300da755d818c74be47885f65932a1d5622801'
RUNTIME_ATTESTATIONS = {
    '2026.9.6': ('0.155.1', CODEX_BINARY_SHA256, CODEX_BINARY_BYTES, CODEX_SURFACE),
    '2026.9.8': ('0.158.0', '167c0148a849d2444f1b5a7fb5f8bb2de1de5ae13a2a504b833fc765980f5cd9',
                 286594376, CODEX_SURFACE),
}
MAX_INDEX_BYTES = 16 * 1024 * 1024
MAX_PACKAGE_BYTES = 256 * 1024


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def _object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Ambiguous runtime JSON object.')
        result[key] = value
    return result


def _json(value):
    try:
        result = json.loads(value, object_pairs_hook=_object)
    except (ValueError, UnicodeError, RecursionError) as error:
        raise RuntimeError('Invalid runtime attestation JSON.') from error
    require(isinstance(result, dict), 'Runtime attestation requires an object.')
    return result


def _identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _regular(path, maximum):
    require(path.is_absolute() and path.resolve(strict=True) == path,
            'Runtime attestation payload was redirected.')
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= maximum,
            'Runtime attestation file is not regular or exceeds its bound.')
    return info


def _package(path, name, version):
    before = _regular(path, MAX_PACKAGE_BYTES)
    with path.open('rb') as stream:
        require(_identity(os.fstat(stream.fileno())) == _identity(before), 'Runtime package identity changed.')
        raw = stream.read(MAX_PACKAGE_BYTES + 1)
    require(len(raw) == before.st_size and _identity(path.lstat()) == _identity(before),
            'Runtime package changed during attestation.')
    package = _json(raw)
    require(package.get('name') == name and package.get('version') == version,
            'The active runtime package is outside the reviewed version.')
    return hashlib.sha256(raw).hexdigest()


def _binary_sha256(path, expected_bytes=CODEX_BINARY_BYTES):
    before = _regular(path, expected_bytes)
    require(before.st_size == expected_bytes, 'The active Codex executable size changed.')
    with path.open('rb') as stream:
        require(_identity(os.fstat(stream.fileno())) == _identity(before), 'Codex executable identity changed.')
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    require(_identity(path.lstat()) == _identity(before), 'Codex executable changed during attestation.')
    return digest


def attest_runtime(root, selected, shared_connection, *, engine_version=ENGINE_VERSION):
    """Attest the active managed npm Codex payload; never discover by glob.

    root is the closed live/restore workspace whose recorded absolute install
    path is authoritative. A snapshot with a different absolute namespace
    must instead be protected by the caller's existing retention comparison.
    Failure raises RuntimeError/OSError; callers must retain append-only rules
    unless this proof and a valid durable startup window are both available.
    """
    require(engine_version in RUNTIME_ATTESTATIONS, 'Unreviewed Codex log-retention engine.')
    codex_version, binary_sha256, binary_bytes, surface = RUNTIME_ATTESTATIONS[engine_version]
    root, selected = Path(root), Path(selected)
    require(root.is_absolute() and root.resolve(strict=True) == root and root.is_dir()
            and not selected.is_absolute() and '..' not in selected.parts,
            'Invalid selected runtime authority.')
    native = root / selected / 'openclaw-runtime'
    projects = native / 'state' / 'npm' / 'projects'
    require(projects.resolve(strict=True) == projects and projects.is_dir(),
            'The selected managed npm store was redirected.')
    columns = [row[1] for row in shared_connection.execute('pragma table_info(config_machine_state)')]
    require(columns == ['state_key', 'value_json', 'updated_at_ms'], 'Native machine-state columns changed.')
    key = 'plugins.installedIndex'
    lengths = list(shared_connection.execute(
        'select length(cast(value_json as blob)) from config_machine_state where state_key=? limit 2', (key,)))
    require(len(lengths) == 1 and type(lengths[0][0]) is int and 0 < lengths[0][0] <= MAX_INDEX_BYTES,
            'Native plugin index is missing, ambiguous or exceeds its bound.')
    entries = list(shared_connection.execute(
        'select value_json,updated_at_ms from config_machine_state where state_key=? limit 2', (key,)))
    require(len(entries) == 1 and isinstance(entries[0][0], str)
            and len(entries[0][0].encode('utf-8')) <= MAX_INDEX_BYTES, 'Native plugin index changed format.')
    value = _json(entries[0][0])
    require(set(value) == {'revision', 'index'} and type(value['revision']) is int
            and 0 <= value['revision'] <= 9007199254740991
            and type(entries[0][1]) is int and entries[0][1] == value['revision'],
            'Native plugin index revision is invalid.')
    index = value['index']
    required = {'version', 'warning', 'hostContractVersion', 'compatRegistryVersion', 'migrationVersion',
                'policyHash', 'generatedAtMs', 'installRecords', 'plugins', 'diagnostics'}
    require(isinstance(index, dict) and required <= set(index) <= required | {'workspaceDir', 'refreshReason'}
            and type(index['version']) is int and index['version'] == 1
            and type(index['migrationVersion']) is int and index['migrationVersion'] == 1
            and index['hostContractVersion'] == engine_version
            and isinstance(index['warning'], str) and len(index['warning']) <= 1024
            and all(isinstance(index[name], str) and re.fullmatch('[a-f0-9]{64}', index[name])
                    for name in ('compatRegistryVersion', 'policyHash'))
            and type(index['generatedAtMs']) is int and 0 <= index['generatedAtMs'] <= value['revision'],
            'Native plugin index envelope is outside the reviewed runtime.')
    records = index['installRecords']
    require(isinstance(records, dict) and 1 <= len(records) <= 1024
            and all(isinstance(name, str) and 0 < len(name) <= 256 and isinstance(record, dict)
                    for name, record in records.items())
            and all(isinstance(index[name], list) and len(index[name]) <= 4096
                    and all(isinstance(item, dict) for item in index[name]) for name in ('plugins', 'diagnostics'))
            and all(isinstance(index[name], str) and len(index[name]) <= 4096
                    for name in ('workspaceDir', 'refreshReason') if name in index),
            'Native plugin index records changed format.')
    record = records.get('codex')
    require(isinstance(record, dict) and record.get('source') == 'npm'
            and record.get('spec') == record.get('resolvedSpec') == '@openclaw/codex@' + engine_version
            and record.get('version') == record.get('resolvedVersion') == engine_version
            and record.get('resolvedName') == '@openclaw/codex' and 'sourcePath' not in record
            and isinstance(record.get('integrity'), str)
            and re.fullmatch(r'sha512-[A-Za-z0-9+/]+={0,2}', record['integrity'])
            and ('acceptedSurfaceHash' not in record or record['acceptedSurfaceHash'] == surface),
            'The active Codex installation is outside the reviewed official npm record.')
    raw_path = record.get('installPath')
    require(isinstance(raw_path, str) and 0 < len(raw_path) <= 4096, 'Invalid Codex install path.')
    installed = Path(raw_path)
    require(installed.is_absolute() and str(installed) == raw_path and installed.is_relative_to(projects),
            'The Codex install is outside the selected managed npm store.')
    relative = installed.relative_to(projects)
    require(len(relative.parts) == 4 and re.fullmatch(r'openclaw-codex-[a-f0-9]{10}', relative.parts[0])
            and relative.parts[1:] == ('node_modules', '@openclaw', 'codex')
            and installed.resolve(strict=True) == installed and installed.is_dir(),
            'The managed Codex payload was redirected or changed layout.')
    modules = installed.parent.parent
    packages = {
        'plugin': _package(installed / 'package.json', '@openclaw/codex', engine_version),
        'codex': _package(modules / '@openai' / 'codex' / 'package.json', '@openai/codex', codex_version),
        'platform': _package(modules / '@openai' / 'codex-linux-x64' / 'package.json',
                             '@openai/codex', codex_version + '-linux-x64'),
    }
    binary = modules / '@openai' / 'codex-linux-x64' / 'vendor' / 'x86_64-unknown-linux-musl' / 'bin' / 'codex'
    digest = _binary_sha256(binary, binary_bytes)
    require(digest == binary_sha256, 'The active Codex executable is outside the reviewed retention policy.')
    return dict(format=1, engineVersion=engine_version, codexVersion=codex_version,
                binarySha256=digest, binaryBytes=binary_bytes, packageSha256=packages,
                installPathSha256=hashlib.sha256(raw_path.encode('utf-8')).hexdigest())


def _cutoff_window(start, end):
    require(type(start) is int and type(end) is int
            and 0 < start <= end <= MAX_TIMESTAMP_SECONDS
            and end - start <= MAX_STARTUP_WINDOW_SECONDS,
            'Invalid recorded native startup window.')
    return start - RETENTION_SECONDS, end - RETENTION_SECONDS


def _schema(connection):
    require(connection.execute('pragma user_version').fetchone()[0] == 0,
            'Unreviewed Codex log database version.')
    columns = tuple(tuple(row) for row in connection.execute('pragma table_xinfo("logs")'))
    require(tuple(column[1] for column in columns) == LOG_COLUMNS
            and [(column[1], column[5]) for column in columns if column[5]] == [('id', 1)]
            and all(column[6] == 0 for column in columns),
            'Unreviewed Codex log columns or identity.')
    definitions = tuple(tuple(row) for row in connection.execute(
        "select type,name,sql from sqlite_schema where tbl_name='logs' and name not like 'sqlite_%' order by type,name"))
    require(any(kind == 'table' and name == 'logs' and sql is not None for kind, name, sql in definitions),
            'The retained log table is missing.')
    return columns, definitions


def _row_hash(row):
    """Typed, length-framed full-row bytes; keep no log payload in the index."""
    result = hashlib.sha256()
    size = 0
    for value in row:
        if value is None:
            tag, raw = b'n', b''
        elif isinstance(value, (bytes, str)):
            require(len(value) <= MAX_LOG_ROW_BYTES, 'Log row exceeds the retained-data memory bound.')
            tag, raw = (b'b', value) if isinstance(value, bytes) else (b's', value.encode('utf-8'))
        elif type(value) is int:
            tag, raw = b'i', str(value).encode('ascii')
        elif type(value) is float:
            tag, raw = b'f', struct.pack('>d', value)
        else:
            raise RuntimeError('Unexpected retained SQLite value type.')
        size += len(raw) + 9
        require(size <= MAX_LOG_ROW_BYTES, 'Log row exceeds the retained-data memory bound.')
        result.update(tag)
        result.update(len(raw).to_bytes(8, 'big'))
        result.update(raw)
    return result.digest()


def _indexed_logs(connection):
    result = {}
    for count, row in enumerate(connection.execute('select * from "logs"'), start=1):
        require(count <= MAX_LOG_ROWS, 'Log retention check exceeds the bounded row count.')
        identity, timestamp = row[0], row[1]
        require(type(identity) is int and identity not in result
                and type(timestamp) is int and 0 <= timestamp <= MAX_TIMESTAMP_SECONDS,
                'Invalid retained log identity or timestamp.')
        result[identity] = (_row_hash(row), timestamp)
    return result


def qualify_logs(before, after, startup_start_seconds, startup_end_seconds, *, engine_version=ENGINE_VERSION):
    """Return content-free evidence or raise RuntimeError on unqualified drift.

Both arguments are SQLite connections exposing execute(). The startup bounds
are integer UTC seconds from the caller's durable receipt, not verification
time. Common IDs must preserve every typed column. Deletions, when present,
must equal the entire timestamp prefix for one cutoff inside that window.
"""
    low, high = _cutoff_window(startup_start_seconds, startup_end_seconds)
    require(_schema(before) == _schema(after), 'Retained Codex log schema changed.')
    old, new = _indexed_logs(before), _indexed_logs(after)
    common = old.keys() & new.keys()
    require(all(old[key][0] == new[key][0] for key in common), 'A retained complete log row changed.')
    removed = old.keys() - new.keys()
    report = dict(beforeRows=len(old), afterRows=len(new), retainedRows=len(common),
                  removedRows=len(removed), addedRows=len(new.keys() - old.keys()),
                  rule='append-only', allRetainedCompleteRowHashesEqual=True)
    if removed:
        # Strict '<' requires all rows at the boundary timestamp to agree.
        # Intersect the exact prefix's possible cutoffs with actual startup.
        first = max(low, max(old[key][1] for key in removed) + 1)
        last = min(high, min((old[key][1] for key in common), default=high))
        require(first <= last, 'Removed logs do not equal the exact startup age-retention prefix.')
        require({key for key, (_, timestamp) in old.items() if timestamp < first} == removed,
                'The complete age-eligible log set differs.')
        require(engine_version in RUNTIME_ATTESTATIONS, 'Unreviewed Codex log-retention engine.')
        report.update(rule='codex-' + RUNTIME_ATTESTATIONS[engine_version][0] + '-startup-10-days', cutoffFirst=first, cutoffLast=last,
                      startupFirst=startup_start_seconds, startupLast=startup_end_seconds)
    digest = hashlib.sha256()
    for key in sorted(common):
        digest.update(old[key][0])
    report['retainedCompleteRowsSha256'] = digest.hexdigest()
    return report
