"""Closed snapshots and independent same-schema restoration for reviewed updates.

Derived from the previously reviewed hosted recovery approach. No function runs
on import. Recovery files are never used as the future live tree through links.
"""
import contextlib
import gc
from contextvars import ContextVar
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
import traceback
import uuid
from codex_log_retention import attest_runtime, qualify_logs

RESERVE = 1610612736
ALLOWANCE = 128 * 1024 ** 2
SESSION_BINDINGS_VERIFIER_SHA256 = '1d51c2af378f27f21c9580a367779ab9192c159c600f02938d780a5de467c5c0'
_VERIFICATION_SCRATCH = ContextVar('nova_verification_scratch', default=None)


@contextlib.contextmanager
def verification_scratch(parent):
    """Keep private evidence copies on the caller's validated recovery filesystem."""
    parent = pathlib.Path(parent)
    require(parent.resolve(strict=True) == parent and parent.is_dir(), 'Verification scratch parent was redirected.')
    info = parent.lstat()
    require(not info.st_mode & 0o022 and (not hasattr(os, 'geteuid') or info.st_uid == os.geteuid()),
            'Verification scratch parent is not protected.')
    directory = pathlib.Path(tempfile.mkdtemp(prefix='nova-update-verification-', dir=parent))
    identity = directory.lstat()
    require(identity.st_dev == info.st_dev, 'Verification scratch left the recovery filesystem.')
    token = _VERIFICATION_SCRATCH.set(directory)
    try:
        yield directory
    finally:
        _VERIFICATION_SCRATCH.reset(token)
        # Each CopiedDatabase removes its own temporary copy. Preserve any
        # unexpected residue instead of recursively deleting unknown contents.
        current = directory.lstat()
        require(not directory.is_symlink() and (current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino),
                'Verification scratch identity changed.')
        directory.rmdir()


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
NATIVE_VERSIONS = {'2026.9.2': (19, 15), '2026.9.6': (23, 18), '2026.9.8': (24, 19)}
NATIVE_MIGRATION_PAIRS = {('2026.9.2', '2026.9.6'), ('2026.9.6', '2026.9.8')}
NATIVE_98_RETAINED_TABLES = frozenset({'session_entry_snapshots'})

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


# Official rust-v0.155.1 thread-history schema (migrations 1..6).
THREAD_HISTORY_96 = (0, {
    '_sqlx_migrations': SQLX_MIGRATION_COLUMNS,
    'thread_turns': 'thread_id turn_id rollout_ordinal status error_json started_at completed_at duration_ms first_user_item_id final_agent_item_id rollout_byte_offset rollout_end_ordinal rollout_end_byte_offset',
    'thread_items': 'thread_id turn_id item_id rollout_ordinal created_at_ms item_json item_type updated_at_ordinal',
    'thread_history_projection_state': 'thread_id next_rollout_byte_offset next_rollout_ordinal',
    'thread_realtime_items': 'thread_id item_id rollout_ordinal created_at_ms item_type item_json',
})
EMBEDDED_DATABASES_96['thread_history_1.sqlite'] = THREAD_HISTORY_96
EMBEDDED_DATABASES_98 = {name: (version, dict(tables)) for name, (version, tables) in EMBEDDED_DATABASES_96.items()}
EMBEDDED_DATABASES_98['state_5.sqlite'][1]['threads'] += ' creator_user_id creator_account_id'
EMBEDDED_DATABASES_98['thread_history_1.sqlite'][1]['thread_items'] += ' started_at_ms completed_at_ms'
CODEX_SQL_MIGRATIONS_98 = {
'state_5.sqlite': [
    (56, 'threads creator identity', '5de44fac5505249be66fcd640e9ac3d36550854c0db1272eb52cbb6c3d18b207db4cb782686d81089e77ebb57f6819b1', 'ALTER TABLE threads ADD COLUMN creator_user_id TEXT;\nALTER TABLE threads ADD COLUMN creator_account_id TEXT;\n'),
    (57, 'cleanup guardian thread metadata', '729562c57bfa8b43d5ae3476c99cef6e81a54709a74283057ce8d2d6f55cf8eae2594fdb7cff4238ebe1e481e7c049e6', '-- Guardian prompts are synthetic review context, not user-authored messages.\n-- Keep the SQLite projection small; rollout JSONL remains canonical.\n-- Legacy automatic titles were empty or copied first_user_message; preserve a\n-- different non-empty title because it may have been set explicitly.\nUPDATE threads\nSET title = CASE\n        WHEN trim(title) = \'\' OR trim(title) = trim(first_user_message)\n            THEN \'Guardian review\'\n        ELSE title\n    END,\n    name = CASE\n        WHEN trim(COALESCE(name, \'\')) != \'\'\n            THEN name\n        WHEN trim(title) != \'\'\n            AND trim(title) != trim(COALESCE(first_user_message, \'\'))\n            THEN title\n        ELSE \'Guardian review\'\n    END,\n    preview = \'Approval review\',\n    first_user_message = \'\'\nWHERE source = \'{"subagent":{"other":"guardian"}}\';\n'),
],
'thread_history_1.sqlite': [
    (7, 'thread item lifecycle timestamps', '9334adb4cda792116a47b69a19e3840ae3806b08773ef1794043fe0aa72891360acb1a0a8431084d53c568482c5fdd20', 'ALTER TABLE thread_items ADD COLUMN started_at_ms INTEGER;\nALTER TABLE thread_items ADD COLUMN completed_at_ms INTEGER;\n'),
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


def allocation_unit(root):
    volume = os.statvfs(root)
    unit = volume.f_frsize or volume.f_bsize
    require(isinstance(unit, int) and unit > 0, 'Recovery allocation unit is unavailable.')
    return unit


def rounded_allocation(size, unit):
    require(isinstance(size, int) and size >= 0, 'Recovery allocation size is invalid.')
    return ((size + unit - 1) // unit) * unit


def inventory(root, *, allocation=None):
    """Capture content once, optionally measuring copy layout in that same walk.

    Allocation is a fresh, invocation-local side result, not manifest content or
    permission to reuse a prior inventory. The public (entries, inodes) result
    and saved manifest format remain unchanged.
    """
    root_info = root.lstat()
    require(stat.S_ISDIR(root_info.st_mode) and not root.is_symlink(), 'Snapshot root must be an ordinary directory.')
    if allocation is not None:
        require(isinstance(allocation, dict) and not allocation, 'Recovery allocation context must be fresh.')
        unit = allocation_unit(root)
        allocation.update(unitBytes=unit, device=root_info.st_dev, directoryCount=0, directoryObservedBytes=0,
                          directoryCopyBytes=0, symlinkCount=0, symlinkObservedBytes=0, symlinkCopyBytes=0)
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
            children = sorted(path.iterdir(), reverse=True)
            pending.extend(children)
            if allocation is not None:
                # Copied directories need fresh blocks even when every regular
                # file links to the old generation. Include names plus one
                # allocation unit for changed directory packing/index layout.
                names = 24 + sum(rounded_allocation(8 + len(os.fsencode(child.name)), 4) for child in children)
                observed = info.st_blocks * 512
                allocation['directoryCount'] += 1
                allocation['directoryObservedBytes'] += observed
                allocation['directoryCopyBytes'] += rounded_allocation(max(observed, info.st_size, names, unit), unit) + unit
        elif stat.S_ISLNK(info.st_mode):
            entry.update(kind='symlink', target=os.readlink(path))
            if allocation is not None:
                # Inline symlinks can allocate blocks when copied. Charging the
                # measured target length at the destination unit is conservative.
                observed = info.st_blocks * 512
                allocation['symlinkCount'] += 1
                allocation['symlinkObservedBytes'] += observed
                allocation['symlinkCopyBytes'] += rounded_allocation(max(observed, len(os.fsencode(entry['target']))), unit)
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
    if allocation is not None:
        allocation['fileInodeCount'] = len(groups)
    return entries, inodes


def inode_ids(records):
    return {(item['device'], item['inode']) for item in records.values()}


def retained_sparse_allocation(entries, source, copied):
    """Qualify allocation, after exact bytes/metadata and independent inodes.

    A copied extent may round up by one 4 KiB block. Losing substantial holes
    is refused even when the result still happens to be classified sparse.
    The total rounding cost must fit inside the existing copy allowance.
    """
    growth = 0
    for relative, info in source.items():
        if info['sparse'] and entries[relative]['size'] >= 1024 ** 2:
            delta = max(0, copied[relative]['allocated'] - info['allocated'])
            require(delta <= 4096, 'A large sparse file lost more than one allocation block.')
            growth += delta
    require(growth <= ALLOWANCE, 'Sparse allocation rounding exceeded its existing copy allowance.')


def unique_allocated(inodes, relatives=None):
    groups = {}
    for relative in inodes if relatives is None else relatives:
        item = inodes[relative]
        identity = item['device'], item['inode']
        require(identity not in groups or groups[identity] == item['allocated'], 'Hardlink allocation changed during inventory.')
        groups[identity] = item['allocated']
    return sum(groups.values())


def json_size(value):
    # Match write_json exactly without retaining another multi-megabyte encoding.
    return sum(len(part.encode('utf8')) for part in json.JSONEncoder(sort_keys=True, separators=(',', ':')).iterencode(value))


def copy_layout(allocation):
    if allocation is None:
        return 0
    return allocation['directoryCopyBytes'] + allocation['symlinkCopyBytes']


def independent_copy_bytes(inodes, allocation):
    return unique_allocated(inodes) + copy_layout(allocation)


def budget_verification_record(plan):
    """Round the future private receipt using the actual JSON encoder.

    Durations are bounded with full-width integer placeholders. Other private
    records are the two copy logs and containing generation directory; copy
    output beyond one unit remains guarded by the existing allowance/monitor.
    """
    unit = plan['allocationUnitBytes']
    if not unit:
        return plan
    timing_bound = {name: 2 ** 63 - 1 for name in ('sourceInventory', 'baselineInventory', 'copy', 'copiedInventory',
                    'sourceReverification', 'baselineReverification', 'flush', 'manifestWrite', 'total')}
    while True:
        receipt = {'manifestSha256': 'f' * 64, **plan, 'timingsMilliseconds': timing_bound}
        required = 3 * unit + rounded_allocation(json_size(receipt), unit)
        extra = max(0, required - plan['recoveryRecordBytes'])
        if not extra:
            return plan
        for field in ('recoveryRecordBytes', 'metadataOverheadBytes', 'requiredFreeBytes'):
            plan[field] += extra


def _capacity_plan(source, source_inodes, baseline, baseline_inodes, free, candidate_bytes=0, *, allocation=None, protected_sizes=()):
    require(allocation is not None or not protected_sizes, 'Protected copies need measured recovery allocation.')
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
    copied = unique_allocated(source_inodes, changed)
    independent = unique_allocated(source_inodes)
    layout = copy_layout(allocation)
    unit = allocation['unitBytes'] if allocation is not None else 0
    manifest = rounded_allocation(json_size(source), unit) if unit else 0
    protected = sum(rounded_allocation(size, unit) for size in protected_sizes) if unit else 0
    # Two private copy logs, verification receipt and containing generation
    # directory. Fixed units complement measured manifest/protected-file bytes;
    # they do not replace the existing aggregate 256 MiB copy allowance.
    records = 4 * unit
    metadata = 2 * layout + manifest + protected + records
    required = candidate_bytes + copied + independent + metadata + RESERVE + 2 * ALLOWANCE
    return budget_verification_record({'freeBytes': free, 'candidateBytes': candidate_bytes, 'snapshotCopyBytes': copied,
            'independentRestoreBytes': independent, 'closedAllocatedBytes': independent,
            'independentTotalBytes': independent + layout,
            'snapshotFileBytes': copied, 'independentFileBytes': independent,
            'copyLayoutBytes': layout, 'snapshotManifestBytes': manifest, 'protectedCopyBytes': protected,
            'recoveryRecordBytes': records, 'metadataOverheadBytes': metadata,
            'metadataOverheadMeasured': allocation is not None,
            'snapshotDeltaMeasured': allocation is not None,
            'allocationEstimateKind': 'fresh-input-upper-bound' if allocation is not None else 'file-allocation-only',
            'directoryObservedBytes': allocation['directoryObservedBytes'] if allocation is not None else 0,
            'directoryCopyBytes': allocation['directoryCopyBytes'] if allocation is not None else 0,
            'symlinkObservedBytes': allocation['symlinkObservedBytes'] if allocation is not None else 0,
            'symlinkCopyBytes': allocation['symlinkCopyBytes'] if allocation is not None else 0,
            'allocationUnitBytes': unit, 'reserveBytes': RESERVE,
            'allowanceBytes': 2 * ALLOWANCE, 'requiredFreeBytes': required})


def capacity(source, source_inodes, baseline, baseline_inodes, free, candidate_bytes=0, *, allocation=None, protected_sizes=()):
    plan = _capacity_plan(source, source_inodes, baseline, baseline_inodes, free, candidate_bytes,
                          allocation=allocation, protected_sizes=protected_sizes)
    required = plan['requiredFreeBytes']
    if free < required:
        raise InsufficientStorage('Candidate, closed recovery, independent restore and operating reserve do not all fit.')
    return plan


def run_copy(arguments, log_path, volume, minimum_free):
    with log_path.open('xb') as log:
        process = subprocess.Popen(arguments, stdout=log, stderr=log, start_new_session=True)
        try:
            while process.poll() is None:
                require(shutil.disk_usage(volume).free >= minimum_free,
                        'Recovery copy approached its operating reserve; evidence was retained.')
                time.sleep(0.05)
            require(process.returncode == 0, 'Recovery copy failed; private evidence was retained.')
            require(shutil.disk_usage(volume).free >= minimum_free,
                    'Recovery copy consumed its operating reserve; evidence was retained.')
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


def snapshot_closed(data, destination, baseline, require_stopped, *, admit_plan=None, begin_copy=None,
                    capacity_volume=None, protected_sizes=()):
    started = time.monotonic()
    timings = {}
    def measured(name, action):
        before = time.monotonic()
        result = action()
        timings[name] = round((time.monotonic() - before) * 1000)
        return result
    require_stopped()
    allocation = {}
    source, source_inodes = measured('sourceInventory', lambda: inventory(data, allocation=allocation))
    old, old_inodes = measured('baselineInventory', lambda: inventory(baseline))
    volume = pathlib.Path(capacity_volume) if capacity_volume is not None else destination.parent
    while not volume.exists():
        require(volume.parent != volume, 'Recovery capacity volume is unavailable.')
        volume = volume.parent
    require(volume.lstat().st_dev == allocation['device'] and allocation_unit(volume) == allocation['unitBytes'],
            'Recovery copy must stay on its measured filesystem.')
    require(baseline.lstat().st_dev == allocation['device'], 'Deduplication baseline must stay on the measured filesystem.')
    plan = _capacity_plan(source, source_inodes, old, old_inodes, shutil.disk_usage(volume).free,
                          allocation=allocation, protected_sizes=protected_sizes)
    base = dict(plan)
    try:
        if admit_plan is not None:
            plan = admit_plan(dict(plan), source, source_inodes)
            require(isinstance(plan, dict) and all(plan.get(key) == value for key, value in base.items() if key != 'requiredFreeBytes')
                    and isinstance(plan.get('requiredFreeBytes'), int) and plan['requiredFreeBytes'] >= base['requiredFreeBytes'],
                    'Admission cannot weaken measured recovery capacity.')
        plan = budget_verification_record(plan)
        if plan['freeBytes'] < plan['requiredFreeBytes']:
            raise InsufficientStorage('Candidate, closed recovery, independent restore and operating reserve do not all fit.')
    except InsufficientStorage as error:
        # Only this pre-write branch conveys safe unchanged admission failure.
        # A mutation/uncertain stop is an ordinary error and stays held.
        require_stopped()
        require(inventory(data) == (source, source_inodes), 'The unchanged closed original changed during capacity review.')
        require_stopped()
        # The caller may restart the original while handling this exception.
        # Release large maps including the completed admission callback frame;
        # preserving their traceback locals would compete with native startup.
        del source, source_inodes, old, old_inodes, allocation
        traceback.clear_frames(error.__traceback__)
        gc.collect()
        raise
    require_stopped()
    require(not destination.exists() and not destination.is_symlink(), 'Snapshot destination already exists.')
    if begin_copy is not None:
        begin_copy(plan)
    require(destination.parent.lstat().st_dev == allocation['device'], 'Snapshot destination left its measured filesystem.')
    destination.mkdir(mode=0o700)
    measured('copy', lambda: run_copy(['/usr/bin/rsync', '-aHAXS', '--numeric-ids', '--checksum', '--modify-window=-1',
              '--link-dest=' + str(baseline), '--', str(data) + '/', str(destination) + '/'],
             destination.parent / 'snapshot-copy.log', destination.parent, RESERVE + ALLOWANCE))
    require_stopped()
    actual, actual_inodes = measured('copiedInventory', lambda: inventory(destination))
    require(measured('sourceReverification', lambda: inventory(data)) == (source, source_inodes), 'Closed live state changed during the snapshot.')
    require(actual == source, 'Closed recovery bytes or metadata differ.')
    require(inode_ids(actual_inodes).isdisjoint(inode_ids(source_inodes)), 'Recovery must not share live file inodes.')
    require(measured('baselineReverification', lambda: inventory(baseline))[0] == old, 'The prior closed recovery changed.')
    retained_sparse_allocation(source, source_inodes, actual_inodes)
    measured('flush', lambda: flush_tree(destination, actual, actual_inodes))
    measured('manifestWrite', lambda: write_json(destination.parent / 'snapshot-manifest.json', actual))
    timings['total'] = round((time.monotonic() - started) * 1000)
    write_json(destination.parent / 'snapshot-verified.json', {'manifestSha256': digest(destination.parent / 'snapshot-manifest.json'),
                                                             **plan, 'timingsMilliseconds': timings})
    return actual


def prepare_independent(snapshot, destination, failed, require_stopped):
    require_stopped()
    require(not destination.exists() and not destination.is_symlink(), 'Independent restore evidence already exists.')
    allocation = {}
    expected, source_inodes = inventory(snapshot, allocation=allocation)
    failed_entries, failed_inodes = inventory(failed)
    require(destination.parent.lstat().st_dev == allocation['device'] and allocation_unit(destination.parent) == allocation['unitBytes'],
            'Independent restore must stay on its measured filesystem.')
    required = independent_copy_bytes(source_inodes, allocation) + RESERVE + ALLOWANCE
    require(shutil.disk_usage(destination.parent).free >= required, 'Independent restore and reserve no longer fit.')
    run_copy(['/usr/bin/cp', '-a', '--reflink=auto', '--', str(snapshot), str(destination)],
             snapshot.parent / 'independent-copy.log', destination.parent, RESERVE + ALLOWANCE)
    actual, actual_inodes = inventory(destination)
    require(actual == expected, 'Independent restore bytes, metadata or links differ.')
    require(inode_ids(actual_inodes).isdisjoint(inode_ids(source_inodes) | inode_ids(failed_inodes)),
            'The future live tree must have independent file inodes.')
    require(inventory(snapshot)[0] == expected and inventory(failed)[0] == failed_entries, 'Retained recovery or failed state changed.')
    retained_sparse_allocation(expected, source_inodes, actual_inodes)
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
    A retained WAL-index binds the committed prefix. Without one, a reset WAL
    may retain complete frames from older generations after its current commit.
    Qualify that narrow tail rather than confusing allocated length with mxFrame.
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
            if (frame_salt1, frame_salt2) != (salt1, salt2) and committed is None:
                require(final_commit == number - 1 and final_commit > 0,
                        'Retained SQLite WAL reset tail does not follow a committed prefix.')
                previous_generation, previous_salts, previous_checksum = 0, None, None
                for tail_number in range(number, frames + 1):
                    if tail_number != number:
                        frame_header, page = source.read(24), source.read(page_size)
                        page_number, _, frame_salt1, frame_salt2, first, second = struct.unpack('>6I', frame_header)
                    generation = (salt1 - frame_salt1) & 0xffffffff
                    salts = (frame_salt1, frame_salt2)
                    require(page_number > 0 and 0 < generation < 0x80000000
                            and generation >= previous_generation and frame_salt2 != salt2,
                            'Retained SQLite WAL tail is not from older reset generations.')
                    if generation == previous_generation:
                        require(salts == previous_salts, 'Retained SQLite WAL reset generation identity failed.')
                        tail_checksum = sqlite_wal_checksum(page, byteorder,
                            sqlite_wal_checksum(frame_header[:8], byteorder, previous_checksum))
                        require(tail_checksum == (first, second), 'Retained SQLite WAL reset tail checksum failed.')
                    # Earlier frames in this obsolete generation were overwritten
                    # by the reset. Its first remaining checksum is only a seed;
                    # all following frames in that generation still must chain.
                    previous_generation, previous_salts, previous_checksum = generation, salts, (first, second)
                limit = final_commit
                break
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
        self.temporary = tempfile.TemporaryDirectory(prefix='nova-update-sqlite-read-', dir=_VERIFICATION_SCRATCH.get())
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
    """Compare stable, stopped trees without opening either retained SQLite family."""
    paths = lambda root: {path.relative_to(root) for path in root.rglob('workspace.sqlite')}
    before_paths = paths(snapshot)
    require(before_paths and before_paths == paths(live), 'The saved database set changed.')
    reports = []
    for relative in sorted(before_paths):
        old, current = snapshot / relative, live / relative
        with contextlib.closing(database(old, True)) as before, contextlib.closing(database(current, True)) as after:
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


def embedded_database_paths(root, selected, active, engine_version='2026.9.2'):
    native = selected / 'openclaw-runtime'
    candidates = {native / 'assignment-receipts' / 'receipts.sqlite'}
    for relative in active:
        if relative.name in {'openclaw-agent.sqlite', 'incognito-openclaw-agent.sqlite'}:
            candidates.update(relative.parent / 'codex-home' / name for name in (EMBEDDED_DATABASES if engine_version == '2026.9.2' else EMBEDDED_DATABASES_96) if name != 'receipts.sqlite')
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
    require(engine_version in NATIVE_VERSIONS, 'An embedded database has no reviewed engine.')
    choices = [EMBEDDED_DATABASES]
    if engine_version in {'2026.9.6', '2026.9.8'}:
        choices.append(EMBEDDED_DATABASES_96)
    if engine_version == '2026.9.8':
        choices.append(EMBEDDED_DATABASES_98)
    require(connection.execute('pragma quick_check').fetchone()[0] == 'ok', 'Embedded database integrity failed.')
    version = connection.execute('pragma user_version').fetchone()[0]
    tables = {row[0] for row in connection.execute("select name from sqlite_schema where type='table' and name not like 'sqlite_%'")}
    actual = {table: ' '.join(row[1] for row in connection.execute('pragma table_xinfo("' + table + '")')) for table in tables}
    # A dormant home can retain an earlier complete schema until first use;
    # never mix columns from two versions or infer a schema from table names.
    require(any(name in choice and choice[name] == (version, actual) for choice in choices),
            'An embedded database contains unreviewed columns or tables.')
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


def migrated_embedded98_database(before, after, name):
    """Exact SQLx 0.158 migrations, including the complete guardian projection.

    Dormant 0.153 homes may still need the already-reviewed 0.155 migrations.
    No old value is dropped: the four guardian changes are SQL-derived while
    the canonical rollout files remain covered by the workspace comparison.
    """
    require(name in CODEX_SQL_MIGRATIONS_98 or name == 'memories_1.sqlite', 'Unreviewed embedded 9.8 migration.')
    old_columns = {table: [row[1] for row in before.execute('pragma table_info("' + table + '")')]
                   for (table,) in before.execute("select name from sqlite_schema where type='table' and name not like 'sqlite_%'")}
    legacy = (name == 'state_5.sqlite' and 'thread_artifacts' in old_columns
              or name == 'memories_1.sqlite' and 'consolidation_progress' not in old_columns)
    migrations = (CODEX_SQL_MIGRATIONS.get(name, []) if legacy else []) + CODEX_SQL_MIGRATIONS_98.get(name, [])
    require(migrations, 'Embedded migration has no reviewed SQL.')
    with contextlib.closing(sqlite3.connect(':memory:')) as model:
        for kind in ('table', 'index', 'trigger', 'view'):
            for row in schema_definitions(before):
                if row[0] == kind and row[3] is not None:
                    model.execute(row[3])
        for _, _, _, sql in migrations:
            model.executescript(sql)
        require(schema_definitions(model) == schema_definitions(after), 'Embedded 0.158 migration changed unreviewed definitions.')
    previous, current = rows(before, '_sqlx_migrations'), rows(after, '_sqlx_migrations')
    added = current - previous
    require(previous <= current and sum(added.values()) == len(migrations), 'Embedded migration history was removed or fabricated.')
    receipts = set()
    for row, count in added.items():
        version, description, installed, success, checksum, duration = row
        require(count == 1 and type(version) is int and isinstance(checksum, bytes) and len(checksum) == 48
                and success == 1 and isinstance(installed, str) and 0 < len(installed) <= 128
                and type(duration) is int and duration >= 0, 'Embedded migration receipt is invalid.')
        receipts.add((version, description, checksum.hex()))
    require(receipts == {(v, d, c) for v, d, c, _ in migrations}, 'Embedded migration receipt identifies unreviewed SQL.')
    guardian = "source = '{\"subagent\":{\"other\":\"guardian\"}}'"
    guardian_fields = {
        'title': "CASE WHEN trim(title) = '' OR trim(title) = trim(first_user_message) THEN 'Guardian review' ELSE title END",
        'name': "CASE WHEN trim(COALESCE(name, '')) != '' THEN name WHEN trim(title) != '' AND trim(title) != trim(COALESCE(first_user_message, '')) THEN title ELSE 'Guardian review' END",
        'preview': "'Approval review'", 'first_user_message': "''",
    }
    for table, columns in old_columns.items():
        if table == '_sqlx_migrations':
            continue
        target = 'thread_attachments' if table == 'thread_artifacts' else table
        new_columns = [row[1] for row in after.execute('pragma table_info("' + target + '")')]
        expressions = []
        for column in new_columns:
            source = 'artifact_type' if table == 'thread_artifacts' and column == 'attachment_type' else column
            expression = '"' + source + '"' if source in columns else 'NULL'
            if table == 'threads' and column in guardian_fields:
                expression = 'CASE WHEN ' + guardian + ' THEN ' + guardian_fields[column] + ' ELSE ' + expression + ' END'
            expressions.append(expression)
        expected = Counter(before.execute('select ' + ','.join(expressions) + ' from "' + table + '"'))
        require(expected == rows(after, target), 'Embedded migration changed retained messages, work, identity or metadata.')
    if name == 'memories_1.sqlite' and legacy:
        require(rows(after, 'consolidation_progress') == Counter({(1, 0): 1}), 'Unexpected migrated memory consolidation state.')


def retained_embedded_databases(snapshot, live, selected, active, from_version='2026.9.2', to_version=None,
                                log_retention_window=None, log_retention_reports=None):
    to_version = to_version or from_version
    require(from_version == to_version or (from_version, to_version) in NATIVE_MIGRATION_PAIRS, 'Unreviewed embedded runtime migration.')
    paths = embedded_database_paths(snapshot, selected, active, from_version)
    require(paths == embedded_database_paths(live, selected, active, to_version), 'The active embedded database set changed.')
    companion = None
    for relative in sorted(paths):
        with contextlib.closing(database(snapshot / relative, True)) as before, contextlib.closing(database(live / relative, True)) as after:
            tables = embedded_schema(before, relative.name, from_version)
            newer = embedded_schema(after, relative.name, to_version)
            if (from_version, to_version) == ('2026.9.6', '2026.9.8') and schema_definitions(before) != schema_definitions(after):
                migrated_embedded98_database(before, after, relative.name)
                continue
            if from_version != to_version and tables != newer and relative.name in CODEX_SQL_MIGRATIONS:
                migrated_embedded_database(before, after, relative.name)
                continue
            require(tables == newer, 'An embedded database changed its tables.')
            definitions = lambda connection: Counter(connection.execute("select type,name,tbl_name,sql from sqlite_schema where name not like 'sqlite_%'"))
            require(definitions(before) == definitions(after), 'An embedded database changed its schema definitions.')
            for table in tables:
                require(list(before.execute('pragma table_xinfo("' + table + '")')) == list(after.execute('pragma table_xinfo("' + table + '")')), 'An embedded database changed its column definitions.')
                append_only = relative.name == 'logs_2.sqlite' and table == 'logs'
                if append_only and log_retention_window is not None and to_version in {'2026.9.6', '2026.9.8'} and (from_version == to_version or (from_version, to_version) == ('2026.9.6', '2026.9.8')):
                    report = qualify_logs(before, after, *log_retention_window, engine_version=to_version)
                    if report['removedRows']:
                        if companion is None:
                            shared = selected / 'openclaw-runtime' / 'state' / 'state' / 'openclaw.sqlite'
                            require(shared in active, 'Native log retention lacks the active runtime authority.')
                            with contextlib.closing(database(live / shared, True)) as runtime:
                                companion = attest_runtime(live, selected, runtime, engine_version=to_version)
                        if log_retention_reports is not None:
                            log_retention_reports.append({**report, 'companion': companion,
                                'databasePathSha256': hashlib.sha256(relative.as_posix().encode()).hexdigest()})
                else:
                    old, new = rows(before, table), rows(after, table)
                    require(old <= new if append_only else old == new, 'Retained embedded work, receipts, history or configuration changed.')
    return paths


def retained_quarantine_cache(snapshot, live, selected, active, from_version, to_version, *, logical_workspace_root=None):
    relative = selected / 'openclaw-runtime' / 'state' / 'state' / 'openclaw-quarantine.sqlite'
    old_path, new_path = snapshot / relative, live / relative
    if to_version not in {'2026.9.6', '2026.9.8'} or not (old_path.exists() or new_path.exists()):
        return set()
    require(new_path.is_file() and new_path.resolve(strict=True) == new_path, 'Native quarantine cache disappeared or was redirected.')
    expected = {
        'quarantined_databases': 'CREATE TABLE quarantined_databases ( path TEXT NOT NULL PRIMARY KEY, kind TEXT NOT NULL, reason TEXT NOT NULL, quarantined_at INTEGER NOT NULL, writer_app_version TEXT, verified_generation TEXT ) STRICT',
        'agent_integrity_verifications': 'CREATE TABLE agent_integrity_verifications ( path TEXT NOT NULL PRIMARY KEY, dev TEXT NOT NULL, ino TEXT NOT NULL, app_version TEXT NOT NULL, verified_at INTEGER NOT NULL, clean_close INTEGER NOT NULL CHECK (clean_close IN (0, 1)) ) STRICT',
    }
    decisions = []
    authority = live if logical_workspace_root is None else logical_workspace_root
    allowed_paths = {str(authority / path) for path in active if path.name != 'openclaw.sqlite'}
    for path, closed in ((old_path, True), (new_path, False)):
        if not path.exists():
            require(closed and from_version == '2026.9.2', 'A native quarantine cache is missing outside the reviewed transition.')
            decisions.append(Counter()); continue
        require(path.is_file() and path.resolve(strict=True) == path, 'Native quarantine cache was redirected.')
        with contextlib.closing(database(path, True)) as connection:
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
    if version in {'2026.9.6', '2026.9.8'} and attachment in tables:
        # The pinned worker store creates this lazy companion table at startup.
        # Existing 9.6 attachments are retained by the normal row comparison.
        sql = connection.execute('select sql from sqlite_schema where type=\'table\' and name=?', (attachment,)).fetchone()[0]
        compact = lambda value: re.sub(r'\s+', '', value)
        require(compact(sql) == compact(WORKER_ATTACHMENTS_SCHEMA),
                'Native worker attachments need separate recovery qualification.')
        if prior_tables is not None and attachment not in prior_tables:
            require(connection.execute('select 1 from worker_environment_session_attachments limit 1').fetchone() is None,
                    'Native worker attachments need separate recovery qualification.')
    known = NATIVE_KNOWN_TABLES | (NATIVE_96_RETAINED_TABLES | NATIVE_96_DERIVED_TABLES if version in {'2026.9.6', '2026.9.8'} else set())
    if version == '2026.9.8':
        known |= NATIVE_98_RETAINED_TABLES
        if expected == 24:
            require({'session_nodes', 'session_entry_snapshots'} <= tables,
                    'Native schema 24 lacks its canonical session snapshots.')
            revision = [row for row in connection.execute('pragma table_xinfo(session_nodes)') if row[1] == 'snapshot_revision']
            require(len(revision) == 1 and revision[0][2:5] == ('INTEGER', 1, '0') and revision[0][6] == 0,
                    'Native schema 24 snapshot revision changed.')
            with contextlib.closing(sqlite3.connect(':memory:')) as model:
                model.executescript(SESSION_SNAPSHOTS_98_SQL)
                expected_snapshots = schema_definitions(model)
            actual_snapshots = Counter(row for row in schema_definitions(connection) if row[2] == 'session_entry_snapshots')
            require(expected_snapshots == actual_snapshots, 'Native schema 24 snapshot definitions changed.')
    require(tables <= known, 'Native database coverage contains an unreviewed table.')
    return tables


def native_preflight(root, expected_epoch=None, version='2026.9.2', target_version=None, *, closed=False):
    selected, epoch, paths = native_scope(root, expected_epoch, closed=closed)
    for relative in sorted(embedded_database_paths(root, selected, paths, version)):
        with contextlib.closing(database(root / relative, closed)) as connection:
            embedded_schema(connection, relative.name, version)
    for relative in sorted(paths):
        with contextlib.closing(database(root / relative, closed)) as connection:
            tables = native_schema(connection, relative, version)
            if target_version is not None and target_version != version:
                require((version, target_version) in NATIVE_MIGRATION_PAIRS, 'Native migration is outside the reviewed pair.')
                if version == '2026.9.2':
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


def verified_session_bindings(snapshot, selected, configuration, node, key):
    """Use the single pinned producer-compatible verifier, without logging keys
    or its private record diagnostics. The source is the selected closed store.
    The driver's reviewed helper manifest authenticates this sibling too.
    """
    require(isinstance(key, (bytes, bytearray)) and len(key) == 32 and node is not None,
            'Session binding derivation requires its protected key and verified Node executable.')
    scratch = _VERIFICATION_SCRATCH.get()
    require(scratch is not None, 'Session binding verification requires private recovery scratch.')
    store, epoch = selected_workspace(snapshot, closed=True)
    require(store == snapshot / selected, 'Session binding verification selected the wrong workspace.')
    source_identity = sqlite_source_identity(store / 'workspace.sqlite')
    bounded_json(configuration, 4 * 1024 * 1024)
    configuration_hash = digest(configuration)
    require(shutil.disk_usage(scratch).free >= sum(value[0][6] for value in source_identity.values()) + RESERVE + ALLOWANCE,
            'Session binding verification copy and recovery reserve no longer fit.')
    verifier = pathlib.Path(__file__).resolve().with_name('verify-session-bindings.mjs')
    require(not verifier.is_symlink() and digest(verifier) == SESSION_BINDINGS_VERIFIER_SHA256,
            'Session binding verifier differs from the reviewed implementation.')
    # Node's disposable database copies must consume the accounted recovery
    # volume, not an unrelated /tmp mount. Do not inherit NODE_OPTIONS/loaders.
    environment = {name: os.environ[name] for name in ('SystemRoot', 'SYSTEMROOT') if name in os.environ}
    environment.update(TMPDIR=str(scratch), TEMP=str(scratch), TMP=str(scratch), NODE_DISABLE_COMPILE_CACHE='1')
    result = subprocess.run([str(node), str(verifier), '--store', str(store), '--config', str(configuration), '--key', '-'],
                            input=key, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            env=environment, timeout=120, check=False)
    require(sqlite_source_identity(store / 'workspace.sqlite') == source_identity and digest(configuration) == configuration_hash,
            'Session binding source or generated configuration changed during verification.')
    require(shutil.disk_usage(scratch).free >= RESERVE + ALLOWANCE, 'Session binding verification consumed its recovery reserve.')
    require(result.returncode == 0 and len(result.stdout) <= 65536,
            'Generated session bindings failed selected-store derivation verification.')
    try:
        report = json.loads(result.stdout)
    except (ValueError, UnicodeError):
        raise RuntimeError('Session binding verifier returned an invalid proof.') from None
    require(report.get('check') == 'sessionBindings-derivation' and report.get('pass') is True
            and report.get('diagnostics', {}).get('epoch') == epoch,
            'Session binding proof does not match the selected workspace epoch.')


def native_runtime_configuration(snapshot, live, selected, from_version='2026.9.2', to_version=None, app_releases=None,
                                 *, session_binding_key=None, session_binding_node=None, logical_workspace_root=None):
    relative = selected / 'openclaw-runtime' / 'openclaw.json'
    paths = (snapshot / relative, live / relative)
    if not any(path.exists() or path.is_symlink() for path in paths):
        return None
    derive_bindings = session_binding_key is not None or session_binding_node is not None
    if derive_bindings:
        require(all(path.resolve(strict=True) == path for path in paths), 'The selected native configuration was redirected.')
        verified_session_bindings(snapshot, selected, paths[1], session_binding_node, session_binding_key)
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
        if derive_bindings and isinstance(bridge, dict):
            # Only this generated field is qualified above. Every other config
            # value (including module permissions and credentials) stays exact.
            bridge.pop('sessionBindings', None)
        if (from_version, to_version) == ('2026.9.6', '2026.9.8'):
            # The official writer stamps its version/time. Migration markers,
            # auth references and every remaining field remain exact.
            meta = value.get('meta', {})
            if isinstance(meta, dict):
                if 'lastTouchedVersion' in meta:
                    require(meta['lastTouchedVersion'] == (from_version if not normalized else to_version),
                            'Native configuration has an unreviewed writer version.')
                    del meta['lastTouchedVersion']
                if 'lastTouchedAt' in meta:
                    require(isinstance(meta['lastTouchedAt'], str) and re.fullmatch(r'[0-9]{4}-[0-9TZ:.+-]+', meta['lastTouchedAt']),
                            'Native configuration writer timestamp changed type.')
                    del meta['lastTouchedAt']
                if not meta:
                    value.pop('meta', None)
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
    authority = live if logical_workspace_root is None else logical_workspace_root
    return {'path': str(authority / relative), 'hashes': hashes, 'byteSizes': byte_sizes}


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
                    require((from_version, to_version) in NATIVE_MIGRATION_PAIRS and parts[1][0] == to_version and node is not None,
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
                    for index, (encoded, config_hash, config_bytes) in enumerate(zip((previous.get(field), value.get(field)), configuration['hashes'], configuration['byteSizes'])):
                        require(isinstance(encoded, str) and len(encoded) <= 1024 * 1024, 'Unexpected native config observation.')
                        observation = json.loads(encoded)
                        require(isinstance(observation, dict) and isinstance(observation.get('hash'), str)
                                and re.fullmatch(r'[a-f0-9]{64}', observation['hash']), 'Unexpected native config observation hash.')
                        require(type(observation.get('bytes')) is int and 0 <= observation['bytes'] <= 4 * 1024 * 1024,
                                'Unexpected native config observation size.')
                        # The last promotion can precede a later legitimate config
                        # write. Only that historical before-side observation may
                        # be stale; startup must now identify the verified config.
                        historical_promotion = index == 0 and field == 'last_promoted_good_json'
                        require(historical_promotion or observation['hash'] == config_hash, 'Native config observation does not identify the retained configuration.')
                        require(historical_promotion or observation['bytes'] == config_bytes,
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


def native_restart_rows(before, after, table, relative, after_path, replacements):
    """Qualify exact 9.6 process/file-generation metadata, never saved content."""
    result = native_boot_rows(after, table, replacements)
    if table not in {'session_key_contract', 'plugin_state_entries'}:
        return result
    columns = [item[1] for item in before.execute('pragma table_info("' + table + '")')]
    old = rows(before, table)
    if old <= result:
        return result
    if table == 'session_key_contract':
        require(columns == ['id', 'main_key', 'updated_at', 'canonical_ready']
                and relative.name in {'openclaw-agent.sqlite', 'incognito-openclaw-agent.sqlite'}
                and len(old) == len(result) == 1, 'Unreviewed native canonical receipt schema.')
        previous, current = next(iter(old)), next(iter(result))
        require(previous[0] == current[0] == 1 and previous[:3] == current[:3], 'Retained native session key contract changed.')
        receipts = []
        for encoded in (previous[3], current[3]):
            require(isinstance(encoded, str) and len(encoded) <= 512, 'Unexpected native canonical receipt.')
            value = json.loads(encoded)
            require(isinstance(value, list) and len(value) == 4 and type(value[0]) is int and value[0] == 1
                    and value[1] == relative.parts[-3] and isinstance(value[2], str) and re.fullmatch(r'[0-9]+:[0-9]+', value[2])
                    and isinstance(value[3], str) and re.fullmatch(r'[0-9]{1,20}', value[3]), 'Unreviewed native canonical receipt format.')
            receipts.append(value)
        identity = after_path.stat()
        require(after_path.is_file() and not after_path.is_symlink()
                and receipts[1][2] == str(identity.st_dev) + ':' + str(identity.st_ino), 'Native canonical receipt belongs to another database.')
        # Birth time is a generation hint; complete logical rows and quick_check
        # still establish retention/integrity. Bind its companion inode exactly.
        return old.copy()
    require(columns == ['plugin_id', 'namespace', 'entry_key', 'value_json', 'created_at', 'expires_at'],
            'Unreviewed native plugin state schema.')
    current = {row[:3]: row for row in result}
    for row, count in (old - result).items():
        plugin, namespace, key, encoded, created, expires = row
        if plugin != 'codex':
            continue
        newer = current.get(row[:3])
        if re.fullmatch(r'session-catalog-resident\.[a-f0-9]{64}', namespace) and key == 'complete' and newer:
            require(json.loads(encoded) == {'version': 1, 'kind': 'complete'} and newer[3] == encoded and newer[5] == expires
                    and type(created) is int and type(newer[4]) is int and 0 <= created <= newer[4],
                    'Retained Codex catalog marker content changed.')
            del result[newer];result[row] = count
        elif namespace == 'app-server-processes' and newer is None:
            require(str(uuid.UUID(key)) == key and type(created) is int and created >= 0 and expires is None,
                    'Unreviewed Codex process registration key.')
            registration = json.loads(encoded)
            require(isinstance(registration, dict) and set(registration) == {'parent', 'child'}, 'Unreviewed Codex process registration.')
            for kind, process in registration.items():
                require(isinstance(process, dict) and {'pid', 'pgid', 'startedAt'} <= set(process)
                        and set(process) <= {'pid', 'pgid', 'startedAt'} | ({'commandFingerprint'} if kind == 'child' else set())
                        and all(type(process.get(name)) is int and 0 < process[name] <= 9007199254740991 for name in ('pid', 'pgid'))
                        and isinstance(process['startedAt'], str) and 0 < len(process['startedAt']) <= 64
                        and ('commandFingerprint' not in process or isinstance(process['commandFingerprint'], str)
                             and re.fullmatch(r'[a-f0-9]{64}', process['commandFingerprint'])), 'Unreviewed Codex process identity.')
                process_path = pathlib.Path('/proc') / str(process['pid'])
                require(not process_path.exists() or (process_path / 'stat').read_text().rsplit(')', 1)[1].split()[0] in {'Z', 'X'},
                        'A removed Codex process registration still has a live owner.')
            result[row] = count
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


def catalog_file(path, expected_hash, signature=None, *, current=False):
    """Attest catalog cache metadata against a bounded, direct ordinary file.

    Snapshot ctime belongs to the independent copy, not the historic cache.
    Current cache timestamps must describe its actual file; both sides retain
    exact content hashes, sizes and mtimes.
    """
    path = pathlib.Path(path)
    require(path.is_absolute() and path.resolve(strict=True) == path,
            'Catalog file was redirected.')
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_size <= 16 * 1024 ** 2
            and isinstance(expected_hash, str) and re.fullmatch('[a-f0-9]{64}', expected_hash),
            'Catalog file identity is invalid.')
    content = path.read_bytes()
    require(len(content) == info.st_size and hashlib.sha256(content).hexdigest() == expected_hash,
            'Catalog file differs from its retained content hash.')
    if signature is not None:
        require(isinstance(signature, dict) and set(signature) == {'size', 'mtimeMs', 'ctimeMs'}
                and type(signature['size']) is int and signature['size'] == info.st_size
                and all(type(signature[name]) in (int, float) and math.isfinite(signature[name])
                        and 0 <= signature[name] <= 9007199254740991 for name in ('mtimeMs', 'ctimeMs')),
                'Catalog file signature changed shape or size.')
        require(abs(signature['mtimeMs'] - info.st_mtime_ns / 10 ** 6) <= 0.001
                and (not current or abs(signature['ctimeMs'] - info.st_ctime_ns / 10 ** 6) <= 0.001),
                'Catalog file signature does not describe its physical file.')
    later = path.lstat()
    identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
    require(identity(info) == identity(later) and path.resolve(strict=True) == path,
            'Catalog file changed during attestation.')
    return content


def retained_catalog_files(indexes, app_releases=None, workspace_roots=None):
    """Normalize only file-proved generated catalog differences, in memory.

    Nova plugin paths/JSON formatting follow the two verified candidate
    closures. A copied workspace Codex package may change ctime only. Every
    other catalog field, policy, capability, installation and order stays exact.
    """
    before, after = indexes
    require(len(before['plugins']) == len(after['plugins']), 'Native plugin catalog membership changed.')
    app_plugins = {'edition3-worker': 'worker-plugin', 'edition3-sources': 'source-plugin',
                   'edition3-accounts': 'account-plugin', 'edition3-workspace': 'module-plugin'}
    seen = set()
    for old, new in zip(before['plugins'], after['plugins']):
        if old == new:
            continue
        plugin_id = old.get('pluginId')
        require(isinstance(plugin_id, str) and plugin_id == new.get('pluginId') and plugin_id not in seen,
                'Native plugin catalog identity or order changed.')
        seen.add(plugin_id)
        if plugin_id in app_plugins and app_releases is not None:
            require(isinstance(app_releases, (tuple, list)) and len(app_releases) == 2,
                    'Catalog relocation requires both verified application releases.')
            relative = pathlib.Path('dist/service/apps/service') / app_plugins[plugin_id]
            documents = []
            for position, (record, (root, manifest)) in enumerate(zip((old, new), app_releases)):
                root = pathlib.Path(root); plugin = root / relative
                require(root.resolve(strict=True) == root and plugin.resolve(strict=True) == plugin
                        and record.get('rootDir') == str(plugin) and record.get('source') == str(plugin / 'index.js')
                        and record.get('manifestPath') == str(plugin / 'openclaw.plugin.json'),
                        'Catalog plugin is outside its verified application release.')
                prefix = relative.as_posix() + '/'
                artifacts = {item['path']: item['sha256'] for item in manifest['artifacts'] if item['path'].startswith(prefix)}
                actual = {}
                require(0 < len(artifacts) <= 1000, 'Catalog plugin lacks its candidate artifact closure.')
                for file in plugin.rglob('*'):
                    require(not file.is_symlink() and (file.is_file() or file.is_dir()), 'Catalog plugin artifact was redirected.')
                    if file.is_file():
                        require(len(actual) < 1000, 'Catalog plugin closure exceeded its bound.')
                        actual[file.relative_to(root).as_posix()] = digest(file)
                require(actual == artifacts, 'Catalog plugin bytes differ from the verified candidate.')
                package = record.get('packageJson')
                require(isinstance(package, dict) and set(package) == {'path', 'hash', 'fileSignature'}
                        and package['path'] == 'package.json' and isinstance(package['fileSignature'], dict)
                        and isinstance(record.get('manifestFile'), dict), 'Catalog package identity changed shape.')
                parsed_manifest = json.loads(catalog_file(plugin / 'openclaw.plugin.json', record.get('manifestHash'),
                                                         record.get('manifestFile'), current=position == 1))
                parsed_package = json.loads(catalog_file(plugin / 'package.json', package['hash'],
                                                        package['fileSignature'], current=position == 1))
                require(isinstance(parsed_manifest, dict) and parsed_manifest.get('id') == plugin_id
                        and isinstance(parsed_package, dict) and parsed_package.get('name') == record.get('packageName')
                        and parsed_package.get('version') == record.get('packageVersion'),
                        'Catalog manifest or package identity differs from its file.')
                documents.append((parsed_manifest, {key: value for key, value in parsed_package.items() if key != 'version'}))
            require(documents[0] == documents[1], 'Catalog plugin JSON semantics changed.')
            for field in ('rootDir', 'source', 'manifestPath', 'manifestHash', 'manifestFile', 'packageVersion'):
                new[field] = old[field]
            new['packageJson'] = old['packageJson']
        elif plugin_id == 'codex' and workspace_roots is not None:
            snapshot, live, logical, selected = map(pathlib.Path, workspace_roots)
            package_root = pathlib.Path(old.get('rootDir', ''))
            projects = logical / selected / 'openclaw-runtime/state/npm/projects'
            require(package_root.is_absolute() and package_root.is_relative_to(projects)
                    and len(package_root.relative_to(projects).parts) == 4
                    and package_root.relative_to(projects).parts[1:] == ('node_modules', '@openclaw', 'codex')
                    and new.get('rootDir') == str(package_root)
                    and old.get('source') == new.get('source') == str(package_root / 'dist/index.js')
                    and old.get('manifestPath') == new.get('manifestPath') == str(package_root / 'openclaw.plugin.json'),
                    'Copied Codex catalog package is outside its retained workspace.')
            physical = [root / package_root.relative_to(logical) for root in (snapshot, live)]
            files = [('openclaw.plugin.json', 'manifestHash', 'manifestFile'),
                     ('dist/doctor-contract-api.js', 'doctorContractHash', 'doctorContractFile')]
            for relative_file, hash_name, signature_name in files:
                require(old.get(hash_name) == new.get(hash_name), 'Copied Codex catalog content hash changed.')
                signatures = [record.get(signature_name) for record in (old, new)]
                require(all(isinstance(value, dict) for value in signatures), 'Copied Codex signature is absent.')
                for position in range(2):
                    catalog_file(physical[position] / relative_file, old.get(hash_name), signatures[position], current=position == 1)
                require({key: value for key, value in signatures[0].items() if key != 'ctimeMs'}
                        == {key: value for key, value in signatures[1].items() if key != 'ctimeMs'},
                        'Copied Codex catalog metadata changed beyond ctime.')
                new[signature_name] = old[signature_name]
            packages = [record.get('packageJson') for record in (old, new)]
            for position, package in enumerate(packages):
                require(isinstance(package, dict) and set(package) == {'path', 'hash', 'fileSignature'}
                        and package['path'] == 'package.json' and isinstance(package['fileSignature'], dict),
                        'Copied Codex package identity changed shape.')
                parsed = json.loads(catalog_file(physical[position] / 'package.json', package['hash'],
                                                 package['fileSignature'], current=position == 1))
                require(parsed.get('name') == '@openclaw/codex'
                        and parsed.get('version') == (old, new)[position].get('packageVersion'),
                        'Copied Codex package identity differs from its file.')
            require(packages[0]['hash'] == packages[1]['hash']
                    and {key: value for key, value in packages[0]['fileSignature'].items() if key != 'ctimeMs'}
                    == {key: value for key, value in packages[1]['fileSignature'].items() if key != 'ctimeMs'},
                    'Copied Codex package content or mtime changed.')
            source_hash = digest(physical[0] / 'dist/index.js')
            for root in physical:
                catalog_file(root / 'dist/index.js', source_hash)
            new['packageJson']['fileSignature'] = old['packageJson']['fileSignature']
        # Unknown changed records are deliberately left for exact comparison.


def retained_plugin_index(before, after, node, after_path, from_version='2026.9.2', to_version='2026.9.6',
                          *, app_releases=None, workspace_roots=None):
    """Qualify pinned migration or same-engine catalog effective content."""
    require((from_version, to_version) in NATIVE_MIGRATION_PAIRS | {('2026.9.6', '2026.9.6'), ('2026.9.8', '2026.9.8')},
            'Native machine-state regeneration is outside the reviewed engines.')
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
    for row, version in ((old[key], from_version), (new[key], to_version)):
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
    if from_version == to_version:
        require(new_index['generatedAtMs'] >= old_index['generatedAtMs'], 'Native plugin index generation moved backwards.')
        retained_catalog_files(indexes, app_releases, workspace_roots)
        effective = lambda index: {name: value for name, value in index.items() if name not in {'generatedAtMs', 'refreshReason'}}
        require(effective(old_index) == effective(new_index), 'Retained native plugin policy or effective catalog changed.')
        return
    records, updated = old_index['installRecords'], new_index['installRecords']
    require(set(records) == set(updated) and 'codex' in records
            and all(records[name] == updated[name] for name in records if name != 'codex')
            and records['codex'].get('version') == from_version, 'An unrelated native plugin installation changed.')
    executable = pathlib.Path(node) if node is not None else None
    require(executable is not None and executable.name == 'node' and executable.parent.name == 'bin'
            and executable.parent.parent.name == 'node' and executable.resolve(strict=True) == executable,
            'The Codex install needs the verified runtime closure.')
    runtime = executable.parent.parent.parent
    package = runtime / 'companions' / 'codex' / 'node_modules' / '@openclaw' / 'codex'
    require(package.resolve(strict=True) == package
            and bounded_json(runtime / 'node_modules' / 'openclaw' / 'package.json', 1024 * 1024).get('version') == to_version
            and bounded_json(package / 'package.json', 1024 * 1024).get('version') == to_version,
            'The Codex install differs from the verified runtime package.')
    record = updated['codex']
    lock = bounded_json(runtime / 'companions' / 'codex' / 'package-lock.json', 16 * 1024 * 1024)
    locked = lock.get('packages', {}).get('node_modules/@openclaw/codex', {})
    require(locked.get('version') == to_version and isinstance(locked.get('integrity'), str)
            and re.fullmatch(r'sha512-[A-Za-z0-9+/]+={0,2}', locked['integrity']), 'The verified Codex npm resolution is missing.')
    base_fields = {'source', 'spec', 'installPath', 'version', 'installedAt', 'resolvedName', 'resolvedVersion',
                   'resolvedSpec', 'integrity', 'shasum', 'resolvedAt'}
    consent_fields = {'acceptedSurface', 'acceptedSurfaceHash', 'acceptedSurfaceAt'}
    require(set(record) in (base_fields, base_fields | consent_fields)
            and record['source'] == 'npm' and record['version'] == record['resolvedVersion'] == to_version
            and record['spec'] == record['resolvedSpec'] == '@openclaw/codex@' + to_version
            and record['resolvedName'] == '@openclaw/codex' and record['integrity'] == locked['integrity']
            and isinstance(record['shasum'], str) and re.fullmatch('[a-f0-9]{40}', record['shasum'])
            and all(isinstance(record[name], str) and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z', record[name])
                    for name in ('installedAt', 'resolvedAt', 'acceptedSurfaceAt') if name in record),
            'The Codex installation is outside the reviewed transition.')
    installed = pathlib.Path(record['installPath'])
    prior = pathlib.Path(records['codex'].get('installPath', ''))
    # Official 9.8 update generations retain the previous project and publish a
    # new package-owned project. The fixed prefix and 16-hex generation suffix
    # come from install-paths-BylxcuP5.mjs; older transitions retain their rule.
    project_pattern = (r'openclaw-codex-8902d781d4(?:__openclaw-generation__g-[a-f0-9]{16})?'
                       if (from_version, to_version) == ('2026.9.6', '2026.9.8')
                       else r'openclaw-codex-[a-f0-9]{10}')
    require(installed.is_absolute() and prior.is_absolute() and len(installed.parts) >= 7
            and installed.parts[-6:-4] == ('npm', 'projects')
            and re.fullmatch(project_pattern, installed.parts[-4])
            and installed.parts[-3:] == ('node_modules', '@openclaw', 'codex')
            and installed.parts[:-6] == prior.parts[:-6], 'The official Codex npm store changed.')
    # Stored absolute paths retain the selected workspace namespace in closed
    # recovery copies; inspect the corresponding payload inside this tree.
    retained_package = pathlib.Path(after_path).parent.parent.joinpath(*installed.parts[-6:])
    require(retained_package.resolve(strict=True) == retained_package
            and bounded_json(retained_package / 'package.json', 1024 * 1024).get('name') == '@openclaw/codex'
            and bounded_json(retained_package / 'package.json', 1024 * 1024).get('version') == to_version,
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


# Official v2026.9.8 src/state/openclaw-agent-schema.sql; applied to a
# disposable schema model, never to retained or live data.
SESSION_SNAPSHOTS_98_SQL = '''CREATE TABLE IF NOT EXISTS session_entry_snapshots (
  session_key TEXT NOT NULL,
  field TEXT NOT NULL CHECK (field IN ('sessionDiffBaseline', 'skillsSnapshot', 'systemPromptReport')),
  value_json TEXT NOT NULL,
  PRIMARY KEY (session_key, field),
  FOREIGN KEY (session_key) REFERENCES session_nodes(session_key) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS session_entry_snapshots_after_insert
AFTER INSERT ON session_entry_snapshots
BEGIN
  UPDATE session_nodes SET snapshot_revision = snapshot_revision + 1
  WHERE session_key = NEW.session_key;
END;

CREATE TRIGGER IF NOT EXISTS session_entry_snapshots_after_update
AFTER UPDATE OF session_key, field, value_json ON session_entry_snapshots
WHEN NEW.session_key IS NOT OLD.session_key
  OR NEW.field IS NOT OLD.field OR NEW.value_json IS NOT OLD.value_json
BEGIN
  UPDATE session_nodes SET snapshot_revision = snapshot_revision + 1
  WHERE session_key IN (OLD.session_key, NEW.session_key);
END;

CREATE TRIGGER IF NOT EXISTS session_entry_snapshots_after_delete
AFTER DELETE ON session_entry_snapshots
BEGIN
  UPDATE session_nodes SET snapshot_revision = snapshot_revision + 1
  WHERE session_key = OLD.session_key;
END;

'''


PROFILE_IDENTITIES_98_SQL = '''CREATE TABLE IF NOT EXISTS user_profile_identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  canonical_login TEXT,
  created_at INTEGER NOT NULL,
  authorization_id TEXT,
  authorization_basis_json TEXT,
  PRIMARY KEY (provider, subject)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_user_profile_identities_profile_id
  ON user_profile_identities(profile_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_profile_identities_authorization
  ON user_profile_identities(authorization_id);'''

SESSION_SNAPSHOT_PROJECTION = r'''
import {readFileSync} from 'node:fs';
const result=JSON.parse(readFileSync(0,'utf8')).map(row=>{
 let entry; try {entry=JSON.parse(row.entry_json);} catch {return null;}
 if (!entry || typeof entry!=='object' || Array.isArray(entry) ||
     typeof entry.sessionId!=='string' || typeof entry.updatedAt!=='number' ||
     !Number.isFinite(entry.updatedAt) || entry.sessionId!==row.current_session_id ||
     entry.updatedAt!==row.updated_at) return null;
 const {sessionDiffBaseline,skillsSnapshot,systemPromptReport,...hot}=entry;
 const values={sessionDiffBaseline,skillsSnapshot,systemPromptReport}, snapshots=[];
 for(const field of ['sessionDiffBaseline','skillsSnapshot','systemPromptReport']) {
   const value=JSON.stringify(values[field]); if(value!==undefined) snapshots.push([field,value]);
 }
 return {entryJson:snapshots.length ? JSON.stringify(hot) : row.entry_json,snapshots};
});
process.stdout.write(JSON.stringify(result));
'''


def session_snapshot_projection(batch, node):
    """Use JS's exact number, property-order and JSON serialization semantics.

    The caller's immutable runtime manifest attests node. This fixed script has
    no dynamic imports, database writes or caller-provided executable text.
    """
    executable = pathlib.Path(node) if node is not None else None
    require(executable is not None and executable.resolve(strict=True) == executable
            and executable.is_file(), 'Session migration requires the verified Node executable.')
    require(len(batch) <= 64, 'Session projection exceeded its bounded batch.')
    raw = json.dumps(batch, ensure_ascii=True, separators=(',', ':')).encode()
    require(len(raw) <= 64 * 1024 * 1024, 'Session projection exceeded its byte bound.')
    result = subprocess.run([str(executable), '--input-type=module', '-e', SESSION_SNAPSHOT_PROJECTION],
                            input=raw, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60, check=False)
    require(result.returncode == 0 and len(result.stdout) <= 128 * 1024 * 1024,
            'Exact session snapshot projection failed.')
    projected = json.loads(result.stdout)
    require(isinstance(projected, list) and len(projected) == len(batch), 'Session projection returned invalid results.')
    return projected


def schema_definitions(connection):
    return Counter(connection.execute("select type,name,tbl_name,sql from sqlite_schema where name not like 'sqlite_%'"))


def native98_schema_change(before, after, tables, newer, agent):
    """Only canonical 23→24 snapshots and nullable 18→19 additions."""
    added = {'session_entry_snapshots'} if agent else (({'user_profile_identities'} - tables) & newer)
    require(newer == tables | added, 'Native 9.8 migration changed an unreviewed table set.')
    affected = {'session_nodes', 'session_entry_snapshots'} if agent else {'user_profile_identities', 'worktrees'}
    expected = schema_definitions(before)
    with contextlib.closing(sqlite3.connect(':memory:')) as model:
        for kind in ('table', 'index', 'trigger', 'view'):
            for entry in expected:
                if entry[0] == kind and entry[2] in affected and entry[3] is not None:
                    model.execute(entry[3])
        if agent:
            require('session_nodes' in tables and 'session_entry_snapshots' not in tables,
                    'The session snapshot migration source is not schema 23.')
            model.execute('ALTER TABLE session_nodes ADD COLUMN snapshot_revision INTEGER NOT NULL DEFAULT 0')
            model.executescript(SESSION_SNAPSHOTS_98_SQL)
        else:
            if 'user_profile_identities' in added:
                model.executescript(PROFILE_IDENTITIES_98_SQL)
                require(not rows(after, 'user_profile_identities'), 'Native migration fabricated profile authority.')
            for table, columns in (('user_profile_identities', ('authorization_id', 'authorization_basis_json')),
                                   ('worktrees', ('gc_protection_json',))):
                if table not in tables:
                    continue
                old_columns = {row[1] for row in before.execute('pragma table_info("' + table + '")')}
                new_columns = {row[1] for row in after.execute('pragma table_info("' + table + '")')}
                for column in columns:
                    require(column in new_columns, 'Native 9.8 startup omitted a required additive column.')
                    if column not in old_columns:
                        model.execute('ALTER TABLE "' + table + '" ADD COLUMN ' + column + ' TEXT')
                        require(after.execute('select 1 from "' + table + '" where "' + column + '" is not null limit 1').fetchone() is None,
                                'Native migration fabricated authorization or worktree protection.')
            if 'user_profile_identities' in tables:
                index = after.execute("select sql from sqlite_schema where type='index' and name='idx_user_profile_identities_authorization'").fetchone()
                require(index is not None, 'Native 9.8 startup omitted the authorization identity index.')
                model.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_user_profile_identities_authorization ON user_profile_identities(authorization_id)')
        expected = Counter({row: count for row, count in expected.items() if row[2] not in affected}) + schema_definitions(model)
        require(expected == schema_definitions(after), 'Native 9.8 migration changed unreviewed schema definitions.')


def migrated_session_snapshots(before, after, node):
    names = [row[1] for row in before.execute('pragma table_info(session_nodes)')]
    current_names = [row[1] for row in after.execute('pragma table_info(session_nodes)')]
    require(current_names == names + ['snapshot_revision'], 'Session snapshot columns differ from the official migration.')
    snapshots = Counter()
    count = 0
    with contextlib.closing(before.execute('select * from session_nodes order by session_key')) as cursor:
        while batch := cursor.fetchmany(64):
            records = [dict(zip(names, row)) for row in batch]
            for record in records:
                require(isinstance(record.get('session_key'), str) and isinstance(record.get('current_session_id'), str)
                        and type(record.get('updated_at')) in (int, float) and isinstance(record.get('entry_json'), str),
                        'Unreadable session row during snapshot migration.')
            projected = session_snapshot_projection(records, node)
            for previous, split in zip(records, projected):
                expected = {**previous, 'snapshot_revision': 0}
                if previous['entry_valid'] == 0:
                    expected['entry_valid'] = 1 if split is not None else -1
                if split is not None and split['snapshots']:
                    expected.update(entry_json=split['entryJson'], entry_valid=1, snapshot_revision=len(split['snapshots']))
                    for field, value in split['snapshots']:
                        snapshots[(previous['session_key'], field, value)] += 1
                actual = list(after.execute('select * from session_nodes where session_key=?', (previous['session_key'],)))
                require(actual == [tuple(expected[name] for name in current_names)],
                        'Migrated session content, identity or snapshot revision changed.')
                count += 1
    require(after.execute('select count(*) from session_nodes').fetchone()[0] == count
            and rows(after, 'session_entry_snapshots') == snapshots,
            'Migrated session snapshots were removed, fabricated or changed.')


def settled_session_validity_rows(connection, node, current_rows):
    """Exact 9.8 ensureSessionEntryValidityProjection for pending rows only.

    JSON, identity, snapshots and every unrelated field remain byte-exact.
    Already settled flags are never reclassified by this startup projection.
    An unchanged closed copy may keep pending zero before any startup occurs.
    """
    names = [row[1] for row in connection.execute('pragma table_info(session_nodes)')]
    require('entry_valid' in names, 'Native session validity column is missing.')
    position = names.index('entry_valid')
    expected = rows(connection, 'session_nodes')
    pending = [row for row in expected if row[position] == 0 and current_rows[row] < expected[row]]
    for offset in range(0, len(pending), 64):
        batch = pending[offset:offset + 64]
        projected = session_snapshot_projection([dict(zip(names, row)) for row in batch], node)
        for row, parsed in zip(batch, projected):
            current = list(row); current[position] = 1 if parsed is not None else -1
            count = expected.pop(row)
            expected[tuple(current)] += count
    return expected


def migrated_native98_rows(before, after, tables, newer, relative, after_path, node, boot_replacements,
                           app_releases=None, workspace_roots=None):
    agent = relative.name != 'openclaw.sqlite'
    native98_schema_change(before, after, tables, newer, agent)
    if agent:
        migrated_session_snapshots(before, after, node)
    for table in tables:
        if table == 'session_nodes' and agent:
            continue
        if table == 'config_machine_state':
            retained_plugin_index(before, after, node, after_path, '2026.9.6', '2026.9.8',
                                  app_releases=app_releases, workspace_roots=workspace_roots)
            continue
        if table not in NATIVE_RETAINED_TABLES | NATIVE_96_RETAINED_TABLES | NATIVE_RECONNECT_COLUMNS.keys():
            continue
        old_names = [row[1] for row in before.execute('pragma table_info("' + table + '")')]
        new_names = [row[1] for row in after.execute('pragma table_info("' + table + '")')]
        omitted = set(NATIVE_RECONNECT_COLUMNS.get(table, ()))
        selected = [name for name in old_names if name not in omitted]
        old_meta = before.execute("select schema_version,app_version from schema_meta where meta_key='primary'").fetchone() if table == 'schema_meta' else None
        def project(connection, names, newer_side):
            result = Counter()
            source = native_restart_rows(before, after, table, relative, after_path, boot_replacements) if newer_side and table in {'session_key_contract', 'plugin_state_entries'} else rows(connection, table)
            for row, multiplicity in source.items():
                value = dict(zip(names, row))
                if newer_side:
                    value = native_boot_row(table, value, boot_replacements)
                    if table == 'schema_meta' and value.get('meta_key') == 'primary':
                        require(old_meta is not None and value['schema_version'] == (24 if agent else 19)
                                and value['app_version'] in {'2026.9.8', old_meta[1]}, 'Native migrated schema ownership changed.')
                        value['schema_version'], value['app_version'] = old_meta
                    if table == 'agent_databases' and value.get('schema_version') == 24:
                        value['schema_version'] = 23
                if table == 'device_pairing_paired' and value.get('tokens_json') is not None:
                    tokens = json.loads(value['tokens_json'])
                    for role, token in tokens.items():
                        require(token.get('role') == role and isinstance(token.get('token'), str), 'Native token identity changed.')
                        token.pop('lastUsedAtMs', None)
                    value['tokens_json'] = json.dumps(tokens, sort_keys=True, separators=(',', ':'))
                result[tuple(value[name] for name in selected)] += multiplicity
            return result
        require(project(before, old_names, False) == project(after, new_names, True),
                'Native 9.8 migration changed retained work, history, configuration or authority.')


def migrated_native_rows(before, after, tables, before_path, after_path, node, boot_replacements=None):
    for table in tables:
        require(re.fullmatch(r'[a-zA-Z0-9_]+', table), 'Unexpected native table name.')
        if table == 'config_machine_state':
            retained_plugin_index(before, after, node, after_path)
            continue
        if table == 'transcript_events':
            require(transcript_hashes(before_path, node) <= transcript_hashes(after.database_path, node), 'Migrated native transcript bytes changed.')
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


def native_saved_state(snapshot, live, expected_epoch=None, from_version='2026.9.2', to_version=None, node=None, app_releases=None,
                       log_retention_window=None, log_retention_reports=None, *, session_binding_key=None, session_binding_node=None,
                       logical_workspace_root=None):
    to_version = to_version or from_version
    migrating = from_version != to_version
    require(not migrating or (from_version, to_version) in NATIVE_MIGRATION_PAIRS, 'Native migration is outside the reviewed pair.')
    before_selected, before_epoch, before_paths = native_scope(snapshot, expected_epoch, closed=True)
    selected, epoch, paths = native_scope(live, before_epoch, closed=True)
    require(before_selected == selected and before_epoch == epoch and before_paths == paths, 'The selected native database authority changed.')
    if logical_workspace_root is not None:
        # An unstarted independent copy retains absolute names from the actual
        # closed workspace. Bind that namespace to its selected epoch and exact
        # canonical database set; never accept arbitrary cached absolute paths.
        require(not migrating and log_retention_window is None and session_binding_key is None
                and session_binding_node is None, 'Logical workspace authority is only for an unchanged pre-start copy.')
        logical_workspace_root = pathlib.Path(logical_workspace_root)
        require(logical_workspace_root.is_absolute() and logical_workspace_root.resolve(strict=True) == logical_workspace_root
                and logical_workspace_root != live and not logical_workspace_root.is_relative_to(live)
                and not live.is_relative_to(logical_workspace_root), 'The logical workspace authority must be the separate canonical original.')
        logical_selected, logical_epoch, logical_paths = native_scope(logical_workspace_root, before_epoch, closed=True)
        require((logical_selected, logical_epoch, logical_paths) == (selected, epoch, paths),
                'The pre-start copy differs from the authoritative selected workspace.')
    configuration = native_runtime_configuration(snapshot, live, selected, from_version, to_version, app_releases,
                                                  session_binding_key=session_binding_key, session_binding_node=session_binding_node,
                                                  logical_workspace_root=logical_workspace_root)
    embedded = retained_embedded_databases(snapshot, live, selected, paths, from_version, to_version,
                                          log_retention_window, log_retention_reports)
    quarantine = retained_quarantine_cache(snapshot, live, selected, paths, from_version, to_version,
                                          logical_workspace_root=logical_workspace_root)
    require(static_sqlite_files(snapshot, selected, paths | embedded | quarantine) == static_sqlite_files(live, selected, paths | embedded | quarantine), 'An inactive database, archived store or nonactive cache changed.')
    for relative in sorted(before_paths):
        with contextlib.closing(database(snapshot / relative, True)) as before, contextlib.closing(database(live / relative, True)) as after:
            require(before.execute('pragma quick_check').fetchone()[0] == after.execute('pragma quick_check').fetchone()[0] == 'ok', 'Native saved database integrity failed.')
            old_tables = native_schema(before, relative, from_version)
            new_tables = native_schema(after, relative, to_version, old_tables if migrating else None)
            boot_replacements = native_boot_replacements(before, after, old_tables & new_tables, configuration, from_version, to_version, node)
            if (from_version, to_version) == ('2026.9.6', '2026.9.8'):
                migrated_native98_rows(before, after, old_tables, new_tables, relative, live / relative, node, boot_replacements, app_releases, (snapshot, live, logical_workspace_root or live, selected))
                continue
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
                    if to_version in {'2026.9.6', '2026.9.8'}:
                        retained_plugin_index(before, after, node, live / relative, from_version, to_version,
                                              app_releases=app_releases,
                                              workspace_roots=(snapshot, live, logical_workspace_root or live, selected))
                    else:
                        require(rows(before, table) == rows(after, table), 'Retained native machine configuration changed.')
                elif to_version == '2026.9.8' and table == 'session_nodes':
                    current = rows(after, table)
                    require(settled_session_validity_rows(before, node, current) <= current,
                            'Retained session content or exact pending validity projection changed.')
                elif table in NATIVE_RETAINED_TABLES | NATIVE_96_RETAINED_TABLES | NATIVE_98_RETAINED_TABLES:
                    retained = rows(before, table)
                    current = (native_restart_rows(before, after, table, relative, live / relative, boot_replacements)
                               if to_version in {'2026.9.6', '2026.9.8'} else native_boot_rows(after, table, boot_replacements))
                    require(retained == current if to_version == '2026.9.8' and table in {'session_entry_snapshots', 'user_profile_identities'} else retained <= current,
                            'Retained native work, history, configuration or permissions changed.')
                elif table in NATIVE_RECONNECT_COLUMNS:
                    require(native_projected_rows(before, table) <= native_projected_rows(after, table, boot_replacements), 'Retained native identity, account content or permissions changed.')
