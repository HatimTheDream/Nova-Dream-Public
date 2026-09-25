"""Closed snapshots and independent same-schema restoration for reviewed updates.

Derived from the previously reviewed hosted recovery approach. No function runs
on import. Recovery files are never used as the future live tree through links.
"""
import contextlib
from collections import Counter
from datetime import datetime
import hashlib
import json
import math
import os
import pathlib
import re
import shutil
import signal
import sqlite3
import stat
import struct
import subprocess
import tempfile
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
NATIVE_96_RETAINED_TABLES = frozenset('''
    cron_run_trigger_state_retirements github_publication_session_lifecycles github_repository_publication_requests
    local_workspace_projections node_worker_launch_cleanup node_worker_prepared_workspaces
    operator_approval_standing_grant_generations session_repository_workspaces worktree_templates
    session_input_completions session_transcript_cold_archives worker_environment_session_attachments
'''.split())
NATIVE_96_DERIVED_TABLES = frozenset({'session_canonical_validation_pending', 'session_transcript_fts_rows'})
NATIVE_VERSIONS = {'2026.9.2': (19, 15), '2026.9.6': (23, 18)}

# Active embedded stores beneath the selected runtime only. Unknown database
# names remain byte-preserved static files; these schemas may not migrate here.
SQLX_MIGRATION_COLUMNS = 'version description installed_on success checksum execution_time'
EMBEDDED_DATABASES = {
    'receipts.sqlite': (2, {
        'identity': 'id host_id', 'outcomes': 'attempt_id bytes payload', 'receipts': 'attempt_id epoch payload',
    }),
    'goals_1.sqlite': (0, {
        '_sqlx_migrations': SQLX_MIGRATION_COLUMNS,
        'thread_goal_continuation_deferrals': 'thread_id',
        'thread_goals': 'thread_id goal_id objective status token_budget tokens_used time_used_seconds created_at_ms updated_at_ms',
    }),
    'logs_2.sqlite': (0, {
        '_sqlx_migrations': SQLX_MIGRATION_COLUMNS,
        'logs': 'id ts ts_nanos level target feedback_log_body module_path file line thread_id process_uuid estimated_bytes',
    }),
    'memories_1.sqlite': (0, {
        '_sqlx_migrations': SQLX_MIGRATION_COLUMNS,
        'jobs': 'kind job_key status worker_id ownership_token started_at finished_at lease_until retry_at retry_remaining last_error input_watermark last_success_watermark',
        'stage1_outputs': 'thread_id source_updated_at raw_memory rollout_summary rollout_slug generated_at usage_count last_usage selected_for_phase2 selected_for_phase2_source_updated_at',
    }),
    'queue_1.sqlite': (0, {
        '_sqlx_migrations': SQLX_MIGRATION_COLUMNS,
        'queued_items': 'id thread_id payload_json queue_order created_at_ms updated_at_ms',
        'queued_thread_revisions': 'revision thread_id',
    }),
    'state_5.sqlite': (0, {
        '_sqlx_migrations': SQLX_MIGRATION_COLUMNS,
        'backfill_state': 'id status last_watermark last_success_at updated_at',
        'external_agent_config_imports': 'import_id completed_at_ms successes failures provider_id',
        'project_idempotency_keys': 'key project_id created_at_ms',
        'project_roots': 'project_id position path',
        'projects': 'id name metadata position created_at_ms updated_at_ms',
        'remote_control_enrollments': 'websocket_url account_id app_server_client_name server_id environment_id server_name updated_at remote_control_enabled',
        'rollout_migration_skipped_rollouts': 'migration_id rollout_path rollout_size_bytes rollout_modified_at_ns skip_reason skipped_at',
        'rollout_migration_state': 'migration_id last_checked_thread_created_at last_checked_thread_id updated_at',
        'thread_artifacts': 'id thread_id artifact_type identity_key payload created_at',
        'thread_dynamic_tools': 'thread_id position name description input_schema defer_loading namespace',
        'thread_sections': 'id name appearance',
        'thread_spawn_edges': 'parent_thread_id child_thread_id status',
        'threads': 'id rollout_path created_at updated_at source model_provider cwd title sandbox_policy approval_mode tokens_used has_user_event archived archived_at git_sha git_branch git_origin_url cli_version first_user_message agent_nickname agent_role memory_mode model reasoning_effort agent_path created_at_ms updated_at_ms thread_source preview recency_at recency_at_ms history_mode name is_pinned thread_section_id section_position section_entered_at_ms project_id',
    }),
}
EMBEDDED_DATABASES_96 = {name: (version, dict(tables)) for name, (version, tables) in EMBEDDED_DATABASES.items()}
EMBEDDED_DATABASES_96['memories_1.sqlite'][1]['consolidation_progress'] = 'singleton max_thread_count'
EMBEDDED_DATABASES_96['state_5.sqlite'][1].pop('thread_artifacts')
EMBEDDED_DATABASES_96['state_5.sqlite'][1]['thread_attachments'] = 'id thread_id attachment_type identity_key payload created_at'
EMBEDDED_DATABASES_96['state_5.sqlite'][1]['threads'] += ' originator daybreak_enabled'
# Exact SQLx migrations from openai/codex rust-v0.155.1, codex-rs/state/
# migrations/{0053,0054,0055}_*.sql and memory_migrations/0002_*.sql.
CODEX_SQL_MIGRATIONS = {
    'memories_1.sqlite': [(2, 'consolidation progress', '18f0a8dd7fe9a847b30d719029066d7a78e0bc64310dc66e4f7708bad6f1a0a594c0dbd14fec1ccb410cd7ae75dd7b10',
        'CREATE TABLE consolidation_progress (\n    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),\n    max_thread_count INTEGER NOT NULL DEFAULT 0\n);\nINSERT INTO consolidation_progress (singleton) VALUES (1);')],
    'state_5.sqlite': [
        (53, 'threads originator', 'e86ef7ccbcc891b1af27f6aedb26bfe36d79c9d405e48f302eb053cb57ff9b24dbeb0479b48b18e2076efb6bfc4a9287', 'ALTER TABLE threads ADD COLUMN originator TEXT;'),
        (54, 'threads daybreak enabled', 'e62a9977d99c7eabf36b67b183d86443d062b0aa8d018c42d1299821de4bf59182e16494ab874fd2d4081ef510e759f1', 'ALTER TABLE threads ADD COLUMN daybreak_enabled BOOLEAN;'),
        (55, 'thread attachments', '6daadc5527b3f57fa360c5d93199282ba54a42b7598558a9765bd6dcf11f555150fe678ed8163abb2e1861cb51d196c3',
         'ALTER TABLE thread_artifacts RENAME TO thread_attachments;\nALTER TABLE thread_attachments RENAME COLUMN artifact_type TO attachment_type;\nDROP INDEX idx_thread_artifacts_thread_created_id;\nCREATE INDEX idx_thread_attachments_thread_created_id\n    ON thread_attachments(thread_id, created_at, id);'),
    ],
}


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


def sqlite_file_identity(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and not path.is_symlink(), 'Expected an ordinary retained SQLite file.')
    identity = lambda value: (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid,
                              value.st_nlink, value.st_size, value.st_mtime_ns,
                              value.st_ctime_ns if os.name != 'nt' else 0)
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(descriptor, 'rb') as source:
        require(identity(os.fstat(source.fileno())) == identity(info), 'Retained SQLite file identity changed.')
        sha256 = hashlib.file_digest(source, 'sha256').hexdigest()
        require(identity(os.fstat(source.fileno())) == identity(info), 'Retained SQLite file changed while being read.')
    require(identity(path.lstat()) == identity(info), 'Retained SQLite file identity changed.')
    return identity(info), sha256


def sqlite_source_identity(path):
    result = {}
    for suffix in ('', '-wal', '-shm', '-journal'):
        source = pathlib.Path(str(path) + suffix)
        if source.exists() or source.is_symlink():
            result[suffix] = sqlite_file_identity(source)
    require('' in result, 'Expected an ordinary workspace database.')
    return result


def sqlite_wal_checksum(data, byteorder, initial=(0, 0)):
    first, second = initial
    for left, right in struct.iter_unpack(byteorder + 'II', data):
        first = (first + left + second) & 0xffffffff
        second = (second + right + first) & 0xffffffff
    return first, second


def verify_sqlite_wal(path):
    """Reject truncated/corrupt committed WAL instead of silently ignoring it.

    SQLite file format sections 4.1-4.4 define these cumulative checksums.
    A valid retained WAL-index binds the committed prefix when reset WALs also
    contain obsolete frames. Without it, require complete current-salt frames.
    """
    wal = pathlib.Path(str(path) + '-wal')
    if not wal.exists() or not wal.stat().st_size:
        return
    with wal.open('rb') as source:
        header = source.read(32)
        require(len(header) == 32, 'Retained SQLite WAL header is invalid.')
        magic, version, page_size, _, salt1, salt2, check1, check2 = struct.unpack('>8I', header)
        require(magic in {0x377f0682, 0x377f0683} and version == 3007000
                and 512 <= page_size <= 65536 and page_size & (page_size - 1) == 0,
                'Retained SQLite WAL header is invalid.')
        byteorder = '>' if magic == 0x377f0683 else '<'
        checksum = sqlite_wal_checksum(header[:24], byteorder)
        require(checksum == (check1, check2), 'Retained SQLite WAL header checksum failed.')
        size = wal.stat().st_size - 32
        require(size % (24 + page_size) == 0, 'Retained SQLite WAL contains a truncated frame.')
        frames = size // (24 + page_size)
        committed, end_checksum = None, None
        shm = pathlib.Path(str(path) + '-shm')
        if shm.exists() and shm.stat().st_size:
            with shm.open('rb') as index:
                indexes = index.read(96)
            require(len(indexes) == 96 and indexes[:48] == indexes[48:96], 'Retained SQLite WAL index headers differ.')
            index = indexes[:48]
            values = struct.unpack('=12I', index)
            require(values[0] == 3007000 and index[12] == 1
                    and index[13] == (magic & 1)
                    and sqlite_wal_checksum(index[:40], '=') == values[10:12]
                    and index[32:40] == header[16:24], 'Retained SQLite WAL index identity failed.')
            committed, end_checksum = values[4], values[6:8]
            require(0 <= committed <= frames, 'Retained SQLite WAL lost committed frames.')
        limit = frames if committed is None else committed
        final_commit = 0
        for number in range(1, limit + 1):
            frame_header, page = source.read(24), source.read(page_size)
            page_number, database_size, frame_salt1, frame_salt2, first, second = struct.unpack('>6I', frame_header)
            require(page_number > 0 and (frame_salt1, frame_salt2) == (salt1, salt2), 'Retained SQLite WAL frame identity failed.')
            checksum = sqlite_wal_checksum(page, byteorder, sqlite_wal_checksum(frame_header[:8], byteorder, checksum))
            require(checksum == (first, second), 'Retained SQLite WAL frame checksum failed.')
            if database_size:
                final_commit = number
        require(final_commit == limit, 'Retained SQLite WAL has an uncommitted tail.')
        if end_checksum is not None and limit:
            require(checksum == end_checksum, 'Retained SQLite WAL committed index differs.')


class CopiedDatabase:
    """Read closed DB/WAL bytes without SQLite touching retained evidence."""
    def __init__(self, path):
        self.source_path = path
        self.source_identity = sqlite_source_identity(path)
        self.temporary = tempfile.TemporaryDirectory(prefix='nova-update-sqlite-read-')
        self.database_path = pathlib.Path(self.temporary.name) / path.name
        self.connection = None
        try:
            require(shutil.disk_usage(self.temporary.name).free >= sum(value[0][6] for value in self.source_identity.values()) + RESERVE + ALLOWANCE,
                    'Private SQLite verification copies and recovery reserve no longer fit.')
            for suffix, expected in self.source_identity.items():
                source_path = pathlib.Path(str(path) + suffix)
                destination = pathlib.Path(str(self.database_path) + suffix)
                descriptor = os.open(source_path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
                with os.fdopen(descriptor, 'rb') as source, destination.open('xb') as output:
                    shutil.copyfileobj(source, output, 1024 * 1024)
                destination.chmod(0o600)
                require(digest(destination) == expected[1], 'Copied SQLite evidence bytes differ.')
            require(sqlite_source_identity(path) == self.source_identity, 'Retained SQLite evidence changed during copying.')
            verify_sqlite_wal(self.database_path)
            # immutable=1 ignores WAL. Normal read-only SQLite may rebuild SHM,
            # but it may do so only inside this private disposable copy.
            self.connection = sqlite3.connect(self.database_path.as_uri() + '?mode=ro', uri=True)
            self.connection.execute('pragma query_only=ON')
            self.connection.execute('begin')
        except BaseException:
            if self.connection is not None:
                self.connection.close()
            self.temporary.cleanup()
            raise

    def __getattr__(self, name):
        return getattr(self.connection, name)

    def close(self):
        if self.connection is None:
            return
        try:
            self.connection.close()
            self.connection = None
            require(sqlite_source_identity(self.source_path) == self.source_identity, 'Retained SQLite evidence changed during verification.')
        finally:
            self.temporary.cleanup()


def database(path, closed):
    require(path.is_file() and not path.is_symlink(), 'Expected an ordinary workspace database.')
    if closed:
        return CopiedDatabase(path)
    connection = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
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


def selected_workspace(root, expected_epoch=None, closed=False):
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
    with contextlib.closing(database(selected / 'workspace.sqlite', closed)) as connection:
        require(connection.execute('pragma user_version').fetchone()[0] == 55, 'The selected workspace schema changed.')
        row = connection.execute("select value from meta where key='epoch'").fetchone()
        require(row is not None and isinstance(row[0], str) and str(uuid.UUID(row[0])) == row[0]
                and (expected_epoch is None or row[0] == expected_epoch), 'The selected workspace does not match authenticated acceptance.')
    return selected, row[0]


def native_scope(root, expected_epoch=None, closed=False):
    selected, epoch = selected_workspace(root, expected_epoch, closed)
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


def embedded_database_paths(root, selected, active):
    native = selected / 'openclaw-runtime'
    candidates = {native / 'assignment-receipts' / 'receipts.sqlite'}
    for relative in active:
        if relative.name in {'openclaw-agent.sqlite', 'incognito-openclaw-agent.sqlite'}:
            candidates.update(relative.parent / 'codex-home' / name for name in EMBEDDED_DATABASES if name != 'receipts.sqlite')
    found = set()
    for relative in candidates:
        path = root / relative
        if path.exists() or path.is_symlink():
            require(path.is_file() and path.resolve(strict=True) == path, 'An active embedded database was redirected.')
            for suffix in ('-wal', '-shm', '-journal'):
                sidecar = pathlib.Path(str(path) + suffix)
                if sidecar.exists() or sidecar.is_symlink():
                    require(sidecar.is_file() and sidecar.resolve(strict=True) == sidecar, 'An active embedded database sidecar was redirected.')
            found.add(relative)
    return found


def embedded_schema(connection, name, engine_version='2026.9.2'):
    require(engine_version in NATIVE_VERSIONS and name in EMBEDDED_DATABASES, 'An embedded database has no reviewed schema.')
    version, expected = EMBEDDED_DATABASES[name]
    require(connection.execute('pragma quick_check').fetchone()[0] == 'ok', 'Embedded database integrity failed.')
    require(connection.execute('pragma user_version').fetchone()[0] == version, 'An embedded database changed its reviewed version.')
    tables = {row[0] for row in connection.execute("select name from sqlite_schema where type='table' and name not like 'sqlite_%'")}
    # Codex initializes a dormant home on first use. The reviewed engine may
    # therefore retain its old complete schema until that bounded migration.
    if engine_version == '2026.9.6' and tables != expected.keys():
        version, expected = EMBEDDED_DATABASES_96[name]
    require(tables == expected.keys(), 'An embedded database contains an unreviewed table set.')
    for table, columns in expected.items():
        require([row[1] for row in connection.execute('pragma table_xinfo("' + table + '")')] == columns.split(), 'An embedded database contains unreviewed columns.')
    return tables


def migrated_embedded_database(before, after, name):
    """Qualify only the four official Codex0.153.4 -> 0.155.1 migrations."""
    migrations = CODEX_SQL_MIGRATIONS[name]
    definitions = lambda db: Counter(db.execute("select type,name,tbl_name,sql from sqlite_schema where name not like 'sqlite_%'"))
    with contextlib.closing(sqlite3.connect(':memory:')) as expected:
        for kind in ('table', 'index', 'trigger', 'view'):
            for (sql,) in before.execute("select sql from sqlite_schema where type=? and sql is not null and name not like 'sqlite_%'", (kind,)):
                expected.execute(sql)
        for _, _, _, sql in migrations:
            expected.executescript(sql)
        require(definitions(expected) == definitions(after), 'An embedded migration changed unreviewed schema definitions.')
    previous, current = rows(before, '_sqlx_migrations'), rows(after, '_sqlx_migrations')
    added = current - previous
    require(previous <= current and sum(added.values()) == len(migrations), 'Retained embedded migration history changed.')
    expected_migrations = {(version, description, checksum) for version, description, checksum, _ in migrations}
    observed = set()
    for row, count in added.items():
        version, description, installed, success, checksum, duration = row
        require(count == 1 and type(version) is int and isinstance(checksum, bytes) and len(checksum) == 48
                and success == 1 and isinstance(installed, str) and 0 < len(installed) <= 128
                and type(duration) is int and duration >= 0, 'An embedded migration receipt is invalid.')
        observed.add((version, description, checksum.hex()))
    require(observed == expected_migrations, 'An embedded migration is outside the reviewed Codex pair.')
    if name == 'memories_1.sqlite':
        require(rows(after, 'consolidation_progress') == Counter({(1, 0): 1}), 'New embedded consolidation state is not the migration default.')
    else:
        require(after.execute('select 1 from threads where originator is not null or daybreak_enabled is not null limit 1').fetchone() is None,
                'New embedded thread fields are not the migration defaults.')
    for table, columns in EMBEDDED_DATABASES[name][1].items():
        if table == '_sqlx_migrations':
            continue
        target = 'thread_attachments' if table == 'thread_artifacts' else table
        selected = [column.replace('artifact_type', 'attachment_type') if table == 'thread_artifacts' else column for column in columns.split()]
        current = Counter(after.execute('select ' + ','.join('"' + column + '"' for column in selected) + ' from "' + target + '"'))
        require(rows(before, table) == current, 'Retained embedded work or attachment bytes changed during migration.')


def retained_embedded_databases(snapshot, live, selected, active, from_version='2026.9.2', to_version=None):
    to_version = to_version or from_version
    require(from_version == to_version or (from_version, to_version) == ('2026.9.2', '2026.9.6'), 'Unreviewed embedded runtime migration.')
    paths = embedded_database_paths(snapshot, selected, active)
    require(paths == embedded_database_paths(live, selected, active), 'The active embedded database set changed.')
    for relative in sorted(paths):
        with contextlib.closing(database(snapshot / relative, True)) as before, contextlib.closing(database(live / relative, False)) as after:
            tables = embedded_schema(before, relative.name, from_version)
            newer = embedded_schema(after, relative.name, to_version)
            if from_version != to_version and tables != newer and relative.name in CODEX_SQL_MIGRATIONS:
                migrated_embedded_database(before, after, relative.name)
                continue
            require(tables == newer, 'An embedded database changed its tables.')
            definitions = lambda connection: Counter(connection.execute("select type,name,tbl_name,sql from sqlite_schema where name not like 'sqlite_%'"))
            require(definitions(before) == definitions(after), 'An embedded database changed its schema definitions.')
            for table in tables:
                require(list(before.execute('pragma table_xinfo("' + table + '")')) == list(after.execute('pragma table_xinfo("' + table + '")')), 'An embedded database changed its column definitions.')
                old, new = rows(before, table), rows(after, table)
                append_only = relative.name == 'logs_2.sqlite' and table == 'logs'
                require(old <= new if append_only else old == new, 'Retained embedded work, receipts, history or configuration changed.')
    return paths


def retained_quarantine_cache(snapshot, live, selected, active, from_version, to_version):
    relative = selected / 'openclaw-runtime' / 'state' / 'state' / 'openclaw-quarantine.sqlite'
    old_path, new_path = snapshot / relative, live / relative
    if to_version != '2026.9.6' or not (old_path.exists() or new_path.exists()):
        return set()
    require(new_path.is_file() and new_path.resolve(strict=True) == new_path, 'Native quarantine cache disappeared or was redirected.')
    expected = {
        'quarantined_databases': 'CREATE TABLE quarantined_databases ( path TEXT NOT NULL PRIMARY KEY, kind TEXT NOT NULL, reason TEXT NOT NULL, quarantined_at INTEGER NOT NULL, writer_app_version TEXT, verified_generation TEXT ) STRICT',
        'agent_integrity_verifications': 'CREATE TABLE agent_integrity_verifications ( path TEXT NOT NULL PRIMARY KEY, dev TEXT NOT NULL, ino TEXT NOT NULL, app_version TEXT NOT NULL, verified_at INTEGER NOT NULL, clean_close INTEGER NOT NULL CHECK (clean_close IN (0, 1)) ) STRICT',
    }
    decisions = []
    allowed_paths = {str(live / path) for path in active if path.name != 'openclaw.sqlite'}
    for path, closed in ((old_path, True), (new_path, False)):
        if not path.exists():
            require(closed and from_version == '2026.9.2', 'A native quarantine cache is missing outside the reviewed transition.')
            decisions.append(Counter()); continue
        require(path.is_file() and path.resolve(strict=True) == path, 'Native quarantine cache was redirected.')
        with contextlib.closing(database(path, closed)) as connection:
            require(connection.execute('pragma user_version').fetchone()[0] == 2
                    and connection.execute('pragma quick_check').fetchone()[0] == 'ok', 'Native quarantine cache integrity or version changed.')
            schema = {name: re.sub(r'\s+', ' ', sql).strip() for kind, name, sql in connection.execute("select type,name,sql from sqlite_schema where name not like 'sqlite_%'") if kind == 'table'}
            require(schema == expected and connection.execute("select 1 from sqlite_schema where type!='table' and name not like 'sqlite_%' limit 1").fetchone() is None,
                    'Native quarantine cache contains an unreviewed schema.')
            decisions.append(rows(connection, 'quarantined_databases'))
            cache = rows(connection, 'agent_integrity_verifications')
            require(sum(cache.values()) <= 100, 'Native integrity cache exceeded its bound.')
            for row in cache:
                pathname, device, inode, version, checked_at, clean = row
                require(pathname in allowed_paths and all(isinstance(value, str) and re.fullmatch('[0-9]+', value) for value in (device, inode))
                        and version in {from_version, to_version} and type(checked_at) is int and 0 <= checked_at <= 9007199254740991
                        and type(clean) is int and clean in (0, 1), 'Native integrity cache contains an unreviewed record.')
    require(decisions[0] == decisions[1], 'Native quarantine decisions changed during the update.')
    return {relative}


WORKER_ATTACHMENTS_SCHEMA = '''CREATE TABLE worker_environment_session_attachments (
session_id TEXT PRIMARY KEY, session_key TEXT NOT NULL, agent_id TEXT NOT NULL,
session_lifecycle_revision TEXT, environment_id TEXT NOT NULL UNIQUE,
generation INTEGER NOT NULL CHECK (generation >= 1), created_at_ms INTEGER NOT NULL,
last_used_at_ms INTEGER NOT NULL, closed_at_ms INTEGER,
FOREIGN KEY (environment_id) REFERENCES worker_environments(environment_id) ON DELETE CASCADE
) STRICT'''


def native_schema(connection, relative, version='2026.9.2', prior_tables=None):
    require(version in NATIVE_VERSIONS, 'The native version has no reviewed data contract.')
    agent, shared = NATIVE_VERSIONS[version]
    expected = agent if relative.name in {'openclaw-agent.sqlite', 'incognito-openclaw-agent.sqlite'} else shared if relative.name == 'openclaw.sqlite' else None
    require(expected is not None and connection.execute('pragma user_version').fetchone()[0] == expected, 'An unreviewed native database needs separate recovery qualification.')
    tables = {item[0] for item in connection.execute("select name from sqlite_schema where type='table' and name not like 'sqlite_%'")}
    attachment = 'worker_environment_session_attachments'
    if version == '2026.9.6' and attachment in tables:
        # The pinned worker store creates this lazy companion table at startup.
        # Existing 9.6 attachments are retained by the normal row comparison.
        sql = connection.execute('select sql from sqlite_schema where type=\'table\' and name=?', (attachment,)).fetchone()[0]
        compact = lambda value: re.sub(r'\s+', '', value)
        require(compact(sql) == compact(WORKER_ATTACHMENTS_SCHEMA),
                'Native worker attachments need separate recovery qualification.')
        if prior_tables is not None and attachment not in prior_tables:
            require(connection.execute('select 1 from worker_environment_session_attachments limit 1').fetchone() is None,
                    'Native worker attachments need separate recovery qualification.')
    known = NATIVE_KNOWN_TABLES | (NATIVE_96_RETAINED_TABLES | NATIVE_96_DERIVED_TABLES if version == '2026.9.6' else set())
    require(tables <= known, 'Native database coverage contains an unreviewed table.')
    return tables


def native_preflight(root, expected_epoch=None, version='2026.9.2', target_version=None):
    selected, epoch, paths = native_scope(root, expected_epoch)
    for relative in sorted(embedded_database_paths(root, selected, paths)):
        with contextlib.closing(database(root / relative, False)) as connection:
            embedded_schema(connection, relative.name, version)
    for relative in sorted(paths):
        with contextlib.closing(database(root / relative, False)) as connection:
            tables = native_schema(connection, relative, version)
            if target_version is not None and target_version != version:
                require((version, target_version) == ('2026.9.2', '2026.9.6'), 'Native migration is outside the reviewed pair.')
                migration_preflight(connection, tables)
    return selected, epoch, paths


def retained_app_plugin_paths(configurations, app_releases):
    """Qualify Nova's generated plugin relocation using candidate-verified roots
    and manifests supplied by the driver. Unrelated load paths stay exact.
    """
    plugins = {'edition3-accounts': 'account-plugin', 'edition3-sources': 'source-plugin',
               'edition3-worker': 'worker-plugin', 'edition3-workspace': 'module-plugin'}
    require(isinstance(app_releases, (tuple, list)) and len(app_releases) == 2,
            'Plugin relocation requires both verified application releases.')
    for plugin_id, directory in plugins.items():
        entries = [value.get('plugins', {}).get('entries', {}).get(plugin_id, {}) for value in configurations]
        paths = [entry.get('config', {}).get('bundlePath') for entry in entries]
        if paths[0] == paths[1]:
            continue
        relative = pathlib.Path('dist/service/apps/service') / directory
        for index, ((root, manifest), path, entry) in enumerate(zip(app_releases, paths, entries)):
            root = pathlib.Path(root)
            expected_path = root / relative
            require(root.resolve(strict=True) == root and path == str(expected_path)
                    and entry.get('enabled') is True and expected_path.resolve(strict=True) == expected_path,
                    'Native plugin path is outside its verified application release.')
            prefix = relative.as_posix() + '/'
            expected = {item['path']: item['sha256'] for item in manifest['artifacts'] if item['path'].startswith(prefix)}
            require(expected and len(expected) <= 1000, 'The verified candidate lacks its generated plugin artifacts.')
            actual = {}
            for file in expected_path.rglob('*'):
                require(not file.is_symlink() and (file.is_file() or file.is_dir()), 'A generated plugin artifact was redirected.')
                if file.is_file():
                    actual[file.relative_to(root).as_posix()] = digest(file)
            require(actual == expected, 'Generated plugin bytes differ from the verified candidate artifacts.')
            load = configurations[index]['plugins'].get('load', {}).get('paths')
            require(isinstance(load, list) and load.count(path) == 1, 'The generated plugin load path is not uniquely retained.')
            marker = '<verified-app-plugin:' + plugin_id + '>'
            load[load.index(path)] = marker
            entry['config']['bundlePath'] = marker


def native_runtime_configuration(snapshot, live, selected, from_version='2026.9.2', to_version=None, app_releases=None):
    relative = selected / 'openclaw-runtime' / 'openclaw.json'
    paths = (snapshot / relative, live / relative)
    if not any(path.exists() or path.is_symlink() for path in paths):
        return None
    normalized, hashes, byte_sizes = [], [], []
    for path in paths:
        require(path.resolve(strict=True) == path, 'The selected native configuration was redirected.')
        value = bounded_json(path, 4 * 1024 * 1024)
        require(isinstance(value, dict), 'Unexpected selected native configuration.')
        hashes.append(digest(path))
        byte_sizes.append(path.stat().st_size)
        # Nova owns this per-process proxy port and module admission token. Keep
        # every other safety argument, endpoint, credential and setting exact.
        arguments = value.get('browser', {}).get('extraArgs')
        if isinstance(arguments, list):
            for index, argument in enumerate(arguments):
                match = re.fullmatch(r'--proxy-server=http://127\.0\.0\.1:([0-9]{1,5})', argument) if isinstance(argument, str) else None
                if match and 0 < int(match[1]) <= 65535:
                    arguments[index] = '--proxy-server=http://127.0.0.1:<owned-port>'
        bridge = value.get('plugins', {}).get('entries', {}).get('edition3-workspace', {}).get('config', {})
        if isinstance(bridge, dict) and isinstance(bridge.get('token'), str) and re.fullmatch(r'[a-f0-9]{64}', bridge['token']):
            bridge['token'] = '<owned-module-token>'
        if (from_version, to_version) == ('2026.9.2', '2026.9.6'):
            # The official configuration writer records these two completed
            # migrations and removes the implicit empty main-agent entry.
            # Actual model policy, permissions and all other settings remain
            # in the exact comparison below.
            meta = value.get('meta', {})
            if isinstance(meta, dict):
                expected_version = from_version if not normalized else to_version
                if 'lastTouchedVersion' in meta:
                    require(meta['lastTouchedVersion'] == expected_version, 'Native configuration has an unreviewed writer version.')
                    del meta['lastTouchedVersion']
                if 'lastTouchedAt' in meta:
                    require(isinstance(meta['lastTouchedAt'], str) and re.fullmatch(r'[0-9]{4}-[0-9TZ:.+-]+', meta['lastTouchedAt']), 'Native configuration writer timestamp changed type.')
                    del meta['lastTouchedAt']
                migrations = meta.get('migrations', {})
                if isinstance(migrations, dict):
                    for name in ('modelPolicyAllowlist', 'utilityModelSeparation'):
                        if name in migrations:
                            require(migrations[name] is True, 'Native configuration migration marker is not complete.')
                            del migrations[name]
                    if not migrations:
                        meta.pop('migrations', None)
                if not meta:
                    value.pop('meta', None)
            agents = value.get('agents', {})
            if isinstance(agents, dict) and isinstance(agents.get('entries'), dict):
                if agents['entries'].get('main') == {}:
                    del agents['entries']['main']
                if not agents['entries']:
                    del agents['entries']
                if not agents:
                    value.pop('agents', None)
        normalized.append(value)
    if app_releases is not None:
        retained_app_plugin_paths(normalized, app_releases)
    require(normalized[0] == normalized[1], 'Retained native configuration or account settings changed.')
    return {'path': str(paths[1]), 'hashes': hashes, 'byteSizes': byte_sizes}


SESSION_TITLES = r'''
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const [path,dist]=process.argv.slice(1), sessions=JSON.parse(readFileSync(0,'utf8'));
const {t:derive}=await import(pathToFileURL(dist+'/derive-goal-session-title-DILXsIfr.mjs'));
const {n:project}=await import(pathToFileURL(dist+'/session-display-projection-bZOY074i.mjs'));
const {i:message}=await import(pathToFileURL(dist+'/session-transcript-entry-message-COJ0koI7.mjs'));
const {c:interSession}=await import(pathToFileURL(dist+'/input-provenance-C4tQegGN.mjs'));
const db=new DatabaseSync(path,{readOnly:true});
try {
 const query=db.prepare('SELECT a.event_seq,a.message_position,e.event_json FROM session_transcript_active_events a JOIN transcript_events e ON e.session_id=a.session_id AND e.seq=a.event_seq WHERE a.session_id=? AND a.message_position IS NOT NULL ORDER BY a.message_position LIMIT 100');
 const result={};
 for(const session of sessions){
  const rows=query.all(session);
  if(rows.some((row,index)=>row.message_position!==index||typeof row.event_json!=='string')||rows.reduce((total,row)=>total+Buffer.byteLength(row.event_json),0)>65536)throw Error('Unsupported title transcript window');
  for(const row of rows){
   const value=message({event:JSON.parse(row.event_json),seq:row.event_seq,displayPosition:row.message_position}),shown=project(value);
   if(shown?.role==='user'&&!interSession(value)){result[session]=derive(shown.text)??null;break;}
  }
 }
 process.stdout.write(JSON.stringify(result));
} finally {db.close();}
'''


def derived_session_titles(before, session_ids, node):
    require(node is not None and len(session_ids) <= 1000, 'Native title repair needs its reviewed runtime and bounded sessions.')
    executable = pathlib.Path(node)
    require(executable.name == 'node' and executable.parent.name == 'bin' and executable.parent.parent.name == 'node',
            'Unreviewed native title repair runtime layout.')
    package = executable.parent.parent.parent / 'node_modules' / 'openclaw'
    require(bounded_json(package / 'package.json', 1024 * 1024).get('version') == '2026.9.6', 'Native title repair runtime version changed.')
    result = subprocess.check_output([str(node), '--input-type=module', '-e', SESSION_TITLES, str(before.database_path), str(package / 'dist')],
                                     input=json.dumps(session_ids).encode(), stderr=subprocess.DEVNULL, timeout=30)
    require(len(result) <= 1024 * 1024, 'Native title repair proof exceeded its bound.')
    value = json.loads(result)
    require(isinstance(value, dict) and set(value) <= set(session_ids), 'Native title repair returned unknown sessions.')
    return value


def native_title_replacements(before, after, tables, node):
    if not {'session_nodes', 'session_windows'} <= tables:
        return {}
    def records(connection, table, key):
        names = [item[1] for item in connection.execute('pragma table_info("' + table + '")')]
        return {row[names.index(key)]: dict(zip(names, row)) for row in rows(connection, table)}
    old = records(before, 'session_nodes', 'session_key')
    new = records(after, 'session_nodes', 'session_key')
    changes = []
    for key, previous in old.items():
        current = new.get(key)
        if current is None or previous.get('display_name') == current.get('display_name'):
            continue
        prior_entry, entry = json.loads(previous['entry_json']), json.loads(current['entry_json'])
        require(previous.get('display_name') is None and isinstance(current.get('display_name'), str)
                and previous.get('status') != 'running' and prior_entry.get('status') != 'running'
                and not prior_entry.get('incognito') and ':incognito:' not in key
                and not any(isinstance(prior_entry.get(name), str) and prior_entry[name].strip() for name in ('label', 'displayName', 'subject', 'groupChannel', 'space')),
                'Native title repair would replace an explicit name or active session.')
        require('displayName' not in prior_entry and entry.get('displayName') == current['display_name']
                and {name: value for name, value in entry.items() if name != 'displayName'} == prior_entry
                and current['current_session_id'] == previous['current_session_id'], 'Native title repair changed retained session content.')
        changes.append((key, previous, current))
    if not changes:
        return {}
    titles = derived_session_titles(before, [old['current_session_id'] for _, old, _ in changes], node)
    old_windows, new_windows = records(before, 'session_windows', 'session_id'), records(after, 'session_windows', 'session_id')
    result = {}
    for key, previous, current in changes:
        session_id = previous['current_session_id']
        require(titles.get(session_id) == current['display_name'], 'Native title repair does not match retained transcript derivation.')
        result[('session_nodes', key)] = {'display_name': previous['display_name'], 'entry_json': previous['entry_json']}
        require(session_id in old_windows and session_id in new_windows
                and old_windows[session_id].get('display_name') is None
                and new_windows[session_id].get('display_name') == current['display_name'], 'Native title window differs from its retained session.')
        result[('session_windows', session_id)] = {'display_name': None}
    return result


def native_boot_replacements(before, after, tables, configuration, from_version, to_version, node):
    """Qualify only the two startup fingerprints and the selected config cache.
    Return after-side field replacements; all other row fields stay exact.
    """
    result = native_title_replacements(before, after, tables, node) if (from_version, to_version) == ('2026.9.2', '2026.9.6') else {}
    for table, key in (('schema_meta', 'meta_key'), ('config_health_entries', 'config_path')):
        if table not in tables:
            continue
        names = [item[1] for item in before.execute('pragma table_info("' + table + '")')]
        newer_names = [item[1] for item in after.execute('pragma table_info("' + table + '")')]
        old = {dict(zip(names, row))[key]: dict(zip(names, row)) for row in rows(before, table)}
        for row in rows(after, table):
            value = dict(zip(newer_names, row)); previous = old.get(value[key])
            if previous is None:
                continue
            replacements = {}
            if table == 'schema_meta' and value[key] in {'startup-migrations', 'state-migrations'} and value.get('app_version') != previous.get('app_version'):
                require(configuration is not None, 'Native startup fingerprint needs retained configuration proof.')
                parts = []
                for fingerprint in (previous.get('app_version'), value.get('app_version')):
                    require(isinstance(fingerprint, str) and len(fingerprint) <= 512, 'Unexpected native startup fingerprint.')
                    fields = fingerprint.split('\n')
                    require(len(fields) == 6 and fields[1] == '3'
                            and re.fullmatch(r'[0-9]{4}-[0-9TZ:.+-]+', fields[2])
                            and all(re.fullmatch(r'[a-zA-Z0-9_-]{43}', field) for field in fields[3:5])
                            and re.fullmatch(r'[a-f0-9]{64}', fields[5]), 'Unreviewed native startup fingerprint format.')
                    parts.append(fields)
                require(parts[0][0] == from_version, 'Saved native startup version changed.')
                if parts[1][:3] != parts[0][:3]:
                    require((from_version, to_version) == ('2026.9.2', '2026.9.6') and parts[1][0] == to_version and node is not None,
                            'Native startup version or build changed outside the reviewed pair.')
                    executable = pathlib.Path(node)
                    require(executable.name == 'node' and executable.parent.name == 'bin' and executable.parent.parent.name == 'node', 'Unreviewed native runtime closure layout.')
                    package = executable.parent.parent.parent / 'node_modules' / 'openclaw'
                    require(bounded_json(package / 'package.json', 1024 * 1024).get('version') == to_version
                            and bounded_json(package / 'dist' / 'build-info.json', 64 * 1024).get('builtAt') == parts[1][2],
                            'Native startup build differs from the verified runtime package.')
                replacements['app_version'] = previous['app_version']
            if table == 'config_health_entries' and configuration is not None and value[key] == configuration['path']:
                for field in ('last_known_good_json', 'last_promoted_good_json'):
                    if value.get(field) == previous.get(field):
                        continue
                    observations = []
                    for encoded, config_hash, config_bytes in zip((previous.get(field), value.get(field)), configuration['hashes'], configuration['byteSizes']):
                        require(isinstance(encoded, str) and len(encoded) <= 1024 * 1024, 'Unexpected native config observation.')
                        observation = json.loads(encoded)
                        require(isinstance(observation, dict) and observation.get('hash') == config_hash, 'Native config observation does not identify the retained configuration.')
                        require(type(observation.get('bytes')) is int and observation['bytes'] == config_bytes,
                                'Native config observation size does not match the retained configuration.')
                        require(all(type(observation.get(name)) in (int, float) and math.isfinite(observation[name]) and observation[name] >= 0 for name in ('ctimeMs', 'mtimeMs'))
                                and isinstance(observation.get('ino'), str) and re.fullmatch(r'[0-9]+', observation['ino'])
                                and isinstance(observation.get('observedAt'), str) and re.fullmatch(r'[0-9]{4}-[0-9TZ:.+-]+', observation['observedAt']),
                                'Native config observation types changed.')
                        for name in ('ctimeMs', 'ino', 'mtimeMs', 'observedAt', 'hash', 'bytes'):
                            require(name in observation, 'Native config observation format changed.')
                            observation.pop(name)
                        observations.append(observation)
                    require(observations[0] == observations[1], 'Retained native config observation content changed.')
                    replacements[field] = previous[field]
                if replacements:
                    replacements['updated_at_ms'] = previous['updated_at_ms']
            if replacements:
                result[(table, value[key])] = replacements
    return result


def native_boot_row(table, values, replacements):
    key = {'schema_meta': 'meta_key', 'config_health_entries': 'config_path', 'session_nodes': 'session_key', 'session_windows': 'session_id'}.get(table)
    return {**values, **replacements.get((table, values.get(key)), {})} if key else values


def native_boot_rows(connection, table, replacements):
    names = [item[1] for item in connection.execute('pragma table_info("' + table + '")')]
    result = Counter()
    for row, count in rows(connection, table).items():
        value = native_boot_row(table, dict(zip(names, row)), replacements)
        result[tuple(value[name] for name in names)] += count
    return result


def native_projected_rows(connection, table, replacements=None):
    names = [item[1] for item in connection.execute('pragma table_info("' + table + '")')]
    omitted = NATIVE_RECONNECT_COLUMNS[table]
    require(set(omitted) <= set(names), 'Reviewed native reconnect metadata changed its schema.')
    selected = [(index, name) for index, name in enumerate(names) if name not in omitted]
    result = Counter()
    for row, count in rows(connection, table).items():
        value = native_boot_row(table, dict(zip(names, row)), replacements or {})
        row = tuple(value[name] for name in names)
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


def migration_preflight(connection, tables):
    # Schema16 intentionally discards ambiguous workshop ownership and rewrites
    # released proposals. Do not authorize either loss through this update route.
    if 'skill_workshop_proposals' in tables:
        require(connection.execute('select 1 from skill_workshop_proposals where claim_released_time is not null limit 1').fetchone() is None,
                'Released native workshop work needs separate migration review.')
    if 'skill_workshop_collection_reviews' in tables:
        for (directory,) in connection.execute('select distinct workspace_dir from skill_workshop_collection_reviews'):
            owners = connection.execute('select distinct owner_agent_id from skill_workshop_proposals where workspace_dir=? and owner_agent_id is not null', (directory,)).fetchall()
            require(len(owners) == 1, 'Native workshop review ownership cannot migrate without losing saved work.')
    if 'memory_index_chunks' in tables:
        for (value,) in connection.execute('select embedding from memory_index_chunks'):
            embedding_bytes(value)


def embedding_bytes(value):
    if isinstance(value, bytes):
        require(len(value) % 8 == 0, 'Invalid migrated memory vector.')
        coordinates = struct.unpack('<' + 'd' * (len(value) // 8), value)
    else:
        require(isinstance(value, str) and len(value) <= 1024 * 1024, 'Native memory vector exceeded its bound.')
        coordinates = json.loads(value)
        require(isinstance(coordinates, list) and len(coordinates) <= 131072, 'Invalid retained memory vector.')
    require(all(type(item) in {int, float} and math.isfinite(item) for item in coordinates), 'Native memory vector cannot migrate losslessly.')
    return struct.pack('<' + 'd' * len(coordinates), *coordinates)


TRANSCRIPT_HASHES = r'''
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {zstdDecompressSync} from 'node:zlib';
const db=new DatabaseSync(process.argv[1],{readOnly:true});
try {
 const compressed=db.prepare('pragma table_info(transcript_events)').all().some(x=>x.name==='event_zstd');
 const statement=db.prepare('select rowid,session_id,seq,created_at,cast(event_json as blob) as payload'+(compressed?',event_zstd,event_utf8_bytes':'')+' from transcript_events');
 statement.setReadBigInts(true); const result=[];
 for(const row of statement.iterate()) {
  if(result.length>=1000000)throw Error('bound');
  let payload=row.payload;
  if(compressed && row.event_zstd!==null) {
   if(payload!==null||row.event_utf8_bytes<0n||row.event_utf8_bytes>4194304n)throw Error('encoding');
   payload=zstdDecompressSync(row.event_zstd,{maxOutputLength:4194304});
   if(BigInt(payload.length)!==row.event_utf8_bytes)throw Error('length');
  }
  if(!(payload instanceof Uint8Array))throw Error('payload');
  const identity=JSON.stringify([String(row.rowid),row.session_id,String(row.seq),String(row.created_at)]);
  result.push(createHash('sha256').update(identity).update('\0').update(payload).digest('hex'));
 }
 process.stdout.write(JSON.stringify(result));
} finally {db.close();}
'''


def transcript_hashes(path, node):
    require(node is not None, 'Reviewed transcript migration requires the verified agent Node runtime.')
    output = subprocess.check_output([str(node), '--input-type=module', '-e', TRANSCRIPT_HASHES, str(path)],
                                     stderr=subprocess.DEVNULL, timeout=120)
    require(len(output) <= 68 * 1024 ** 2, 'Retained transcript verification exceeded its bound.')
    hashes = json.loads(output)
    require(isinstance(hashes, list) and all(isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value) for value in hashes),
            'Unexpected retained transcript proof.')
    return Counter(hashes)


def retained_plugin_index(before, after, node, after_path):
    """Permit the pinned official npm Codex install and rebuilt catalog only."""
    names = ['state_key', 'value_json', 'updated_at_ms']
    for connection in (before, after):
        require([item[1] for item in connection.execute('pragma table_info(config_machine_state)')] == names,
                'Native machine-state columns changed.')
    old = {row[0]: row for row in rows(before, 'config_machine_state')}
    new = {row[0]: row for row in rows(after, 'config_machine_state')}
    key = 'plugins.installedIndex'
    audit = 'config.lastTouchedAt'
    if audit in old and audit in new and old[audit] != new[audit]:
        for row in (old[audit], new[audit]):
            require(isinstance(row[1], str) and len(row[1]) <= 64, 'Native configuration audit timestamp changed format.')
            stamp = json.loads(row[1])
            require(isinstance(stamp, str) and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z', stamp)
                    and type(row[2]) is int and 0 <= row[2] <= 9007199254740991
                    and round(datetime.fromisoformat(stamp.replace('Z', '+00:00')).timestamp() * 1000) == row[2],
                    'Native configuration audit timestamp is invalid.')
        require(new[audit][2] >= old[audit][2], 'Native configuration audit timestamp moved backwards.')
        new[audit] = old[audit]
    require(set(old) == set(new) and all(old[name] == new[name] for name in old if name != key),
            'Retained native machine configuration changed.')
    if key not in old or old[key] == new[key]:
        return
    indexes, revisions = [], []
    required = {'version', 'warning', 'hostContractVersion', 'compatRegistryVersion', 'migrationVersion',
                'policyHash', 'generatedAtMs', 'installRecords', 'plugins', 'diagnostics'}
    for row, version in ((old[key], '2026.9.2'), (new[key], '2026.9.6')):
        require(isinstance(row[1], str) and len(row[1]) <= 16 * 1024 * 1024, 'Native plugin index exceeded its bound.')
        value = json.loads(row[1])
        require(isinstance(value, dict) and set(value) == {'revision', 'index'}
                and type(value['revision']) is int and 0 <= value['revision'] <= 9007199254740991
                and type(row[2]) is int and row[2] == value['revision'], 'Native plugin index revision is invalid.')
        index = value['index']
        require(isinstance(index, dict) and required <= set(index) <= required | {'workspaceDir', 'refreshReason'}
                and type(index['version']) is int and index['version'] == 1
                and type(index['migrationVersion']) is int and index['migrationVersion'] == 1
                and index['hostContractVersion'] == version
                and isinstance(index['warning'], str) and len(index['warning']) <= 1024
                and all(isinstance(index[name], str) and re.fullmatch('[a-f0-9]{64}', index[name])
                        for name in ('compatRegistryVersion', 'policyHash'))
                and type(index['generatedAtMs']) is int and 0 <= index['generatedAtMs'] <= value['revision'],
                'Native plugin index envelope changed.')
        require(all(isinstance(index[name], str) and len(index[name]) <= 4096 for name in ('workspaceDir', 'refreshReason') if name in index)
                and isinstance(index['installRecords'], dict) and len(index['installRecords']) <= 1024
                and all(isinstance(name, str) and 0 < len(name) <= 256 and isinstance(record, dict)
                        for name, record in index['installRecords'].items())
                and all(isinstance(index[name], list) and len(index[name]) <= 4096
                        and all(isinstance(item, dict) for item in index[name]) for name in ('plugins', 'diagnostics')),
                'Native plugin index records changed format.')
        indexes.append(index); revisions.append(value['revision'])
    old_index, new_index = indexes
    require(revisions[1] >= revisions[0] and old_index.get('workspaceDir') == new_index.get('workspaceDir')
            and old_index['warning'] == new_index['warning'], 'Native plugin index authority changed.')
    records, updated = old_index['installRecords'], new_index['installRecords']
    require(set(records) == set(updated) and 'codex' in records
            and all(records[name] == updated[name] for name in records if name != 'codex')
            and records['codex'].get('version') == '2026.9.2', 'An unrelated native plugin installation changed.')
    executable = pathlib.Path(node) if node is not None else None
    require(executable is not None and executable.name == 'node' and executable.parent.name == 'bin'
            and executable.parent.parent.name == 'node' and executable.resolve(strict=True) == executable,
            'The Codex install needs the verified runtime closure.')
    runtime = executable.parent.parent.parent
    package = runtime / 'companions' / 'codex' / 'node_modules' / '@openclaw' / 'codex'
    require(package.resolve(strict=True) == package
            and bounded_json(runtime / 'node_modules' / 'openclaw' / 'package.json', 1024 * 1024).get('version') == '2026.9.6'
            and bounded_json(package / 'package.json', 1024 * 1024).get('version') == '2026.9.6',
            'The Codex install differs from the verified runtime package.')
    record = updated['codex']
    lock = bounded_json(runtime / 'companions' / 'codex' / 'package-lock.json', 16 * 1024 * 1024)
    locked = lock.get('packages', {}).get('node_modules/@openclaw/codex', {})
    require(locked.get('version') == '2026.9.6' and isinstance(locked.get('integrity'), str)
            and re.fullmatch(r'sha512-[A-Za-z0-9+/]+={0,2}', locked['integrity']), 'The verified Codex npm resolution is missing.')
    base_fields = {'source', 'spec', 'installPath', 'version', 'installedAt', 'resolvedName', 'resolvedVersion',
                   'resolvedSpec', 'integrity', 'shasum', 'resolvedAt'}
    consent_fields = {'acceptedSurface', 'acceptedSurfaceHash', 'acceptedSurfaceAt'}
    require(set(record) in (base_fields, base_fields | consent_fields)
            and record['source'] == 'npm' and record['version'] == record['resolvedVersion'] == '2026.9.6'
            and record['spec'] == record['resolvedSpec'] == '@openclaw/codex@2026.9.6'
            and record['resolvedName'] == '@openclaw/codex' and record['integrity'] == locked['integrity']
            and isinstance(record['shasum'], str) and re.fullmatch('[a-f0-9]{40}', record['shasum'])
            and all(isinstance(record[name], str) and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z', record[name])
                    for name in ('installedAt', 'resolvedAt', 'acceptedSurfaceAt') if name in record),
            'The Codex installation is outside the reviewed transition.')
    installed = pathlib.Path(record['installPath'])
    prior = pathlib.Path(records['codex'].get('installPath', ''))
    require(installed.is_absolute() and prior.is_absolute() and len(installed.parts) >= 7
            and installed.parts[-6:-4] == ('npm', 'projects')
            and re.fullmatch(r'openclaw-codex-[a-f0-9]{10}', installed.parts[-4])
            and installed.parts[-3:] == ('node_modules', '@openclaw', 'codex')
            and installed.parts[:-6] == prior.parts[:-6], 'The official Codex npm store changed.')
    # Stored absolute paths retain the selected workspace namespace in closed
    # recovery copies; inspect the corresponding payload inside this tree.
    retained_package = pathlib.Path(after_path).parent.parent.joinpath(*installed.parts[-6:])
    require(retained_package.resolve(strict=True) == retained_package
            and bounded_json(retained_package / 'package.json', 1024 * 1024).get('name') == '@openclaw/codex'
            and bounded_json(retained_package / 'package.json', 1024 * 1024).get('version') == '2026.9.6',
            'The official Codex npm payload changed.')
    if consent_fields <= set(record):
        surface = record['acceptedSurface']
        require(isinstance(surface, dict) and record['acceptedSurfaceHash'] == 'd05cd8ba6d0e24e4e81ec442be300da755d818c74be47885f65932a1d5622801'
                and hashlib.sha256(json.dumps(surface, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest() == record['acceptedSurfaceHash'],
                'The Codex capability surface changed.')


def retained_collection_review_jobs(before, after, node):
    """Match only the reviewed 9.6 replacement of generated Workshop monitors.

    User jobs continue through complete-row retention. The new monitor's exact
    instructions and tool scope come from the verified official runtime.
    """
    names = lambda connection: [item[1] for item in connection.execute('pragma table_info(cron_jobs)')]
    old_names, new_names = names(before), names(after)
    previous = [dict(zip(old_names, row)) for row in rows(before, 'cron_jobs')]
    current = [dict(zip(new_names, row)) for row in rows(after, 'cron_jobs')]
    legacy = [row for row in previous if row['payload_kind'] == 'skillCollectionReview']
    if not legacy:
        return {}
    executable = pathlib.Path(node) if node is not None else None
    require(executable is not None and executable.name == 'node' and executable.parent.name == 'bin'
            and executable.parent.parent.name == 'node' and executable.resolve(strict=True) == executable,
            'Workshop monitor migration requires the verified runtime closure.')
    package = executable.parent.parent.parent / 'node_modules/openclaw'
    require(bounded_json(package / 'package.json', 1024 * 1024).get('version') == '2026.9.6',
            'Workshop monitor migration requires the reviewed native version.')
    for name, pin in {
        'load.kernel-bWRpwlYl.mjs': 'be846a42ef55a511f6b97958ebc6b48c49c3171ce3c6120e2f0e42f0f998a0b1',
        'skill-collection-review-monitor-DnbqA4A4.mjs': '3d711142f949ee43a5364cf9abe534e7a2e6e11b2fb179e741ba1f0b82fa6146',
        'maintenance-prompt-zOCiE9ju.mjs': 'd4b152601a17afcb323246f2dd2a5036a2a6181d9303193cdc94dc888bbdfa4d',
        'scheduled-tool-policy-pqnwO5x1.mjs': '6ae8aee0f445d020c46004a4243c856c87f1f5d20f9421b22db4051c76931635',
        'jobs-tool-policy-DBCUJ2uk.mjs': '6cd412b9b38218d5a8cbcfc451e3f9297d77eb6f3b54e7df641ed814131a31a5',
    }.items():
        path = package / 'dist' / name
        require(path.resolve(strict=True) == path and digest(path) == pin, 'Workshop monitor migration source changed.')
    replacements = {}
    job_keys = {'id', 'declarationKey', 'displayName', 'agentId', 'name', 'enabled', 'createdAtMs',
                'schedule', 'sessionTarget', 'wakeMode', 'payload', 'state'}
    for old in legacy:
        agent_id = old['agent_id']
        require(isinstance(agent_id, str) and re.fullmatch('[a-z0-9_-]+', agent_id)
                and old['declaration_key'] == 'skill-collection-review:' + agent_id
                and old['name'] == 'skill-collection-review-' + agent_id and old['description'] is None
                and old['owner_agent_id'] is None and old['enabled'] == 1,
                'Retired Workshop job is not the unchanged generated monitor.')
        matching = [row for row in current if row['store_key'] == old['store_key']
                    and row['declaration_key'] == old['declaration_key']]
        require(len(matching) == 1, 'The generated Workshop monitor is missing or duplicated.')
        new = matching[0]
        if new['job_id'] == old['job_id']:
            # Offline schema migration leaves this generated job intact. The
            # replacement below is created only when the new gateway starts.
            require(all(new[name] == old[name] for name in old_names),
                    'The offline Workshop monitor changed retained settings.')
            continue
        old_job, new_job = json.loads(old['job_json']), json.loads(new['job_json'])
        require(set(old_job) == job_keys and set(new_job) == job_keys | {'delivery', 'scheduledToolPolicy'}
                and old_job['payload'] == {'kind': 'skillCollectionReview'}
                and old_job['state'] == new_job['state'] == {}
                and old_job['sessionTarget'] == 'main' and old_job['wakeMode'] == 'next-heartbeat'
                and old_job['enabled'] is True and old_job['agentId'] == agent_id
                and old_job['displayName'] == 'Skill collection review (' + agent_id + ')'
                and old_job['name'] == old['name'] and old_job['declarationKey'] == old['declaration_key'],
                'The retained Workshop monitor contains unreviewed user configuration.')
        for record, job in ((old, old_job), (new, new_job)):
            require(str(uuid.UUID(record['job_id'])) == record['job_id'] == job['id']
                    and type(job['createdAtMs']) is int and 0 <= job['createdAtMs'] <= 9007199254740991,
                    'The generated Workshop monitor identity changed format.')
        payload = new_job['payload']
        require(new['payload_kind'] == 'agentTurn' and isinstance(payload, dict)
                and set(payload) == {'kind', 'message', 'toolsAllow'} and payload['kind'] == 'agentTurn'
                and isinstance(payload['message'], str)
                and hashlib.sha256(payload['message'].encode()).hexdigest() == '73ff56de2590636d9dd52ead7a149052cd928f4b5b7462864e2b4c07047e48fe'
                and payload['toolsAllow'] == ['ls', 'read', 'write', 'edit', 'apply_patch', 'exec', 'process']
                and new_job['delivery'] == {'mode': 'none'}
                and new_job['scheduledToolPolicy'] == {'version': 1, 'mode': 'trusted'}
                and new_job['sessionTarget'] == 'isolated'
                and new_job['createdAtMs'] >= old_job['createdAtMs'],
                'The replacement Workshop monitor differs from the reviewed native definition.')
        retained = dict(new_job)
        for name in ('delivery', 'scheduledToolPolicy'):
            retained.pop(name)
        for name in ('id', 'createdAtMs', 'payload', 'sessionTarget'):
            retained[name] = old_job[name]
        require(retained == old_job, 'The generated Workshop monitor changed its retained settings.')
        schedule = old_job['schedule']
        require(isinstance(schedule, dict) and set(schedule) == {'kind', 'everyMs', 'anchorMs'}
                and schedule['kind'] == 'every' and schedule['everyMs'] == 604800000
                and type(schedule['anchorMs']) is int and 0 <= schedule['anchorMs'] < schedule['everyMs'],
                'The retained Workshop monitor schedule is outside the reviewed definition.')
        old_state, new_state = json.loads(old['state_json']), json.loads(new['state_json'])
        next_run = schedule['anchorMs'] + ((new_job['createdAtMs'] - schedule['anchorMs']) // schedule['everyMs'] + 1) * schedule['everyMs']
        require(set(old_state) == {'nextRunAtMs'} and type(old_state['nextRunAtMs']) is int
                and new_state == {'nextRunAtMs': next_run} and next_run >= old_state['nextRunAtMs']
                and new['runtime_updated_at_ms'] == new['updated_at'] == new_job['createdAtMs'],
                'The replacement Workshop monitor runtime state is outside the reviewed restart.')
        mutable = {'job_id', 'payload_kind', 'job_json', 'state_json', 'runtime_updated_at_ms', 'updated_at'}
        require(all(old[name] == new[name] for name in old_names if name not in mutable),
                'The generated Workshop monitor changed unrelated saved fields.')
        key = (new['store_key'], new['job_id'])
        require(key not in replacements, 'The generated Workshop monitor replacement is ambiguous.')
        replacements[key] = old
    return replacements


def migrated_native_rows(before, after, tables, before_path, after_path, node, boot_replacements=None):
    for table in tables:
        require(re.fullmatch(r'[a-zA-Z0-9_]+', table), 'Unexpected native table name.')
        if table == 'config_machine_state':
            retained_plugin_index(before, after, node, after_path)
            continue
        if table == 'transcript_events':
            require(transcript_hashes(before_path, node) <= transcript_hashes(after_path, node), 'Migrated native transcript bytes changed.')
            continue
        if table not in NATIVE_RETAINED_TABLES | NATIVE_96_RETAINED_TABLES | NATIVE_RECONNECT_COLUMNS.keys():
            continue
        old_names = [item[1] for item in before.execute('pragma table_info("' + table + '")')]
        new_names = [item[1] for item in after.execute('pragma table_info("' + table + '")')]
        removed = set(old_names) - set(new_names)
        allowed_removed = {'workspace_dir', 'claim_released_time'} if table == 'skill_workshop_proposals' else {'workspace_dir'} if table == 'skill_workshop_collection_reviews' else set()
        require(removed == allowed_removed, 'A retained native column disappeared outside the reviewed migration.')
        omitted = set(NATIVE_RECONNECT_COLUMNS.get(table, ()))
        if table == 'schema_meta':
            expected = 23 if after_path.name != 'openclaw.sqlite' else 18
            old_meta = before.execute("select schema_version,app_version from schema_meta where meta_key='primary'").fetchone()
            new_meta = after.execute("select schema_version,app_version from schema_meta where meta_key='primary'").fetchone()
            require(old_meta is not None, 'Retained native schema ownership is missing.')
            # Shared repair publishes its schema without rewriting app_version;
            # normal gateway startup later publishes the current package version.
            allowed_versions = {old_meta[1], '2026.9.6'} if expected == 18 else {'2026.9.6'}
            require(new_meta is not None and new_meta[0] == expected and new_meta[1] in allowed_versions,
                    'Migrated native schema ownership does not identify the reviewed version.')
        cron_replacements = retained_collection_review_jobs(before, after, node) if table == 'cron_jobs' else {}
        selected = [name for name in old_names if name not in removed | omitted]
        def projected(connection, names, old):
            result = Counter()
            for row, count in rows(connection, table).items():
                values = dict(zip(names, row))
                if not old:
                    values = native_boot_row(table, values, boot_replacements or {})
                    if table == 'cron_jobs':
                        values = cron_replacements.get((values['store_key'], values['job_id']), values)
                if table == 'session_nodes' and old and values.get('entry_valid') == 0:
                    # The official projection validates pending entries. A
                    # negative result is rejected; identity and JSON stay exact.
                    values['entry_valid'] = 1
                if table == 'schema_meta' and not old and values.get('meta_key') == 'primary':
                    values['schema_version'], values['app_version'] = old_meta
                if table == 'memory_index_state':
                    require(values.get('id') == 1 and type(values.get('revision')) is int, 'Unexpected memory index revision owner.')
                    if not old:
                        prior_revision = before.execute('select revision from memory_index_state where id=1').fetchone()[0]
                        require(values['revision'] >= prior_revision, 'Memory index revision moved backwards.')
                        values['revision'] = prior_revision
                if table == 'memory_index_sources' and old:
                    # The pinned provenance backfill invalidates only sources
                    # whose retained chunks lack provenance; all content stays exact.
                    missing = before.execute('select 1 from memory_index_chunks c left join memory_index_chunk_provenance p on p.chunk_id=c.id where c.path=? and c.source is ? and p.chunk_id is null limit 1', (values['path'], values['source'])).fetchone()
                    if missing is not None:
                        values['hash'] = ''
                if table == 'agent_databases' and not old and values.get('schema_version') == 23:
                    # Registration republishes the version after the exact
                    # canonical agent databases have passed schema23 validation.
                    values['schema_version'] = 19
                if table == 'memory_index_chunks':
                    values['embedding'] = embedding_bytes(values['embedding'])
                if table == 'device_pairing_paired' and values.get('tokens_json') is not None:
                    tokens = json.loads(values['tokens_json'])
                    for role, token in tokens.items():
                        require(token.get('role') == role and isinstance(token.get('token'), str), 'Native token identity changed.')
                        token.pop('lastUsedAtMs', None)
                    values['tokens_json'] = json.dumps(tokens, sort_keys=True, separators=(',', ':'))
                retained = [values[name] for name in selected]
                if table == 'skill_workshop_collection_reviews':
                    owner = before.execute('select distinct owner_agent_id from skill_workshop_proposals where workspace_dir=? and owner_agent_id is not null', (values['workspace_dir'],)).fetchone()[0] if old else values['owner_agent_id']
                    retained.append(owner)
                result[tuple(retained)] += count
            return result
        require(projected(before, old_names, True) <= projected(after, new_names, False),
                'Native migration did not retain saved work, history, configuration or permissions.')


def native_saved_state(snapshot, live, expected_epoch=None, from_version='2026.9.2', to_version=None, node=None, app_releases=None):
    to_version = to_version or from_version
    migrating = from_version != to_version
    require(not migrating or (from_version, to_version) == ('2026.9.2', '2026.9.6'), 'Native migration is outside the reviewed pair.')
    before_selected, before_epoch, before_paths = native_scope(snapshot, expected_epoch, closed=True)
    selected, epoch, paths = native_scope(live, before_epoch)
    require(before_selected == selected and before_epoch == epoch and before_paths == paths, 'The selected native database authority changed.')
    configuration = native_runtime_configuration(snapshot, live, selected, from_version, to_version, app_releases)
    embedded = retained_embedded_databases(snapshot, live, selected, paths, from_version, to_version)
    quarantine = retained_quarantine_cache(snapshot, live, selected, paths, from_version, to_version)
    require(static_sqlite_files(snapshot, selected, paths | embedded | quarantine) == static_sqlite_files(live, selected, paths | embedded | quarantine), 'An inactive database, archived store or nonactive cache changed.')
    for relative in sorted(before_paths):
        with contextlib.closing(database(snapshot / relative, True)) as before, contextlib.closing(database(live / relative, False)) as after:
            require(before.execute('pragma quick_check').fetchone()[0] == after.execute('pragma quick_check').fetchone()[0] == 'ok', 'Native saved database integrity failed.')
            old_tables = native_schema(before, relative, from_version)
            new_tables = native_schema(after, relative, to_version, old_tables if migrating else None)
            boot_replacements = native_boot_replacements(before, after, old_tables & new_tables, configuration, from_version, to_version, node)
            if migrating:
                migration_preflight(before, old_tables)
                # The pinned agent migration retires its old process lease table;
                # the shared database still owns current maintenance leases.
                retired = {'state_leases'} if relative.name != 'openclaw.sqlite' else set()
                require(old_tables - retired <= new_tables, 'A retained native table disappeared during migration.')
                migrated_native_rows(before, after, old_tables, before.database_path, live / relative, node, boot_replacements)
                continue
            require(old_tables == new_tables, 'An unchanged native database changed its schema.')
            schema = lambda connection: Counter(connection.execute("select type,name,tbl_name,sql from sqlite_schema where name not like 'sqlite_%'"))
            require(schema(before) == schema(after), 'An unchanged native database changed its schema definitions.')
            for table in old_tables:
                require(re.fullmatch(r'[a-zA-Z0-9_]+', table), 'Unexpected native table name.')
                require(list(before.execute('pragma table_info("' + table + '")')) == list(after.execute('pragma table_info("' + table + '")')), 'An unchanged native table changed its columns.')
                if table == 'config_machine_state':
                    require(rows(before, table) == rows(after, table), 'Retained native machine configuration changed.')
                elif table in NATIVE_RETAINED_TABLES | NATIVE_96_RETAINED_TABLES:
                    require(rows(before, table) <= native_boot_rows(after, table, boot_replacements), 'Retained native work, history, configuration or permissions changed.')
                elif table in NATIVE_RECONNECT_COLUMNS:
                    require(native_projected_rows(before, table) <= native_projected_rows(after, table, boot_replacements), 'Retained native identity, account content or permissions changed.')
