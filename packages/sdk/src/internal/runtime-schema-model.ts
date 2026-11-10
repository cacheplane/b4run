/** Trusted additive physical2 source contract. No live/marker input. */
export type RecoveryBackend = "sqlite" | "postgres"
export interface RecoveryNaming {
  readonly schema: string
  readonly prefix: string
}
export interface RecoveryForeignKey {
  readonly columns: readonly string[]
  readonly target: string
  readonly targetColumns: readonly string[]
  readonly onUpdate: string
  readonly onDelete: string
  readonly deferrable: boolean
  readonly initiallyDeferred: boolean
}
export interface RecoveryTable {
  readonly name: string
  readonly columns: readonly string[]
  readonly primaryKey: readonly string[]
  readonly foreignKeys: readonly RecoveryForeignKey[]
  readonly unique: readonly (readonly string[])[]
  readonly indexes: readonly { readonly name: string; readonly columns: readonly string[] }[]
  readonly checks: readonly string[]
}
export const recoveryTables: readonly RecoveryTable[] = [
  {
    name: "runtime_recovery_keys",
    columns: [
      "singleton INTEGER NOT NULL CHECK(singleton=1)",
      "key_version INTEGER NOT NULL CHECK(key_version=1)",
      "key_hex TEXT NOT NULL",
    ],
    primaryKey: ["singleton"],
    foreignKeys: [
      {
        columns: ["singleton"],
        target: "runtime_installation",
        targetColumns: ["singleton"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: false,
        initiallyDeferred: false,
      },
    ],
    unique: [],
    indexes: [],
    checks: ["length(key_hex)=64", "HEX64(key_hex)"],
  },
  {
    name: "recovery_scopes",
    columns: [
      "scope_key TEXT NOT NULL CHECK(length(scope_key)=32 AND HEX32(scope_key))",
      "thread_id TEXT NOT NULL, generation TEXT NOT NULL",
      "scope_hash TEXT NOT NULL CHECK(length(scope_hash)=64 AND HEX64(scope_hash))",
      "scope_identity_json TEXT NOT NULL",
    ],
    primaryKey: ["scope_key"],
    foreignKeys: [
      {
        columns: ["thread_id", "generation"],
        target: "scopes",
        targetColumns: ["thread_id", "generation"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: false,
        initiallyDeferred: false,
      },
    ],
    unique: [],
    indexes: [
      {
        name: "rec_scope_lookup",
        columns: ["scope_hash"],
      },
    ],
    checks: ["JSON_ARRAY(scope_identity_json)"],
  },
  {
    name: "recovery_entities",
    columns: [
      "thread_id TEXT NOT NULL, generation TEXT NOT NULL",
      "scope_key TEXT NOT NULL CHECK(length(scope_key)=32 AND HEX32(scope_key))",
      "entity_key TEXT NOT NULL CHECK(length(entity_key)=32 AND HEX32(entity_key))",
      "entity_kind TEXT NOT NULL CHECK((entity_kind='thread' OR entity_kind='run' OR entity_kind='turn' OR entity_kind='pending' OR entity_kind='activity' OR entity_kind='message' OR entity_kind='namespace' OR entity_kind='maintenance' OR entity_kind='checkpoint'))",
      "identity_hash TEXT NOT NULL CHECK(length(identity_hash)=64 AND HEX64(identity_hash))",
      "identity_json TEXT NOT NULL",
      "namespace_json TEXT NOT NULL",
      "public_id_json TEXT NOT NULL",
    ],
    primaryKey: ["scope_key", "entity_key"],
    foreignKeys: [
      {
        columns: ["thread_id", "generation"],
        target: "scopes",
        targetColumns: ["thread_id", "generation"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: false,
        initiallyDeferred: false,
      },
      {
        columns: ["scope_key"],
        target: "recovery_scopes",
        targetColumns: ["scope_key"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: false,
        initiallyDeferred: false,
      },
    ],
    unique: [],
    indexes: [
      {
        name: "rec_entity_lookup",
        columns: ["scope_key", "identity_hash"],
      },
    ],
    checks: [
      "JSON_ARRAY(identity_json)",
      "JSON_ARRAY(namespace_json)",
      "JSON_VALID(public_id_json)",
    ],
  },
  {
    name: "recovery_generations",
    columns: [
      "thread_id TEXT NOT NULL, generation TEXT NOT NULL",
      "scope_key TEXT NOT NULL CHECK(length(scope_key)=32 AND HEX32(scope_key))",
      "baseline_kind TEXT NOT NULL CHECK((baseline_kind='fresh_empty' OR baseline_kind='legacy_unknown'))",
      "legacy_through_seq INTEGER NOT NULL CHECK((legacy_through_seq>=0 AND legacy_through_seq<=9007199254740991))",
      "replay_after_seq INTEGER NOT NULL CHECK((replay_after_seq>=0 AND replay_after_seq<=9007199254740991))",
      "branch_id TEXT NOT NULL CHECK(length(branch_id)=36)",
      "current_cut_seq INTEGER",
      "history_epoch INTEGER NOT NULL CHECK((history_epoch>=0 AND history_epoch<=9007199254740991))",
      "open_bytes INTEGER CHECK((open_bytes>=0 AND open_bytes<=9007199254740991))",
      "pending_bytes INTEGER CHECK((pending_bytes>=0 AND pending_bytes<=9007199254740991))",
      "pending_count INTEGER CHECK((pending_count>=0 AND pending_count<=9007199254740991))",
      "recent_bytes INTEGER CHECK((recent_bytes>=0 AND recent_bytes<=9007199254740991))",
      "recent_count INTEGER CHECK((recent_count>=0 AND recent_count<=9007199254740991))",
      "accounting_status TEXT NOT NULL CHECK((accounting_status='available' OR accounting_status='unknown'))",
    ],
    primaryKey: ["scope_key"],
    foreignKeys: [
      {
        columns: ["thread_id", "generation"],
        target: "scopes",
        targetColumns: ["thread_id", "generation"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: false,
        initiallyDeferred: false,
      },
      {
        columns: ["scope_key", "branch_id"],
        target: "recovery_branches",
        targetColumns: ["scope_key", "branch_id"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: true,
        initiallyDeferred: true,
      },
      {
        columns: ["scope_key", "current_cut_seq"],
        target: "recovery_cuts",
        targetColumns: ["scope_key", "through_seq"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: true,
        initiallyDeferred: true,
      },
      {
        columns: ["scope_key"],
        target: "recovery_scopes",
        targetColumns: ["scope_key"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: false,
        initiallyDeferred: false,
      },
    ],
    unique: [],
    indexes: [],
    checks: [
      "replay_after_seq>=legacy_through_seq",
      "current_cut_seq IS NULL OR (current_cut_seq>=0 AND current_cut_seq<=9007199254740991)",
      "recent_count IS NULL OR recent_count<=256",
      "recent_bytes IS NULL OR recent_bytes<=1048576",
      "(accounting_status='available' AND open_bytes IS NOT NULL AND pending_bytes IS NOT NULL AND pending_count IS NOT NULL AND recent_bytes IS NOT NULL AND recent_count IS NOT NULL) OR (accounting_status='unknown' AND open_bytes IS NULL AND pending_bytes IS NULL AND pending_count IS NULL AND recent_bytes IS NULL AND recent_count IS NULL)",
    ],
  },
  {
    name: "recovery_branches",
    columns: [
      "thread_id TEXT NOT NULL, generation TEXT NOT NULL",
      "scope_key TEXT NOT NULL CHECK(length(scope_key)=32 AND HEX32(scope_key))",
      "branch_id TEXT NOT NULL CHECK(length(branch_id)=36)",
      "parent_branch_id TEXT",
      "born_seq INTEGER NOT NULL CHECK((born_seq>=0 AND born_seq<=9007199254740991))",
      "invalidated_seq INTEGER",
      "root_checkpoint_id TEXT",
    ],
    primaryKey: ["scope_key", "branch_id"],
    foreignKeys: [
      {
        columns: ["thread_id", "generation"],
        target: "scopes",
        targetColumns: ["thread_id", "generation"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: false,
        initiallyDeferred: false,
      },
      {
        columns: ["scope_key", "parent_branch_id"],
        target: "recovery_branches",
        targetColumns: ["scope_key", "branch_id"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: true,
        initiallyDeferred: true,
      },
      {
        columns: ["thread_id", "generation", "root_checkpoint_id"],
        target: "checkpoint_identities",
        targetColumns: ["thread_id", "generation", "id"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: true,
        initiallyDeferred: true,
      },
      {
        columns: ["scope_key"],
        target: "recovery_scopes",
        targetColumns: ["scope_key"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: false,
        initiallyDeferred: false,
      },
    ],
    unique: [],
    indexes: [],
    checks: [
      "invalidated_seq IS NULL OR (invalidated_seq>=born_seq AND invalidated_seq<=9007199254740991)",
    ],
  },
  {
    name: "recovery_objects",
    columns: [
      "thread_id TEXT NOT NULL, generation TEXT NOT NULL",
      "scope_key TEXT NOT NULL CHECK(length(scope_key)=32 AND HEX32(scope_key))",
      "object_id TEXT NOT NULL",
      "kind TEXT NOT NULL CHECK((kind='state' OR kind='thread' OR kind='run' OR kind='turn' OR kind='pending' OR kind='activity' OR kind='message_header' OR kind='message_fragment' OR kind='history_fragment' OR kind='namespace' OR kind='maintenance'))",
      "payload TEXT NOT NULL",
      "payload_bytes INTEGER NOT NULL CHECK((payload_bytes>=0 AND payload_bytes<=9007199254740991))",
    ],
    primaryKey: ["scope_key", "object_id"],
    foreignKeys: [
      {
        columns: ["thread_id", "generation"],
        target: "scopes",
        targetColumns: ["thread_id", "generation"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: false,
        initiallyDeferred: false,
      },
      {
        columns: ["scope_key"],
        target: "recovery_scopes",
        targetColumns: ["scope_key"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: false,
        initiallyDeferred: false,
      },
    ],
    unique: [],
    indexes: [],
    checks: [
      "length(object_id)=64",
      "HEX64(object_id)",
      "JSON_VALID(payload)",
      "UTF8_BYTES(payload)=payload_bytes",
    ],
  },
  {
    name: "recovery_checkpoints",
    columns: [
      "thread_id TEXT NOT NULL, generation TEXT NOT NULL",
      "scope_key TEXT NOT NULL CHECK(length(scope_key)=32 AND HEX32(scope_key))",
      "checkpoint_key TEXT NOT NULL CHECK(length(checkpoint_key)=32 AND HEX32(checkpoint_key))",
      "checkpoint_id TEXT NOT NULL",
      "version_seq INTEGER NOT NULL CHECK((version_seq>=0 AND version_seq<=9007199254740991))",
      "source_seq INTEGER NOT NULL CHECK((source_seq>=0 AND source_seq<=9007199254740991))",
      "namespace_json TEXT NOT NULL",
      "owner_run_id TEXT",
      "turn_id TEXT",
      "parent_checkpoint_id TEXT",
      "state_status TEXT NOT NULL CHECK((state_status='available' OR state_status='unknown'))",
      "values_object_id TEXT",
      "messages_supported INTEGER NOT NULL CHECK((messages_supported=0 OR messages_supported=1))",
      "authority_alias_id TEXT",
    ],
    primaryKey: ["scope_key", "checkpoint_key", "version_seq"],
    foreignKeys: [
      {
        columns: ["thread_id", "generation"],
        target: "scopes",
        targetColumns: ["thread_id", "generation"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: false,
        initiallyDeferred: false,
      },
      {
        columns: ["thread_id", "generation", "owner_run_id"],
        target: "run_identities",
        targetColumns: ["thread_id", "generation", "id"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: true,
        initiallyDeferred: true,
      },
      {
        columns: ["thread_id", "generation", "turn_id"],
        target: "run_identities",
        targetColumns: ["thread_id", "generation", "id"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: true,
        initiallyDeferred: true,
      },
      {
        columns: ["thread_id", "generation", "checkpoint_id"],
        target: "checkpoint_identities",
        targetColumns: ["thread_id", "generation", "id"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: true,
        initiallyDeferred: true,
      },
      {
        columns: ["thread_id", "generation", "parent_checkpoint_id"],
        target: "checkpoint_identities",
        targetColumns: ["thread_id", "generation", "id"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: true,
        initiallyDeferred: true,
      },
      {
        columns: ["scope_key", "values_object_id"],
        target: "recovery_objects",
        targetColumns: ["scope_key", "object_id"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: true,
        initiallyDeferred: true,
      },
      {
        columns: ["scope_key", "version_seq"],
        target: "recovery_cuts",
        targetColumns: ["scope_key", "through_seq"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: true,
        initiallyDeferred: true,
      },
      {
        columns: ["scope_key"],
        target: "recovery_scopes",
        targetColumns: ["scope_key"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: false,
        initiallyDeferred: false,
      },
      {
        columns: ["scope_key", "checkpoint_key"],
        target: "recovery_entities",
        targetColumns: ["scope_key", "entity_key"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: false,
        initiallyDeferred: false,
      },
    ],
    unique: [],
    indexes: [
      {
        name: "rec_state_ns_seq",
        columns: ["scope_key", "version_seq DESC", "checkpoint_key"],
      },
    ],
    checks: [
      "source_seq<=version_seq",
      "(state_status='available' AND values_object_id IS NOT NULL) OR (state_status='unknown' AND values_object_id IS NULL)",
      "JSON_ARRAY(namespace_json)",
    ],
  },
  {
    name: "recovery_versions",
    columns: [
      "thread_id TEXT NOT NULL, generation TEXT NOT NULL",
      "scope_key TEXT NOT NULL CHECK(length(scope_key)=32 AND HEX32(scope_key))",
      "entity_kind TEXT NOT NULL CHECK((entity_kind='thread' OR entity_kind='run' OR entity_kind='turn' OR entity_kind='pending' OR entity_kind='activity' OR entity_kind='message' OR entity_kind='namespace' OR entity_kind='maintenance'))",
      "entity_key TEXT NOT NULL CHECK(length(entity_key)=32 AND HEX32(entity_key))",
      "version_seq INTEGER NOT NULL CHECK((version_seq>=0 AND version_seq<=9007199254740991))",
      "source_seq INTEGER NOT NULL CHECK((source_seq>=0 AND source_seq<=9007199254740991))",
      "namespace_json TEXT NOT NULL",
      "owner_run_id TEXT",
      "turn_id TEXT",
      "checkpoint_id TEXT",
      "object_id TEXT NOT NULL",
      "is_open INTEGER NOT NULL CHECK((is_open=0 OR is_open=1))",
      "is_deleted INTEGER NOT NULL CHECK((is_deleted=0 OR is_deleted=1))",
      "authority_alias_id TEXT",
      "previous_version_seq INTEGER",
    ],
    primaryKey: ["scope_key", "entity_kind", "entity_key", "version_seq"],
    foreignKeys: [
      {
        columns: ["thread_id", "generation"],
        target: "scopes",
        targetColumns: ["thread_id", "generation"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: false,
        initiallyDeferred: false,
      },
      {
        columns: ["thread_id", "generation", "owner_run_id"],
        target: "run_identities",
        targetColumns: ["thread_id", "generation", "id"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: true,
        initiallyDeferred: true,
      },
      {
        columns: ["thread_id", "generation", "turn_id"],
        target: "run_identities",
        targetColumns: ["thread_id", "generation", "id"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: true,
        initiallyDeferred: true,
      },
      {
        columns: ["thread_id", "generation", "checkpoint_id"],
        target: "checkpoint_identities",
        targetColumns: ["thread_id", "generation", "id"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: true,
        initiallyDeferred: true,
      },
      {
        columns: ["scope_key", "object_id"],
        target: "recovery_objects",
        targetColumns: ["scope_key", "object_id"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: true,
        initiallyDeferred: true,
      },
      {
        columns: ["scope_key", "version_seq"],
        target: "recovery_cuts",
        targetColumns: ["scope_key", "through_seq"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: true,
        initiallyDeferred: true,
      },
      {
        columns: ["scope_key", "entity_kind", "entity_key", "previous_version_seq"],
        target: "recovery_versions",
        targetColumns: ["scope_key", "entity_kind", "entity_key", "version_seq"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: true,
        initiallyDeferred: true,
      },
      {
        columns: ["scope_key"],
        target: "recovery_scopes",
        targetColumns: ["scope_key"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: false,
        initiallyDeferred: false,
      },
      {
        columns: ["scope_key", "entity_key"],
        target: "recovery_entities",
        targetColumns: ["scope_key", "entity_key"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: false,
        initiallyDeferred: false,
      },
    ],
    unique: [],
    indexes: [
      {
        name: "rec_versions_cut",
        columns: ["scope_key", "entity_kind", "entity_key", "version_seq DESC"],
      },
      {
        name: "rec_versions_tail",
        columns: ["scope_key", "version_seq DESC", "entity_kind", "entity_key"],
      },
    ],
    checks: [
      "source_seq<=version_seq",
      "JSON_ARRAY(namespace_json)",
      "previous_version_seq IS NULL OR previous_version_seq<version_seq",
    ],
  },
  {
    name: "recovery_current",
    columns: [
      "thread_id TEXT NOT NULL, generation TEXT NOT NULL",
      "scope_key TEXT NOT NULL CHECK(length(scope_key)=32 AND HEX32(scope_key))",
      "entity_kind TEXT NOT NULL CHECK((entity_kind='thread' OR entity_kind='run' OR entity_kind='turn' OR entity_kind='pending' OR entity_kind='activity' OR entity_kind='message' OR entity_kind='namespace' OR entity_kind='maintenance'))",
      "entity_key TEXT NOT NULL CHECK(length(entity_key)=32 AND HEX32(entity_key))",
      "version_seq INTEGER NOT NULL CHECK((version_seq>=0 AND version_seq<=9007199254740991))",
      "namespace_json TEXT NOT NULL",
      "is_open INTEGER NOT NULL CHECK((is_open=0 OR is_open=1))",
      "wire_bytes INTEGER NOT NULL CHECK((wire_bytes>=0 AND wire_bytes<=9007199254740991))",
    ],
    primaryKey: ["scope_key", "entity_kind", "entity_key"],
    foreignKeys: [
      {
        columns: ["thread_id", "generation"],
        target: "scopes",
        targetColumns: ["thread_id", "generation"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: false,
        initiallyDeferred: false,
      },
      {
        columns: ["scope_key", "entity_kind", "entity_key", "version_seq"],
        target: "recovery_versions",
        targetColumns: ["scope_key", "entity_kind", "entity_key", "version_seq"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: true,
        initiallyDeferred: true,
      },
      {
        columns: ["scope_key"],
        target: "recovery_scopes",
        targetColumns: ["scope_key"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: false,
        initiallyDeferred: false,
      },
      {
        columns: ["scope_key", "entity_key"],
        target: "recovery_entities",
        targetColumns: ["scope_key", "entity_key"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: false,
        initiallyDeferred: false,
      },
    ],
    unique: [],
    indexes: [
      {
        name: "rec_current_open",
        columns: ["scope_key", "is_open", "entity_kind", "entity_key"],
      },
      {
        name: "rec_current_recent",
        columns: ["scope_key", "entity_kind", "version_seq DESC", "entity_key"],
      },
    ],
    checks: ["JSON_ARRAY(namespace_json)"],
  },
  {
    name: "recovery_cuts",
    columns: [
      "thread_id TEXT NOT NULL, generation TEXT NOT NULL",
      "scope_key TEXT NOT NULL CHECK(length(scope_key)=32 AND HEX32(scope_key))",
      "through_seq INTEGER NOT NULL CHECK((through_seq>=0 AND through_seq<=9007199254740991))",
      "public_revision_json TEXT NOT NULL",
      "branch_id TEXT NOT NULL CHECK(length(branch_id)=36)",
      "history_epoch INTEGER NOT NULL CHECK((history_epoch>=0 AND history_epoch<=9007199254740991))",
      "previous_cut_seq INTEGER",
      "selected_checkpoint_key TEXT",
      "selected_checkpoint_version_seq INTEGER",
      "values_object_id TEXT",
      "state_status TEXT NOT NULL CHECK((state_status='available' OR state_status='unknown'))",
      "activity_status TEXT NOT NULL CHECK((activity_status='available' OR activity_status='unknown'))",
      "public_fingerprint TEXT NOT NULL",
      "open_bytes INTEGER CHECK((open_bytes>=0 AND open_bytes<=9007199254740991))",
      "pending_bytes INTEGER CHECK((pending_bytes>=0 AND pending_bytes<=9007199254740991))",
      "pending_count INTEGER CHECK((pending_count>=0 AND pending_count<=9007199254740991))",
      "recent_bytes INTEGER CHECK((recent_bytes>=0 AND recent_bytes<=9007199254740991))",
      "recent_count INTEGER CHECK((recent_count>=0 AND recent_count<=9007199254740991))",
      "accounting_status TEXT NOT NULL CHECK((accounting_status='available' OR accounting_status='unknown'))",
    ],
    primaryKey: ["scope_key", "through_seq"],
    foreignKeys: [
      {
        columns: ["thread_id", "generation"],
        target: "scopes",
        targetColumns: ["thread_id", "generation"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: false,
        initiallyDeferred: false,
      },
      {
        columns: ["scope_key", "branch_id"],
        target: "recovery_branches",
        targetColumns: ["scope_key", "branch_id"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: true,
        initiallyDeferred: true,
      },
      {
        columns: ["scope_key", "selected_checkpoint_key", "selected_checkpoint_version_seq"],
        target: "recovery_checkpoints",
        targetColumns: ["scope_key", "checkpoint_key", "version_seq"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: true,
        initiallyDeferred: true,
      },
      {
        columns: ["scope_key", "values_object_id"],
        target: "recovery_objects",
        targetColumns: ["scope_key", "object_id"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: true,
        initiallyDeferred: true,
      },
      {
        columns: ["scope_key"],
        target: "recovery_scopes",
        targetColumns: ["scope_key"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: false,
        initiallyDeferred: false,
      },
    ],
    unique: [],
    indexes: [],
    checks: [
      "previous_cut_seq IS NULL OR previous_cut_seq<through_seq",
      "(selected_checkpoint_key IS NULL)=(selected_checkpoint_version_seq IS NULL)",
      "(state_status='available' AND values_object_id IS NOT NULL) OR (state_status='unknown' AND values_object_id IS NULL)",
      "length(public_fingerprint)=64",
      "HEX64(public_fingerprint)",
      "recent_count IS NULL OR recent_count<=256",
      "recent_bytes IS NULL OR recent_bytes<=1048576",
      "(accounting_status='available' AND open_bytes IS NOT NULL AND pending_bytes IS NOT NULL AND pending_count IS NOT NULL AND recent_bytes IS NOT NULL AND recent_count IS NOT NULL) OR (accounting_status='unknown' AND open_bytes IS NULL AND pending_bytes IS NULL AND pending_count IS NULL AND recent_bytes IS NULL AND recent_count IS NULL)",
      "JSON_STRING(public_revision_json)",
    ],
  },
  {
    name: "recovery_fragments",
    columns: [
      "thread_id TEXT NOT NULL, generation TEXT NOT NULL",
      "scope_key TEXT NOT NULL CHECK(length(scope_key)=32 AND HEX32(scope_key))",
      "branch_id TEXT NOT NULL CHECK(length(branch_id)=36)",
      "fragment_id TEXT NOT NULL CHECK(length(fragment_id)=36)",
      "item_key TEXT NOT NULL CHECK(length(item_key)=32 AND HEX32(item_key))",
      "fragment_index INTEGER NOT NULL CHECK((fragment_index>=0 AND fragment_index<=9007199254740991))",
      "source_seq INTEGER NOT NULL CHECK((source_seq>=0 AND source_seq<=9007199254740991))",
      "commit_seq INTEGER NOT NULL CHECK((commit_seq>=0 AND commit_seq<=9007199254740991))",
      "namespace_json TEXT NOT NULL",
      "owner_run_id TEXT",
      "turn_id TEXT",
      "kind TEXT NOT NULL CHECK((kind='message' OR kind='activity'))",
      "operation TEXT NOT NULL CHECK((operation='append' OR operation='replace' OR operation='remove'))",
      "object_id TEXT NOT NULL",
      "authority_alias_id TEXT",
    ],
    primaryKey: ["scope_key", "branch_id", "fragment_id"],
    foreignKeys: [
      {
        columns: ["thread_id", "generation"],
        target: "scopes",
        targetColumns: ["thread_id", "generation"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: false,
        initiallyDeferred: false,
      },
      {
        columns: ["thread_id", "generation", "owner_run_id"],
        target: "run_identities",
        targetColumns: ["thread_id", "generation", "id"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: true,
        initiallyDeferred: true,
      },
      {
        columns: ["thread_id", "generation", "turn_id"],
        target: "run_identities",
        targetColumns: ["thread_id", "generation", "id"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: true,
        initiallyDeferred: true,
      },
      {
        columns: ["scope_key", "branch_id"],
        target: "recovery_branches",
        targetColumns: ["scope_key", "branch_id"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: true,
        initiallyDeferred: true,
      },
      {
        columns: ["scope_key", "commit_seq"],
        target: "recovery_cuts",
        targetColumns: ["scope_key", "through_seq"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: true,
        initiallyDeferred: true,
      },
      {
        columns: ["scope_key", "object_id"],
        target: "recovery_objects",
        targetColumns: ["scope_key", "object_id"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: true,
        initiallyDeferred: true,
      },
      {
        columns: ["scope_key"],
        target: "recovery_scopes",
        targetColumns: ["scope_key"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: false,
        initiallyDeferred: false,
      },
      {
        columns: ["scope_key", "item_key"],
        target: "recovery_entities",
        targetColumns: ["scope_key", "entity_key"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: false,
        initiallyDeferred: false,
      },
    ],
    unique: [["scope_key", "branch_id", "item_key", "fragment_index"]],
    indexes: [
      {
        name: "rec_hist_item",
        columns: ["scope_key", "branch_id", "item_key", "fragment_index"],
      },
      {
        name: "rec_hist_commit",
        columns: ["scope_key", "branch_id", "commit_seq", "source_seq", "fragment_id"],
      },
    ],
    checks: ["source_seq<=commit_seq", "JSON_ARRAY(namespace_json)"],
  },
  {
    name: "recovery_anchors",
    columns: [
      "thread_id TEXT NOT NULL, generation TEXT NOT NULL",
      "scope_key TEXT NOT NULL CHECK(length(scope_key)=32 AND HEX32(scope_key))",
      "branch_id TEXT NOT NULL CHECK(length(branch_id)=36)",
      "fragment_id TEXT NOT NULL CHECK(length(fragment_id)=36)",
      "link_seq INTEGER NOT NULL CHECK((link_seq>=0 AND link_seq<=9007199254740991))",
      "checkpoint_key TEXT NOT NULL",
      "checkpoint_version_seq INTEGER NOT NULL CHECK((checkpoint_version_seq>=0 AND checkpoint_version_seq<=9007199254740991))",
      "checkpoint_fragment_index INTEGER NOT NULL CHECK((checkpoint_fragment_index>=0 AND checkpoint_fragment_index<=9007199254740991))",
    ],
    primaryKey: ["scope_key", "branch_id", "fragment_id"],
    foreignKeys: [
      {
        columns: ["thread_id", "generation"],
        target: "scopes",
        targetColumns: ["thread_id", "generation"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: false,
        initiallyDeferred: false,
      },
      {
        columns: ["scope_key", "branch_id", "fragment_id"],
        target: "recovery_fragments",
        targetColumns: ["scope_key", "branch_id", "fragment_id"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: true,
        initiallyDeferred: true,
      },
      {
        columns: ["scope_key", "checkpoint_key", "checkpoint_version_seq"],
        target: "recovery_checkpoints",
        targetColumns: ["scope_key", "checkpoint_key", "version_seq"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: true,
        initiallyDeferred: true,
      },
      {
        columns: ["scope_key", "link_seq"],
        target: "recovery_cuts",
        targetColumns: ["scope_key", "through_seq"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: true,
        initiallyDeferred: true,
      },
      {
        columns: ["scope_key"],
        target: "recovery_scopes",
        targetColumns: ["scope_key"],
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        deferrable: false,
        initiallyDeferred: false,
      },
    ],
    unique: [["scope_key", "branch_id", "checkpoint_key", "checkpoint_fragment_index"]],
    indexes: [
      {
        name: "rec_hist_page",
        columns: [
          "scope_key",
          "branch_id",
          "checkpoint_key",
          "checkpoint_fragment_index DESC",
          "link_seq",
        ],
      },
    ],
    checks: [
      "checkpoint_version_seq<=link_seq",
      "length(checkpoint_key)=32 AND HEX32(checkpoint_key)",
    ],
  },
]
const tags = ["rk", "rs", "re", "rg", "rb", "ro", "rcp", "rv", "rc", "rct", "rf", "ra"] as const
export function recoveryTableTag(name: string): string {
  const tag = tags[recoveryTables.findIndex((table) => table.name === name)]
  if (!tag) throw new Error("Unknown source recovery table")
  return tag
}
const int4Columns = new Set([
  "singleton",
  "key_version",
  "messages_supported",
  "is_open",
  "is_deleted",
])
export function recoveryColumnType(column: string): "text" | "int4" | "int8" {
  const [name, type] = column.split(/\s+/)
  if (type !== "TEXT" && type !== "INTEGER") throw new Error("Unknown recovery source column type")
  return type === "TEXT" ? "text" : int4Columns.has(name ?? "") ? "int4" : "int8"
}
export function recoveryColumnSources(table: RecoveryTable): readonly string[] {
  return table.columns.flatMap((raw) =>
    raw === "thread_id TEXT NOT NULL, generation TEXT NOT NULL" ? raw.split(", ") : [raw],
  )
}
function quote(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value) || value.length > 63)
    throw new Error("Invalid source-owned recovery identifier")
  return `"${value}"`
}
export function renderRecoveryExpression(source: string, backend: RecoveryBackend): string {
  let value = source.replace(/HEX(?:32|64)\((\w+)\)/g, (_, field: string) =>
    backend === "sqlite" ? `${field} NOT GLOB '*[^0-9a-f]*'` : `${field} !~ '[^0-9a-f]'`,
  )
  value = value.replace(/JSON_VALID\((\w+)\)/g, (_, field: string) =>
    backend === "sqlite" ? `json_valid(${field})` : `CAST(${field} AS pg_catalog.json) IS NOT NULL`,
  )
  value = value.replace(/JSON_ARRAY\((\w+)\)/g, (_, field: string) =>
    backend === "sqlite"
      ? `json_valid(${field}) AND substr(${field},1,1)='['`
      : `CAST(${field} AS pg_catalog.json) IS NOT NULL AND pg_catalog.substr(${field},1,1)='['`,
  )
  value = value.replace(/JSON_STRING\((\w+)\)/g, (_, field: string) =>
    backend === "sqlite"
      ? `json_valid(${field}) AND substr(${field},1,1)='"'`
      : `CAST(${field} AS pg_catalog.json) IS NOT NULL AND pg_catalog.substr(${field},1,1)='"'`,
  )
  return value.replace(
    "UTF8_BYTES(payload)",
    backend === "sqlite" ? "length(CAST(payload AS BLOB))" : "octet_length(payload)",
  )
}
export function recoveryChecks(table: RecoveryTable, backend: RecoveryBackend): readonly string[] {
  return [
    ...recoveryColumnSources(table).flatMap((raw) => {
      const match = / CHECK\((.*)\)$/.exec(raw)
      return match?.[1] === undefined ? [] : [match[1]]
    }),
    ...table.checks,
  ].map((value) => renderRecoveryExpression(value, backend))
}
export function recoverySchemaStatements(
  backend: RecoveryBackend,
  naming: RecoveryNaming = { schema: "r9_v1", prefix: "b4_ap_v1" },
): readonly string[] {
  quote(naming.schema)
  quote(naming.prefix)
  if (naming.prefix.length > 38)
    throw new Error("Recovery prefix exceeds preserved native naming budget")
  const tableName = (name: string) =>
    backend === "sqlite"
      ? quote(name)
      : `${quote(naming.schema)}.${quote(`${naming.prefix}_${name}`)}`
  const created: string[] = [],
    foreign: string[] = [],
    indexes: string[] = []
  for (const table of recoveryTables) {
    const tag = recoveryTableTag(table.name)
    let check = 0,
      notNull = 0
    const cname = (kind: string) =>
      quote(backend === "sqlite" ? `${tag}_${kind}` : `${naming.prefix}_${tag}_${kind}`)
    const constraints: string[] = []
    const columns = recoveryColumnSources(table).map((raw) => {
      const match = /^(.*?) CHECK\((.*)\)$/.exec(raw)
      let column = match?.[1] ?? raw
      if (match?.[2] !== undefined)
        constraints.push(
          `CONSTRAINT ${cname(`c${check++}`)} CHECK(${renderRecoveryExpression(match[2], backend)})`,
        )
      if (backend === "postgres" && recoveryColumnType(column) === "int8")
        column = column.replace(/\bINTEGER\b/, "BIGINT")
      if (column.includes(" NOT NULL"))
        column = column.replace(" NOT NULL", ` CONSTRAINT ${cname(`n${notNull++}`)} NOT NULL`)
      return column
    })
    constraints.push(
      `CONSTRAINT ${cname("p")} PRIMARY KEY(${table.primaryKey.map(quote).join(",")})`,
    )
    table.unique.forEach((key, i) => {
      constraints.push(`CONSTRAINT ${cname(`u${i}`)} UNIQUE(${key.map(quote).join(",")})`)
    })
    for (const value of table.checks)
      constraints.push(
        `CONSTRAINT ${cname(`c${check++}`)} CHECK(${renderRecoveryExpression(value, backend)})`,
      )
    table.foreignKeys.forEach((fk, i) => {
      if (
        fk.onUpdate !== "NO ACTION" ||
        fk.onDelete !== "NO ACTION" ||
        fk.deferrable !== fk.initiallyDeferred
      )
        throw new Error("Unknown recovery FK action or timing")
      const value = `CONSTRAINT ${cname(`f${i}`)} FOREIGN KEY(${fk.columns.map(quote).join(",")}) REFERENCES ${tableName(fk.target)}(${fk.targetColumns.map(quote).join(",")}) ON UPDATE NO ACTION ON DELETE NO ACTION${fk.deferrable ? " DEFERRABLE INITIALLY DEFERRED" : ""}`
      if (backend === "sqlite") constraints.push(value)
      else foreign.push(`ALTER TABLE ${tableName(table.name)} ADD ${value}`)
    })
    created.push(
      `CREATE TABLE ${tableName(table.name)} (\n  ${[...columns, ...constraints].join(",\n  ")}\n)`,
    )
    for (const index of table.indexes) {
      const name = backend === "sqlite" ? index.name : `${naming.prefix}_${index.name}`
      indexes.push(
        `CREATE INDEX ${quote(name)} ON ${tableName(table.name)}(${index.columns.map((value) => (value.endsWith(" DESC") ? `${quote(value.slice(0, -5))} DESC` : quote(value))).join(",")})`,
      )
    }
  }
  return [...created, ...foreign, ...indexes]
}
