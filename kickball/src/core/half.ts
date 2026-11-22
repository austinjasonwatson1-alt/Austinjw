import { CONFIG } from '../config';
import type { Player } from '../data/types';
import type { LivePlay } from './play';

/** Score, outs and runners for one half-inning. */
export class HalfInning {
  outs = 0;
  runs = 0;
  bases: (Player | null)[] = [null, null, null];

  get over(): boolean {
    return this.outs >= CONFIG.rules.outsPerHalf;
  }

  /** Walk: the kicker takes first and forced runners move up. Returns runs forced in. */
  walk(batter: Player): number {
    let carry: Player | null = batter;
    let runs = 0;
    for (let i = 0; i < 3 && carry; i++) {
      const here: Player | null = this.bases[i];
      this.bases[i] = carry;
      carry = here;
    }
    if (carry) runs = 1;
    this.runs += runs;
    return runs;
  }

  out(): void {
    this.outs++;
  }

  /** Takes the outcome of a live play. */
  applyPlay(play: LivePlay): void {
    this.outs = play.outs;
    this.runs += play.runs;
    this.bases = play.basesAfter();
  }
}
