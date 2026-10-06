import { logger } from "./logger.js";

/**
 * Maximum time a mutex can be held before it's considered leaked and
 * force-released. Overridable via MUTEX_MAX_HOLD_MS for tests.
 */
const MAX_HOLD_MS = (() => {
  const parsed = parseInt(process.env.MUTEX_MAX_HOLD_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
})();

export class Mutex {
  private queue: Array<{ waiter: () => void; enqueuedAt: number; key: string }> = [];
  private locked = false;
  private lockedAt = 0;
  private lockedByKey = "";
  /** Monotonic generation: every acquire bumps it so a stale owner's
   * late release() is a no-op (classic ABA / stale-release fix). */
  private generation = 0;
  private currentToken: string | null = null;

  constructor(
    public readonly name: string = "unnamed",
    private readonly maxHoldMs: number = MAX_HOLD_MS,
  ) {}

  /**
   * Acquire the mutex. Resolves with a release handle whose `release` function
   * is a no-op if the lock has already changed hands (fenced via a generation
   * token). This prevents the ABA bug where a stale owner's late `release()`
   * corrupts a new owner's lock.
   */
  async acquire(
    timeoutMs = 300_000,
    key = "",
    options?: { silentTimeout?: boolean },
  ): Promise<() => void> {
    // Stale detection: force-release if held beyond the hold limit
    // (leaked lock). The chat lock uses a longer hold so a legitimate
    // long generation (2-3 min with huge contexts) is not force-released
    // mid-stream; the page/init locks keep the shorter safety net so a
    // stuck browser op releases the account back to the pool faster.
    const holdLimitMs = this.maxHoldMs;
    if (this.locked && Date.now() - this.lockedAt > holdLimitMs) {
      this.forceRelease(`hold-limit ${holdLimitMs}ms`);
    }

    if (!this.locked) {
      this.locked = true;
      this.lockedAt = Date.now();
      this.lockedByKey = key;
      this.generation++;
      this.currentToken = `${this.generation}`;
      const token = this.currentToken;
      return this.createRelease(token);
    }

    const enqueuedAt = Date.now();
    const logKey = key || "anon";
    if (logger.isLevelEnabled("debug")) {
      logger.debug(`[Mutex:${this.name}] enqueue key=${logKey} queue=${this.queue.length + 1} heldBy=${this.lockedByKey || "unknown"} heldFor=${Date.now() - this.lockedAt}ms`);
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter = () => {
        clearTimeout(timer);
        this.lockedByKey = logKey;
        this.lockedAt = Date.now();
        this.generation++;
        this.currentToken = `${this.generation}`;
        const expectedToken = this.currentToken;
        resolve(this.createRelease(expectedToken));
      };
      const timer = setTimeout(() => {
        const index = this.queue.findIndex((e) => e.waiter === waiter);
        if (index !== -1) this.queue.splice(index, 1);
        const heldFor = Date.now() - this.lockedAt;
        // silentTimeout: the caller treats the timeout as the designed path
        // (e.g. personalization skip) — debug only, never a warn. The
        // rejection is unchanged; the caller decides.
        if (options?.silentTimeout) {
          logger.debug(`[Mutex:${this.name}] skip key=${logKey} waited=${timeoutMs}ms heldBy=${this.lockedByKey || "unknown"} heldFor=${heldFor}ms queueLeft=${this.queue.length}`);
        } else {
          logger.warn(`[Mutex:${this.name}] TIMEOUT key=${logKey} waited=${timeoutMs}ms heldBy=${this.lockedByKey || "unknown"} heldFor=${heldFor}ms queueLeft=${this.queue.length}`);
        }
        reject(new Error(`Mutex[${this.name}] acquire timeout after ${timeoutMs}ms (held by ${this.lockedByKey || "unknown"} for ${heldFor}ms)`));
      }, timeoutMs);
      this.queue.push({ waiter, enqueuedAt, key: logKey });
    });
  }

  /**
   * Force-release the lock no matter who holds it.
   *
   * Used by stuck-holder recovery (a holder that no longer has a live promise
   * behind it — a wedged browser op, an init whose context died). Unlike a
   * plain `release()`, this:
   *
   *  - bumps the generation, so the previous owner's late `release()` becomes
   *    a fenced no-op instead of corrupting the next owner's lock;
   *  - hands the lock to the OLDEST waiter (or unlocks), so queued acquirers
   *    are served immediately instead of timing out one at a time.
   *
   * Returns what was reclaimed so callers can log/report it.
   */
  forceRelease(
    reason = "forced",
  ): { released: boolean; heldBy: string; heldMs: number; handedTo: string | null } {
    if (!this.locked) {
      return { released: false, heldBy: "", heldMs: 0, handedTo: null };
    }
    const heldBy = this.lockedByKey;
    const heldMs = Date.now() - this.lockedAt;
    logger.warn(
      `[Mutex:${this.name}] Force-releasing lock | heldBy=${heldBy || "unknown"} | heldFor=${heldMs}ms | reason=${reason}`,
    );
    // Invalidate the current owner's token BEFORE handing the lock over.
    this.generation++;
    this.currentToken = null;

    const next = this.queue.shift();
    if (next) {
      // `locked` is still true here; waiter() re-stamps holder + token.
      next.waiter();
      return { released: true, heldBy, heldMs, handedTo: next.key };
    }
    this.locked = false;
    this.lockedAt = 0;
    this.lockedByKey = "";
    return { released: true, heldBy, heldMs, handedTo: null };
  }

  async withLock<T>(fn: () => Promise<T> | T, timeoutMs?: number): Promise<T> {
    const release = await this.acquire(timeoutMs);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private createRelease(expectedToken: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(expectedToken);
    };
  }

  private release(expectedToken: string): void {
    // ABA guard: a stale owner (whose token no longer matches because the
    // lock changed hands — including via a force-release that bumped the
    // generation) must NOT mutate the current owner's lock.
    if (this.currentToken !== expectedToken) {
      logger.debug(
        `[Mutex:${this.name}] stale release ignored | currentGen=${this.generation} expectedToken=${expectedToken}`,
      );
      return;
    }
    const next = this.queue.shift();
    if (next) {
      const waitTime = Date.now() - next.enqueuedAt;
      if (waitTime > 1_000 && logger.isLevelEnabled("debug")) {
        logger.debug(`[Mutex:${this.name}] dequeued key=${next.key} waited=${waitTime}ms`);
      }
      next.waiter();
      return;
    }

    this.locked = false;
    this.lockedAt = 0;
    this.lockedByKey = "";
    this.currentToken = null;
  }

  /** Returns true if the mutex is not locked and has no waiting queue. */
  isIdle(): boolean {
    return !this.locked && this.queue.length === 0;
  }

  /** Returns diagnostic info about the current lock state. */
  state(): { locked: boolean; heldBy: string; heldForMs: number; queueLength: number; generation: number } {
    return {
      locked: this.locked,
      heldBy: this.lockedByKey,
      heldForMs: this.locked ? Date.now() - this.lockedAt : 0,
      queueLength: this.queue.length,
      generation: this.generation,
    };
  }
}
