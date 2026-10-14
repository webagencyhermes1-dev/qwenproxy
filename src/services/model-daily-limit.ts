/**
 * Per-account DAILY MODEL CAP registry.
 *
 * Qwen answers a capped account with an ordinary assistant message plus
 * `extra.update_member: true` on the terminal delta — it looks like a normal
 * answer, so nothing in the stream path can tell it apart by content alone.
 * The cap is scoped to ONE model on ONE account: the same account serves other
 * models normally, and every account has its own daily allowance.
 *
 * This registry turns that marker into routing state so:
 *   - the request path can skip an account that cannot serve the model at all;
 *   - the failure is reported as a daily-limit outcome rather than a generic
 *     upstream error;
 *   - a restart is not needed to re-probe (re-probing is cheap, so entries are
 *     deliberately NOT persisted — Qwen owns the reset schedule, not us).
 *
 * Only the diagnostic counter and the skip set live here; the decision to
 * rotate, cool down or fail is the retry policy's.
 */

/** `accountId\u0000model` — nul-joined so a model name can never collide. */
function key(accountId: string, model: string): string {
  return `${accountId}\u0000${model}`;
}

const capped = new Map<
  string,
  { accountId: string; model: string; since: number; resetsAt: number }
>();
const byModel = new Map<string, Set<string>>();

/** Next 00:00 UTC after `nowMs` — Qwen's daily allowance reset boundary. */
function computeNextUtcMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

/**
 * Fire-and-forget durable mirror of a cap. The in-memory registry stays the
 * hot-path source of truth; SQLite is the restart survivor. Dynamic import
 * keeps database.ts out of this module's static graph (no import cycle).
 */
function dbPersistCap(accountId: string, model: string, nowMs: number): void {
  void import("../core/database.ts")
    .then(({ getDatabase }) => {
      getDatabase()
        .prepare(
          "INSERT OR REPLACE INTO model_daily_caps (account_id, model, capped_at, resets_at) VALUES (?, ?, ?, ?)",
        )
        .run(accountId, model, nowMs, computeNextUtcMidnight(nowMs));
    })
    .catch(() => {
      // Best-effort: the in-memory cap already holds for this process.
    });
}

/** Record that `accountId` has hit its daily cap for `model` today. */
export function markAccountModelCapped(accountId: string, model: string): void {
  if (!accountId || !model) return;
  const k = key(accountId, model);
  if (capped.has(k)) return;
  const now = Date.now();
  capped.set(k, {
    accountId,
    model,
    since: now,
    resetsAt: computeNextUtcMidnight(now),
  });
  let set = byModel.get(model);
  if (!set) {
    set = new Set<string>();
    byModel.set(model, set);
  }
  set.add(accountId);
  dbPersistCap(accountId, model, now);
}

/** True when this account is known to be capped for this model. */
export function isAccountModelCapped(
  accountId: string | null | undefined,
  model: string | null | undefined,
): boolean {
  if (!accountId || !model) return false;
  return byModel.get(model)?.has(accountId) === true;
}

/** Every account currently known to be capped for `model`. */
export function cappedAccountsForModel(model: string): string[] {
  const set = byModel.get(model);
  return set ? [...set] : [];
}

/**
 * Accounts that are neither capped for `model` nor otherwise unusable.
 * `all` is the full configured account list.
 */
export function accountsUsableForModel(
  all: readonly string[],
  model: string,
): string[] {
  const cappedSet = byModel.get(model);
  if (!cappedSet || cappedSet.size === 0) return [...all];
  return all.filter((id) => !cappedSet.has(id));
}

/** True when EVERY account in `all` is capped for `model`. */
export function allAccountsCappedForModel(
  all: readonly string[],
  model: string,
): boolean {
  if (all.length === 0) return false;
  return accountsUsableForModel(all, model).length === 0;
}

/** Diagnostic snapshot for /health and logs. */
export function getModelCapStats(): {
  models: Array<{ model: string; capped: number; accounts: string[] }>;
} {
  return {
    models: [...byModel.entries()].map(([model, set]) => ({
      model,
      capped: set.size,
      accounts: [...set],
    })),
  };
}

/**
 * Restore persisted caps into the in-memory registry. Call once at startup
 * (before the first warmup tick) so a restart does not re-probe — and
 * re-drain — accounts that already reported `extra.update_member`.
 */
export async function initModelCapsFromDb(): Promise<void> {
  try {
    const { getDatabase } = await import("../core/database.ts");
    const db = getDatabase();
    const now = Date.now();
    const rows = db
      .prepare(
        "SELECT account_id, model, capped_at, resets_at FROM model_daily_caps WHERE resets_at > ?",
      )
      .all(now) as Array<{
      account_id: string;
      model: string;
      capped_at: number;
      resets_at: number;
    }>;
    for (const row of rows) {
      const k = key(row.account_id, row.model);
      if (capped.has(k)) continue;
      capped.set(k, {
        accountId: row.account_id,
        model: row.model,
        since: row.capped_at,
        resetsAt: row.resets_at,
      });
      let set = byModel.get(row.model);
      if (!set) {
        set = new Set<string>();
        byModel.set(row.model, set);
      }
      set.add(row.account_id);
    }
    if (rows.length > 0) {
      console.log(
        `📦 [ModelCaps] Restored ${rows.length} persisted cap(s) from database`,
      );
    }
  } catch {
    // DB unavailable — in-memory only (pre-persistence behavior).
  }
}

/**
 * Drop caps whose UTC-midnight reset has passed, from both the in-memory
 * registry and SQLite. Safe to call on every reconciliation tick; returns the
 * number of in-memory entries cleared.
 */
export async function sweepExpiredModelCaps(): Promise<number> {
  const now = Date.now();
  let swept = 0;
  for (const [k, entry] of [...capped.entries()]) {
    if (entry.resetsAt <= now) {
      capped.delete(k);
      const set = byModel.get(entry.model);
      if (set) {
        set.delete(entry.accountId);
        if (set.size === 0) byModel.delete(entry.model);
      }
      swept += 1;
    }
  }
  try {
    const { getDatabase } = await import("../core/database.ts");
    getDatabase()
      .prepare("DELETE FROM model_daily_caps WHERE resets_at <= ?")
      .run(now);
  } catch {
    // Best-effort.
  }
  return swept;
}

/** Clear all cap knowledge. Used by tests and by the TUI's pool reset. */
export function resetModelCaps(): void {
  capped.clear();
  byModel.clear();
}