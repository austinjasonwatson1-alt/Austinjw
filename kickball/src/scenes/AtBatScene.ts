import Phaser from 'phaser';
import { CONFIG } from '../config';
import teamsData from '../data/teams.json';
import type { Player, Team } from '../data/types';
import { InputController, type Action, type Phase } from '../input';
import { applyPitch, freshCount, type Count, type PitchEvent } from '../core/count';
import { describeKick, describeWhiff, timingLabel } from '../core/describe';
import { flightPositionAt, simulateFlight, type Flight } from '../core/flight';
import { kickTypeFor, resolveKick, whiffWindow, type KickOutcome } from '../core/kick';
import { generatePitch, pitchPosition, type Pitch, type Vec3 } from '../core/pitch';
import { defaultRng } from '../core/rng';
import { benchSpots, createField, toScreen } from '../art/field';
import { HUD } from '../art/palette';
import { addFigure, lookFor, makeStaticTextures, setFigureLook } from '../art/textures';
import { Hud, type Tone } from './Hud';

type State = 'waiting' | 'windup' | 'pitch' | 'flight' | 'call' | 'atBatOver';
type Contact = Extract<KickOutcome, { kind: 'contact' }>;

const S = CONFIG.screen;
const F = CONFIG.field;
const R = S.renderScale;
const FIGURE_SCALE = 1.05 / R;
const FT_PER_S_TO_MPH = 0.6818;

const DEPTH = { aim: 5, ground: 8, players: 10, ball: 20, fx: 25 };

interface Fielder {
  sprite: Phaser.GameObjects.Image;
  pos: string;
}

export class AtBatScene extends Phaser.Scene {
  private controls!: InputController;
  private hud!: Hud;
  private roster: Player[] = [];
  private kickerIdx = 0;

  private state: State = 'waiting';
  private stateStart = 0;
  private count: Count = freshCount();
  private aimIndex: number = CONFIG.kick.defaultAimIndex;
  private bunt = false;

  private pitch: Pitch | null = null;
  private releaseTime = 0;
  private pitchLive = false;
  private holdStart: number | null = null;

  private flight: Flight | null = null;
  private flightStart = 0;
  private lastKick: Contact | null = null;
  private kickTime = -1e9;
  private bouncesShown = 0;
  private lastFrame = 0;
  private fxRing: { x: number; y: number; t: number; color: number } | null = null;

  private aimGfx!: Phaser.GameObjects.Graphics;
  private groundGfx!: Phaser.GameObjects.Graphics;
  private fxGfx!: Phaser.GameObjects.Graphics;
  private ball!: Phaser.GameObjects.Image;
  private fielders: Fielder[] = [];
  private kickerSprite!: Phaser.GameObjects.Image;
  private onDeckSprite!: Phaser.GameObjects.Image;
  private benchSprites: Phaser.GameObjects.Image[] = [];
  private sparks!: Phaser.GameObjects.Particles.ParticleEmitter;
  private dust!: Phaser.GameObjects.Particles.ParticleEmitter;
  private confetti!: Phaser.GameObjects.Particles.ParticleEmitter;

  constructor() {
    super('AtBat');
  }

  create(): void {
    const team = (teamsData.teams as Team[]).find((t) => t.isPlayer)!;
    this.roster = team.players;

    this.cameras.main.setZoom(R).centerOn(S.width / 2, S.height / 2);
    makeStaticTextures(this);
    createField(this);

    this.aimGfx = this.add.graphics().setDepth(DEPTH.aim);
    this.groundGfx = this.add.graphics().setDepth(DEPTH.ground);
    this.fxGfx = this.add.graphics().setDepth(DEPTH.fx);
    this.createPlayers();
    this.ball = this.add.image(0, 0, 'ball').setScale(1 / R).setDepth(DEPTH.ball).setVisible(false);
    this.createParticles();
    this.hud = new Hud(this, team.name);

    this.controls = new InputController();
    this.controls.on((a, p, t) => this.handleInput(a, p, t));
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.controls.dispose());

    this.startAtBat();
    if (import.meta.env.DEV) (window as unknown as { __atBat: AtBatScene }).__atBat = this;
  }

  // ------------------------------------------------------------------ setup

  private createPlayers(): void {
    let i = 0;
    for (const [pos, spot] of Object.entries(F.positions)) {
      const look = lookFor(`defense-${pos}`, i++ % 3 === 1);
      const p = toScreen(spot.x, spot.y);
      const sprite = addFigure(this, p.sx, p.sy, 'defense', look).setScale(FIGURE_SCALE).setDepth(DEPTH.players);
      this.fielders.push({ sprite, pos });
    }
    const look = lookFor('placeholder', false);
    this.kickerSprite = addFigure(this, 0, 0, 'offense', look).setScale(FIGURE_SCALE).setDepth(DEPTH.players + 1);
    this.onDeckSprite = addFigure(this, 0, 0, 'offense', look).setScale(FIGURE_SCALE).setDepth(DEPTH.players);
    for (let k = 0; k < this.roster.length - 2; k++) {
      this.benchSprites.push(addFigure(this, 0, 0, 'offense', look).setScale(FIGURE_SCALE * 0.8).setDepth(DEPTH.players));
    }
  }

  private createParticles(): void {
    this.sparks = this.add
      .particles(0, 0, 'spark', {
        speed: { min: 60, max: 220 },
        lifespan: { min: 250, max: 500 },
        scale: { start: 0.9, end: 0 },
        alpha: { start: 1, end: 0 },
        tint: [0xffffff, 0xffe066, 0xffb703],
        emitting: false,
      })
      .setDepth(DEPTH.fx);
    this.dust = this.add
      .particles(0, 0, 'puff', {
        speed: { min: 8, max: 40 },
        lifespan: { min: 350, max: 700 },
        scale: { start: 0.6, end: 1.4 },
        alpha: { start: 0.7, end: 0 },
        emitting: false,
      })
      .setDepth(DEPTH.ground);
    this.confetti = this.add
      .particles(0, 0, 'confetti', {
        speed: { min: 80, max: 260 },
        angle: { min: 200, max: 340 },
        gravityY: 260,
        lifespan: { min: 900, max: 1600 },
        rotate: { min: 0, max: 360 },
        scale: { start: 1.2, end: 0.8 },
        tint: [0xef4444, 0x3b82f6, 0xfacc15, 0x22c55e, 0xa855f7, 0xffffff],
        emitting: false,
      })
      .setDepth(DEPTH.fx);
  }

  // ------------------------------------------------------------------ helpers

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

  private ballScreen(pos: Vec3): { sx: number; sy: number; by: number } {
    const p = toScreen(pos.x, pos.y);
    return { ...p, by: p.sy - pos.z * S.ballHeightLiftPx };
  }

  // ------------------------------------------------------------------ flow

  private startAtBat(): void {
    this.count = freshCount();
    this.bunt = false;
    this.aimIndex = CONFIG.kick.defaultAimIndex;
    this.flight = null;
    this.pitch = null;
    this.pitchLive = false;
    this.hud.clearResult();
    this.hud.setTiming('');
    this.hud.setPrompt('');
    this.hud.setPitch(null);
    this.placeOffense();
    this.updateHud();
    this.setState('waiting');
  }

  private placeOffense(): void {
    const n = this.roster.length;
    const dress = (img: Phaser.GameObjects.Image, p: Player) => setFigureLook(img, 'offense', lookFor(p.name, p.kicksAs === 'girl'));
    const kp = toScreen(-2.2, -2.5);
    dress(this.kickerSprite, this.kicker);
    this.kickerSprite.setPosition(kp.sx, kp.sy).setRotation(0.25);
    const onDeck = this.roster[(this.kickerIdx + 1) % n];
    const od = toScreen(34, -6);
    dress(this.onDeckSprite, onDeck);
    this.onDeckSprite.setPosition(od.sx, od.sy).setRotation(-0.6);
    const spots = benchSpots(this.benchSprites.length);
    this.benchSprites.forEach((s, i) => {
      const p = this.roster[(this.kickerIdx + 2 + i) % n];
      dress(s, p);
      s.setPosition(spots[i].sx, spots[i].sy).setRotation(spots[i].rot);
    });
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
    }
  }

  private attemptKick(time: number, holdMs: number): void {
    if (!this.pitch) return;
    const deltaMs = time - this.plateTime();
    const outcome = resolveKick(
      { pitch: this.pitch, deltaMs, holdMs, aimIndex: this.aimIndex, bunt: this.bunt, kicker: this.kicker },
      defaultRng,
    );
    this.kickTime = performance.now();
    if (outcome.kind === 'whiff') {
      this.showTiming(deltaMs, false);
      this.applyEvent('whiff', describeWhiff(outcome.reason));
      return;
    }
    this.pitchLive = false;
    this.flight = simulateFlight(outcome.sprayDeg, outcome.launchDeg, outcome.exitSpeed);
    this.flightStart = performance.now();
    this.lastKick = outcome;
    this.bouncesShown = 0;
    this.showTiming(deltaMs, outcome.clean);
    this.hud.clearResult();

    // Impact effects
    const home = toScreen(0, 0.5);
    const strength = outcome.exitSpeed / CONFIG.kick.power.speedMax;
    this.sparks.explode(Math.round(8 + 18 * strength * outcome.quality), home.sx, home.sy);
    this.fxRing = { x: home.sx, y: home.sy, t: this.flightStart, color: outcome.type === 'power' ? HUD.power : HUD.liner };
    if (outcome.type === 'power' && outcome.quality > 0.9) {
      this.cameras.main.shake(140, CONFIG.ui.shakePowerKick * outcome.quality);
    }
    if (Math.abs(deltaMs) <= CONFIG.ui.perfectTimingMs) this.hud.pop('PERFECT!', home.sx, home.sy - 44, '#ffe066');
    this.setState('flight');
  }

  private finishFlight(): void {
    if (!this.flight || !this.lastKick) return;
    const text = describeKick(this.lastKick, this.flight);
    if (this.flight.overFence) {
      const p = toScreen(this.flight.landing.x, this.flight.landing.y);
      this.confetti.explode(80, p.sx, p.sy);
      this.confetti.explode(60, S.width / 2, 120);
      this.cameras.main.shake(300, CONFIG.ui.shakeHomeRun);
      this.hud.pop('HOME RUN!', S.width / 2, S.height / 2 - 40, '#ffe066', 48);
    }
    this.applyEvent(this.flight.fair ? 'fair' : 'foul', text);
  }

  private applyEvent(event: PitchEvent, text: string): void {
    const { count, result } = applyPitch(this.count, event);
    this.count = count;
    let line = text;
    let tone: Tone = event === 'fair' || event === 'ball' ? 'good' : event === 'foul' ? 'neutral' : 'bad';
    if (result === 'walk') line = 'Ball four. Take your base.';
    if (result === 'strikeout') line = `${text.replace(/ Strike\.$/, '')} Strike three, you're out!`;
    if (result === 'foulout') {
      line = `${text} That's four fouls. You're out!`;
      tone = 'bad';
    }
    this.hud.showResult(line, tone);
    if (event === 'whiff') {
      const kp = toScreen(0, 0);
      this.hud.pop('WHIFF', kp.sx, kp.sy - 40, '#ff6b6b', 20);
    }
    this.updateHud();
    if (result === 'continue') {
      this.setState('call');
    } else {
      this.setState('atBatOver');
      const next = this.roster[(this.kickerIdx + 1) % this.roster.length];
      this.hud.setPrompt(`PRESS SPACE FOR THE NEXT KICKER: ${next.name.toUpperCase()}`);
    }
  }

  private showTiming(deltaMs: number, clean: boolean): void {
    if (!CONFIG.ui.showTimingDebug) return;
    this.hud.setTiming(`TIMING: ${timingLabel(deltaMs).toUpperCase()}${clean ? '  ·  CLEAN' : ''}`);
  }

  private updateHud(): void {
    this.hud.setKicker(this.kickerIdx + 1, this.kicker);
    this.hud.setCount(this.count);
    this.hud.setAim(CONFIG.kick.aimZones[this.aimIndex].name, this.bunt);
  }

  // ------------------------------------------------------------------ update

  update(): void {
    const now = performance.now();
    const dt = Math.min(0.05, (now - (this.lastFrame || now)) / 1000);
    this.lastFrame = now;
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
          this.hud.setPitch(this.pitch.type, this.pitch.speed * FT_PER_S_TO_MPH);
          this.hud.setTiming('');
          this.hud.clearResult();
          this.setState('pitch', now);
        }
        break;
      case 'pitch': {
        if (!this.pitch) break;
        const sincePlate = now - this.plateTime();
        if (this.holdStart !== null && sincePlate > whiffWindow(this.kicker.contact, this.pitch, this.bunt)) {
          this.holdStart = null;
          this.kickTime = now;
          if (CONFIG.ui.showTimingDebug) this.hud.setTiming('TIMING: HELD IT TOO LONG');
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
        if (this.flight) this.emitBounces(t);
        if (this.flight && t >= this.flight.duration) this.finishFlight();
        break;
      }
      case 'call':
        if (elapsed >= CONFIG.ui.resultHold) {
          this.flight = null;
          this.setState('waiting');
        }
        break;
      case 'atBatOver':
        break;
    }

    this.drawFrame(now, dt);
  }

  /** Dust or grass puffs each time the kicked ball hits the ground. */
  private emitBounces(t: number): void {
    const f = this.flight!;
    let touches = 0;
    let wasUp = false;
    for (let i = 1; i < f.points.length && f.points[i].t <= t; i++) {
      const up = f.points[i].z > 0.05;
      if (wasUp && !up) {
        touches++;
        if (touches > this.bouncesShown) {
          const p = toScreen(f.points[i].x, f.points[i].y);
          const dist = Math.hypot(f.points[i].x, f.points[i].y);
          const onDirt = dist < 95 && f.fair;
          this.dust.setParticleTint(onDirt ? 0xd9a66d : 0x9be28f);
          this.dust.explode(touches === 1 ? 10 : 5, p.sx, p.sy);
          this.bouncesShown = touches;
        }
      }
      wasUp = up;
    }
  }

  // ------------------------------------------------------------------ drawing

  private drawFrame(now: number, dt: number): void {
    this.drawAim();
    const g = this.groundGfx;
    const fx = this.fxGfx;
    g.clear();
    fx.clear();

    // Where is the ball right now?
    let ballPos: Vec3 | null = null;
    if (this.pitch && this.pitchLive) {
      ballPos = pitchPosition(this.pitch, (now - this.releaseTime) / 1000);
    } else if (this.flight) {
      const t = this.state === 'flight' ? ((now - this.flightStart) / 1000) * CONFIG.ui.flightPlaybackSpeed : this.flight.duration;
      ballPos = flightPositionAt(this.flight, t);
      this.drawFlightTrack(g, t);
    } else if (this.state === 'windup' || this.state === 'waiting') {
      ballPos = { x: 1.2, y: F.pitchingDistance + 1, z: 1.5 }; // in the pitcher's hands
    } else if (this.state === 'call' || this.state === 'atBatOver') {
      ballPos = { x: 0.8, y: -F.catcherDepth + 1.5, z: 1 }; // with the catcher
    }

    if (ballPos) {
      const b = this.ballScreen(ballPos);
      const r = S.ballRadiusPx * (1 + ballPos.z * S.ballHeightScale);
      g.fillStyle(0x000000, Math.max(0.12, 0.32 - ballPos.z * 0.004));
      g.fillEllipse(b.sx + ballPos.z * 0.25, b.sy + 2, r * 2.1, r * 1.2);
      const moving = this.pitchLive || this.state === 'flight';
      if (moving) this.ball.rotation += dt * (this.state === 'flight' ? 14 : 9);
      this.ball.setVisible(true).setPosition(b.sx, b.by).setScale(((r / S.ballRadiusPx) * 0.8) / R);
    } else {
      this.ball.setVisible(false);
    }

    this.animatePlayers(now, ballPos);
    this.drawKickerExtras(now, fx);

    // Impact ring
    if (this.fxRing) {
      const age = (now - this.fxRing.t) / 350;
      if (age >= 1) this.fxRing = null;
      else {
        fx.lineStyle(3 * (1 - age), this.fxRing.color, 1 - age);
        fx.strokeCircle(this.fxRing.x, this.fxRing.y, 6 + age * 34);
      }
    }
  }

  private drawAim(): void {
    const g = this.aimGfx;
    g.clear();
    if (this.state === 'flight') return;
    const locked = this.state === 'pitch';
    const home = toScreen(0, 0);
    const zone = CONFIG.kick.aimZones[this.aimIndex];
    const deg = this.bunt ? (zone.deg / 30) * CONFIG.kick.bunt.maxSprayDeg : zone.deg;
    const lenFt = this.bunt ? 34 : 95;
    const color = this.bunt ? HUD.bunt : 0xffffff;
    const half = 7.5;
    const ang = (d: number) => Phaser.Math.DegToRad(d - 90);
    // translucent cone for the zone
    g.fillStyle(color, locked ? 0.08 : 0.16);
    g.slice(home.sx, home.sy, lenFt * S.pxPerFoot, ang(deg - half), ang(deg + half), false);
    g.fillPath();
    // dashed center line + arrowhead
    const a = ang(deg);
    const len = lenFt * S.pxPerFoot;
    g.lineStyle(2.5, color, locked ? 0.3 : 0.75);
    for (let d = 14; d < len - 12; d += 12) {
      const e = Math.min(d + 7, len - 12);
      g.lineBetween(home.sx + Math.cos(a) * d, home.sy + Math.sin(a) * d, home.sx + Math.cos(a) * e, home.sy + Math.sin(a) * e);
    }
    const tx = home.sx + Math.cos(a) * len;
    const ty = home.sy + Math.sin(a) * len;
    const px = -Math.sin(a);
    const py = Math.cos(a);
    g.fillStyle(color, locked ? 0.3 : 0.85);
    g.fillTriangle(
      tx,
      ty,
      tx - Math.cos(a) * 13 + px * 7,
      ty - Math.sin(a) * 13 + py * 7,
      tx - Math.cos(a) * 13 - px * 7,
      ty - Math.sin(a) * 13 - py * 7,
    );
  }

  private drawFlightTrack(g: Phaser.GameObjects.Graphics, t: number): void {
    const f = this.flight!;
    // ground track
    g.fillStyle(0xffffff, 0.3);
    for (let s = 0; s < Math.min(t, f.duration); s += 0.07) {
      const p = flightPositionAt(f, s);
      const sp = toScreen(p.x, p.y);
      g.fillCircle(sp.sx, sp.sy, 1.3);
    }
    // motion trail behind the ball
    if (t < f.duration) {
      for (let k = 1; k <= 7; k++) {
        const s = t - k * 0.03;
        if (s < 0) break;
        const p = flightPositionAt(f, s);
        const b = this.ballScreen(p);
        g.fillStyle(0xff8a8a, 0.28 * (1 - k / 8));
        g.fillCircle(b.sx, b.by, S.ballRadiusPx * (1 + p.z * S.ballHeightScale) * (1 - k * 0.07));
      }
    }
    // landing marker
    if (t >= f.landing.t) {
      const lp = toScreen(f.landing.x, f.landing.y);
      const col = f.fair ? 0xffe066 : 0xff6b6b;
      g.lineStyle(3, 0x000000, 0.35);
      g.strokeCircle(lp.sx + 1, lp.sy + 1, 7);
      g.lineStyle(2.5, col, 1);
      g.strokeCircle(lp.sx, lp.sy, 7);
      g.lineBetween(lp.sx - 4, lp.sy - 4, lp.sx + 4, lp.sy + 4);
      g.lineBetween(lp.sx - 4, lp.sy + 4, lp.sx + 4, lp.sy - 4);
    }
  }

  private animatePlayers(now: number, ballPos: Vec3 | null): void {
    const home = toScreen(0, 0);
    const watching = this.state === 'flight' && ballPos !== null;
    const ready = this.pitchLive || this.state === 'windup';
    const ballScreen = ballPos ? toScreen(ballPos.x, ballPos.y) : home;
    for (const f of this.fielders) {
      const tx = watching ? ballScreen.sx : home.sx;
      const ty = watching ? ballScreen.sy : home.sy;
      const target = Math.atan2(ty - f.sprite.y, tx - f.sprite.x) + Math.PI / 2;
      f.sprite.rotation = Phaser.Math.Angle.RotateTo(f.sprite.rotation, target, 0.12);
      const breathe = 1 + Math.sin(now / 420 + f.sprite.x) * 0.015;
      const crouch = ready && f.pos !== 'P' ? 1.05 : 1;
      f.sprite.setScale(FIGURE_SCALE * breathe * crouch);
    }
    // Pitcher wind-up: rear back, then roll it
    if (this.state === 'windup') {
      const pitcher = this.fielders.find((f) => f.pos === 'P')!;
      const k = (now - this.stateStart) / CONFIG.pitch.windupTime;
      pitcher.sprite.setScale(FIGURE_SCALE * (1 + Math.sin(k * Math.PI) * 0.2));
      pitcher.sprite.rotation += Math.sin(k * Math.PI * 2) * 0.05;
    }
    // Kicker turns to watch a kicked ball
    const k = this.kickerSprite;
    const kickerTarget = watching ? Math.atan2(ballScreen.sy - k.y, ballScreen.sx - k.x) + Math.PI / 2 : 0.25;
    k.rotation = Phaser.Math.Angle.RotateTo(k.rotation, kickerTarget, 0.1);
  }

  private drawKickerExtras(now: number, g: Phaser.GameObjects.Graphics): void {
    const k = this.kickerSprite;
    // Kicking leg swing
    const since = now - this.kickTime;
    if (since < 220) {
      const p = since / 220;
      const swing = Phaser.Math.Easing.Cubic.Out(Math.min(1, p * 1.6));
      const ang = Math.PI / 2 + 0.6 - swing * 2.4; // from behind the kicker, through the ball
      const hipX = k.x + 3;
      const hipY = k.y + 1;
      const fx = hipX + Math.cos(ang) * 15;
      const fy = hipY + Math.sin(ang) * 15;
      g.lineStyle(5, 0x1e3a8a, 1 - p * 0.6);
      g.lineBetween(hipX, hipY, fx, fy);
      g.fillStyle(0xffffff, 1 - p * 0.6);
      g.fillCircle(fx, fy, 3.5);
    }

    // Charge meter beside the kicker
    if (this.holdStart === null) return;
    const hold = now - this.holdStart;
    const K = CONFIG.kick;
    const frac = Math.min(1, hold / K.powerFullCharge);
    const type = kickTypeFor(hold, this.bunt);
    const color = type === 'power' ? HUD.power : type === 'bunt' ? HUD.bunt : HUD.liner;
    const bx = k.x - 34;
    const by = k.y + 20;
    const h = 60;
    g.fillStyle(0x000000, 0.55);
    g.fillRoundedRect(bx - 3, by - h - 3, 16, h + 6, 5);
    g.fillStyle(color, 1);
    const fillH = Math.max(2, h * frac);
    g.fillRoundedRect(bx, by - fillH, 10, fillH, 3);
    if (frac >= 1) {
      g.lineStyle(2, color, 0.5 + 0.5 * Math.sin(now / 60));
      g.strokeRoundedRect(bx - 4, by - h - 4, 18, h + 8, 6);
    }
    if (!this.bunt) {
      const ty = by - h * (K.powerHoldThreshold / K.powerFullCharge);
      g.lineStyle(2, 0xffffff, 1);
      g.lineBetween(bx - 5, ty, bx + 15, ty);
    }
  }
}
