/**
 * AccModel2D — time-based 2-D acceleration physics, ported from CapsLockX.
 *
 * Single source of truth: `rs/core/src/acc_model.rs` in snomiao/CapsLockX
 * (a JS reference lives at snomiao/capslockx.js). This is a faithful port of
 * the *motion* half — the `ma` acceleration curve, velocity integration and
 * damping — so that WASD-pan / RF-zoom in rgui feel identical to moving the
 * cursor with CapsLockX. The mouse-button chord logic (R+F = middle, opposite
 * keys = middle-click nudge) is intentionally omitted: rgui drives a viewport,
 * not a cursor with buttons.
 *
 * The model is FPS-independent: acceleration is a function of how long a key
 * has been HELD (not of frame time), and displacement is the time-integral of
 * velocity, so the same hold produces the same travel at any tick rate. The
 * caller drives it by calling `tick(now)` once per animation frame; each call
 * returns the float displacement accumulated since the previous tick.
 */

/** Raw double-integral of the accel polynomial over a 1 s hold (≈ ∫₀¹∫₀ᵗ). */
const K_RAW = 3.935;

const sign = (x: number): number => (x > 0 ? 1 : x < 0 ? -1 : 0);

/**
 * Acceleration as a function of net hold time `dt` (seconds). Matches the AHK
 * / Rust polynomial+exponential formula, normalised by K_RAW so that a 1 s
 * hold at rate 1 yields ~1 unit of travel (hence rate = units per first
 * second).
 */
function ma(dt: number): number {
  const s = sign(dt);
  const a = Math.abs(dt);
  return (
    (s * (Math.exp(a) - 1 + 3 + 4 * a + 9 * a * a + 16 * a * a * a)) / K_RAW
  );
}

/** Velocity damping applied when input is absent or opposes the motion. */
function damping(
  v: number,
  accel: number,
  dt: number,
  maxSpeed: number,
): number {
  if (Number.isFinite(maxSpeed)) {
    v = Math.max(-maxSpeed, Math.min(maxSpeed, v));
  }
  // Friction never fights the user's intent: while pushing, keep the speed.
  if (accel * v > 0) return v;
  v *= Math.exp(-dt * 20); // exponential decay (the dominant feel)
  v -= sign(v) * dt; // linear friction floor
  if (Math.abs(v) < 1) v = 0; // zero-point snap for a clean stop
  return v;
}

export interface AccTick {
  /** horizontal displacement (units) since the previous tick */
  dx: number;
  /** vertical displacement (units) since the previous tick */
  dy: number;
  /** true while the model is still moving or a key is held */
  active: boolean;
}

/**
 * 2-D acceleration model. Press/release the four cardinal directions, then
 * call `tick(now)` every frame to pump the physics. `now` is any monotonic
 * millisecond clock (e.g. `performance.now()`); press timestamps must come
 * from the same clock.
 */
export class AccModel2D {
  private leftDown: number | null = null;
  private rightDown: number | null = null;
  private upDown: number | null = null;
  private downDown: number | null = null;
  private lastTick: number | null = null;
  private hVel = 0;
  private vVel = 0;
  private active = false;
  private hRate: number;
  private vRate: number;
  private maxSpeed: number;

  /** @param vRate 0 → mirror hRate (matches the AHK default). */
  constructor(hRate = 1, vRate = 0, maxSpeed = Infinity) {
    this.hRate = hRate;
    this.vRate = vRate || hRate;
    this.maxSpeed = maxSpeed;
  }

  get isActive(): boolean {
    return this.active;
  }

  setRates(hRate: number, vRate = 0, maxSpeed = this.maxSpeed): void {
    this.hRate = hRate;
    this.vRate = vRate || hRate;
    this.maxSpeed = maxSpeed;
  }

  private wake(): void {
    if (!this.active) {
      this.active = true;
      this.lastTick = null; // fast-start on the next tick
    }
  }

  pressLeft(now: number): void {
    if (this.leftDown == null) this.leftDown = now;
    this.wake();
  }
  pressRight(now: number): void {
    if (this.rightDown == null) this.rightDown = now;
    this.wake();
  }
  pressUp(now: number): void {
    if (this.upDown == null) this.upDown = now;
    this.wake();
  }
  pressDown(now: number): void {
    if (this.downDown == null) this.downDown = now;
    this.wake();
  }
  releaseLeft(): void {
    this.leftDown = null;
  }
  releaseRight(): void {
    this.rightDown = null;
  }
  releaseUp(): void {
    this.upDown = null;
  }
  releaseDown(): void {
    this.downDown = null;
  }

  /** Halt immediately and clear all held directions. */
  stop(): void {
    this.leftDown = this.rightDown = this.upDown = this.downDown = null;
    this.lastTick = null;
    this.hVel = 0;
    this.vVel = 0;
    this.active = false;
  }

  /** Advance to `now`; returns displacement since the previous tick. */
  tick(now: number): AccTick {
    if (!this.active) return { dx: 0, dy: 0, active: false };

    // Fast-start: the first tick just anchors the clock (no jump).
    if (this.lastTick == null) {
      this.lastTick = now;
      return { dx: 0, dy: 0, active: true };
    }
    const dt = (now - this.lastTick) / 1000;
    this.lastTick = now;

    const leftS = this.leftDown == null ? 0 : (now - this.leftDown) / 1000;
    const rightS = this.rightDown == null ? 0 : (now - this.rightDown) / 1000;
    const upS = this.upDown == null ? 0 : (now - this.upDown) / 1000;
    const downS = this.downDown == null ? 0 : (now - this.downDown) / 1000;

    const hAccel = ma(rightS - leftS) * this.hRate;
    const vAccel = ma(downS - upS) * this.vRate;

    this.hVel = damping(this.hVel + hAccel * dt, hAccel, dt, this.maxSpeed);
    this.vVel = damping(this.vVel + vAccel * dt, vAccel, dt, this.maxSpeed);

    const dx = this.hVel * dt;
    const dy = this.vVel * dt;

    const anyKey =
      this.leftDown != null ||
      this.rightDown != null ||
      this.upDown != null ||
      this.downDown != null;
    if (this.hVel === 0 && this.vVel === 0 && !anyKey) {
      this.active = false;
    }
    return { dx, dy, active: this.active };
  }
}
