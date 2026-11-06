# W07 durable preference CAS contract

Owner: User module / user-preferences database repository. Integration partners: Lead owns database schema/migrations and server shared types/barrel; frontend W07 owner owns cross-window outbox and API calls.

Status: implemented and verified against Lead-owned schema/shared contracts (UUIDv7, exactly three body fields). Baseline worktree HEAD: `45abcd9bf540d934e0b2f5aab0aefaa1000ff12a`; changes remain uncommitted in the shared worktree.

## Root cause and guarantee

The existing `user_preferences` table stores JSON values without a revision. The legacy merge PATCH unconditionally overwrites each supplied key. An older HTTP request can therefore arrive after a newer request commits and restore its older value; aborting a browser request or retaining an in-memory queue cannot prevent that server-side write.

The new protocol uses persistent per-user/per-key revisions and one SQLite `BEGIN IMMEDIATE` transaction covering comparison of **all** supplied revisions, all value/revision writes, and an operation acknowledgement. A mismatch writes none of the requested values. Revisions survive server restart and deletion of a preference value (revision tombstones remain). A successful write increments every supplied field's revision, including writes of an equal value, so an older in-flight transaction loses its original CAS precondition.

Legacy writes increment those same revisions in the same transaction as their values. Thus a versioned transaction prepared before a legacy write cannot overwrite it. A legacy plain PATCH itself carries no precondition and cannot provide the same ordering guarantee; production ordering requires every deployed preference writer to use the new endpoint. Frontend deployment must fail closed when the versioned endpoint is unavailable; it must not silently fall back to plain PATCH for queued transactions.

## Wire contract

Base route: `/api/user`.

### GET `/preferences`

```json
{"success":true,"preferences":{"theme":"dark"},"revisions":{"theme":4}}
```

`preferences` remains the existing plain values map. `revisions` is added alongside it. A key absent from `revisions` has revision **0**. Existing rows at upgrade start at revision 0; no value rewrite/backfill is required. Deleted values may be absent from `preferences` while their positive revisions remain in `revisions`.

### PATCH `/preferences/transactions`

The body contains exactly these three fields; no additional transport fields are accepted:

```json
{
  "operationId":"019cfabc-def0-7000-8000-000000000001",
  "updates":{"theme":"light","tasksEnabled":false},
  "expectedRevisions":{"theme":4,"tasksEnabled":0}
}
```

- `operationId`: canonical UUIDv7 (case-insensitive input normalized to lowercase), 36 characters. UUIDv7 embeds creation time in the first 48 bits. Use cryptographically random remaining bits. A random UUIDv4 alone cannot distinguish a pruned/expired operation from a new operation and is deliberately rejected.
- `updates`: nonempty JSON object, at most 128 own fields; keys retain the existing 1–200 character rule. Preference names and valid JSON value shapes remain extensible; there is no new preference-name allowlist. JSON null is a stored value, not a deletion instruction.
- `expectedRevisions`: exactly the same own key set as `updates`; each value is a safe integer in `[0, Number.MAX_SAFE_INTEGER]`.
- The canonical JSON of updates plus expected revisions is at most 64 KiB UTF-8. Nested object key order is canonicalized for hashing; array order is significant. Any nested non-JSON runtime value is rejected before persistence.
- UUIDv7 creation time must be no more than five minutes ahead of server time, and the fixed acceptance lifetime is 24 hours from its embedded timestamp. An expired operation gets 409 `PREFERENCE_OPERATION_EXPIRED` and can **never** be resubmitted as a fresh operation. The database persists a per-user server-time high-water mark so clock rollback after pruning/restart cannot reopen the acceptance window.

Success (200):

```json
{"success":true,"operationId":"...","replayed":false,"preferences":{"theme":"light","tasksEnabled":false},"revisions":{"theme":5,"tasksEnabled":1}}
```

Revision conflict (409):

```json
{"success":false,"code":"PREFERENCE_REVISION_CONFLICT","operationId":"...","replayed":false,"preferences":{"theme":"dark"},"revisions":{"theme":5,"tasksEnabled":0}}
```

Success/conflict maps contain **only the requested fields**; a currently absent value is omitted from `preferences`, but every requested field is present in `revisions`. They are merge results, not full-cache replacement documents. No fields are partially committed on conflict.

The same operation ID and same canonical request replay the stored acknowledgement without writing again (`replayed:true`). This acknowledgement is historical; clients must not lower a newer locally known revision or clear a later dirty intent merely because an older replay succeeded. The same operation ID with a different canonical request returns 409 `PREFERENCE_OPERATION_MISMATCH` without writing. Rejected CAS acknowledgements are also journaled so changing their payload cannot reuse the ID.

The per-user journal admits at most 1,024 unexpired operations. Only expired entries are pruned; live/in-flight acknowledgement entries are not evicted. Saturation returns 429 `PREFERENCE_OPERATION_CAPACITY`, does not write values, and must not cause an immediate rebase/retry loop. A new operation is created only for a still-current dirty intent once retry is appropriate.

Malformed transport input returns 400 (stable `INVALID_PREFERENCE_TRANSACTION`, `INVALID_PREFERENCE_OPERATION_ID`, `INVALID_PREFERENCE_REVISIONS`, `INVALID_PREFERENCES`, or `INVALID_PREFERENCE_KEY`); size overflow returns 413 `PREFERENCE_TRANSACTION_TOO_LARGE`.

### Legacy PATCH `/preferences`

The original plain body remains accepted. Existing getPreferences repository callers keep their plain-object return contract. Legacy writes now increment the same durable revision of every supplied key, including equal-value writes and repository-level `undefined` deletions; deleting a preference does not delete its revision. Response adds full `revisions` alongside full `preferences`.

## Frontend ordering requirements

1. Hydrate values and revisions together; initialize absent revisions to 0. A response lacking revisions does not authorize the versioned protocol.
2. Freeze an operation's updates and expected revisions at creation. Retries of that operation resend the exact payload and ID.
3. Merge server snapshots using nondecreasing revisions. A historical acknowledgement never replaces newer state.
4. On a revision conflict, update the server base and rebase **only the latest still-dirty intent**. Create a new UUIDv7 operation ID with fresh expected revisions. A superseded/deleted/account-reset intent must never be revived.
5. Preserve account/session ownership fencing across every async HTTP boundary; discard responses for a retired frontend session. Backend preference CAS is synchronous after authenticated route admission, with no `await` between compare and commit.
6. On expired operation, fetch current state and decide from the current intent; do not reissue an expired payload automatically under a new ID. On mismatch, stop that operation as corrupt. On journal capacity, back off and keep the live intent.

## Lead-owned database SQL

Add `USER_PREFERENCE_CAS_TABLE_SCHEMA_SQL` to the schema module and invoke it in fresh initialization and migrations after users/preferences exist:

```sql
CREATE TABLE IF NOT EXISTS user_preference_versions (
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (user_id, key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS user_preference_operations (
  user_id INTEGER NOT NULL,
  op_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  ack_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, op_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_preference_operations_expires
ON user_preference_operations(expires_at);
CREATE TABLE IF NOT EXISTS user_preference_cas_state (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  observed_at INTEGER NOT NULL CHECK (typeof(observed_at) = 'integer' AND observed_at >= 0)
);
```

No revision backfill: absent revision rows read as 0. This is an additive migration. Values, revisions, journal entries and clock state are all scoped to the authenticated user and cascade on account deletion.

## Lead-owned shared type/barrel contract

```ts
export type UserPreferenceSnapshot = {
  preferences: Record<string, unknown>;
  revisions: Record<string, number>;
};
export type UserPreferenceTransaction = {
  operationId: string;
  updates: Record<string, unknown>;
  expectedRevisions: Record<string, number>;
};
export type UserPreferenceTransactionResult = UserPreferenceSnapshot & (
  | { success: true; operationId: string; replayed: boolean }
  | {
      success: false;
      operationId: string;
      replayed: boolean;
      code: 'PREFERENCE_REVISION_CONFLICT'
        | 'PREFERENCE_OPERATION_MISMATCH'
        | 'PREFERENCE_OPERATION_EXPIRED'
        | 'PREFERENCE_OPERATION_CAPACITY';
    }
);
```

Place these adjacent under a documented preference transaction group in server shared types and export their types through the shared barrel. Repository, User service/module and tests consume these contracts.

## Verification record

Final run: **56 tests passed, 0 failed, 0 skipped**, Node v24.21.0, duration 44.919 seconds. Evidence is in [tests-final.log](tests-final.log). The run used the actual existing better-sqlite3 dependency, temporary disk databases, actual User service/router and real HTTP requests. The independent-writer test started two Node processes against one database with the same expected revisions: exactly one multi-field transaction committed and the loser received a full-field conflict.

Verified cases: additive/repeat migration preserves legacy values at revision 0; normal JSON values and touched-only acknowledgements; canonical request replay; rejected operation replay and changed-payload 409; all-field CAS refusal; SQL-trigger abort after a first field rolls back values, revisions, journal and time watermark; close/reopen followed by a delayed stale transaction and historical acknowledgement; legacy equal-value writes and deletions invalidate old CAS reads; deletion tombstones prevent resurrection; expiry pruning plus server-clock rollback and reopen; live 1,024-entry saturation retains existing acknowledgements and returns capacity refusal; user isolation and all-state user-delete cascade; invalid input/size and safe-integer exhaustion; strict HTTP envelope and 400/409/413/429 responses; prototype-like own JSON keys.

Commands from the repository root:

```powershell
$env:TSX_TSCONFIG_PATH = 'server/tsconfig.json'
node --import tsx --experimental-test-module-mocks --test server/modules/database/tests/user-preferences.cas.integration.test.ts server/modules/database/tests/user-preferences.db.integration.test.ts server/modules/user/tests/user.service.test.ts server/modules/user/tests/user.routes.test.ts server/modules/user/tests/user.preferences-cas.routes.integration.test.ts
node docs/remediation/2026-10-31/W07-preference-cas/typecheck.mjs
node node_modules/oxlint/bin/oxlint server/modules/database/repositories/user-preferences.db.ts server/modules/database/tests/user-preferences.cas-writer.ts server/modules/database/tests/user-preferences.cas.integration.test.ts server/modules/user/user.service.ts server/modules/user/user.routes.ts server/modules/user/user.module.ts server/modules/user/tests/user.service.test.ts server/modules/user/tests/user.routes.test.ts server/modules/user/tests/user.preferences-cas.routes.integration.test.ts
```

Scoped no-emit TypeScript semantic check: **9 owned files, 0 owned diagnostics, 0 imported-file diagnostics**, recorded in [typecheck-final.log](typecheck-final.log). Narrow oxlint: **0 warnings, 0 errors**, recorded in [lint-final.log](lint-final.log). Git diff whitespace check on owned tracked sources passed. No dependency installation, full-suite test run, build or commit was performed.

SHA-256 content hashes for all owned source/tests, final evidence and the Lead-owned integrated schema/shared files are in [sha256.txt](sha256.txt). Hashes identify the observed files in a concurrently edited shared worktree; Lead-owned files may change after this report. Every background job started for this task completed and its output was collected.

## Operational limits and remaining integration responsibilities

- The final ordering guarantee applies to callers using the CAS transaction endpoint. Legacy requests remain unguarded by design; all deployed clients must be upgraded/gated, and versioned clients must never fall back to plain PATCH.
- The backend cannot know that a same-device newer intent has superseded an older request before that newer intent commits. The frontend outbox must preserve latest-intent ordering and rebase only the still-live dirty intent after 409. The backend guarantees that a stale transaction cannot overwrite any already-committed revision.
- The journal is bounded to 1,024 live operations per user, each request to 128 fields / 64 KiB canonical JSON, lifetime to 24 hours and future skew to five minutes. Saturated callers receive backpressure. Expiry cleanup is opportunistic on a subsequent transaction for that user; inactive users retain at most their bounded journal until next write or account deletion.
- Revision rows are permanent tombstones for every distinct preference key the user has written, matching the existing extensible preference-key contract; there is no new finite preference-name allowlist. The operation journal is bounded, not an unlimited operation tombstone history.
- A revision cannot exceed `Number.MAX_SAFE_INTEGER`; the SQLite CHECK fails closed and rolls back the full write on exhaustion. A server clock jump far forward can expire pending operations and the persisted high-water mark deliberately prevents reopening their window after rollback.
- JSON null remains a stored value. The new HTTP endpoint does not introduce delete syntax; repository-level legacy undefined deletion retains a revision tombstone.
- HTTP integration tests inject an already-authenticated request identity and deliberately do not change/test the separately owned authentication stack. There is no await between preference route admission and its synchronous SQLite commit. Frontend account/session response fencing remains the frontend owner's responsibility.
- A full production build, full repository suite and live deployed-client validation were outside this authorized narrow task.
