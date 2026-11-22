import { CONFIG } from '../config';
import type { Player } from '../data/types';
import { BASE_SHORT, baseXY, pathXY } from './bases';
import { flightPositionAt, rollPath, type Flight, type FlightPoint } from './flight';
import type { Vec3 } from './pitch';
import { clamp, lerp, type Rng } from './rng';

const FC = CONFIG.fielding;
const BASE_FT = CONFIG.field.baseDistance;
const INFIELD = new Set(['P', 'C', '1B', '2B', 'SS', '3B']);
const COVER_ORDER: Record<number, string[]> = {
  1: ['1B', '2B', 'P'],
  2: ['2B', 'SS', 'P'],
  3: ['3B', 'SS', 'P'],
  4: ['C', 'P'],
};

export interface Ratings {
  speed: number;
  glove: number;
  arm: number;
}

export type OutHow = 'fly' | 'foulFly' | 'force' | 'tag' | 'peg' | 'doubledOff';

export type PlayEvent =
  | { type: 'catch'; fielder: string; foul: boolean }
  | { type: 'out'; runner: RunnerState; how: OutHow; base: number; fielder: string }
  | { type: 'run'; runner: RunnerState }
  | { type: 'error'; fielder: string; what: 'drop' | 'bobble' | 'throw' }
  | { type: 'pegMiss'; fielder: string; runner: RunnerState }
  | { type: 'knockedDown'; fielder: string }
  | { type: 'homeRun' }
  | { type: 'runsWipedOut'; count: number };

export interface FielderState {
  pos: string;
  x: number;
  y: number;
  ratings: Ratings;
  speed: number;
  tx: number;
  ty: number;
  cover: number | null;
  stunUntil: number;
  moving: boolean;
}

export interface RunnerState {
  id: number;
  player: Player;
  origin: number; // base the runner started the play on (0 = the kicker)
  pos: number; // position along the base path, 0..4
  target: number; // base the runner is heading to
  speed: number;
  out: boolean;
  scored: boolean;
  forced: boolean;
  mustReturn: boolean; // a fly was caught; must retouch the origin base
  startAt: number;
}

type HeldAction =
  | { kind: 'throw'; base: number | null; toX: number; toY: number }
  | { kind: 'peg'; runner: RunnerState; toX: number; toY: number; hit: boolean };

type Ball =
  | { kind: 'flight' }
  | { kind: 'held'; f: number; releaseAt: number | null; action: HeldAction | null }
  | {
      kind: 'thrown';
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      t0: number;
      dur: number;
      by: number;
      peg: RunnerState | null;
      pegHit: boolean;
    }
  | { kind: 'loose'; path: FlightPoint[] };

export interface PlaySetup {
  flight: Flight;
  batter: Player;
  bases: (Player | null)[]; // runners on 1st, 2nd, 3rd before the kick
  outs: number;
  defense: Record<string, Ratings>;
  rng: Rng;
  manualDefense?: boolean; // the player chooses every throw
  autoRun?: boolean; // the computer runs the bases
}

export type EndReason = 'settled' | 'threeOuts' | 'foul' | 'homeRun' | 'timeout';

export const runSpeed = (rating: number) => lerp(FC.runSpeedMin, FC.runSpeedMax, clamp(rating, 1, 100) / 100);
const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);
const isOnBase = (r: RunnerState) => Number.isInteger(r.pos);

/**
 * One live ball, from the kick until every runner is safe or out.
 * Pure game logic, no drawing: the scene reads its state each frame.
 */
export class LivePlay {
  t = 0;
  ball: Ball = { kind: 'flight' };
  fielders: FielderState[];
  runners: RunnerState[];
  outs: number;
  runsCounted = 0;
  events: PlayEvent[] = [];
  over = false;
  endReason: EndReason | null = null;
  caughtFly = false;
  private waitingOnFly = false;

  private flight: Flight;
  private rng: Rng;
  private fair: boolean;
  private scoredThisPlay: RunnerState[] = [];
  private settledFor = 0;
  private nextDecision = 0;
  private attempted = new Map<number, number>(); // fielder -> time of last fielding try
  readonly manualDefense: boolean;
  private autoRun: boolean;
  private nextRunDecision = 0;

  constructor(s: PlaySetup) {
    this.flight = s.flight;
    this.rng = s.rng;
    this.fair = s.flight.fair;
    this.outs = s.outs;
    this.manualDefense = !!s.manualDefense;
    this.autoRun = !!s.autoRun;

    this.fielders = Object.entries(CONFIG.field.positions).map(([pos, spot]) => {
      const ratings = s.defense[pos] ?? FC.defenseRatings;
      return {
        pos,
        x: spot.x,
        y: spot.y,
        ratings,
        speed: runSpeed(ratings.speed) * FC.fielderSpeedMult,
        tx: spot.x,
        ty: spot.y,
        cover: null,
        stunUntil: 0,
        moving: false,
      };
    });

    let id = 0;
    this.runners = [];
    const mk = (player: Player, origin: number): RunnerState => ({
      id: id++,
      player,
      origin,
      pos: origin,
      target: origin,
      speed: runSpeed(player.speed),
      out: false,
      scored: false,
      forced: false,
      mustReturn: false,
      startAt: origin === 0 ? FC.batterStartDelay : 0,
    });
    if (this.fair) this.runners.push(mk(s.batter, 0));
    s.bases.forEach((p, i) => p && this.runners.push(mk(p, i + 1)));
    this.updateForces();
    // The kicker always runs. Other forced runners run on ground balls, but wait
    // on a catchable ball in the air until it lands (you can still send them).
    this.waitingOnFly =
      this.fair && !this.flight.overFence && this.flight.maxHeight > FC.catchHeight && this.catchableInAir();
    if (this.fair) for (const r of this.runners) if (r.forced && (r.origin === 0 || !this.waitingOnFly)) r.target = r.origin + 1;

    if (this.fair && this.flight.overFence) {
      // Over the fence: everyone trots home.
      for (const r of this.runners) r.target = 4;
      this.events.push({ type: 'homeRun' });
    }
    this.assignChase();
  }

  // ------------------------------------------------------------------ queries

  get batter(): RunnerState | undefined {
    return this.runners.find((r) => r.origin === 0);
  }

  activeRunners(): RunnerState[] {
    return this.runners.filter((r) => !r.out && !r.scored).sort((a, b) => b.pos - a.pos);
  }

  runnerXY(r: RunnerState): { x: number; y: number } {
    return pathXY(r.pos);
  }

  ballPosition(): Vec3 {
    const b = this.ball;
    if (b.kind === 'flight') return flightPositionAt(this.flight, this.t);
    if (b.kind === 'held') {
      const f = this.fielders[b.f];
      return { x: f.x + 0.8, y: f.y + 0.8, z: 3 };
    }
    if (b.kind === 'thrown') {
      const u = clamp((this.t - b.t0) / b.dur, 0, 1);
      const d = dist(b.fromX, b.fromY, b.toX, b.toY);
      return {
        x: lerp(b.fromX, b.toX, u),
        y: lerp(b.fromY, b.toY, u),
        z: 4 + 4 * d * 0.06 * u * (1 - u),
      };
    }
    return this.pathAt(b.path, this.t);
  }

  holder(): FielderState | null {
    return this.ball.kind === 'held' ? this.fielders[this.ball.f] : null;
  }

  /** Runs that scored on this play and still count. */
  get runs(): number {
    return this.runsCounted;
  }

  // ------------------------------------------------------------------ player commands

  /** Send runners one more base. `id` null = every runner. */
  send(id: number | null): void {
    for (const r of this.activeRunners()) {
      if (id !== null && r.id !== id) continue;
      if (r.mustReturn || this.t < r.startAt) continue;
      if (r.target < r.pos) r.target = Math.ceil(r.pos);
      else r.target = Math.min(4, Math.max(r.target, Math.floor(r.pos)) + 1);
    }
    this.clampTargets();
  }

  /** Hold runners: stop at the base they are on, or go back to the last one. */
  hold(id: number | null): void {
    for (const r of this.activeRunners()) {
      if (id !== null && r.id !== id) continue;
      if (r.mustReturn) continue;
      if (r.forced && r.pos < r.origin + 1 && !(this.waitingOnFly && r.origin > 0)) continue; // a forced runner has to go
      if (isOnBase(r)) r.target = r.pos;
      else if (r.target > r.pos) r.target = Math.floor(r.pos);
    }
  }

  // ------------------------------------------------------------------ simulation

  step(dt: number): void {
    if (this.over) return;
    this.t += dt;
    this.stepBall();
    this.stepFielders(dt);
    this.stepRunners(dt);
    if (this.over) return;
    this.checkOuts();
    if (this.over) return;
    if (!this.manualDefense) this.decide();
    if (this.autoRun) this.runAi();
    this.checkEnd(dt);
  }

  private pathAt(path: FlightPoint[], t: number): FlightPoint {
    if (t <= path[0].t) return path[0];
    const last = path[path.length - 1];
    if (t >= last.t) return last;
    const step = path.length > 1 ? path[1].t - path[0].t : 1;
    return path[Math.min(path.length - 1, Math.floor((t - path[0].t) / step))];
  }

  private ballVelocity(): { vx: number; vy: number } {
    const a = this.ballPosition();
    const save = this.t;
    this.t = Math.max(0, save - 0.05);
    const b = this.ballPosition();
    this.t = save;
    return { vx: (a.x - b.x) / 0.05, vy: (a.y - b.y) / 0.05 };
  }

  private stepBall(): void {
    const b = this.ball;
    if (b.kind === 'flight') {
      const f = this.flight;
      if (!this.fair && this.t >= f.landing.t) {
        this.finish('foul');
        return;
      }
      if (f.overFence && this.t >= f.landing.t) {
        // ball is gone; runners keep trotting
        return;
      }
      if (this.waitingOnFly && this.t >= f.landing.t) {
        // It dropped in: forced runners go now.
        this.waitingOnFly = false;
        for (const r of this.activeRunners()) if (r.forced && r.target < r.origin + 1) r.target = r.origin + 1;
      }
      if (this.t >= f.duration) {
        const last = f.points[f.points.length - 1];
        this.ball = { kind: 'loose', path: [{ t: this.t, x: last.x, y: last.y, z: 0 }] };
        this.assignChase();
      }
    } else if (b.kind === 'held') {
      if (b.releaseAt !== null && this.t >= b.releaseAt && b.action) this.release(b.f, b.action);
    } else if (b.kind === 'thrown') {
      if (this.t >= b.t0 + b.dur) this.arrive(b);
    }
  }

  private release(fi: number, a: HeldAction): void {
    const f = this.fielders[fi];
    const speed = lerp(FC.throwSpeedMin, FC.throwSpeedMax, f.ratings.arm / 100);
    const d = dist(f.x, f.y, a.toX, a.toY);
    this.ball = {
      kind: 'thrown',
      fromX: f.x,
      fromY: f.y,
      toX: a.toX,
      toY: a.toY,
      t0: this.t,
      dur: Math.max(0.15, d / speed),
      by: fi,
      peg: a.kind === 'peg' ? a.runner : null,
      pegHit: a.kind === 'peg' ? a.hit : false,
    };
  }

  private arrive(b: Extract<Ball, { kind: 'thrown' }>): void {
    const dirX = (b.toX - b.fromX) / Math.max(1, dist(b.fromX, b.fromY, b.toX, b.toY));
    const dirY = (b.toY - b.fromY) / Math.max(1, dist(b.fromX, b.fromY, b.toX, b.toY));
    const speed = dist(b.fromX, b.fromY, b.toX, b.toY) / b.dur;
    const thrower = this.fielders[b.by];
    if (b.peg) {
      const r = b.peg;
      const p = this.runnerXY(r);
      const close = dist(p.x, p.y, b.toX, b.toY) <= FC.pegHitRadius;
      if (!r.out && !r.scored && !isOnBase(r) && close && b.pegHit) {
        this.recordOut(r, 'peg', Math.round(r.pos), thrower.pos);
        this.ball = { kind: 'loose', path: rollPath(p.x, p.y, -dirX * 6, -dirY * 6, this.t) };
      } else {
        this.events.push({ type: 'pegMiss', fielder: thrower.pos, runner: r });
        this.ball = {
          kind: 'loose',
          path: rollPath(b.toX, b.toY, dirX * speed * FC.looseKeep, dirY * speed * FC.looseKeep, this.t),
        };
      }
      this.assignChase();
      return;
    }
    // A throw: whoever is closest to where it arrives tries to catch it.
    let best = -1;
    let bestD = Infinity;
    this.fielders.forEach((f, i) => {
      if (i === b.by) return;
      const d = dist(f.x, f.y, b.toX, b.toY);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0 && bestD <= FC.receiveRadius) {
      const f = this.fielders[best];
      const p = lerp(FC.receiveMin, FC.receiveMax, f.ratings.glove / 100);
      if (this.rng() < p) {
        this.ball = { kind: 'held', f: best, releaseAt: null, action: null };
        this.nextDecision = this.t + FC.decisionInterval;
        return;
      }
      f.stunUntil = this.t + FC.errorStun;
      this.events.push({ type: 'error', fielder: f.pos, what: 'throw' });
    } else {
      this.events.push({ type: 'error', fielder: thrower.pos, what: 'throw' });
    }
    this.ball = {
      kind: 'loose',
      path: rollPath(b.toX, b.toY, dirX * speed * FC.looseKeep, dirY * speed * FC.looseKeep, this.t),
    };
    this.assignChase();
  }

  /** Predicts the ball's path from now, for working out who can get to it. */
  private predictedPath(): FlightPoint[] {
    const b = this.ball;
    if (b.kind === 'flight') {
      const pts = this.flight.points.filter((p) => p.t >= this.t);
      return pts.length ? pts : [this.flight.points[this.flight.points.length - 1]];
    }
    if (b.kind === 'loose') return b.path.filter((p) => p.t >= this.t).concat(b.path.slice(-1));
    return [];
  }

  /** Can any fielder get under this kick before it lands? */
  private catchableInAir(): boolean {
    const f = this.flight;
    return this.fielders.some((fl) =>
      f.points.some(
        (p) =>
          p.t < f.landing.t &&
          p.z <= FC.catchHeight &&
          Math.max(0, dist(fl.x, fl.y, p.x, p.y) - FC.reachFt) <= Math.max(0, p.t - FC.reactionTime) * fl.speed,
      ),
    );
  }

  /** Sends the fielder who can reach the ball first, and sets base coverage for the rest. */
  private assignChase(): void {
    const path = this.predictedPath();
    if (!path.length) return;
    let chaser = -1;
    let bestT = Infinity;
    let spot = { x: path[0].x, y: path[0].y };
    this.fielders.forEach((f, i) => {
      const react = this.t < FC.reactionTime ? FC.reactionTime - this.t : 0;
      for (const p of path) {
        if (p.z > FC.catchHeight) continue;
        const need = Math.max(0, dist(f.x, f.y, p.x, p.y) - FC.reachFt);
        const avail = Math.max(0, p.t - this.t - react) * f.speed;
        if (need <= avail) {
          if (p.t < bestT) {
            bestT = p.t;
            chaser = i;
            spot = { x: p.x, y: p.y };
          }
          return;
        }
      }
      // can't beat it anywhere: run to where it stops
      const last = path[path.length - 1];
      const tt = this.t + react + dist(f.x, f.y, last.x, last.y) / f.speed;
      if (tt < bestT) {
        bestT = tt;
        chaser = i;
        spot = { x: last.x, y: last.y };
      }
    });
    if (chaser < 0) return;
    const c = this.fielders[chaser];
    c.tx = spot.x;
    c.ty = spot.y;
    c.cover = null;
    this.assignCovers(chaser);
  }

  private assignCovers(busy: number): void {
    const taken = new Set<number>([busy]);
    const h = this.ball.kind === 'held' ? this.ball.f : -1;
    if (h >= 0) taken.add(h);
    for (const base of [1, 2, 3, 4]) {
      const order = base === 2 && this.flightSpray() > 0 ? ['SS', '2B', 'P'] : COVER_ORDER[base];
      for (const pos of order) {
        const i = this.fielders.findIndex((f) => f.pos === pos);
        if (i < 0 || taken.has(i)) continue;
        const f = this.fielders[i];
        const b = baseXY(base);
        f.cover = base;
        f.tx = b.x + (base === 4 ? 0 : 0);
        f.ty = b.y;
        taken.add(i);
        break;
      }
    }
  }

  private flightSpray(): number {
    const p = this.flight.landing;
    return Math.atan2(p.x, p.y);
  }

  private stepFielders(dt: number): void {
    const ballPos = this.ballPosition();
    this.fielders.forEach((f, i) => {
      const holding = this.ball.kind === 'held' && this.ball.f === i;
      const releasing = holding && this.ball.kind === 'held' && this.ball.releaseAt !== null;
      if (this.t < f.stunUntil || releasing || this.t < FC.reactionTime) {
        f.moving = false;
        return;
      }
      // Home in on a loose ball once close
      if ((this.ball.kind === 'loose' || this.ball.kind === 'flight') && f.cover === null) {
        if (dist(f.x, f.y, ballPos.x, ballPos.y) < 12 && ballPos.z < FC.catchHeight) {
          f.tx = ballPos.x;
          f.ty = ballPos.y;
        }
      }
      const d = dist(f.x, f.y, f.tx, f.ty);
      const stepLen = f.speed * dt;
      if (d > 0.05) {
        const k = Math.min(1, stepLen / d);
        f.x += (f.tx - f.x) * k;
        f.y += (f.ty - f.y) * k;
        f.moving = true;
      } else f.moving = false;

      // Fielding attempts
      if (holding || !(this.ball.kind === 'flight' || this.ball.kind === 'loose')) return;
      if (this.fair === false && this.ball.kind === 'flight' && this.t >= this.flight.landing.t) return;
      if (this.flight.overFence && this.ball.kind === 'flight') return;
      if (ballPos.z > FC.catchHeight) return;
      if (dist(f.x, f.y, ballPos.x, ballPos.y) > FC.reachFt) return;
      const last = this.attempted.get(i) ?? -1;
      if (this.t - last < FC.errorStun) return;
      this.attempted.set(i, this.t);
      this.tryField(i, ballPos);
    });
  }

  private tryField(i: number, ballPos: Vec3): void {
    const f = this.fielders[i];
    const airborne = this.ball.kind === 'flight' && this.t < this.flight.landing.t && ballPos.z > 0.2;
    let p: number;
    let hard = false;
    if (airborne) {
      p = lerp(FC.catchMin, FC.catchMax, f.ratings.glove / 100);
      if (f.moving) p *= FC.runningCatchMult;
      const v = this.ballVelocity();
      if (Math.hypot(v.vx, v.vy) > FC.hardLinerSpeed) {
        p *= FC.hardLinerMult;
        hard = true;
      }
    } else {
      p = lerp(FC.pickupMin, FC.pickupMax, f.ratings.glove / 100);
      const v = this.ballVelocity();
      if (Math.hypot(v.vx, v.vy) > FC.hardGrounderSpeed) {
        p *= FC.hardGrounderMult;
        hard = true;
      }
    }
    if (this.rng() < p) {
      this.ball = { kind: 'held', f: i, releaseAt: null, action: null };
      this.nextDecision = this.t + FC.decisionInterval;
      if (airborne) this.flyCaught(f);
      else if (!this.fair) this.finish('foul');
      return;
    }
    // Bobbled. A ball hit too hard to handle is a hit, not an error.
    f.stunUntil = this.t + FC.errorStun;
    if (!hard) this.events.push({ type: 'error', fielder: f.pos, what: airborne ? 'drop' : 'bobble' });
    else this.events.push({ type: 'knockedDown', fielder: f.pos });
    if (this.waitingOnFly) {
      this.waitingOnFly = false;
      for (const r of this.activeRunners()) if (r.forced && r.target < r.origin + 1) r.target = r.origin + 1;
    }
    if (!this.fair) {
      this.finish('foul');
      return;
    }
    const v = this.ballVelocity();
    const jx = (this.rng() - 0.5) * 8;
    const jy = (this.rng() - 0.5) * 8;
    this.ball = {
      kind: 'loose',
      path: rollPath(ballPos.x, ballPos.y, v.vx * FC.looseKeep + jx, v.vy * FC.looseKeep + jy, this.t),
    };
    this.assignChase();
  }

  private flyCaught(f: FielderState): void {
    this.caughtFly = true;
    this.events.push({ type: 'catch', fielder: f.pos, foul: !this.fair });
    const b = this.batter;
    if (b) this.recordOut(b, this.fair ? 'fly' : 'foulFly', 0, f.pos);
    else {
      // foul fly: the kicker was never a runner
      this.outs++;
      this.events.push({
        type: 'out',
        runner: { id: -1, player: { name: 'Kicker' } as Player, origin: 0, pos: 0, target: 0, speed: 0, out: true, scored: false, forced: false, mustReturn: false, startAt: 0 },
        how: 'foulFly',
        base: 0,
        fielder: f.pos,
      });
      this.finish(this.outs >= CONFIG.rules.outsPerHalf ? 'threeOuts' : 'settled');
      return;
    }
    if (this.over) return;
    for (const r of this.activeRunners()) {
      r.forced = false;
      if (r.pos !== r.origin) {
        r.mustReturn = true;
        r.target = r.origin;
      }
    }
  }

  private updateForces(): void {
    const batter = this.batter;
    const chain = (origin: number): boolean => {
      if (origin === 0) return !!batter && !batter.out && !this.caughtFly;
      const behind = this.runners.find((r) => r.origin === origin - 1);
      return !!behind && !behind.out && chain(origin - 1);
    };
    for (const r of this.runners) r.forced = !r.out && !this.caughtFly && chain(r.origin);
  }

  private clampTargets(): void {
    const act = this.activeRunners(); // lead runner first
    for (let i = 1; i < act.length; i++) {
      const lead = act[i - 1];
      const max = lead.target >= 4 ? 4 : lead.target - 1;
      if (act[i].target > max) act[i].target = Math.max(Math.floor(act[i].pos), max);
    }
  }

  private stepRunners(dt: number): void {
    this.clampTargets();
    for (const r of this.activeRunners()) {
      if (this.t < r.startAt) continue;
      if (r.target === r.pos) continue;
      const dir = Math.sign(r.target - r.pos);
      const next = r.pos + (dir * r.speed * dt) / BASE_FT;
      r.pos = (dir > 0 && next >= r.target) || (dir < 0 && next <= r.target) ? r.target : next;
      if (r.mustReturn && r.pos === r.origin) r.mustReturn = false;
      if (r.pos >= 4) {
        r.pos = 4;
        r.scored = true;
        this.scoredThisPlay.push(r);
        this.runsCounted++;
        this.events.push({ type: 'run', runner: r });
      }
    }
    if (this.flight.overFence && this.activeRunners().length === 0) this.finish('homeRun');
  }

  private recordOut(r: RunnerState, how: OutHow, base: number, fielder: string): void {
    r.out = true;
    this.outs++;
    this.events.push({ type: 'out', runner: r, how, base, fielder });
    this.updateForces();
    if (this.outs >= CONFIG.rules.outsPerHalf) {
      // No runs count when the third out is a force (or the kicker out before reaching first).
      if (how === 'force' && this.scoredThisPlay.length) {
        this.events.push({ type: 'runsWipedOut', count: this.scoredThisPlay.length });
        this.runsCounted = 0;
      }
      this.finish('threeOuts');
    }
  }

  private checkOuts(): void {
    const h = this.holder();
    if (!h) return;
    for (const r of this.activeRunners()) {
      // force or failure to retouch: ball beats the runner to the base
      let forceBase: number | null = null;
      if (r.mustReturn) forceBase = r.origin;
      else if (r.forced && r.pos < r.origin + 1) forceBase = r.origin + 1;
      if (forceBase !== null) {
        const b = baseXY(forceBase);
        if (dist(h.x, h.y, b.x, b.y) <= FC.baseRadius) {
          this.recordOut(r, r.mustReturn ? 'doubledOff' : 'force', forceBase, h.pos);
          if (this.over) return;
          continue;
        }
      }
      // tag a runner caught between bases
      if (!isOnBase(r)) {
        const p = this.runnerXY(r);
        if (dist(h.x, h.y, p.x, p.y) <= FC.tagRadius) {
          this.recordOut(r, 'tag', Math.round(r.pos), h.pos);
          if (this.over) return;
        }
      }
    }
  }

  // ------------------------------------------------------------------ the player's defense

  /** True while a fielder has the ball and is waiting for the player's call. */
  awaitingThrow(): boolean {
    return this.manualDefense && this.ball.kind === 'held' && this.ball.releaseAt === null && !this.over;
  }

  /** Throw to a base (1-4). A fielder close to that base runs there instead. */
  throwTo(base: number): void {
    const b = this.ball;
    if (b.kind !== 'held' || b.releaseAt !== null) return;
    const h = this.fielders[b.f];
    const bp = baseXY(base);
    if (dist(h.x, h.y, bp.x, bp.y) < 18) {
      h.tx = bp.x;
      h.ty = bp.y;
      return;
    }
    b.action = { kind: 'throw', base, toX: bp.x, toY: bp.y };
    b.releaseAt = this.t + FC.releaseDelay;
  }

  /** Peg the closest runner caught between bases. Returns false if nobody is in range. */
  pegNearest(): boolean {
    const b = this.ball;
    if (b.kind !== 'held' || b.releaseAt !== null) return false;
    const h = this.fielders[b.f];
    const throwSpeed = lerp(FC.throwSpeedMin, FC.throwSpeedMax, h.ratings.arm / 100);
    const targets = this.activeRunners()
      .filter((r) => !isOnBase(r))
      .map((r) => ({ r, d: dist(h.x, h.y, this.runnerXY(r).x, this.runnerXY(r).y) }))
      .filter((x) => x.d <= FC.pegRange * 1.3)
      .sort((a, c) => a.d - c.d);
    if (!targets.length) return false;
    const { r, d } = targets[0];
    const chance = lerp(FC.pegHitMin, FC.pegHitMax, h.ratings.arm / 100) * Math.max(0.1, 1 - 0.5 * (d / FC.pegRange));
    const travel = FC.releaseDelay + d / throwSpeed;
    const dir = Math.sign(r.target - r.pos);
    const aim = pathXY(clamp(r.pos + (dir * r.speed * travel) / BASE_FT, 0, 4));
    b.action = { kind: 'peg', runner: r, toX: aim.x, toY: aim.y, hit: this.rng() < chance };
    b.releaseAt = this.t + FC.releaseDelay;
    return true;
  }

  /** The base the lead runner is heading for: a sensible default throw. */
  suggestedBase(): number {
    const moving = this.activeRunners().filter((r) => r.target !== r.pos || !isOnBase(r));
    if (!moving.length) return 2;
    const lead = moving[0];
    return lead.target === 0 ? 1 : lead.target;
  }

  // ------------------------------------------------------------------ computer baserunning

  private runAi(): void {
    if (this.t < this.nextRunDecision) return;
    this.nextRunDecision = this.t + CONFIG.ai.runDecisionInterval;
    // While a catchable fly is up, wait.
    if (this.ball.kind === 'flight' && this.waitingOnFly) return;
    const ballPos = this.ballPosition();
    const holder = this.holder();
    // Time for the defense to get the ball into a fielder's hands
    let getBall = 0;
    if (!holder) {
      getBall = Math.min(...this.fielders.map((f) => Math.max(0, dist(f.x, f.y, ballPos.x, ballPos.y) - FC.reachFt) / f.speed));
    }
    const fromX = holder ? holder.x : ballPos.x;
    const fromY = holder ? holder.y : ballPos.y;
    for (const r of this.activeRunners()) {
      if (r.mustReturn || this.t < r.startAt) continue;
      // Decide on the base past the one the runner is already heading for, while still running.
      if (r.target < r.pos || r.target >= 4) continue;
      const next = Math.max(r.target, Math.floor(r.pos)) + 1;
      if (next > 4) continue;
      const bp = baseXY(next);
      const avgThrow = (FC.throwSpeedMin + FC.throwSpeedMax) / 2;
      const ballT = getBall + FC.releaseDelay + dist(fromX, fromY, bp.x, bp.y) / avgThrow;
      const runT = ((next - r.pos) * BASE_FT) / r.speed;
      if (runT + CONFIG.ai.runAggression < ballT) r.target = next;
      else if (!isOnBase(r) && r.target > r.pos && !(r.forced && r.pos < r.origin + 1)) {
        // heading for a base it can't make: go back
        const back = Math.floor(r.pos);
        const backT = ((r.pos - back) * BASE_FT) / r.speed;
        if (runT > ballT && backT < runT) r.target = back;
      }
    }
    this.clampTargets();
  }

  // ------------------------------------------------------------------ defensive decisions

  private decide(): void {
    const b = this.ball;
    if (b.kind !== 'held' || b.releaseAt !== null || this.t < this.nextDecision) return;
    this.nextDecision = this.t + FC.decisionInterval;
    const hi = b.f;
    const h = this.fielders[hi];
    const throwSpeed = lerp(FC.throwSpeedMin, FC.throwSpeedMax, h.ratings.arm / 100);

    type Option = { value: number; run?: { x: number; y: number }; act?: HeldAction };
    let best: Option | null = null;
    const consider = (o: Option) => {
      if (!best || o.value > best.value) best = o;
    };

    for (const r of this.activeRunners()) {
      if (r.target === r.pos && isOnBase(r)) continue; // standing safe
      if (this.t < r.startAt && r.origin === 0) {
        // kicker hasn't left yet; treat as heading to first
      }
      const dest = r.target;
      const forceDest = r.mustReturn ? r.origin : r.forced && r.pos < r.origin + 1 ? r.origin + 1 : null;
      const runnerEta = (Math.abs(dest - r.pos) * BASE_FT) / r.speed + Math.max(0, r.startAt - this.t);
      const bp = baseXY(dest);
      const selfT = dist(h.x, h.y, bp.x, bp.y) / h.speed;
      const coverer = this.fielders.findIndex((f, i) => i !== hi && f.cover === (dest === 0 ? 4 : dest));
      let throwT = Infinity;
      if (coverer >= 0) {
        const c = this.fielders[coverer];
        const arrive = FC.releaseDelay + dist(h.x, h.y, bp.x, bp.y) / throwSpeed;
        const cEta = dist(c.x, c.y, bp.x, bp.y) / c.speed;
        if (cEta <= arrive + 0.25) throwT = arrive;
      }
      const ballT = Math.min(selfT, throwT);
      const leadBonus = dest * 0.15 + (dest >= 4 ? 0.5 : 0);
      if (ballT + FC.outMargin < runnerEta) {
        const value = (forceDest === dest ? 3 : 2.2) + leadBonus;
        if (selfT <= throwT) consider({ value, run: bp });
        else consider({ value, act: { kind: 'throw', base: dest, toX: bp.x, toY: bp.y } });
      }
      // Peg a runner caught between bases
      if (!isOnBase(r)) {
        const rp = this.runnerXY(r);
        const d = dist(h.x, h.y, rp.x, rp.y);
        if (d <= FC.pegRange) {
          const chance = lerp(FC.pegHitMin, FC.pegHitMax, h.ratings.arm / 100) * (1 - 0.5 * (d / FC.pegRange));
          if (chance >= FC.pegMinChance) {
            // lead the runner
            const travel = FC.releaseDelay + d / throwSpeed;
            const dir = Math.sign(r.target - r.pos);
            const aim = pathXY(clamp(r.pos + (dir * r.speed * travel) / BASE_FT, 0, 4));
            consider({
              value: 1.2 + chance + leadBonus,
              act: { kind: 'peg', runner: r, toX: aim.x, toY: aim.y, hit: this.rng() < chance },
            });
          }
        }
      }
      // Nothing sure: at least get the ball to the base the runner is going to
      if (coverer >= 0) consider({ value: 0.5 + leadBonus, act: { kind: 'throw', base: dest, toX: bp.x, toY: bp.y } });
    }

    const choice = best as Option | null;
    if (choice) {
      if (choice.run) {
        h.tx = choice.run.x;
        h.ty = choice.run.y;
      } else if (choice.act) {
        b.action = choice.act;
        b.releaseAt = this.t + FC.releaseDelay;
        h.tx = h.x;
        h.ty = h.y;
      }
      return;
    }
    // Nobody running. An outfielder throws it back in to the infield.
    if (!INFIELD.has(h.pos)) {
      const cut = this.fielders
        .map((f, i) => ({ f, i }))
        .filter(({ f, i }) => i !== hi && (f.pos === 'SS' || f.pos === '2B'))
        .sort((a, b2) => dist(a.f.x, a.f.y, h.x, h.y) - dist(b2.f.x, b2.f.y, h.x, h.y))[0];
      if (cut) {
        b.action = { kind: 'throw', base: null, toX: cut.f.x, toY: cut.f.y };
        b.releaseAt = this.t + FC.releaseDelay;
      }
    } else {
      h.tx = h.x;
      h.ty = h.y;
    }
  }

  private checkEnd(dt: number): void {
    if (this.t > FC.maxPlayTime) {
      this.finish('timeout');
      return;
    }
    const allSafe = this.activeRunners().every((r) => isOnBase(r) && r.target === r.pos && !r.mustReturn);
    const b = this.ball;
    const settledBall =
      b.kind === 'held' && b.releaseAt === null && (this.manualDefense || INFIELD.has(this.fielders[b.f].pos));
    if (allSafe && settledBall) {
      this.settledFor += dt;
      if (this.settledFor >= FC.settleTime) this.finish('settled');
    } else this.settledFor = 0;
  }

  private finish(reason: EndReason): void {
    if (this.over) return;
    this.over = true;
    this.endReason = reason;
  }

  // ------------------------------------------------------------------ results

  /** Runners left on base after the play, as [1st, 2nd, 3rd]. */
  basesAfter(): (Player | null)[] {
    const bases: (Player | null)[] = [null, null, null];
    for (const r of this.activeRunners()) {
      const b = Math.round(r.pos);
      if (b >= 1 && b <= 3) bases[b - 1] = r.player;
    }
    return bases;
  }

  /** What the kicker got: 0 = out, 1-3 = bases, 4 = home run. */
  batterResult(): number {
    const b = this.batter;
    if (!b || b.out) return 0;
    if (b.scored) return 4;
    return Math.round(b.pos);
  }

  hadError(): boolean {
    return this.events.some((e) => e.type === 'error');
  }

  /** Short sentence about outs, runs and errors on this play. */
  summary(): string {
    const parts: string[] = [];
    for (const e of this.events) {
      if (e.type === 'out' && e.runner.origin !== 0) {
        const n = e.runner.player.name;
        if (e.how === 'force') parts.push(`${n} forced at ${BASE_SHORT[e.base]}.`);
        else if (e.how === 'tag') parts.push(`${n} tagged out.`);
        else if (e.how === 'peg') parts.push(`${n} pegged out!`);
        else if (e.how === 'doubledOff') parts.push(`${n} doubled off ${BASE_SHORT[e.base]}.`);
      }
      if (e.type === 'error') parts.push(`Error on the ${e.fielder}.`);
    }
    const scored = this.events.filter((e) => e.type === 'run').length;
    const wiped = this.events.find((e) => e.type === 'runsWipedOut');
    if (wiped) parts.push(`Third out was a force, so the run${scored > 1 ? 's don’t' : ' doesn’t'} count.`);
    else if (scored === 1) parts.push('1 run scores.');
    else if (scored > 1) parts.push(`${scored} runs score.`);
    return parts.join(' ');
  }

  /** How the kicker's own at-bat ended, in a few words. */
  batterLine(): string {
    const b = this.batter;
    const out = this.events.find((e) => e.type === 'out' && e.runner.origin === 0) as
      | Extract<PlayEvent, { type: 'out' }>
      | undefined;
    if (out) {
      if (out.how === 'fly') return `caught by the ${out.fielder}`;
      if (out.how === 'foulFly') return `caught in foul ground by the ${out.fielder}`;
      if (out.how === 'force') return `out at first`;
      if (out.how === 'peg') return `pegged out`;
      return `tagged out`;
    }
    if (!b) return '';
    const res = this.batterResult();
    const otherOut = this.events.some((e) => e.type === 'out' && e.runner.origin !== 0);
    if (res === 1 && otherOut) return "safe on a fielder's choice";
    if (res === 4) return this.flight.overFence ? 'home run' : 'inside-the-park home run';
    const err = this.hadError();
    return ['', err ? 'safe at first' : 'single', err ? 'safe at second' : 'double', err ? 'safe at third' : 'triple'][res];
  }
}
