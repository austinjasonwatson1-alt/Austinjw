import { CONFIG } from '../config';
import type { Player, Team } from '../data/types';
import { HalfInning } from './half';
import { fieldForInning, type FieldPos, type Lineup } from './lineup';
import type { LivePlay } from './play';

export interface Side {
  team: Team;
  lineup: Lineup;
  isPlayer: boolean;
  next: number; // index in the kicking order of the next kicker
}

export interface BoxLine {
  player: Player;
  ab: number;
  r: number;
  h: number;
  rbi: number;
  hr: number;
  bb: number;
  e: number;
  outsMade: number; // putouts and assists, for player of the game
}

export interface GameOptions {
  innings: number;
  extraInnings: 'one-then-tie' | 'until-winner';
}

/** A whole game: innings, halves, line score and every player's line. */
export class GameState {
  away: Side;
  home: Side;
  inning = 1;
  top = true;
  half = new HalfInning();
  line: [number[], number[]] = [[], []];
  hits: [number, number] = [0, 0];
  errors: [number, number] = [0, 0];
  box = new Map<Player, BoxLine>();
  over = false;
  opts: GameOptions;

  constructor(away: Side, home: Side, opts: Partial<GameOptions> = {}) {
    this.away = away;
    this.home = home;
    this.opts = { innings: CONFIG.rules.innings, extraInnings: 'one-then-tie', ...opts };
    for (const s of [away, home]) for (const p of s.lineup.order) this.box.set(p, blank(p));
    this.line[0].push(0);
  }

  get kicking(): Side {
    return this.top ? this.away : this.home;
  }
  get fielding(): Side {
    return this.top ? this.home : this.away;
  }
  get score(): [number, number] {
    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
    return [sum(this.line[0]), sum(this.line[1])];
  }
  get kickerUp(): Player {
    const s = this.kicking;
    return s.lineup.order[s.next % s.lineup.order.length];
  }
  get onDeck(): Player {
    const s = this.kicking;
    return s.lineup.order[(s.next + 1) % s.lineup.order.length];
  }
  /** Who plays each spot for the fielding team this inning. */
  defense(): Record<FieldPos, Player> {
    return fieldForInning(this.fielding.lineup, this.inning);
  }
  private sideIdx(): 0 | 1 {
    return this.top ? 0 : 1;
  }

  private addRuns(n: number): void {
    const l = this.line[this.sideIdx()];
    l[l.length - 1] += n;
  }

  // ------------------------------------------------------------------ recording plate appearances

  /** A walk. */
  walk(): void {
    const k = this.kickerUp;
    const runs = this.half.walk(k);
    const b = this.box.get(k)!;
    b.bb++;
    b.rbi += runs;
    if (runs) this.box.get(this.half.lastForcedHome!)!.r++;
    this.addRuns(runs);
    this.advanceKicker();
  }

  /** Strikeout or four fouls. */
  out(): void {
    this.box.get(this.kickerUp)!.ab++;
    this.half.out();
    this.advanceKicker();
  }

  /** A ball in play (or a foul fly caught). */
  applyPlay(play: LivePlay): void {
    const k = this.kickerUp;
    const b = this.box.get(k)!;
    b.ab++;
    const res = play.batterResult();
    const errors = play.events.filter((e) => e.type === 'error');
    const fc = play.events.some((e) => e.type === 'out' && e.runner.origin !== 0);
    if (res > 0 && !fc && !play.hadError()) {
      b.h++;
      this.hits[this.sideIdx()]++;
      if (res === 4) b.hr++;
    }
    for (const e of play.events) if (e.type === 'run' && play.runs > 0) this.box.get(e.runner.player)!.r++;
    if (!play.hadError()) b.rbi += play.runs;
    const def = this.defense();
    for (const e of errors) {
      const fielder = def[e.fielder as FieldPos];
      if (fielder) this.box.get(fielder)!.e++;
      this.errors[this.top ? 1 : 0]++;
    }
    for (const e of play.events) {
      if (e.type === 'out') {
        const f = def[e.fielder as FieldPos];
        if (f) this.box.get(f)!.outsMade++;
      }
    }
    this.half.applyPlay(play);
    this.addRuns(play.runs);
    this.advanceKicker();
  }

  private advanceKicker(): void {
    this.kicking.next = (this.kicking.next + 1) % this.kicking.lineup.order.length;
    this.checkWalkOff();
  }

  // ------------------------------------------------------------------ innings

  get lastInning(): number {
    return this.opts.innings;
  }

  /** Home team took the lead in the bottom of the last inning or later: game over right away. */
  private checkWalkOff(): void {
    if (!this.top && this.inning >= this.lastInning) {
      const [a, h] = this.score;
      if (h > a) this.over = true;
    }
  }

  /** Call when the half-inning has 3 outs. Returns true if the game is over. */
  endHalf(): boolean {
    const [a, h] = this.score;
    if (this.top) {
      // Home is ahead after the top of the last (or an extra) inning: no need to bat.
      if (this.inning >= this.lastInning && h > a) {
        this.over = true;
        return true;
      }
      this.top = false;
      this.line[1].push(0);
    } else {
      if (this.inning >= this.lastInning && a !== h) {
        this.over = true;
        return true;
      }
      if (this.inning >= this.lastInning && a === h) {
        const maxInnings = this.opts.extraInnings === 'one-then-tie' ? this.lastInning + 1 : Infinity;
        if (this.inning + 1 > maxInnings) {
          this.over = true;
          return true;
        }
      }
      this.top = true;
      this.inning++;
      this.line[0].push(0);
    }
    this.half = new HalfInning();
    return false;
  }

  get winner(): Side | null {
    const [a, h] = this.score;
    return a > h ? this.away : h > a ? this.home : null;
  }

  /** Best all-round day, from the winning team (or both teams in a tie). */
  playerOfTheGame(): Player {
    const pool = this.winner ? this.winner.lineup.order : [...this.away.lineup.order, ...this.home.lineup.order];
    const score = (l: BoxLine) => l.h * 2 + l.hr * 3 + l.r * 1.5 + l.rbi * 1.5 + l.bb * 0.5 + l.outsMade * 0.6 - l.e * 1.5;
    return pool.reduce((best, p) => (score(this.box.get(p)!) > score(this.box.get(best)!) ? p : best), pool[0]);
  }
}

function blank(player: Player): BoxLine {
  return { player, ab: 0, r: 0, h: 0, rbi: 0, hr: 0, bb: 0, e: 0, outsMade: 0 };
}
