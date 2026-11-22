import Phaser from 'phaser';
import { CONFIG } from '../config';
import teamsData from '../data/teams.json';
import type { Player, Team } from '../data/types';
import { InputController, type Action, type Phase } from '../input';
import { applyPitch, freshCount, type Count, type PitchEvent } from '../core/count';
import { describeKick, describeWhiff, timingLabel } from '../core/describe';
import { flightPositionAt, simulateFlight, type Flight } from '../core/flight';
import { resolveKick, whiffWindow, kickTypeFor, type KickOutcome } from '../core/kick';
import { generatePitch, pitchPosition, type Pitch, type Vec3 } from '../core/pitch';
import { defaultRng } from '../core/rng';

type State = 'waiting' | 'windup' | 'pitch' | 'flight' | 'call' | 'atBatOver';

const S = CONFIG.screen;
const F = CONFIG.field;

const COLORS = {
  grassDark: 0x1e5a2c,
  grass: 0x2f8a3e,
  grassStripe: 0x35964a,
  dirt: 0xc8925a,
  dirtLight: 0xd9a66d,
  chalk: 0xffffff,
  fence: 0xf2c230,
  ball: 0xe63946,
  ballHighlight: 0xff8a8a,
  shadow: 0x000000,
  defense: 0xd62828,
  offense: 0x1d70d6,
  aim: 0xffffff,
  liner: 0x4cc9f0,
  power: 0xff8c1a,
  bunt: 0xb388ff,
  panel: 0x0b1f12,
};

const TEXT_FONT = 'Arial, Helvetica, sans-serif';

export class AtBatScene extends Phaser.Scene {
  private controls!: InputController;
  private roster: Player[] = [];
  private teamName = '';
  private kickerIdx = 0;

  private state: State = 'waiting';
  private stateStart = 0;
  private count: Count = freshCount();
  private aimIndex: number = CONFIG.kick.defaultAimIndex;
  private bunt = false;

  private pitch: Pitch | null = null;
  private releaseTime = 0;
  private pitchLive = false; // the pitched ball is still rolling toward the catcher
  private holdStart: number | null = null;

  private flight: Flight | null = null;
  private flightStart = 0;
  private kickFlash = 0;

  private gfx!: Phaser.GameObjects.Graphics;
  private pitcherDot!: Phaser.GameObjects.Arc;
  private teamText!: Phaser.GameObjects.Text;
  private kickerText!: Phaser.GameObjects.Text;
  private countText!: Phaser.GameObjects.Text;
  private aimText!: Phaser.GameObjects.Text;
  private pitchText!: Phaser.GameObjects.Text;
  private resultText!: Phaser.GameObjects.Text;
  private timingText!: Phaser.GameObjects.Text;
  private promptText!: Phaser.GameObjects.Text;
  private chargeLabel!: Phaser.GameObjects.Text;

  constructor() {
    super('AtBat');
  }

  create(): void {
    const team = (teamsData.teams as Team[]).find((t) => t.isPlayer)!;
    this.roster = team.players;
    this.teamName = team.name;

    this.drawField();
    this.drawFielders();
    this.gfx = this.add.graphics();
    this.createHud();

    this.controls = new InputController();
    this.controls.on((a, p, t) => this.handleInput(a, p, t));
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.controls.dispose());

    this.startAtBat();
    if (import.meta.env.DEV) (window as unknown as { __atBat: AtBatScene }).__atBat = this;
  }

  // ------------------------------------------------------------------ helpers

  private toScreen(x: number, y: number): { sx: number; sy: number } {
    return { sx: S.homeX + x * S.pxPerFoot, sy: S.homeY - y * S.pxPerFoot };
  }

  private get kicker(): Player {
    return this.roster[this.kickerIdx];
  }

  private setState(s: State, now = performance.now()): void {
    this.state = s;
    this.stateStart = now;
  }

  private plateTime(): number {
    return this.releaseTime + (this.pitch ? this.pitch.timeToPlate * 1000 : 0);
  }

  // ------------------------------------------------------------------ flow

  private startAtBat(): void {
    this.count = freshCount();
    this.bunt = false;
    this.aimIndex = CONFIG.kick.defaultAimIndex;
    this.flight = null;
    this.pitch = null;
    this.pitchLive = false;
    this.resultText.setText('');
    this.timingText.setText('');
    this.promptText.setText('');
    this.pitchText.setText('');
    this.updateHud();
    this.setState('waiting');
  }

  private nextPitch(): void {
    this.flight = null;
    this.setState('waiting');
  }

  private handleInput(action: Action, phase: Phase, time: number): void {
    const canAdjust = this.state === 'waiting' || this.state === 'windup' || this.state === 'call';
    if (phase === 'press') {
      if (action === 'left' && canAdjust) this.aimIndex = Math.max(0, this.aimIndex - 1);
      if (action === 'right' && canAdjust) this.aimIndex = Math.min(CONFIG.kick.aimZones.length - 1, this.aimIndex + 1);
      if (action === 'down' && canAdjust) this.bunt = !this.bunt;
      if (action === 'up' && canAdjust) this.bunt = false;
      if (action === 'confirm') {
        if (this.state === 'atBatOver') {
          this.kickerIdx = (this.kickerIdx + 1) % this.roster.length;
          this.startAtBat();
          return;
        }
        if (this.state === 'windup' || this.state === 'pitch') this.holdStart = time;
      }
      this.updateHud();
    } else if (action === 'confirm' && this.holdStart !== null) {
      const holdStart = this.holdStart;
      this.holdStart = null;
      if (this.state === 'pitch') this.attemptKick(time, time - holdStart);
      // Releasing before the ball is rolled just cancels the wind-up.
    }
  }

  private attemptKick(time: number, holdMs: number): void {
    if (!this.pitch) return;
    const deltaMs = time - this.plateTime();
    const outcome = resolveKick(
      { pitch: this.pitch, deltaMs, holdMs, aimIndex: this.aimIndex, bunt: this.bunt, kicker: this.kicker },
      defaultRng,
    );
    this.kickFlash = performance.now();
    if (outcome.kind === 'whiff') {
      this.showTiming(deltaMs, false);
      this.applyEvent('whiff', describeWhiff(outcome.reason));
      return;
    }
    this.pitchLive = false;
    this.flight = simulateFlight(outcome.sprayDeg, outcome.launchDeg, outcome.exitSpeed);
    this.flightStart = performance.now();
    this.lastKick = outcome;
    this.showTiming(deltaMs, outcome.clean);
    this.resultText.setText('');
    this.setState('flight');
  }

  private lastKick: Extract<KickOutcome, { kind: 'contact' }> | null = null;

  private finishFlight(): void {
    if (!this.flight || !this.lastKick) return;
    const text = describeKick(this.lastKick, this.flight);
    this.applyEvent(this.flight.fair ? 'fair' : 'foul', text);
  }

  private applyEvent(event: PitchEvent, text: string): void {
    const { count, result } = applyPitch(this.count, event);
    this.count = count;
    let line = text;
    if (result === 'walk') line = 'Ball four. Take your base.';
    if (result === 'strikeout') line = `${text.replace(/ Strike\.$/, '')} Strike three, you're out!`;
    if (result === 'foulout') line = `${text} That's four fouls. You're out!`;
    this.resultText.setText(line);
    this.updateHud();
    if (result === 'continue') {
      this.setState('call');
    } else {
      this.setState('atBatOver');
      const next = this.roster[(this.kickerIdx + 1) % this.roster.length];
      this.promptText.setText(`Press SPACE for the next kicker: ${next.name}`);
    }
  }

  private showTiming(deltaMs: number, clean: boolean): void {
    if (!CONFIG.ui.showTimingDebug) return;
    this.timingText.setText(`Timing: ${timingLabel(deltaMs)}${clean ? ' · clean' : ''}`);
  }

  // ------------------------------------------------------------------ update

  update(): void {
    const now = performance.now();
    const elapsed = now - this.stateStart;

    switch (this.state) {
      case 'waiting':
        if (elapsed >= CONFIG.pitch.delayBeforePitch) this.setState('windup', now);
        break;
      case 'windup':
        if (elapsed >= CONFIG.pitch.windupTime) {
          this.pitch = generatePitch(defaultRng);
          this.releaseTime = now;
          this.pitchLive = true;
          this.pitchText.setText(`Pitch: ${this.pitch.type[0].toUpperCase()}${this.pitch.type.slice(1)}`);
          this.timingText.setText('');
          this.setState('pitch', now);
        }
        break;
      case 'pitch': {
        if (!this.pitch) break;
        const sincePlate = now - this.plateTime();
        if (this.holdStart !== null && sincePlate > whiffWindow(this.kicker.contact, this.pitch, this.bunt)) {
          this.holdStart = null;
          this.kickFlash = now;
          this.timingText.setText(CONFIG.ui.showTimingDebug ? 'Timing: held it too long' : '');
          this.applyEvent('whiff', 'Held the wind-up too long. Swing and a miss.');
          break;
        }
        const pos = pitchPosition(this.pitch, (now - this.releaseTime) / 1000);
        if (pos.y < -F.catcherDepth) {
          this.pitchLive = false;
          this.applyEvent(
            this.pitch.isStrike ? 'calledStrike' : 'ball',
            this.pitch.isStrike ? 'Right down the middle and taken. Strike.' : 'Wide of the plate. Ball.',
          );
        }
        break;
      }
      case 'flight': {
        const t = ((now - this.flightStart) / 1000) * CONFIG.ui.flightPlaybackSpeed;
        if (this.flight && t >= this.flight.duration) this.finishFlight();
        break;
      }
      case 'call':
        if (elapsed >= CONFIG.ui.resultHold) this.nextPitch();
        break;
      case 'atBatOver':
        break;
    }

    this.drawDynamic(now);
  }

  // ------------------------------------------------------------------ drawing

  private drawField(): void {
    const g = this.add.graphics();
    const { homeX, homeY, pxPerFoot: px } = S;
    const fenceR = F.fenceDistance * px;
    const toRad = Phaser.Math.DegToRad;
    const start = toRad(-90 - F.foulLineDeg);
    const end = toRad(-90 + F.foulLineDeg);

    // Foul territory backdrop
    g.fillStyle(COLORS.grassDark, 1);
    g.fillRect(0, 0, S.width, S.height);

    // Fair-territory grass with mowing stripes
    for (let r = F.fenceDistance, i = 0; r > 0; r -= 20, i++) {
      g.fillStyle(i % 2 === 0 ? COLORS.grass : COLORS.grassStripe, 1);
      g.slice(homeX, homeY, r * px, start, end, false);
      g.fillPath();
    }
    // Warning track
    g.lineStyle(10, 0xa4774a, 1);
    g.beginPath();
    g.arc(homeX, homeY, fenceR - 5, start, end, false);
    g.strokePath();

    // Infield dirt: an arc behind the bases plus the base paths
    g.fillStyle(COLORS.dirt, 1);
    g.slice(homeX, homeY, 95 * px, start, end, false);
    g.fillPath();
    // Infield grass inside the diamond
    const b = F.baseDistance / Math.SQRT2;
    const inset = 9;
    const grassPts = [
      this.toScreen(0, inset * 1.4),
      this.toScreen(b - inset, b),
      this.toScreen(0, 2 * b - inset * 1.4),
      this.toScreen(-(b - inset), b),
    ].map((p) => new Phaser.Math.Vector2(p.sx, p.sy));
    g.fillStyle(COLORS.grass, 1);
    g.fillPoints(grassPts, true);

    // Home plate circle and mound
    const home = this.toScreen(0, 0);
    g.fillStyle(COLORS.dirt, 1);
    g.fillCircle(home.sx, home.sy, 13 * px);
    const mound = this.toScreen(0, F.pitchingDistance);
    g.fillStyle(COLORS.dirtLight, 1);
    g.fillCircle(mound.sx, mound.sy, 6 * px);

    // Foul lines, extended past the fence
    g.lineStyle(2, COLORS.chalk, 0.95);
    for (const sgn of [-1, 1]) {
      const a = toRad(F.foulLineDeg) * sgn;
      const far = (F.fenceDistance + 25) * px;
      g.lineBetween(homeX, homeY, homeX + Math.sin(a) * far, homeY - Math.cos(a) * far);
    }

    // Fence
    g.lineStyle(4, COLORS.fence, 1);
    g.beginPath();
    g.arc(homeX, homeY, fenceR, start, end, false);
    g.strokePath();

    // Bases
    const bases = [this.toScreen(b, b), this.toScreen(0, 2 * b), this.toScreen(-b, b)];
    g.fillStyle(COLORS.chalk, 1);
    for (const p of bases) {
      g.fillRect(p.sx - 5, p.sy - 5, 10, 10);
    }
    // Home plate (pentagon pointing at the catcher)
    const hp = [
      [-1.2, 0.6],
      [1.2, 0.6],
      [1.2, -0.3],
      [0, -1.2],
      [-1.2, -0.3],
    ].map(([x, y]) => {
      const p = this.toScreen(x, y);
      return new Phaser.Math.Vector2(p.sx, p.sy);
    });
    g.fillPoints(hp, true);

    // Strike zone guide: how wide a pitch can be and still be a strike
    const zl = this.toScreen(-CONFIG.pitch.plateHalfWidth, 0);
    const zr = this.toScreen(CONFIG.pitch.plateHalfWidth, 0);
    g.lineStyle(2, COLORS.chalk, 0.6);
    g.strokeRect(zl.sx, zl.sy - 6, zr.sx - zl.sx, 12);

    // Fence distance marker
    const cf = this.toScreen(0, F.fenceDistance + 8);
    this.add
      .text(cf.sx, cf.sy, `${F.fenceDistance}`, { fontFamily: TEXT_FONT, fontSize: '14px', color: '#f2c230' })
      .setOrigin(0.5);
  }

  private drawFielders(): void {
    for (const [pos, spot] of Object.entries(F.positions)) {
      const p = this.toScreen(spot.x, spot.y);
      const dot = this.add.circle(p.sx, p.sy, 8, COLORS.defense).setStrokeStyle(2, 0xffffff);
      if (pos === 'P') this.pitcherDot = dot;
      this.add
        .text(p.sx, p.sy + 12, pos, { fontFamily: TEXT_FONT, fontSize: '11px', color: '#ffffff' })
        .setOrigin(0.5, 0)
        .setAlpha(0.8);
    }
  }

  private createHud(): void {
    const panel = this.add.graphics();
    panel.fillStyle(COLORS.panel, 0.82);
    panel.fillRoundedRect(12, 12, 300, 132, 10);
    panel.fillRoundedRect(S.width - 212, 12, 200, 40, 10);

    const base = { fontFamily: TEXT_FONT, color: '#ffffff' };
    this.teamText = this.add.text(24, 20, '', { ...base, fontSize: '13px', color: '#9fd3a8' });
    this.kickerText = this.add.text(24, 38, '', { ...base, fontSize: '18px', fontStyle: 'bold' });
    this.countText = this.add.text(24, 66, '', { ...base, fontSize: '16px' });
    this.aimText = this.add.text(24, 92, '', { ...base, fontSize: '14px', lineSpacing: 4 });
    this.pitchText = this.add.text(S.width - 200, 22, '', { ...base, fontSize: '16px' });

    this.resultText = this.add
      .text(S.width / 2, S.height - 66, '', {
        ...base,
        fontSize: '24px',
        fontStyle: 'bold',
        stroke: '#000000',
        strokeThickness: 5,
        align: 'center',
        wordWrap: { width: S.width - 80 },
      })
      .setOrigin(0.5);
    this.timingText = this.add
      .text(S.width / 2, S.height - 96, '', { ...base, fontSize: '14px', color: '#ffe066', stroke: '#000', strokeThickness: 3 })
      .setOrigin(0.5);
    this.promptText = this.add
      .text(S.width / 2, S.height - 36, '', { ...base, fontSize: '16px', color: '#ffe066', stroke: '#000', strokeThickness: 3 })
      .setOrigin(0.5);
    this.add
      .text(
        S.width / 2,
        S.height - 10,
        '←/→ aim     ↓ bunt stance     ↑ normal stance     Hold SPACE = power kick     Tap SPACE = liner     Release = kick',
        { ...base, fontSize: '12px', color: '#d8f3dc', align: 'center' },
      )
      .setOrigin(0.5, 1)
      .setAlpha(0.85);
    this.chargeLabel = this.add
      .text(0, 0, '', { ...base, fontSize: '13px', fontStyle: 'bold', stroke: '#000', strokeThickness: 3 })
      .setOrigin(0.5, 1);
  }

  private updateHud(): void {
    const k = this.kicker;
    const R = CONFIG.rules;
    const pips = (n: number, max: number) => '●'.repeat(n) + '○'.repeat(Math.max(0, max - n));
    this.teamText.setText(this.teamName.toUpperCase());
    this.kickerText.setText(
      `#${this.kickerIdx + 1} ${k.name} (${k.kicksAs === 'girl' ? 'Girl' : 'Guy'})  CON ${k.contact} · POW ${k.power}`,
    );
    this.countText.setText(
      `B ${pips(this.count.balls, R.ballsForWalk - 1)}   S ${pips(this.count.strikes, R.strikesForOut - 1)}   F ${pips(this.count.fouls, R.foulsForOut - 1)}`,
    );
    const zone = CONFIG.kick.aimZones[this.aimIndex];
    this.aimText.setText(`Aim: ◀ ${zone.name} ▶\nStance: ${this.bunt ? 'BUNT' : 'Kick'}`);
  }

  private drawBall(pos: Vec3): void {
    const g = this.gfx;
    const p = this.toScreen(pos.x, pos.y);
    const r = S.ballRadiusPx * (1 + pos.z * S.ballHeightScale);
    g.fillStyle(COLORS.shadow, Math.max(0.12, 0.35 - pos.z * 0.004));
    g.fillEllipse(p.sx + pos.z * 0.25, p.sy + 2, r * 2.1, r * 1.3);
    const by = p.sy - pos.z * S.ballHeightLiftPx;
    g.fillStyle(COLORS.ball, 1);
    g.fillCircle(p.sx, by, r);
    g.fillStyle(COLORS.ballHighlight, 1);
    g.fillCircle(p.sx - r * 0.35, by - r * 0.35, r * 0.35);
  }

  private drawDynamic(now: number): void {
    const g = this.gfx;
    g.clear();
    const home = this.toScreen(0, 0);

    // Aim arrow
    const aimLocked = this.state === 'pitch' || this.state === 'flight';
    const zone = CONFIG.kick.aimZones[this.aimIndex];
    const aimDeg = this.bunt ? (zone.deg / 30) * CONFIG.kick.bunt.maxSprayDeg : zone.deg;
    const len = (this.bunt ? 32 : 85) * S.pxPerFoot;
    const a = Phaser.Math.DegToRad(aimDeg);
    const tip = { x: home.sx + Math.sin(a) * len, y: home.sy - Math.cos(a) * len };
    const aimColor = this.bunt ? COLORS.bunt : COLORS.aim;
    g.lineStyle(3, aimColor, aimLocked ? 0.25 : 0.6);
    g.lineBetween(home.sx, home.sy, tip.x, tip.y);
    const back = 12;
    const side = 7;
    g.fillStyle(aimColor, aimLocked ? 0.25 : 0.7);
    g.fillTriangle(
      tip.x + Math.sin(a) * 4,
      tip.y - Math.cos(a) * 4,
      tip.x - Math.sin(a) * back + Math.cos(a) * side,
      tip.y + Math.cos(a) * back + Math.sin(a) * side,
      tip.x - Math.sin(a) * back - Math.cos(a) * side,
      tip.y + Math.cos(a) * back - Math.sin(a) * side,
    );

    // Pitcher wind-up pulse
    const wind = this.state === 'windup' ? Math.sin(((now - this.stateStart) / CONFIG.pitch.windupTime) * Math.PI) : 0;
    this.pitcherDot.setScale(1 + wind * 0.35);

    // Kicker
    const kp = this.toScreen(-1.5, -3.5);
    const flashing = now - this.kickFlash < 160;
    g.fillStyle(COLORS.offense, 1);
    g.fillCircle(kp.sx, kp.sy, flashing ? 11 : 9);
    g.lineStyle(2, 0xffffff, 1);
    g.strokeCircle(kp.sx, kp.sy, flashing ? 11 : 9);

    // Charge meter
    this.chargeLabel.setText('');
    if (this.holdStart !== null) {
      const hold = now - this.holdStart;
      const K = CONFIG.kick;
      const frac = Math.min(1, hold / K.powerFullCharge);
      const bx = kp.sx - 34;
      const by = kp.sy + 14;
      const h = 56;
      const type = kickTypeFor(hold, this.bunt);
      const color = type === 'power' ? COLORS.power : type === 'bunt' ? COLORS.bunt : COLORS.liner;
      g.fillStyle(0x000000, 0.6);
      g.fillRect(bx - 1, by - h - 1, 12, h + 2);
      g.fillStyle(color, 1);
      g.fillRect(bx, by - h * frac, 10, h * frac);
      if (!this.bunt) {
        const ty = by - h * (K.powerHoldThreshold / K.powerFullCharge);
        g.lineStyle(2, 0xffffff, 1);
        g.lineBetween(bx - 3, ty, bx + 13, ty);
      }
      this.chargeLabel.setPosition(bx + 5, by - h - 4).setColor(
        '#' + color.toString(16).padStart(6, '0'),
      );
      this.chargeLabel.setText(type.toUpperCase());
    }

    // Pitched ball
    if (this.pitch && this.pitchLive) {
      this.drawBall(pitchPosition(this.pitch, (now - this.releaseTime) / 1000));
    }
    if (this.pitch && !this.pitchLive && this.state === 'call' && !this.flight) {
      // Ball sitting with the catcher after a call
      const c = this.toScreen(0, -F.catcherDepth + 1);
      g.fillStyle(COLORS.ball, 1);
      g.fillCircle(c.sx, c.sy, S.ballRadiusPx);
    }

    // Kicked ball, its ground track, and where it landed
    if (this.flight) {
      const f = this.flight;
      const t =
        this.state === 'flight'
          ? ((now - this.flightStart) / 1000) * CONFIG.ui.flightPlaybackSpeed
          : f.duration;
      g.fillStyle(0xffffff, 0.35);
      for (let s = 0; s < Math.min(t, f.duration); s += 0.08) {
        const p = flightPositionAt(f, s);
        const sp = this.toScreen(p.x, p.y);
        g.fillCircle(sp.sx, sp.sy, 1.5);
      }
      if (t >= f.landing.t) {
        const lp = this.toScreen(f.landing.x, f.landing.y);
        g.lineStyle(2, f.fair ? 0xffe066 : 0xff6b6b, 1);
        g.lineBetween(lp.sx - 6, lp.sy - 6, lp.sx + 6, lp.sy + 6);
        g.lineBetween(lp.sx - 6, lp.sy + 6, lp.sx + 6, lp.sy - 6);
      }
      this.drawBall(flightPositionAt(f, t));
    }
  }
}
