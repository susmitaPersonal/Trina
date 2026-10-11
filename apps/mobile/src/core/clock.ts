/**
 * Session clock: wall time (user-adjustable) + a monotonic counter that survives app restarts
 * as well as JS allows. Server validation compares the two to spot clock changes.
 *
 * Limitation (documented): without a native elapsedRealtime module, mono continuity across an
 * app kill is estimated from wall time and flagged with ClockAnomalyDetected if wall time went backwards.
 */
export interface Clock {
  wallNow(): number;
  /** Monotonic ms (performance.now in RN/Node). */
  perfNow(): number;
}

export const systemClock: Clock = {
  wallNow: () => Date.now(),
  perfNow: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
};

export class SessionClock {
  private anchorPerf: number;
  private baseMono: number;
  readonly anomaly: string | null;

  /**
   * @param lastMono last recorded mono ms for this session (0 for a new session)
   * @param lastWallMs wall ms when lastMono was recorded (0 for a new session)
   */
  constructor(
    private readonly clock: Clock,
    lastMono = 0,
    lastWallMs = 0,
  ) {
    const wall = clock.wallNow();
    this.anchorPerf = clock.perfNow();
    if (lastWallMs === 0) {
      this.baseMono = lastMono;
      this.anomaly = null;
    } else if (wall < lastWallMs) {
      // Wall clock went backwards while the app was not running.
      this.baseMono = lastMono + 1;
      this.anomaly = `wall clock moved back ${lastWallMs - wall} ms`;
    } else {
      this.baseMono = lastMono + (wall - lastWallMs);
      this.anomaly = null;
    }
  }

  monoNow(): number {
    return Math.max(0, Math.round(this.baseMono + (this.clock.perfNow() - this.anchorPerf)));
  }

  wallIso(): string {
    return new Date(this.clock.wallNow()).toISOString();
  }

  /** Converts a platform timestamp (e.g. a GPS fix time in wall ms) to this session's mono scale. */
  monoAtWall(wallMs: number): number {
    return Math.max(0, Math.round(this.monoNow() - (this.clock.wallNow() - wallMs)));
  }
}

export function backoffMs(attempts: number, random: () => number = Math.random, baseMs = 2000, capMs = 15 * 60_000): number {
  // Exponential backoff with full jitter.
  return Math.round(random() * Math.min(capMs, baseMs * 2 ** Math.max(0, attempts - 1)));
}
