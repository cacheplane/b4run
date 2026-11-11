/** Independent source contracts. No expected fact comes from marker.catalog or native DDL. */
import {
  type RuntimeBuiltinType,
  type RuntimeExpressionContext,
  recoveryChecks,
  recoveryColumnSources,
  recoveryColumnType,
  recoveryTables,
  recoveryTableTag,
  runtimeExpressionsEqual,
} from "@b4run/sdk/internal/runtime-schema"
import { assertIdentifier, type TableNaming } from "../schema.js"
import type { SqlClient } from "../sql.js"
import { postgresV1Relations } from "./schema-v1.js"

interface Name {
  schema: string
  name: string
}
interface Column {
  ordinal: number
  name: string
  type: Name
  typmod: number
  notNull: boolean
  identity: string
  generated: string
  collation: Name | null
  sourceDefaultExpression: string | null
}
interface Check {
  name: string | null
  expression: string
  validated: boolean
  enforced: boolean
  noInherit: boolean
}
interface Key {
  expression: string
  opclass: Name
  collation: Name | null
  option: number
}
interface Index {
  name: string | null
  constraintKind: "p" | "u" | null
  method: string
  keys: Key[]
  include: string[]
  unique: boolean
  primary: boolean
  immediate: boolean
  exclusion: boolean
  nullsNotDistinct: boolean
  valid: boolean
  ready: boolean
  live: boolean
  predicate: string | null
}
interface ForeignKey {
  name: string | null
  columns: string[]
  target: string
  targetColumns: string[]
  updateAction: string
  deleteAction: string
  matchType: string
  deferrable: boolean
  initiallyDeferred: boolean
  validated: boolean
  enforced: boolean
  temporal: boolean
  deleteSetColumns: string[]
  triggers: Trigger[]
}
interface Trigger {
  relation: string
  function: Name
  type: number
  enabled: string
  internal: boolean
  deferrable: boolean
  initiallyDeferred: boolean
  args: number
  columns: string
  qualifier: string | null
  oldTable: string | null
  newTable: string | null
}
export interface RuntimeCatalogRelation {
  qualifiedTable: string
  relationKind: string
  persistence: string
  rowSecurity: boolean
  forceRowSecurity: boolean
  partitioned: boolean
  inherits: number
  rules: number
  unsupportedNamespaceIndexes: number
  columns: Column[]
  checks: Check[]
  primary: string[]
  unique: string[][]
  foreignKeys: ForeignKey[]
  indexes: Index[]
  userTriggers: unknown[]
  policies: unknown[]
  unsupportedConstraints: number
  unsupportedInternalTriggers: number
  invalidNotNullConstraints: number
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    )
  return value
}
const equality = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
const sorted = <T>(values: readonly T[]): T[] =>
  [...values].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
function qualified(n: TableNaming, suffix: string) {
  return `${n.schema}.${n.prefix}_${suffix}`
}
function checkNaming(n: TableNaming) {
  assertIdentifier("schema", n.schema)
  assertIdentifier("tablePrefix", n.prefix)
}
function collation(type: string): Name | null {
  return type === "text" ? { schema: "pg_catalog", name: "default" } : null
}
function key(expression: string, columns: readonly Column[]): Key {
  const descending = expression.endsWith(" DESC")
  const source = descending ? expression.slice(0, -5) : expression
  const type = columns.find((column) => column.name === source)?.type.name ?? "text"
  const opclass =
    type === "int4"
      ? "int4_ops"
      : type === "int8"
        ? "int8_ops"
        : type === "timestamptz"
          ? "timestamptz_ops"
          : type === "bytea"
            ? "bytea_ops"
            : "text_ops"
  return {
    expression: source,
    opclass: { schema: "pg_catalog", name: opclass },
    collation: collation(type),
    option: descending ? 3 : 0,
  }
}
function supportingIndex(
  columns: readonly string[],
  kind: "p" | "u",
  relation: RuntimeCatalogRelation,
  name: string | null,
): Index {
  return {
    name,
    constraintKind: kind,
    method: "btree",
    keys: columns.map((column) => key(column, relation.columns)),
    include: [],
    unique: true,
    primary: kind === "p",
    immediate: true,
    exclusion: false,
    nullsNotDistinct: false,
    valid: true,
    ready: true,
    live: true,
    predicate: null,
  }
}
function triggers(
  source: string,
  target: string,
  deferrable: boolean,
  initiallyDeferred: boolean,
): Trigger[] {
  return [
    [source, "RI_FKey_check_ins", 5],
    [source, "RI_FKey_check_upd", 17],
    [target, "RI_FKey_noaction_del", 9],
    [target, "RI_FKey_noaction_upd", 17],
  ].map(([relation, name, type]) => ({
    relation: String(relation),
    function: { schema: "pg_catalog", name: String(name) },
    type: Number(type),
    enabled: "O",
    internal: true,
    deferrable,
    initiallyDeferred,
    args: 0,
    columns: "",
    qualifier: null,
    oldTable: null,
    newTable: null,
  }))
}
function base(qualifiedTable: string, columns: Column[]): RuntimeCatalogRelation {
  return {
    qualifiedTable,
    relationKind: "r",
    persistence: "p",
    rowSecurity: false,
    forceRowSecurity: false,
    partitioned: false,
    inherits: 0,
    rules: 0,
    unsupportedNamespaceIndexes: 0,
    columns,
    checks: [],
    primary: [],
    unique: [],
    foreignKeys: [],
    indexes: [],
    userTriggers: [],
    policies: [],
    unsupportedConstraints: 0,
    unsupportedInternalTriggers: 0,
    invalidNotNullConstraints: 0,
  }
}
/** Both contracts retain the frozen old objects; version2 adds exactly twelve. */
export function expectedRuntimeRelations(n: TableNaming, version: 1 | 2): RuntimeCatalogRelation[] {
  checkNaming(n)
  const rename = (source: string) => {
    if (!source.startsWith("r9_v1.b4_ap_v1_")) throw new Error("Unknown frozen source relation")
    return qualified(n, source.slice("r9_v1.b4_ap_v1_".length))
  }
  const old = postgresV1Relations.map((source): RuntimeCatalogRelation => {
    const columns: Column[] = source.columns.map((column) => ({
      ...column,
      type: { ...column.type },
      collation: collation(column.type.name),
    }))
    const relation = base(rename(source.qualifiedTable), columns)
    relation.primary = [...source.primary]
    relation.unique = source.unique.map((columns) => [...columns])
    relation.checks = source.checks.map((expression) => ({
      name: null,
      expression,
      validated: true,
      enforced: true,
      noInherit: false,
    }))
    relation.foreignKeys = source.foreignKeys.map((fk) => ({
      name: fk.sourceExplicitName,
      columns: [...fk.columns],
      target: rename(fk.target),
      targetColumns: [...fk.targetColumns],
      updateAction: fk.updateAction,
      deleteAction: fk.deleteAction,
      matchType: fk.matchType,
      deferrable: fk.deferrable,
      initiallyDeferred: fk.initiallyDeferred,
      validated: true,
      enforced: true,
      temporal: false,
      deleteSetColumns: [],
      triggers: triggers(
        relation.qualifiedTable,
        rename(fk.target),
        fk.deferrable,
        fk.initiallyDeferred,
      ),
    }))
    relation.indexes = [
      supportingIndex(relation.primary, "p", relation, null),
      ...relation.unique.map((columns) => supportingIndex(columns, "u", relation, null)),
      ...source.explicitIndexes.map(
        (index): Index => ({
          name: `${n.prefix}_${index.name.slice("b4_ap_v1_".length)}`,
          constraintKind: null,
          method: "btree",
          keys: index.sourceKeys.map((value) => key(value, columns)),
          include: [],
          unique: index.unique,
          primary: false,
          immediate: true,
          exclusion: false,
          nullsNotDistinct: false,
          valid: true,
          ready: true,
          live: true,
          predicate: index.sourcePredicate,
        }),
      ),
    ]
    return relation
  })
  if (version === 1) return old
  if (n.prefix.length > 38) throw new Error("Recovery prefix exceeds preserved naming budget")
  return [
    ...old,
    ...recoveryTables.map((source) => {
      const tag = recoveryTableTag(source.name)
      const name = (kind: string) => `${n.prefix}_${tag}_${kind}`
      const columns: Column[] = recoveryColumnSources(source).map((raw, ordinal) => ({
        ordinal: ordinal + 1,
        name: raw.split(" ")[0]!,
        type: { schema: "pg_catalog", name: recoveryColumnType(raw) },
        typmod: -1,
        notNull: raw.includes(" NOT NULL") || source.primaryKey.includes(raw.split(" ")[0]!),
        identity: "",
        generated: "",
        collation: collation(recoveryColumnType(raw)),
        sourceDefaultExpression: null,
      }))
      const relation = base(qualified(n, source.name), columns)
      relation.primary = [...source.primaryKey]
      relation.unique = source.unique.map((columns) => [...columns])
      relation.checks = recoveryChecks(source, "postgres").map((expression, i) => ({
        name: name(`c${i}`),
        expression,
        validated: true,
        enforced: true,
        noInherit: false,
      }))
      relation.foreignKeys = source.foreignKeys.map((fk, i) => ({
        name: name(`f${i}`),
        columns: [...fk.columns],
        target: qualified(n, fk.target),
        targetColumns: [...fk.targetColumns],
        updateAction: "a",
        deleteAction: "a",
        matchType: "s",
        deferrable: fk.deferrable,
        initiallyDeferred: fk.initiallyDeferred,
        validated: true,
        enforced: true,
        temporal: false,
        deleteSetColumns: [],
        triggers: triggers(
          relation.qualifiedTable,
          qualified(n, fk.target),
          fk.deferrable,
          fk.initiallyDeferred,
        ),
      }))
      relation.indexes = [
        supportingIndex(relation.primary, "p", relation, name("p")),
        ...relation.unique.map((columns, i) =>
          supportingIndex(columns, "u", relation, name(`u${i}`)),
        ),
        ...source.indexes.map(
          (index): Index => ({
            name: `${n.prefix}_${index.name}`,
            constraintKind: null,
            method: "btree",
            keys: index.columns.map((value) => key(value, columns)),
            include: [],
            unique: false,
            primary: false,
            immediate: true,
            exclusion: false,
            nullsNotDistinct: false,
            valid: true,
            ready: true,
            live: true,
            predicate: null,
          }),
        ),
      ]
      return relation
    }),
  ]
}

function context(relation: RuntimeCatalogRelation): RuntimeExpressionContext {
  const columnTypes = Object.fromEntries(
    relation.columns.map((column) => [column.name, column.type.name]),
  ) as Record<string, RuntimeBuiltinType>
  const strictLessThan = relation.qualifiedTable.endsWith("_recovery_versions")
    ? { left: "previous_version_seq", right: "version_seq" }
    : relation.qualifiedTable.endsWith("_recovery_cuts")
      ? { left: "previous_cut_seq", right: "through_seq" }
      : undefined
  return {
    relation: relation.qualifiedTable,
    columnTypes,
    ...(strictLessThan ? { strictLessThan } : {}),
  }
}
function expression(a: string | null, b: string | null, c: RuntimeExpressionContext): boolean {
  return a === null || b === null ? a === b : runtimeExpressionsEqual(a, b, c)
}
function unordered<T>(
  expected: readonly T[],
  actual: readonly T[],
  match: (a: T, b: T) => boolean,
): boolean {
  if (expected.length !== actual.length) return false
  const remaining = [...actual]
  return expected.every((value) => {
    const index = remaining.findIndex((candidate) => match(value, candidate))
    if (index === -1) return false
    remaining.splice(index, 1)
    return true
  })
}
/** Unknown representations and extra objects fail closed. Native read errors propagate. */
export function runtimeCatalogMatchesSource(
  actual: readonly RuntimeCatalogRelation[],
  n: TableNaming,
  version: 1 | 2,
): boolean {
  try {
    return unordered(expectedRuntimeRelations(n, version), actual, (source, live) => {
      const c = context(source)
      const { columns: _sc, checks: _sk, foreignKeys: _sf, indexes: _si, ...shape } = source
      const { columns: _lc, checks: _lk, foreignKeys: _lf, indexes: _li, ...liveShape } = live
      if (!equality(shape, liveShape) || source.columns.length !== live.columns.length) return false
      if (
        !source.columns.every((column, i) => {
          const other = live.columns[i]!
          const { sourceDefaultExpression: a, ...expected } = column,
            { sourceDefaultExpression: b, ...actualColumn } = other
          return (
            equality(expected, actualColumn) &&
            expression(a, b, { ...c, expectedType: column.type.name as RuntimeBuiltinType })
          )
        })
      )
        return false
      if (
        !unordered(
          source.checks,
          live.checks,
          (a, b) =>
            (a.name === null || a.name === b.name) &&
            a.validated === b.validated &&
            a.enforced === b.enforced &&
            a.noInherit === b.noInherit &&
            expression(a.expression, b.expression, c),
        )
      )
        return false
      if (
        !unordered(source.foreignKeys, live.foreignKeys, (a, b) => {
          const { name: an, triggers: at, ...af } = a,
            { name: bn, triggers: bt, ...bf } = b
          return (an === null || an === bn) && equality(af, bf) && equality(sorted(at), sorted(bt))
        })
      )
        return false
      return unordered(source.indexes, live.indexes, (a, b) => {
        const { name: an, keys: ak, predicate: ap, ...ai } = a,
          { name: bn, keys: bk, predicate: bp, ...bi } = b
        if (
          (an !== null && an !== bn) ||
          !equality(ai, bi) ||
          ak.length !== bk.length ||
          !expression(ap, bp, c)
        )
          return false
        // The sole legacy jsonb context is the frozen receipts_operation expression index.
        const legacy =
          source.qualifiedTable === qualified(n, "receipts") &&
          an === `${n.prefix}_receipts_operation`
        return ak.every((value, i) => {
          const other = bk[i]!,
            { expression: ae, ...af } = value,
            { expression: be, ...bf } = other
          return (
            equality(af, bf) && expression(ae, be, { ...c, ...(legacy ? { legacy: true } : {}) })
          )
        })
      })
    })
  } catch {
    return false
  }
}

/** Caller holds the installation transaction/lock and SET LOCAL search_path=pg_catalog. */
export async function readRuntimeCatalog(
  client: SqlClient,
  n: TableNaming,
): Promise<RuntimeCatalogRelation[]> {
  checkNaming(n)
  const result = await client.query<{ relation: RuntimeCatalogRelation }>(
    `
    SELECT jsonb_build_object(
      'qualifiedTable',s.nspname||'.'||c.relname,'relationKind',c.relkind,'persistence',c.relpersistence,
      'rowSecurity',c.relrowsecurity,'forceRowSecurity',c.relforcerowsecurity,'partitioned',c.relispartition,
      'inherits',(SELECT count(*)::int FROM pg_inherits h WHERE h.inhrelid=c.oid OR h.inhparent=c.oid),
      'rules',(SELECT count(*)::int FROM pg_rewrite w WHERE w.ev_class=c.oid),
      'unsupportedNamespaceIndexes',(SELECT count(*)::int FROM pg_class e JOIN pg_namespace es ON es.oid=e.relnamespace
        JOIN pg_index i ON i.indexrelid=e.oid JOIN pg_class owner ON owner.oid=i.indrelid
        WHERE es.nspname=$1 AND left(e.relname,length($2)+1)=$2||'_' AND
        (owner.relnamespace<>e.relnamespace OR left(owner.relname,length($2)+1)<>$2||'_')),
      'columns',COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'ordinal',a.attnum,'name',a.attname,'type',jsonb_build_object('schema',ts.nspname,'name',t.typname),
        'typmod',a.atttypmod,'notNull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,
        'collation',CASE WHEN a.attcollation=0 THEN NULL ELSE jsonb_build_object('schema',cs.nspname,'name',co.collname) END,
        'sourceDefaultExpression',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
        FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid JOIN pg_namespace ts ON ts.oid=t.typnamespace
        LEFT JOIN pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_namespace cs ON cs.oid=co.collnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'[]'::jsonb),
      'primary',COALESCE((SELECT jsonb_agg(a.attname ORDER BY x.position) FROM pg_constraint k
        CROSS JOIN LATERAL unnest(k.conkey) WITH ORDINALITY x(number,position)
        JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=x.number WHERE k.conrelid=c.oid AND k.contype='p'),'[]'::jsonb),
      'unique',COALESCE((SELECT jsonb_agg(keys ORDER BY keys::text) FROM (SELECT
        (SELECT jsonb_agg(a.attname ORDER BY x.position) FROM unnest(k.conkey) WITH ORDINALITY x(number,position)
         JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=x.number) AS keys
        FROM pg_constraint k WHERE k.conrelid=c.oid AND k.contype='u') u),'[]'::jsonb),
      'checks',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',k.conname,'expression',pg_get_expr(k.conbin,k.conrelid),
        'validated',k.convalidated,'enforced',(CASE WHEN to_jsonb(k)?'conenforced' THEN (to_jsonb(k)->>'conenforced')::boolean WHEN current_setting('server_version_num')::int<180000 THEN true ELSE NULL END),'noInherit',k.connoinherit))
        FROM pg_constraint k WHERE k.conrelid=c.oid AND k.contype='c'),'[]'::jsonb),
      'foreignKeys',COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'name',k.conname,'columns',(SELECT jsonb_agg(a.attname ORDER BY x.position) FROM unnest(k.conkey) WITH ORDINALITY x(number,position) JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=x.number),
        'target',fs.nspname||'.'||f.relname,'targetColumns',(SELECT jsonb_agg(a.attname ORDER BY x.position) FROM unnest(k.confkey) WITH ORDINALITY x(number,position) JOIN pg_attribute a ON a.attrelid=f.oid AND a.attnum=x.number),
        'updateAction',k.confupdtype,'deleteAction',k.confdeltype,'matchType',k.confmatchtype,'deferrable',k.condeferrable,'initiallyDeferred',k.condeferred,
        'validated',k.convalidated,'enforced',(CASE WHEN to_jsonb(k)?'conenforced' THEN (to_jsonb(k)->>'conenforced')::boolean WHEN current_setting('server_version_num')::int<180000 THEN true ELSE NULL END),'temporal',(CASE WHEN to_jsonb(k)?'conperiod' THEN (to_jsonb(k)->>'conperiod')::boolean WHEN current_setting('server_version_num')::int<180000 THEN false ELSE NULL END),
        'deleteSetColumns',COALESCE((SELECT jsonb_agg(a.attname ORDER BY x.position) FROM jsonb_array_elements_text(COALESCE(NULLIF(to_jsonb(k)->'confdelsetcols','null'::jsonb),'[]'::jsonb)) WITH ORDINALITY x(number,position) JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=x.number::int),'[]'::jsonb),
        'triggers',COALESCE((SELECT jsonb_agg(jsonb_build_object('relation',ns.nspname||'.'||r.relname,'function',jsonb_build_object('schema',ps.nspname,'name',p.proname),
          'type',g.tgtype,'enabled',g.tgenabled,'internal',g.tgisinternal,'deferrable',g.tgdeferrable,'initiallyDeferred',g.tginitdeferred,
          'args',g.tgnargs,'columns',g.tgattr::text,'qualifier',g.tgqual::text,'oldTable',g.tgoldtable,'newTable',g.tgnewtable))
          FROM pg_trigger g JOIN pg_class r ON r.oid=g.tgrelid JOIN pg_namespace ns ON ns.oid=r.relnamespace
          JOIN pg_proc p ON p.oid=g.tgfoid JOIN pg_namespace ps ON ps.oid=p.pronamespace WHERE g.tgconstraint=k.oid),'[]'::jsonb)))
        FROM pg_constraint k JOIN pg_class f ON f.oid=k.confrelid JOIN pg_namespace fs ON fs.oid=f.relnamespace WHERE k.conrelid=c.oid AND k.contype='f'),'[]'::jsonb),
      'indexes',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',ic.relname,'constraintKind',k.contype,'method',am.amname,
        'keys',(SELECT jsonb_agg(jsonb_build_object('expression',CASE WHEN x.number=0 THEN pg_get_indexdef(i.indexrelid,x.position::int,true) ELSE (SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum=x.number) END,
          'opclass',jsonb_build_object('schema',ops.nspname,'name',op.opcname),
          'collation',CASE WHEN co.oid IS NULL THEN NULL ELSE jsonb_build_object('schema',cs.nspname,'name',co.collname) END,
          'option',i.indoption[x.position::int-1]) ORDER BY x.position)
          FROM unnest(i.indkey) WITH ORDINALITY x(number,position)
          JOIN pg_opclass op ON op.oid=i.indclass[x.position::int-1] JOIN pg_namespace ops ON ops.oid=op.opcnamespace
          LEFT JOIN pg_collation co ON co.oid=i.indcollation[x.position::int-1] LEFT JOIN pg_namespace cs ON cs.oid=co.collnamespace WHERE x.position<=i.indnkeyatts),
        'include',COALESCE((SELECT jsonb_agg(a.attname ORDER BY x.position) FROM unnest(i.indkey) WITH ORDINALITY x(number,position) JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=x.number WHERE x.position>i.indnkeyatts),'[]'::jsonb),
        'unique',i.indisunique,'primary',i.indisprimary,'immediate',i.indimmediate,'exclusion',i.indisexclusion,
        'nullsNotDistinct',(CASE WHEN to_jsonb(i)?'indnullsnotdistinct' THEN (to_jsonb(i)->>'indnullsnotdistinct')::boolean WHEN current_setting('server_version_num')::int<150000 THEN false ELSE NULL END),
        'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,'predicate',pg_get_expr(i.indpred,i.indrelid)))
        FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid JOIN pg_am am ON am.oid=ic.relam
        LEFT JOIN pg_constraint k ON k.conindid=i.indexrelid AND k.conrelid=c.oid AND k.contype IN ('p','u','x') WHERE i.indrelid=c.oid),'[]'::jsonb),
      'userTriggers',COALESCE((SELECT jsonb_agg(g.tgname) FROM pg_trigger g WHERE g.tgrelid=c.oid AND NOT g.tgisinternal),'[]'::jsonb),
      'policies',COALESCE((SELECT jsonb_agg(p.polname) FROM pg_policy p WHERE p.polrelid=c.oid),'[]'::jsonb),
      'unsupportedConstraints',(SELECT count(*)::int FROM pg_constraint k WHERE k.conrelid=c.oid AND
        (k.contype NOT IN ('p','u','f','c','n') OR (CASE WHEN to_jsonb(k)?'conperiod' THEN (to_jsonb(k)->>'conperiod')::boolean WHEN current_setting('server_version_num')::int<180000 THEN false ELSE NULL END) IS DISTINCT FROM false OR NOT k.conislocal OR k.coninhcount<>0 OR k.conparentid<>0 OR (k.contype IN ('p','u') AND (k.condeferrable OR NOT k.convalidated OR (CASE WHEN to_jsonb(k)?'conenforced' THEN (to_jsonb(k)->>'conenforced')::boolean WHEN current_setting('server_version_num')::int<180000 THEN true ELSE NULL END) IS DISTINCT FROM true)))),
      'unsupportedInternalTriggers',(SELECT count(*)::int FROM pg_trigger g LEFT JOIN pg_constraint k ON k.oid=g.tgconstraint
        LEFT JOIN pg_class source ON source.oid=k.conrelid LEFT JOIN pg_namespace source_namespace ON source_namespace.oid=source.relnamespace
        WHERE g.tgrelid=c.oid AND g.tgisinternal AND (k.oid IS NULL OR k.contype<>'f' OR source_namespace.nspname IS DISTINCT FROM $1
        OR left(source.relname,length($2)+1) IS DISTINCT FROM $2||'_')),
      'invalidNotNullConstraints',(SELECT count(*)::int FROM pg_constraint k WHERE k.conrelid=c.oid AND k.contype='n' AND
        (NOT k.convalidated OR (CASE WHEN to_jsonb(k)?'conenforced' THEN (to_jsonb(k)->>'conenforced')::boolean WHEN current_setting('server_version_num')::int<180000 THEN true ELSE NULL END) IS DISTINCT FROM true OR k.condeferrable OR k.condeferred OR cardinality(k.conkey)<>1 OR NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum=k.conkey[1] AND a.attnotnull)))
    ) AS relation
    FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace
    WHERE s.nspname=$1 AND left(c.relname,length($2)+1)=$2||'_' AND c.relkind NOT IN ('i','I') ORDER BY c.relname`,
    [n.schema, n.prefix],
  )
  // jsonb key order is not the contract: return explicitly ordered source-shaped objects.
  return result.rows.map(({ relation: r }) => ({
    qualifiedTable: r.qualifiedTable,
    relationKind: r.relationKind,
    persistence: r.persistence,
    rowSecurity: r.rowSecurity,
    forceRowSecurity: r.forceRowSecurity,
    partitioned: r.partitioned,
    inherits: r.inherits,
    rules: r.rules,
    unsupportedNamespaceIndexes: r.unsupportedNamespaceIndexes,
    columns: r.columns.map((a) => ({
      ordinal: a.ordinal,
      name: a.name,
      type: { schema: a.type.schema, name: a.type.name },
      typmod: a.typmod,
      notNull: a.notNull,
      identity: a.identity,
      generated: a.generated,
      collation: a.collation && { schema: a.collation.schema, name: a.collation.name },
      sourceDefaultExpression: a.sourceDefaultExpression,
    })),
    checks: r.checks.map((a) => ({
      name: a.name,
      expression: a.expression,
      validated: a.validated,
      enforced: a.enforced,
      noInherit: a.noInherit,
    })),
    primary: r.primary,
    unique: r.unique.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    foreignKeys: r.foreignKeys.map((a) => ({
      name: a.name,
      columns: a.columns,
      target: a.target,
      targetColumns: a.targetColumns,
      updateAction: a.updateAction,
      deleteAction: a.deleteAction,
      matchType: a.matchType,
      deferrable: a.deferrable,
      initiallyDeferred: a.initiallyDeferred,
      validated: a.validated,
      enforced: a.enforced,
      temporal: a.temporal,
      deleteSetColumns: a.deleteSetColumns,
      triggers: a.triggers.map((g) => ({
        relation: g.relation,
        function: { schema: g.function.schema, name: g.function.name },
        type: g.type,
        enabled: g.enabled,
        internal: g.internal,
        deferrable: g.deferrable,
        initiallyDeferred: g.initiallyDeferred,
        args: g.args,
        columns: g.columns,
        qualifier: g.qualifier,
        oldTable: g.oldTable,
        newTable: g.newTable,
      })),
    })),
    indexes: r.indexes.map((a) => ({
      name: a.name,
      constraintKind: a.constraintKind,
      method: a.method,
      keys: a.keys.map((k) => ({
        expression: k.expression,
        opclass: { schema: k.opclass.schema, name: k.opclass.name },
        collation: k.collation && { schema: k.collation.schema, name: k.collation.name },
        option: k.option,
      })),
      include: a.include,
      unique: a.unique,
      primary: a.primary,
      immediate: a.immediate,
      exclusion: a.exclusion,
      nullsNotDistinct: a.nullsNotDistinct,
      valid: a.valid,
      ready: a.ready,
      live: a.live,
      predicate: a.predicate,
    })),
    userTriggers: r.userTriggers,
    policies: r.policies,
    unsupportedConstraints: r.unsupportedConstraints,
    unsupportedInternalTriggers: r.unsupportedInternalTriggers,
    invalidNotNullConstraints: r.invalidNotNullConstraints,
  }))
}
