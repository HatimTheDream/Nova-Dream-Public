"""Closed snapshots and independent same-schema restoration for reviewed updates.

Derived from the previously reviewed hosted recovery approach. No function runs
on import. Recovery files are never used as the future live tree through links.
"""
import contextlib
from collections import Counter
import hashlib
import json
import os
import pathlib
import re
import shutil
import signal
import sqlite3
import stat
import subprocess
import time
import uuid

RESERVE = 1610612736
ALLOWANCE = 128 * 1024 ** 2


# Exact OpenClaw 2026.9.2 shared schema15 and agent schema19 coverage.
# Durable content is retained as complete rows; no entry_json field is omitted.
# Unknown tables require another reviewed driver, rather than a substring guess.
NATIVE_RETAINED_TABLES = frozenset("""
    acp_parent_stream_events acp_replay_events acp_replay_sessions acp_sessions
    agent_deletion_journal agent_provenance apns_registration_tombstones apns_registrations
    audit_events audit_identity_keys auth_profile_state backup_runs
    board_tabs board_widgets capture_blobs capture_events
    capture_sessions channel_ingress_events channel_pairing_allow_entries channel_pairing_requests
    claw_cron_refs claw_installs claw_mcp_server_refs claw_package_refs
    claw_workspace_files clawhub_promotion_claims config_health_entries config_machine_state
    config_revision_keys context_engine_turn_outbox conversation_deliveries conversations
    cron_job_runtime_authorities cron_job_scratch cron_jobs cron_run_receipts
    current_conversation_bindings delivery_queue_entries device_auth_tokens device_bootstrap_tokens
    device_identities device_pair_setup_completions device_pairing_join_codes device_pairing_pending
    exec_approvals_config execution_decision_facts execution_identity_contexts execution_owner_lifecycle_bindings
    fleet_cells flow_runs gateway_origin_device_tokens gateway_restart_handoff
    gateway_restart_intent gateway_restart_sentinel github_personal_publication_requests github_publication_requests
    heartbeat_outcomes managed_outgoing_image_records mcp_oauth_pending_authorizations mcp_oauth_stores
    meeting_transcript_sessions meeting_transcript_summaries meeting_transcript_utterances memory_entry_origins
    memory_index_chunk_provenance memory_index_chunk_recall_metadata memory_index_chunks memory_index_meta
    memory_index_sources memory_index_state memory_session_tombstones message_tool_run_outcomes
    migration_runs migration_sources node_worker_launch_containers node_worker_launches
    node_worker_turns operator_approval_execution_identities operator_approval_standing_grants operator_approvals
    outbound_media_provenance outbound_message_execution_bindings outbound_message_progress plugin_binding_approvals
    plugin_blob_entries plugin_state_entries projects sandbox_registry_entries
    secret_store_entries session_conversations session_goal_operations session_groups
    session_key_contract session_members session_nodes session_participants
    session_pending_inputs session_progress_cards session_state_events session_state_heads
    session_suggestions session_transcript_archives session_upstream_links session_watch_cursors
    session_windows skill_library_entries skill_library_events skill_library_revisions
    skill_library_uploads skill_upload_chunks skill_uploads skill_usage
    skill_workshop_collection_reviews skill_workshop_proposal_events skill_workshop_proposal_rollbacks skill_workshop_proposals
    standing_intents subagent_runs task_delivery_state task_runs
    trajectory_runtime_events transcript_event_identities transcript_events transcript_rewrite_watermarks
    update_runs user_preferences web_push_approval_deliveries web_push_subscriptions
    worker_environment_credentials worker_environment_ssh_fallback_ports worker_environments worker_inference_turns
    worker_session_placement_moves worker_session_placements worker_session_tool_operations worker_transcript_commit_heads
    worker_transcript_commits worker_turn_tool_authorities worker_workspace_pending_results worker_workspace_reconciliations
    workspace_generated_bootstrap_hashes workspace_path_aliases workspace_setup_state worktree_provisioned_file_chunks
    worktrees
""".split())
# Only derived caches, live process leases and boot observations may be rebuilt.
# Their source records remain in the complete-row set above.
NATIVE_TRANSIENT_TABLES = frozenset("""
    agent_database_leases cache_entries diagnostic_events gateway_boot_lifecycle
    macos_port_guardian_records memory_embedding_cache native_hook_relay_bridges official_external_plugin_catalog_snapshots
    session_transcript_active_events session_transcript_index_state state_leases
""".split())
# Fixed reconnect/inspection timestamps only. Auth values, scopes and unknown
# nested token fields still match; the exact token last-use timestamp is below.
NATIVE_RECONNECT_COLUMNS = {
    'schema_meta': ('updated_at',),
    'agent_databases': ('last_seen_at', 'size_bytes'),
    'auth_profile_store': ('updated_at',),
    'device_pairing_paired': ('last_seen_at_ms', 'last_seen_reason'),
}
NATIVE_RETAINED_TABLES |= {'user_profiles', 'user_profile_emails', 'user_profile_identities'}
NATIVE_FTS_TABLES = frozenset(base + suffix for base in ('standing_intents_fts', 'session_transcript_fts', 'memory_index_chunks_fts', 'memory_index_paths_fts')
                             for suffix in ('', '_data', '_idx', '_content', '_docsize', '_config'))
NATIVE_KNOWN_TABLES = NATIVE_RETAINED_TABLES | NATIVE_TRANSIENT_TABLES | NATIVE_FTS_TABLES | NATIVE_RECONNECT_COLUMNS.keys()


class InsufficientStorage(RuntimeError):
    """Safe typed preflight rejection; it conveys no host path or raw exception."""


def require(value, message):
    if not value:
        raise RuntimeError(message)


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def sync_dir(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_json(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf8') as output:
        json.dump(value, output, sort_keys=True, separators=(',', ':'))
        output.flush()
        os.fsync(output.fileno())
    sync_dir(path.parent)


def inventory(root):
    root_info = root.lstat()
    require(stat.S_ISDIR(root_info.st_mode) and not root.is_symlink(), 'Snapshot root must be an ordinary directory.')
    pending, entries, inodes, groups = [root], {}, {}, {}
    while pending:
        path = pending.pop()
        info = path.lstat()
        require(info.st_dev == root_info.st_dev, 'Nested filesystems need separate recovery review.')
        relative = path.relative_to(root).as_posix()
        entry = {'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid,
                 'mtime_ns': info.st_mtime_ns,
                 'xattrs': {name: hashlib.sha256(os.getxattr(path, name, follow_symlinks=False)).hexdigest()
                            for name in sorted(os.listxattr(path, follow_symlinks=False))}}
        if stat.S_ISDIR(info.st_mode):
            entry['kind'] = 'directory'
            pending.extend(sorted(path.iterdir(), reverse=True))
        elif stat.S_ISLNK(info.st_mode):
            entry.update(kind='symlink', target=os.readlink(path))
        elif stat.S_ISREG(info.st_mode):
            entry.update(kind='file', size=info.st_size, sha256=digest(path))
            inodes[relative] = {'device': info.st_dev, 'inode': info.st_ino,
                                'allocated': info.st_blocks * 512,
                                'sparse': info.st_blocks * 512 < info.st_size}
            groups.setdefault((info.st_dev, info.st_ino), []).append(relative)
        else:
            raise RuntimeError('Special files need separate recovery review.')
        after = path.lstat()
        identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        require(identity(info) == identity(after), 'Source changed while its recovery identity was being captured.')
        entries[relative] = entry
    for relatives in groups.values():
        if len(relatives) > 1:
            for relative in relatives:
                entries[relative]['hardlink_group'] = min(relatives)
    return entries, inodes


def inode_ids(records):
    return {(item['device'], item['inode']) for item in records.values()}


def capacity(source, source_inodes, baseline, baseline_inodes, free, candidate_bytes=0):
    require(inode_ids(source_inodes).isdisjoint(inode_ids(baseline_inodes)), 'Live files already share recovery inodes.')
    changed = []
    for relative, entry in source.items():
        if entry['kind'] != 'file':
            continue
        old = baseline.get(relative)
        if old and old.get('kind') == 'file':
            comparable = lambda value: {key: item for key, item in value.items() if key != 'hardlink_group'}
            require(comparable(entry) != comparable(old) or entry.get('hardlink_group') == old.get('hardlink_group'),
                    'Changed hardlink topology requires a separately reviewed copy.')
        if entry != old:
            changed.append(relative)
    copied = sum(source_inodes[name]['allocated'] for name in changed)
    independent = sum(item['allocated'] for item in source_inodes.values())
    required = candidate_bytes + copied + independent + RESERVE + 2 * ALLOWANCE
    if free < required:
        raise InsufficientStorage('Candidate, closed recovery, independent restore and operating reserve do not all fit.')
    return {'freeBytes': free, 'candidateBytes': candidate_bytes, 'snapshotCopyBytes': copied,
            'independentRestoreBytes': independent, 'reserveBytes': RESERVE,
            'allowanceBytes': 2 * ALLOWANCE, 'requiredFreeBytes': required}


def run_copy(arguments, log_path, volume, minimum_free):
    with log_path.open('xb') as log:
        process = subprocess.Popen(arguments, stdout=log, stderr=log, start_new_session=True)
        try:
            while process.poll() is None:
                require(shutil.disk_usage(volume).free >= minimum_free,
                        'Recovery copy approached its operating reserve; evidence was retained.')
                time.sleep(0.05)
            require(process.returncode == 0, 'Recovery copy failed; private evidence was retained.')
        except BaseException:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGTERM)
            with contextlib.suppress(subprocess.TimeoutExpired):
                process.wait(timeout=10)
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise
        finally:
            log.flush()
            os.fsync(log.fileno())


def flush_tree(root, entries, inodes):
    for relative in inodes:
        descriptor = os.open(root / relative, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    for relative, entry in sorted(entries.items(), reverse=True):
        if entry['kind'] == 'directory':
            sync_dir(root / relative)


def snapshot_closed(data, destination, baseline, require_stopped):
    require_stopped()
    source, source_inodes = inventory(data)
    old, old_inodes = inventory(baseline)
    plan = capacity(source, source_inodes, old, old_inodes, shutil.disk_usage(destination.parent).free)
    require(not destination.exists() and not destination.is_symlink(), 'Snapshot destination already exists.')
    destination.mkdir(mode=0o700)
    run_copy(['/usr/bin/rsync', '-aHAXS', '--numeric-ids', '--checksum', '--modify-window=-1',
              '--link-dest=' + str(baseline), '--', str(data) + '/', str(destination) + '/'],
             destination.parent / 'snapshot-copy.log', destination.parent, RESERVE + ALLOWANCE)
    require_stopped()
    actual, actual_inodes = inventory(destination)
    require(inventory(data) == (source, source_inodes), 'Closed live state changed during the snapshot.')
    require(actual == source, 'Closed recovery bytes or metadata differ.')
    require(inode_ids(actual_inodes).isdisjoint(inode_ids(source_inodes)), 'Recovery must not share live file inodes.')
    require(inventory(baseline)[0] == old, 'The prior closed recovery changed.')
    for relative, info in source_inodes.items():
        if info['sparse'] and source[relative]['size'] >= 1024 ** 2:
            require(actual_inodes[relative]['sparse'], 'A large sparse recovery file became fully allocated.')
    flush_tree(destination, actual, actual_inodes)
    write_json(destination.parent / 'snapshot-manifest.json', actual)
    write_json(destination.parent / 'snapshot-verified.json', {'manifestSha256': digest(destination.parent / 'snapshot-manifest.json'), **plan})
    return actual


def prepare_independent(snapshot, destination, failed, require_stopped):
    require_stopped()
    require(not destination.exists() and not destination.is_symlink(), 'Independent restore evidence already exists.')
    expected, source_inodes = inventory(snapshot)
    failed_entries, failed_inodes = inventory(failed)
    required = sum(item['allocated'] for item in source_inodes.values()) + RESERVE + ALLOWANCE
    require(shutil.disk_usage(destination.parent).free >= required, 'Independent restore and reserve no longer fit.')
    run_copy(['/usr/bin/cp', '-a', '--reflink=auto', '--', str(snapshot), str(destination)],
             snapshot.parent / 'independent-copy.log', destination.parent, RESERVE + ALLOWANCE)
    actual, actual_inodes = inventory(destination)
    require(actual == expected, 'Independent restore bytes, metadata or links differ.')
    require(inode_ids(actual_inodes).isdisjoint(inode_ids(source_inodes) | inode_ids(failed_inodes)),
            'The future live tree must have independent file inodes.')
    require(inventory(snapshot)[0] == expected and inventory(failed)[0] == failed_entries, 'Retained recovery or failed state changed.')
    for relative, info in source_inodes.items():
        if info['sparse'] and expected[relative]['size'] >= 1024 ** 2:
            require(actual_inodes[relative]['sparse'], 'A large sparse restored file became fully allocated.')
    require_stopped()
    flush_tree(destination, actual, actual_inodes)
    return expected


def database(path, closed):
    require(path.is_file() and not path.is_symlink(), 'Expected an ordinary workspace database.')
    if closed:
        for suffix in ('-wal', '-journal'):
            extra = pathlib.Path(str(path) + suffix)
            require(not extra.exists() or extra.stat().st_size == 0, 'A closed database still has an uncheckpointed journal.')
    connection = sqlite3.connect(path.as_uri() + ('?mode=ro&immutable=1' if closed else '?mode=ro'), uri=True)
    connection.execute('pragma query_only=ON')
    connection.execute('begin')
    return connection


def saved_state(snapshot, live, restored=False):
    paths = lambda root: {path.relative_to(root) for path in root.rglob('workspace.sqlite')}
    before_paths = paths(snapshot)
    require(before_paths and before_paths == paths(live), 'The saved database set changed.')
    reports = []
    for relative in sorted(before_paths):
        old, current = snapshot / relative, live / relative
        with contextlib.closing(database(old, True)) as before, contextlib.closing(database(current, False)) as after:
            require(before.execute('pragma quick_check').fetchone()[0] == after.execute('pragma quick_check').fetchone()[0] == 'ok', 'Saved database integrity failed.')
            old_schema, new_schema = before.execute('pragma user_version').fetchone()[0], after.execute('pragma user_version').fetchone()[0]
            require(old_schema in {53, 55} and new_schema == old_schema, 'An app-only update changed a saved database schema.')
            for table in ('entities', 'history', 'blobs', 'blob_refs', 'receipts', 'meta'):
                retained = rows(before, table)
                require(retained == rows(after, table), 'Saved content, history, attachment, request receipt or workspace metadata changed.')
            old_services, new_services = rows(before, 'service_records'), rows(after, 'service_records')
            # Only transport-auth reissue and this updater's own durable lease
            # are permitted to change while domain effects are held.
            ephemeral = lambda key: key.startswith('update:native-lease:') or bool(re.fullmatch(r'gateway(?::[a-z-]+)?(?::owner-bound)?:device-token:[a-zA-Z0-9-]+', key))
            meaningful = lambda values: {row for row in values if not ephemeral(str(row[0]))}
            require(meaningful(old_services) == meaningful(new_services), 'Saved domain or account configuration records changed.')
            require({row[0] for row in old_services} <= {row[0] for row in new_services}, 'A retained service record was removed.')
            for name in ('workspace.identity', 'workspace-key.json', 'workspace-selection.json'):
                if (old.parent / name).exists():
                    require((old.parent / name).read_bytes() == (current.parent / name).read_bytes(), 'Workspace identity, key or selection changed.')
            reports.append({'beforeSchema': old_schema, 'afterSchema': new_schema})
    require(any(item['beforeSchema'] == 55 for item in reports), 'The prior selected schema55 store is missing.')
    return reports


def rows(connection, table, maximum=1_000_000):
    require(re.fullmatch(r'[a-zA-Z0-9_]+', table), 'Unexpected database table name.')
    metadata = list(connection.execute('pragma table_info("' + table + '")'))
    require(metadata, 'A retained database table is missing.')
    values = list(connection.execute('select * from "' + table + '" limit ' + str(maximum + 1)))
    require(len(values) <= maximum, 'Retained database verification exceeds its reviewed row bound.')
    return Counter(values)


def bounded_json(path, maximum):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= maximum, 'Unexpected workspace authority record.')
    return json.loads(path.read_bytes())


def selected_workspace(root, expected_epoch=None):
    """Follow the reviewed workspace-host selection contract, then bind its epoch
    to the authenticated live acceptance. Never guess the active runtime by name.
    """
    require(root.resolve(strict=True) == root and root.is_dir(), 'The durable workspace root changed.')
    selected = root
    selection = root / 'workspace-selection.json'
    if selection.exists() or selection.is_symlink():
        value = bounded_json(selection, 1024)
        require(set(value) == {'format', 'recoveryId'} and value['format'] == 1
                and str(uuid.UUID(value['recoveryId'])) == value['recoveryId'], 'The workspace selection is not reviewed.')
        selected = root / 'recovered-workspaces' / value['recoveryId']
        require(selected.resolve(strict=True) == selected and selected.is_dir(), 'The selected recovery workspace was redirected.')
        proof = bounded_json(selected / 'recovery-complete.json', 64 * 1024)
        require(proof.get('jobId') == value['recoveryId'] and re.fullmatch(r'[a-f0-9]{64}', proof.get('sourceHash', '')), 'Selected recovery proof changed.')
    marker = selected / 'edition3.identity'
    require(marker.is_file() and not marker.is_symlink() and marker.read_bytes() == b'private.novadream.edition3.preview\n', 'Selected workspace identity changed.')
    with contextlib.closing(database(selected / 'workspace.sqlite', False)) as connection:
        require(connection.execute('pragma user_version').fetchone()[0] == 55, 'The selected workspace schema changed.')
        row = connection.execute("select value from meta where key='epoch'").fetchone()
        require(row is not None and isinstance(row[0], str) and str(uuid.UUID(row[0])) == row[0]
                and (expected_epoch is None or row[0] == expected_epoch), 'The selected workspace does not match authenticated acceptance.')
    return selected, row[0]


def native_scope(root, expected_epoch=None):
    selected, epoch = selected_workspace(root, expected_epoch)
    native = selected / 'openclaw-runtime'
    require(native.resolve(strict=True) == native and native.is_dir(), 'Selected native runtime was redirected.')
    marker = native / 'edition3-runtime.identity'
    require(marker.is_file() and not marker.is_symlink() and marker.read_bytes() == b'edition3-owned-gateway\n', 'Selected native runtime ownership changed.')
    paths = set()
    shared = native / 'state' / 'state' / 'openclaw.sqlite'
    if shared.exists() or shared.is_symlink():
        require(shared.resolve(strict=True) == shared, 'Canonical native database was redirected.')
        paths.add(shared.relative_to(root))
    agents = native / 'state' / 'agents'
    if agents.exists() or agents.is_symlink():
        require(agents.resolve(strict=True) == agents and agents.is_dir(), 'Canonical native agent root was redirected.')
        entries = list(agents.iterdir())
        require(len(entries) <= 100, 'Native agent inventory exceeded its reviewed bound.')
        for agent in entries:
            require(agent.is_dir() and not agent.is_symlink() and re.fullmatch(r'[a-z0-9_-]+', agent.name), 'Unexpected canonical native agent.')
            for name in ('openclaw-agent.sqlite', 'incognito-openclaw-agent.sqlite'):
                path = agent / 'agent' / name
                if path.exists() or path.is_symlink():
                    require(path.resolve(strict=True) == path, 'Canonical native agent database was redirected.')
                    paths.add(path.relative_to(root))
    return selected.relative_to(root), epoch, paths


def static_sqlite_files(root, selected, active):
    """Dormant stores, nested archives, plugin fixtures and nonactive caches keep
    their exact bytes, even when they are not readable canonical SQLite stores.
    """
    ignored = active | {selected / 'workspace.sqlite'}
    result = {}
    for path in root.rglob('*.sqlite*'):
        name = path.name
        suffix = next((suffix for suffix in ('-wal', '-shm', '-journal') if name.endswith('.sqlite' + suffix)), '')
        if not suffix and not name.endswith('.sqlite'):
            continue
        relative = path.relative_to(root)
        base = relative.with_name(name[:-len(suffix)] if suffix else name)
        if base in ignored:
            continue
        require(len(result) < 10000, 'Retained static database inventory exceeded its bound.')
        before = path.lstat()
        if stat.S_ISLNK(before.st_mode):
            result[relative] = ('symlink', os.readlink(path))
        else:
            require(stat.S_ISREG(before.st_mode), 'Unexpected retained static database entry.')
            result[relative] = ('file', before.st_size, digest(path))
        after = path.lstat()
        identity = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        require(identity(before) == identity(after), 'An inactive database changed during retention verification.')
    return result


def native_schema(connection, relative):
    expected = 19 if relative.name in {'openclaw-agent.sqlite', 'incognito-openclaw-agent.sqlite'} else 15 if relative.name == 'openclaw.sqlite' else None
    require(expected is not None and connection.execute('pragma user_version').fetchone()[0] == expected, 'An unreviewed native database needs separate recovery qualification.')
    tables = {item[0] for item in connection.execute("select name from sqlite_schema where type='table' and name not like 'sqlite_%'")}
    require(tables <= NATIVE_KNOWN_TABLES, 'Native database coverage contains an unreviewed table.')
    return tables


def native_preflight(root, expected_epoch=None):
    selected, epoch, paths = native_scope(root, expected_epoch)
    for relative in sorted(paths):
        with contextlib.closing(database(root / relative, False)) as connection:
            native_schema(connection, relative)
    return selected, epoch, paths


def native_projected_rows(connection, table):
    names = [item[1] for item in connection.execute('pragma table_info("' + table + '")')]
    omitted = NATIVE_RECONNECT_COLUMNS[table]
    require(set(omitted) <= set(names), 'Reviewed native reconnect metadata changed its schema.')
    selected = [(index, name) for index, name in enumerate(names) if name not in omitted]
    result = Counter()
    for row, count in rows(connection, table).items():
        values = []
        for index, name in selected:
            value = row[index]
            if table == 'device_pairing_paired' and name == 'tokens_json' and value is not None:
                require(isinstance(value, str) and len(value) <= 1024 * 1024, 'Retained native token metadata exceeded its bound.')
                tokens = json.loads(value)
                require(isinstance(tokens, dict) and len(tokens) <= 64, 'Unexpected native role token metadata.')
                for role, token in tokens.items():
                    require(isinstance(token, dict) and token.get('role') == role and isinstance(token.get('token'), str), 'Unexpected native role token record.')
                    # Pinned device-pairing-tokens successful authentication changes
                    # only this direct last-use timestamp within a token entry.
                    # Issuer, bearer value, roles/scopes and unknown fields remain.
                    token.pop('lastUsedAtMs', None)
                value = json.dumps(tokens, sort_keys=True, separators=(',', ':'))
            values.append(value)
        result[tuple(values)] += count
    return result


def native_saved_state(snapshot, live, expected_epoch=None):
    before_selected, before_epoch, before_paths = native_scope(snapshot, expected_epoch)
    selected, epoch, paths = native_scope(live, before_epoch)
    require(before_selected == selected and before_epoch == epoch and before_paths == paths, 'The selected native database authority changed.')
    require(static_sqlite_files(snapshot, selected, paths) == static_sqlite_files(live, selected, paths), 'An inactive database, archived store or nonactive cache changed.')
    for relative in sorted(before_paths):
        with contextlib.closing(database(snapshot / relative, True)) as before, contextlib.closing(database(live / relative, False)) as after:
            require(before.execute('pragma quick_check').fetchone()[0] == after.execute('pragma quick_check').fetchone()[0] == 'ok', 'Native saved database integrity failed.')
            old_tables = native_schema(before, relative)
            require(old_tables == native_schema(after, relative), 'An unchanged native database changed its schema.')
            schema = lambda connection: Counter(connection.execute("select type,name,tbl_name,sql from sqlite_schema where name not like 'sqlite_%'"))
            require(schema(before) == schema(after), 'An unchanged native database changed its schema definitions.')
            for table in old_tables:
                require(re.fullmatch(r'[a-zA-Z0-9_]+', table), 'Unexpected native table name.')
                require(list(before.execute('pragma table_info("' + table + '")')) == list(after.execute('pragma table_info("' + table + '")')), 'An unchanged native table changed its columns.')
                if table in NATIVE_RETAINED_TABLES:
                    require(rows(before, table) <= rows(after, table), 'Retained native work, history, configuration or permissions changed.')
                elif table in NATIVE_RECONNECT_COLUMNS:
                    require(native_projected_rows(before, table) <= native_projected_rows(after, table), 'Retained native identity, account content or permissions changed.')
