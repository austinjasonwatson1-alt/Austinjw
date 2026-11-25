// Drive-by-drive game sim. Stops whenever your team attempts a kick (when you are the
// starter) and waits for the result. Honest: late kicks only happen when a close game
// produces them. Seeded, no UI code.

import { CONFIG, type LevelKey, type Weather } from '../config';
import type { Hash, KickerRatings } from '../kick/physics';
import { Rng } from '../sim/rng';
import { autoMakeProb, coachRangeYd, evenSkills, trustDelta } from './progression';
import type { KickLog, Rival, Role, Team } from './types';

export interface GameSetup {
  level: LevelKey;
  us: Team;
  them: Team;
  home: boolean;
  playoff: boolean;
  weather: Weather;
  windMph: number;
  windToDeg: number;
  kicker: KickerRatings;
  kickerName: string;
  trust: number;
  role: Role;
  rival: Rival | null;
  autoXp: boolean;
  seed: number;
  /** Name of the other team's kicker when he matters (your old rival). */
  oppKickerName?: string | null;
}

export interface TickerLine {
  q: number;
  clock: string;
  text: string;
  us: number;
  them: number;
  tone: 'us' | 'them' | 'neutral' | 'me' | 'coach';
}

export interface KickMoment {
  xp: boolean;
  distance: number;
  hash: Hash;
  pressure: number;
  iced: boolean;
  gw: boolean;
  tag: string | null;
  q: number;
  clock: string;
  us: number;
  them: number;
  title: string;
  /** No timeouts and the clock running: aim before the snap. */
  hurry: boolean;
  /** You told the coach you could make it. */
  vouched: boolean;
}

/** The coach turns to you: can you make it from here? */
export interface AskMoment {
  distance: number;
  coachRange: number;
  spot: string;
  q: number;
  clock: string;
  us: number;
  them: number;
}

type Yielded = { line: TickerLine } | { kick: KickMoment } | { ask: AskMoment };

export interface SimStep {
  line?: TickerLine;
  kick?: KickMoment;
  ask?: AskMoment;
  done: boolean;
}

export class GameSim {
  readonly s: GameSetup;
  private rng: Rng;
  private gen: Generator<Yielded, void, boolean | undefined>;
  us = 0;
  them = 0;
  q = 1;
  ot = false;
  trust: number;
  myKicks: KickLog[] = [];
  rivalKicks: KickLog[] = [];
  lines: TickerLine[] = [];
  done = false;
  private waiting: KickMoment | null = null;
  private asking: AskMoment | null = null;
  private qLen: number;
  private t: number;
  private timeouts = { us: 3, them: 3 };

  constructor(setup: GameSetup) {
    this.s = setup;
    this.rng = new Rng(setup.seed);
    this.trust = setup.trust;
    this.qLen = (setup.level === 'hs' ? CONFIG.career.sim.quarterMin : CONFIG.career.sim.quarterMinBig) * 60;
    this.t = this.qLen;
    this.gen = this.run();
  }

  /** Advance to the next ticker line or kick moment. */
  next(): SimStep {
    if (this.done) return { done: true };
    if (this.waiting) return { kick: this.waiting, done: false };
    if (this.asking) return { ask: this.asking, done: false };
    const r = this.gen.next(undefined);
    return this.handle(r);
  }

  /** Answer the coach: true = "I've got it". */
  answerAsk(yes: boolean): SimStep {
    if (!this.asking) return this.next();
    this.asking = null;
    return this.handle(this.gen.next(yes));
  }

  /** Report the result of the kick moment the sim is waiting on. */
  answer(made: boolean): SimStep {
    if (!this.waiting) return this.next();
    this.waiting = null;
    return this.handle(this.gen.next(made));
  }

  /** Simulate everything to the end, auto-resolving my kicks (tests, backups). */
  simToEnd(): void {
    let step = this.next();
    let guard = 0;
    while (!step.done && guard++ < 5000) {
      if (step.ask) {
        step = this.answerAsk(autoMakeProb(this.s.kicker, step.ask.distance, this.s.weather, this.s.windMph, 0.3) > 0.55);
        continue;
      }
      if (step.kick) {
        const k = step.kick;
        step = this.answer(this.rng.next() < autoMakeProb(this.s.kicker, k.distance, this.s.weather, this.s.windMph, k.pressure));
      } else step = this.next();
    }
  }

  private handle(r: IteratorResult<Yielded, void>): SimStep {
    if (r.done) {
      this.done = true;
      return { done: true };
    }
    const v = r.value;
    if ('kick' in v) {
      this.waiting = v.kick;
      return { kick: v.kick, done: false };
    }
    if ('ask' in v) {
      this.asking = v.ask;
      return { ask: v.ask, done: false };
    }
    this.lines.push(v.line);
    return { line: v.line, done: false };
  }

  // -------------------------------------------------------------------------

  private clock(): string {
    if (this.ot) return 'OT';
    const t = Math.max(0, Math.round(this.t));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  }

  private line(text: string, tone: TickerLine['tone'] = 'neutral'): Yielded {
    return { line: { q: this.ot ? 5 : this.q, clock: this.clock(), text, us: this.us, them: this.them, tone } };
  }

  private secondsLeftInGame(): number {
    return this.ot ? 0 : (4 - this.q) * this.qLen + this.t;
  }

  private strength(side: 'us' | 'them'): number {
    const team = side === 'us' ? this.s.us : this.s.them;
    const homeEdge = (side === 'us') === this.s.home ? 2 : -2;
    return team.strength + homeEdge;
  }

  private oppKicker(): KickerRatings {
    return evenSkills(CONFIG.career.sim.oppKickerRating[this.s.level] + (this.s.them.strength - 50) * 0.15);
  }

  private myKicker(): { skills: KickerRatings; mine: boolean } {
    if (this.s.role === 'starter') return { skills: this.s.kicker, mine: true };
    return { skills: evenSkills(this.s.rival?.overall ?? 60), mine: false };
  }

  private *run(): Generator<Yielded, void, boolean | undefined> {
    const first: 'us' | 'them' = this.rng.next() < 0.5 ? 'us' : 'them';
    let poss = first;
    yield this.line(`${this.s.home ? this.s.us.name : this.s.them.name} hosts. ${poss === 'us' ? this.s.us.name : this.s.them.name} get the ball first.`);

    for (this.q = 1; this.q <= 4; ) {
      const endOfHalf = this.q === 2 || this.q === 4;
      const dur = this.rng.range(CONFIG.career.sim.driveMinutes[0], CONFIG.career.sim.driveMinutes[1]) * 60;
      let lastPlay = false;
      if (dur >= this.t) {
        if (endOfHalf) {
          lastPlay = true;
          this.t = 0;
        } else {
          const carry = dur - this.t;
          this.q++;
          this.t = this.qLen - carry;
          yield this.line(`End of the ${this.q === 2 ? '1st' : '3rd'} quarter.`);
        }
      } else this.t -= dur;

      yield* this.drive(poss, lastPlay);
      poss = poss === 'us' ? 'them' : 'us';

      if (lastPlay) {
        if (this.q === 2) {
          yield this.line(`Halftime.`);
          this.q = 3;
          this.t = this.qLen;
          this.timeouts = { us: 3, them: 3 };
          poss = first === 'us' ? 'them' : 'us';
        } else {
          this.q = 5;
        }
      }
    }

    if (this.us === this.them) {
      yield this.line('Tied at the end of regulation. Overtime.');
      this.ot = true;
      this.timeouts = { us: 1, them: 1 };
      let otFirst: 'us' | 'them' = this.rng.next() < 0.5 ? 'us' : 'them';
      for (let round = 0; round < 6 && this.us === this.them; round++) {
        yield* this.drive(otFirst, false);
        yield* this.drive(otFirst === 'us' ? 'them' : 'us', false);
        otFirst = otFirst === 'us' ? 'them' : 'us';
      }
    }
    const res = this.us > this.them ? 'win' : this.us < this.them ? 'lose' : 'tie';
    yield this.line(`Final: ${this.s.us.short} ${this.us}, ${this.s.them.short} ${this.them}.${res === 'tie' ? ' A tie.' : ''}`, res === 'win' ? 'us' : res === 'lose' ? 'them' : 'neutral');
  }

  private *drive(side: 'us' | 'them', lastPlay: boolean): Generator<Yielded, void, boolean | undefined> {
    const S = CONFIG.career.sim;
    const base = S[this.s.level];
    const team = side === 'us' ? this.s.us : this.s.them;
    const diff = (this.strength(side) - this.strength(side === 'us' ? 'them' : 'us')) * S.strengthEffect;
    const margin = side === 'us' ? this.us - this.them : this.them - this.us;
    const late = (this.q === 4 && this.t < 150) || lastPlay || this.ot;
    let td = base.td + diff;
    let fg = base.fgChance;
    if (late && margin >= -3) {
      // Late and close or ahead: bleed clock, settle for points.
      td -= 0.04;
      fg += S.twoMinuteFgBoost;
    }
    if (this.ot) fg += 0.12;
    if (lastPlay && this.q === 2) {
      td *= 0.6;
      fg += 0.1;
    }
    const to = base.turnover - diff / 2;
    const r = this.rng.next();

    if (r < td) {
      if (side === 'us') this.us += 6;
      else this.them += 6;
      yield this.line(`TOUCHDOWN ${team.name}. ${this.driveFlavor()}`, side);
      yield* this.extraPoint(side);
      return;
    }
    if (r < td + fg) {
      const [lo, hi] = S.stallYardline;
      const yl = Math.round(lo + (hi - lo) * Math.pow(this.rng.next(), 1.15));
      yield* this.fieldGoalDecision(side, yl, lastPlay);
      return;
    }
    if (r < td + fg + to) {
      yield this.line(`${team.name} turn it over${this.rng.next() < 0.5 ? ' on an interception' : ' on a fumble'}.`, side === 'us' ? 'them' : 'us');
      return;
    }
    if (this.rng.next() < base.safety * 8) {
      if (side === 'us') this.them += 2;
      else this.us += 2;
      yield this.line(`SAFETY. ${team.name} are tackled in their own end zone.`, side === 'us' ? 'them' : 'us');
      return;
    }
    if (lastPlay) {
      yield this.line(`${team.name} run out the clock.`);
      return;
    }
    yield this.line(`${team.name} punt after ${this.rng.int(3, 9)} plays.`);
  }

  private driveFlavor(): string {
    const plays = this.rng.int(4, 13);
    const yards = this.rng.int(45, 85);
    const how = this.rng.pick(['on a short run', 'on a pass to the corner', 'on a QB sneak', 'on a screen pass', 'on a deep ball', 'up the middle']);
    return `${plays} plays, ${yards} yards, scoring ${how}.`;
  }

  private *extraPoint(side: 'us' | 'them'): Generator<Yielded, void, boolean | undefined> {
    const dist = CONFIG.levels[this.s.level].xpDistanceYd;
    if (side === 'them') {
      if (this.rng.next() < autoMakeProb(this.oppKicker(), dist, this.s.weather, this.s.windMph, 0.1)) {
        this.them += 1;
        yield this.line(`${this.s.them.name} add the extra point.`, 'them');
      } else yield this.line(`${this.s.them.name} miss the extra point.`, 'us');
      return;
    }
    const kicker = this.myKicker();
    const margin = this.us - this.them; // after the TD
    const late = (this.q >= 4 && this.secondsLeftInGame() < 120) || this.ot;
    const p = Math.min(late && margin === -1 ? 1 : CONFIG.career.pressure.xpCap, this.pressureFor(margin, true));
    let made: boolean;
    if (kicker.mine && !this.s.autoXp) {
      made = (yield { kick: this.moment(true, dist, p, late && margin === -1, margin) }) ?? false;
    } else {
      made = this.rng.next() < autoMakeProb(kicker.skills, dist, this.s.weather, this.s.windMph, p);
    }
    this.log(kicker.mine, dist, made, true, p, late && margin === -1);
    if (made) {
      this.us += 1;
      yield this.line(`${kicker.mine ? this.s.kickerName : this.s.rival?.name ?? 'The kicker'} hits the extra point.`, kicker.mine ? 'me' : 'us');
    } else yield this.line(`Extra point NO GOOD by ${kicker.mine ? this.s.kickerName : this.s.rival?.name ?? 'the kicker'}.`, kicker.mine ? 'me' : 'them');
  }

  private pressureFor(marginBefore: number, xp: boolean): number {
    const P = CONFIG.career.pressure;
    let p = P.base;
    const secs = this.secondsLeftInGame();
    const close = Math.abs(marginBefore) <= 8;
    if ((this.q >= 4 || this.ot) && close) p += P.q4Close;
    if ((this.q >= 4 && secs <= 120) || this.ot) p += P.lastTwoMin;
    if (this.s.playoff) p += CONFIG.pressure.playoffBoost;
    if (!xp && this.isGameWinner(marginBefore)) p += P.gameWinner;
    return Math.min(1, p);
  }

  private isGameWinner(marginBefore: number): boolean {
    const final = this.ot || (this.q >= 4 && this.secondsLeftInGame() <= 40);
    return final && marginBefore <= 0 && marginBefore >= -3;
  }

  private moment(xp: boolean, distance: number, pressure: number, gw: boolean, margin: number, hurry = false, vouched = false): KickMoment {
    let iced = false;
    if (!xp && pressure >= CONFIG.icing.minPressure && this.timeouts.them > 0 && this.rng.next() < CONFIG.icing.chanceWhenAvailable) {
      iced = true;
      this.timeouts.them--;
    }
    const hr = this.rng.next();
    const hash: Hash = xp ? 'M' : hr < 0.35 ? 'L' : hr < 0.65 ? 'M' : 'R';
    let tag: string | null = null;
    if (gw) tag = xp ? 'TO TIE' : margin === -3 ? 'TO TIE' : this.ot || this.secondsLeftInGame() <= 5 ? 'GAME-WINNER' : 'GO-AHEAD';
    else if (pressure >= 0.6) tag = 'PRESSURE';
    return {
      xp,
      distance,
      hash,
      pressure,
      iced,
      gw,
      tag,
      q: this.ot ? 5 : this.q,
      clock: this.clock(),
      us: this.us,
      them: this.them,
      title: xp ? 'Extra point' : `${distance}-yard field goal`,
      hurry,
      vouched,
    };
  }

  private log(mine: boolean, d: number, made: boolean, xp: boolean, pressure: number, gw: boolean, vouched = false) {
    const k: KickLog = { d, made, xp, pressure, gw, q: this.ot ? 5 : this.q, clock: this.clock(), by: mine ? 'me' : 'rival', vouched };
    if (mine) {
      this.myKicks.push(k);
      const A = CONFIG.story.coachAsk;
      this.trust = Math.max(0, Math.min(100, this.trust + trustDelta(k) + (vouched ? (made ? A.vouchMake : A.vouchMiss) : 0)));
    } else this.rivalKicks.push(k);
  }

  private *fieldGoalDecision(side: 'us' | 'them', yl: number, lastPlay: boolean): Generator<Yielded, void, boolean | undefined> {
    const dist = yl + 17;
    const ytg = this.rng.int(2, 11);
    const spot = `4th & ${ytg} at the ${side === 'us' ? this.s.them.short : this.s.us.short} ${yl}`;
    const marginBefore = side === 'us' ? this.us - this.them : this.them - this.us;
    const needPoints = lastPlay || (this.q === 4 && this.t < 60) || this.ot;
    const desperation = needPoints && marginBefore <= 0 && marginBefore >= -3 ? CONFIG.career.trust.desperationBonusYd : lastPlay && this.q === 2 ? CONFIG.career.trust.desperationBonusYd : 0;

    if (side === 'them') {
      const k = this.oppKicker();
      const range = coachRangeYd(k, this.s.weather, this.s.windMph, 60) + desperation;
      if (dist <= range) {
        if (this.rng.next() < autoMakeProb(k, dist, this.s.weather, this.s.windMph, 0.2)) {
          this.them += 3;
          yield this.line(this.s.oppKickerName ? `${this.s.oppKickerName} hits a ${dist}-yarder for ${this.s.them.name}. Your old rival.` : `${this.s.them.name} kick a ${dist}-yard field goal.`, 'them');
        } else yield this.line(this.s.oppKickerName ? `${this.s.oppKickerName} MISSES from ${dist} for ${this.s.them.name}.` : `${this.s.them.name} miss a ${dist}-yard field goal.`, 'us');
      } else if (yl <= 36 && this.rng.next() < 0.45) {
        if (this.rng.next() < 0.4) {
          this.them += 7;
          yield this.line(`${this.s.them.name} go for it on ${spot} and score. TOUCHDOWN.`, 'them');
        } else yield this.line(`${this.s.them.name} go for it on ${spot} and come up short.`, 'us');
      } else yield this.line(`${this.s.them.name} punt from the ${this.s.us.short} ${yl}.`);
      return;
    }

    const kicker = this.myKicker();
    const trust = kicker.mine ? this.trust : 60;
    const range = coachRangeYd(kicker.skills, this.s.weather, this.s.windMph, trust) + desperation;
    const who = kicker.mine ? this.s.kickerName : this.s.rival?.name ?? 'the starter';

    // Close to the edge of his range: the coach asks you.
    let vouched = false;
    if (dist > range && kicker.mine && dist <= range + CONFIG.story.coachAsk.windowYd) {
      const yes = (yield { ask: { distance: dist, coachRange: Math.floor(range), spot, q: this.ot ? 5 : this.q, clock: this.clock(), us: this.us, them: this.them } }) ?? false;
      if (yes) {
        vouched = true;
        yield this.line(`${spot}. Coach asks ${who} if he can make it from ${dist}. "I've got it." Field goal unit on.`, 'coach');
      } else {
        this.trust = Math.max(0, this.trust + CONFIG.story.coachAsk.decline);
        yield this.line(`${who} waves it off from ${dist}. The coach nods, but he'll remember.`, 'coach');
      }
    }
    if (dist > range && !vouched) {
      const goForIt = yl <= 38 && (this.rng.next() < 0.5 || (this.q >= 4 && marginBefore < 0));
      if (kicker.mine) yield this.line(`${spot}. Coach won't trust ${who} from ${dist} (his range today: ${Math.floor(range)}).`, 'coach');
      if (goForIt) {
        if (this.rng.next() < 0.42) {
          this.us += 6;
          yield this.line(`${this.s.us.name} go for it and convert, then punch it in. TOUCHDOWN.`, 'us');
          yield* this.extraPoint('us');
        } else yield this.line(`${this.s.us.name} go for it on ${spot}. Stopped short.`, 'them');
      } else if (lastPlay) {
        yield this.line(`Time runs out on ${this.s.us.name} at the ${this.s.them.short} ${yl}.`);
      } else yield this.line(`${this.s.us.name} punt from the ${this.s.them.short} ${yl}.`);
      return;
    }

    const pressure = Math.min(1, this.pressureFor(marginBefore, false) + (vouched ? 0.15 : 0));
    const gw = this.isGameWinner(marginBefore);
    // Last play with the clock running and no timeouts: the unit sprints on.
    const hurry = lastPlay && this.rng.next() < CONFIG.story.hurry.chance;
    if (hurry) yield this.line(`${spot}. No timeouts, clock running. The field goal unit SPRINTS on.`, 'coach');
    else if (lastPlay) yield this.line(`${spot}. ${this.q === 2 ? 'Seconds left in the half.' : 'Final seconds.'} Field goal unit on.`, 'coach');
    else if (!vouched) yield this.line(`${spot}. ${kicker.mine ? 'Coach sends you out.' : `${who} trots on.`}`, 'coach');

    let made: boolean;
    if (kicker.mine) {
      made = (yield { kick: this.moment(false, dist, pressure, gw, marginBefore, hurry, vouched) }) ?? false;
    } else {
      made = this.rng.next() < autoMakeProb(kicker.skills, dist, this.s.weather, this.s.windMph, pressure);
    }
    this.log(kicker.mine, dist, made, false, pressure, gw, vouched);
    if (made) {
      this.us += 3;
      yield this.line(`${who} is GOOD from ${dist}.${gw ? ' Huge kick.' : ''}`, kicker.mine ? 'me' : 'us');
    } else yield this.line(`${who} MISSES from ${dist}.`, kicker.mine ? 'me' : 'them');
  }
}
