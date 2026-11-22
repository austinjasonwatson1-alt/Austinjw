import Phaser from 'phaser';
import { CONFIG } from '../config';
import teamsData from '../data/teams.json';
import type { Player, Team } from '../data/types';
import { InputController, type Action, type Phase } from '../input';
import { baseXY, pathXY } from '../core/bases';
import { applyPitch, freshCount, type Count, type PitchEvent } from '../core/count';
import { describeKick, describeWhiff, kickPhrase, timingLabel } from '../core/describe';
import { flightPositionAt, simulateFlight, type Flight } from '../core/flight';
import { HalfInning } from '../core/half';
import { kickTypeFor, resolveKick, whiffWindow, type KickOutcome } from '../core/kick';
import { generatePitch, pitchPosition, type Pitch, type Vec3 } from '../core/pitch';
import { LivePlay, type RunnerState } from '../core/play';
import { defaultRng } from '../core/rng';
import { benchSpots, createField, toScreen } from '../art/field';
import { HUD } from '../art/palette';
import { addFigure, lookFor, makeStaticTextures, setFigureLook } from '../art/textures';
import type { Hud, Tone } from './Hud';
import type { HudScene } from './HudScene';

type State = 'waiting' | 'windup' | 'pitch' | 'live' | 'call' | 'atBatOver' | 'sideRetired';
type Contact = Extract<KickOutcome, { kind: 'contact' }>;

const S = CONFIG.screen;
const F = CONFIG.field;
const R = S.renderScale;
const TS = S.textureScale;
const CAM = CONFIG.camera;
const FIGURE_SCALE = 1.05 / TS;
const FT_PER_S_TO_MPH = 0.6818;
const SIM_STEP = 1 / 120;

const DEPTH = { aim: 5, ground: 8, players: 10, runners: 11, clouds: 15, ball: 20, fx: 25, labels: 26 };

export class AtBatScene extends Phaser.Scene {
  private controls!: InputController;
  private hud!: Hud;
  private roster: Player[] = [];
  private kickerIdx = 0;
  private half = new HalfInning();

  private state: State = 'waiting';
  private stateStart = 0;
  private count: Count = freshCount();
  private aimIndex: number = CONFIG.kick.defaultAimIndex;
  private bunt = false;

  private pitch: Pitch | null = null;
  private releaseTime = 0;
  private pitchLive = false;
  private holdStart: number | null = null;

  private play: LivePlay | null = null;
  private flight: Flight | null = null;
  private lastKick: Contact | null = null;
  private eventsSeen = 0;
  private selected: number | null = null; // runner id, or null for all runners
  private kickTime = -1e9;
  private bouncesShown = 0;
  private lastFrame = 0;
  private fxRing: { x: number; y: number; t: number; color: number } | null = null;
  private cam = { x: 0, y: 0, zoom: 1 };
  private camHold: { x: number; y: number; zoom: number } | null = null;
  private kickerFt = { ...CONFIG.runUp.start };
  private kickerRot = 0;

  private aimGfx!: Phaser.GameObjects.Graphics;
  private groundGfx!: Phaser.GameObjects.Graphics;
  private fxGfx!: Phaser.GameObjects.Graphics;
  private ball!: Phaser.GameObjects.Image;
  private fielderSprites: { sprite: Phaser.GameObjects.Image; pos: string }[] = [];
  private kickerSprite!: Phaser.GameObjects.Image;
  private onDeckSprite!: Phaser.GameObjects.Image;
  private runnerSprites: Phaser.GameObjects.Image[] = [];
  private runnerLabels: Phaser.GameObjects.Text[] = [];
  private benchSprites: Phaser.GameObjects.Image[] = [];
  private clouds: Phaser.GameObjects.Image[] = [];
  private sparks!: Phaser.GameObjects.Particles.ParticleEmitter;
  private dust!: Phaser.GameObjects.Particles.ParticleEmitter;
  private confetti!: Phaser.GameObjects.Particles.ParticleEmitter;

  constructor() {
    super('AtBat');
  }

  create(): void {
    const team = (teamsData.teams as Team[]).find((t) => t.isPlayer)!;
    this.roster = team.players;

    makeStaticTextures(this);
    createField(this);

    this.aimGfx = this.add.graphics().setDepth(DEPTH.aim);
    this.groundGfx = this.add.graphics().setDepth(DEPTH.ground);
    this.fxGfx = this.add.graphics().setDepth(DEPTH.fx);
    this.createPlayers();
    this.ball = this.add.image(0, 0, 'ball').setScale(1 / TS).setDepth(DEPTH.ball).setVisible(false);
    this.createParticles();
    this.createClouds();
    this.hud = (this.scene.get('Hud') as HudScene).hud;

    this.cam = { ...this.homeView() };
    this.cameras.main.setBounds(0, 0, S.width, S.height);
    this.applyCamera();

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
      this.fielderSprites.push({ sprite, pos });
    }
    const look = lookFor('placeholder', false);
    this.kickerSprite = addFigure(this, 0, 0, 'offense', look).setScale(FIGURE_SCALE).setDepth(DEPTH.runners);
    this.onDeckSprite = addFigure(this, 0, 0, 'offense', look).setScale(FIGURE_SCALE).setDepth(DEPTH.players);
    for (let k = 0; k < 3; k++) {
      this.runnerSprites.push(addFigure(this, 0, 0, 'offense', look).setScale(FIGURE_SCALE).setDepth(DEPTH.runners).setVisible(false));
    }
    for (let k = 0; k < 4; k++) {
      this.runnerLabels.push(
        this.add
          .text(0, 0, '', {
            fontFamily: '"Helvetica Neue", Arial, sans-serif',
            fontSize: '8px',
            fontStyle: 'bold',
            color: '#ffffff',
            stroke: '#000000',
            strokeThickness: 2.5,
          })
          .setResolution(TS)
          .setOrigin(0.5, 1)
          .setDepth(DEPTH.labels)
          .setVisible(false),
      );
    }
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

  private createClouds(): void {
    for (let i = 0; i < 3; i++) {
      const c = this.add
        .image(i * 420 - 100, 140 + i * 190, 'cloud')
        .setScale((3 + i * 0.6) / TS)
        .setAlpha(0.22)
        .setDepth(DEPTH.clouds);
      this.clouds.push(c);
    }
  }

  // ------------------------------------------------------------------ camera

  private homeView(): { x: number; y: number; zoom: number } {
    const p = toScreen(CAM.homeCenter.x, CAM.homeCenter.y);
    return { x: p.sx, y: p.sy, zoom: CAM.homeZoom };
  }

  private updateCamera(dt: number): void {
    let target = this.homeView();
    if (this.state === 'live' && this.play) {
      const play = this.play;
      // Follow the ball, looking a little ahead while it is in the air
      let focus: Vec3 = play.ballPosition();
      if (play.ball.kind === 'flight' && this.flight) focus = flightPositionAt(this.flight, play.t + CAM.flightLead);
      // keep the lead runner in mind too
      const lead = play.activeRunners()[0];
      const lp = lead ? pathXY(lead.pos) : { x: focus.x, y: focus.y };
      const fx = focus.x * 0.75 + lp.x * 0.25;
      const fy = focus.y * 0.75 + lp.y * 0.25;
      const p = toScreen(fx, fy);
      const d = Math.max(Math.hypot(focus.x, focus.y - 40), Math.hypot(lp.x, lp.y - 40));
      const far = Phaser.Math.Clamp((d - 30) / (CAM.flightZoomFarFt - 30), 0, 1);
      const home = this.homeView();
      const pull = Phaser.Math.Clamp(play.t / 0.6, 0, 1);
      target = {
        x: Phaser.Math.Linear(home.x, p.sx, pull),
        y: Phaser.Math.Linear(home.y, p.sy, pull),
        zoom: Phaser.Math.Linear(CONFIG.ui.playZoomNear, CONFIG.ui.playZoomFar, far),
      };
      this.camHold = target;
    } else if ((this.state === 'call' || this.state === 'atBatOver' || this.state === 'sideRetired') && this.camHold) {
      target = this.camHold;
    }
    const kf = 1 - Math.exp(-dt * CAM.followRate);
    const kz = 1 - Math.exp(-dt * CAM.zoomRate);
    this.cam.x += (target.x - this.cam.x) * kf;
    this.cam.y += (target.y - this.cam.y) * kf;
    this.cam.zoom += (target.zoom - this.cam.zoom) * kz;
    this.applyCamera();
  }

  private applyCamera(): void {
    this.cameras.main.setZoom(R * this.cam.zoom).centerOn(this.cam.x, this.cam.y);
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

  private dress(img: Phaser.GameObjects.Image, p: Player): void {
    setFigureLook(img, 'offense', lookFor(p.name, p.kicksAs === 'girl'));
  }

  /** A pop-up word on the field that moves with the camera. */
  private worldPop(s: string, x: number, y: number, color: string, size: number): void {
    const t = this.add
      .text(x, y, s, { fontFamily: '"Arial Black", Arial, sans-serif', fontSize: `${size}px`, color, stroke: '#000000', strokeThickness: 4 })
      .setResolution(TS)
      .setOrigin(0.5)
      .setDepth(DEPTH.labels + 1)
      .setScale(0.4);
    this.tweens.add({ targets: t, scale: 1, duration: 220, ease: 'Back.Out' });
    this.tweens.add({ targets: t, y: y - 20, alpha: 0, delay: 750, duration: 450, onComplete: () => t.destroy() });
  }

  // ------------------------------------------------------------------ flow

  private startAtBat(): void {
    this.count = freshCount();
    this.bunt = false;
    this.aimIndex = CONFIG.kick.defaultAimIndex;
    this.flight = null;
    this.play = null;
    this.pitch = null;
    this.pitchLive = false;
    this.selected = null;
    this.hud.clearResult();
    this.hud.setTiming('');
    this.hud.setPrompt('');
    this.hud.setPitch(null);
    this.hud.setHelp('kick');
    this.camHold = null;
    this.kickerFt = { ...CONFIG.runUp.start };
    this.placeOffense();
    this.updateHud();
    this.setState('waiting');
  }

  private placeOffense(): void {
    const n = this.roster.length;
    this.dress(this.kickerSprite, this.kicker);
    this.kickerSprite.setAlpha(1).setVisible(true);
    const onDeck = this.roster[(this.kickerIdx + 1) % n];
    const od = toScreen(34, -6);
    this.dress(this.onDeckSprite, onDeck);
    this.onDeckSprite.setPosition(od.sx, od.sy).setRotation(-0.6);
    this.placeBaseRunners();
    // Everyone else on the bench (not the kicker, on-deck kicker or runners)
    const busy = new Set<Player>([this.kicker, onDeck, ...this.half.bases.filter((b): b is Player => !!b)]);
    const benchers: Player[] = [];
    for (let k = 0; k < n; k++) {
      const p = this.roster[(this.kickerIdx + 2 + k) % n];
      if (!busy.has(p)) benchers.push(p);
    }
    const spots = benchSpots(this.benchSprites.length);
    this.benchSprites.forEach((s, i) => {
      const p = benchers[i];
      if (!p) {
        s.setVisible(false);
        return;
      }
      this.dress(s, p);
      s.setVisible(true).setPosition(spots[i].sx, spots[i].sy).setRotation(spots[i].rot);
    });
  }

  /** Runners standing on their bases between plays. */
  private placeBaseRunners(): void {
    this.half.bases.forEach((p, i) => {
      const s = this.runnerSprites[i];
      if (!p) {
        s.setVisible(false);
        return;
      }
      this.dress(s, p);
      const b = baseXY(i + 1);
      const sp = toScreen(b.x, b.y);
      s.setVisible(true).setAlpha(1).setPosition(sp.sx, sp.sy);
      const home = toScreen(0, 0);
      s.setRotation(Math.atan2(home.sy - sp.sy, home.sx - sp.sx) + Math.PI / 2);
    });
  }

  private runnerChoices(): (number | null)[] {
    return [null, ...(this.play?.activeRunners().map((r) => r.id) ?? [])];
  }

  private selectedName(): string {
    if (this.selected === null || !this.play) return 'ALL RUNNERS';
    const r = this.play.runners.find((x) => x.id === this.selected);
    return r ? r.player.name.toUpperCase() : 'ALL RUNNERS';
  }

  private handleInput(action: Action, phase: Phase, time: number): void {
    if (this.state === 'live' && this.play) {
      if (phase !== 'press') return;
      if (action === 'right') this.play.send(this.selected);
      if (action === 'left') this.play.hold(this.selected);
      if (action === 'up' || action === 'down') {
        const choices = this.runnerChoices();
        let i = choices.indexOf(this.selected);
        if (i < 0) i = 0;
        i = (i + (action === 'down' ? 1 : -1) + choices.length) % choices.length;
        this.selected = choices[i];
        this.hud.setHelp('run', this.selectedName());
      }
      return;
    }
    const canAdjust = this.state === 'waiting' || this.state === 'windup' || this.state === 'call';
    if (phase === 'press') {
      if (action === 'left' && canAdjust) this.aimIndex = Math.max(0, this.aimIndex - 1);
      if (action === 'right' && canAdjust) this.aimIndex = Math.min(CONFIG.kick.aimZones.length - 1, this.aimIndex + 1);
      if (action === 'down' && canAdjust) this.bunt = !this.bunt;
      if (action === 'up' && canAdjust) this.bunt = false;
      if (action === 'confirm') {
        if (this.state === 'atBatOver') {
          this.nextKicker();
          return;
        }
        if (this.state === 'sideRetired') {
          this.half = new HalfInning();
          this.nextKicker();
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

  private nextKicker(): void {
    this.kickerIdx = (this.kickerIdx + 1) % this.roster.length;
    this.startAtBat();
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
      this.applyCountEvent('whiff', describeWhiff(outcome.reason));
      return;
    }
    this.pitchLive = false;
    this.flight = simulateFlight(outcome.sprayDeg, outcome.launchDeg, outcome.exitSpeed);
    this.lastKick = outcome;
    this.bouncesShown = 0;
    this.eventsSeen = 0;
    this.selected = null;
    this.play = new LivePlay({
      flight: this.flight,
      batter: this.kicker,
      bases: this.half.bases,
      outs: this.half.outs,
      defense: {},
      rng: defaultRng,
    });
    // The kicker's sprite becomes the batter-runner; base runners keep their sprites.
    this.showTiming(deltaMs, outcome.clean);
    this.hud.clearResult();
    if (this.flight.fair) this.hud.setHelp('run', this.selectedName());

    const home = toScreen(0, 0.5);
    const strength = outcome.exitSpeed / CONFIG.kick.power.speedMax;
    this.sparks.explode(Math.round(8 + 18 * strength * outcome.quality), home.sx, home.sy);
    this.fxRing = { x: home.sx, y: home.sy, t: performance.now(), color: outcome.type === 'power' ? HUD.power : HUD.liner };
    if (outcome.type === 'power' && outcome.quality > 0.9) {
      this.cameras.main.shake(140, CONFIG.ui.shakePowerKick * outcome.quality);
    }
    if (Math.abs(deltaMs) <= CONFIG.ui.perfectTimingMs) this.worldPop('PERFECT!', home.sx, home.sy - 30, '#ffe066', 18);
    if (this.flight.overFence) {
      this.time.delayedCall(((this.flight.landing.t / CONFIG.ui.flightPlaybackSpeed) * 1000) | 0, () => {
        const p = toScreen(this.flight!.landing.x, this.flight!.landing.y);
        this.confetti.explode(90, p.sx, p.sy);
        this.cameras.main.shake(300, CONFIG.ui.shakeHomeRun);
        this.hud.pop('HOME RUN!', S.width / 2, S.height / 2 - 40, '#ffe066', 48);
      });
    }
    this.setState('live');
  }

  /** Pitch outcomes that only change the count: ball, strike, whiff, foul. */
  private applyCountEvent(event: PitchEvent, text: string): void {
    const { count, result } = applyPitch(this.count, event);
    this.count = count;
    let line = text;
    let tone: Tone = event === 'ball' ? 'good' : event === 'foul' ? 'neutral' : 'bad';
    if (result === 'walk') {
      const runs = this.half.walk(this.kicker);
      line = runs ? 'Ball four, and that forces in a run!' : 'Ball four. Take your base.';
      tone = 'good';
      this.placeBaseRunners();
      this.kickerSprite.setAlpha(0);
    }
    if (result === 'strikeout') {
      line = `${text.replace(/ Strike\.$/, '')} Strike three, you're out!`;
      this.half.out();
    }
    if (result === 'foulout') {
      line = `${text} That's four fouls. You're out!`;
      tone = 'bad';
      this.half.out();
    }
    this.hud.showResult(line, tone);
    if (event === 'whiff') {
      const kp = toScreen(0, 0);
      this.worldPop('WHIFF', kp.sx, kp.sy - 28, '#ff6b6b', 14);
    }
    this.updateHud();
    if (result === 'continue') this.setState('call');
    else this.endAtBat();
  }

  private endAtBat(): void {
    if (this.half.over) {
      this.setState('sideRetired');
      const r = this.half.runs;
      this.hud.setPrompt(`SIDE RETIRED · ${r} RUN${r === 1 ? '' : 'S'} · PRESS SPACE FOR ANOTHER HALF-INNING`);
      return;
    }
    this.setState('atBatOver');
    const next = this.roster[(this.kickerIdx + 1) % this.roster.length];
    this.hud.setPrompt(`NEXT KICKER: ${next.name.toUpperCase()}  ·  SPACE TO SKIP`);
  }

  private finishPlay(): void {
    const play = this.play!;
    const k = this.lastKick!;
    const f = this.flight!;
    if (play.endReason === 'foul' && !play.caughtFly) {
      this.play = null;
      this.applyCountEvent('foul', describeKick(k, f));
      return;
    }
    this.half.applyPlay(play);
    // Runners now stand where the play left them; the kicker is a runner, out, or home.
    this.placeBaseRunners();
    this.kickerSprite.setAlpha(0);
    const bl = play.batterLine();
    const sum = play.summary();
    let line = `${kickPhrase(k, f)}${bl ? `, ${bl}` : ''}.${sum ? ' ' + sum : ''}`;
    if (play.caughtFly && !f.fair) line = `${kickPhrase(k, f)}, ${bl}.`;
    const good = play.batterResult() > 0 || play.runs > 0;
    this.hud.showResult(line, good ? 'good' : 'bad');
    this.hud.setHelp('kick');
    this.updateHud();
    this.endAtBat();
  }

  private showTiming(deltaMs: number, clean: boolean): void {
    if (!CONFIG.ui.showTimingDebug) return;
    this.hud.setTiming(`TIMING: ${timingLabel(deltaMs).toUpperCase()}${clean ? '  ·  CLEAN' : ''}`);
  }

  private updateHud(): void {
    this.hud.setKicker(this.kickerIdx + 1, this.kicker);
    this.hud.setCount(this.count);
    this.hud.setAim(CONFIG.kick.aimZones[this.aimIndex].name, this.bunt);
    let bases = this.half.bases.map((b) => !!b);
    let outs = this.half.outs;
    let runs = this.half.runs;
    if (this.state === 'live' && this.play) {
      bases = [1, 2, 3].map((b) => this.play!.activeRunners().some((r) => r.pos === b));
      outs = this.play.outs;
      runs = this.half.runs + this.play.runs;
    }
    this.hud.setSituation(runs, outs, bases);
  }

  /** Pops for outs, runs, catches and errors as they happen. */
  private showPlayEvents(): void {
    const play = this.play!;
    while (this.eventsSeen < play.events.length) {
      const e = play.events[this.eventsSeen++];
      if (e.type === 'out') {
        const at = e.runner.id >= 0 ? pathXY(e.runner.pos) : play.ballPosition();
        const p = toScreen(at.x, at.y);
        const word = e.how === 'peg' ? 'PEGGED!' : 'OUT!';
        this.worldPop(word, p.sx, p.sy - 16, '#ff6b6b', 16);
      } else if (e.type === 'run') {
        const p = toScreen(0, 0);
        this.worldPop('RUN SCORES!', p.sx, p.sy - 20, '#7CFC9A', 15);
        this.confetti.explode(25, p.sx, p.sy);
      } else if (e.type === 'catch') {
        const b = play.ballPosition();
        const p = toScreen(b.x, b.y);
        this.worldPop('CAUGHT', p.sx, p.sy - 16, '#ffffff', 13);
      } else if (e.type === 'error') {
        const fs = play.fielders.find((f) => f.pos === e.fielder);
        if (fs) {
          const p = toScreen(fs.x, fs.y);
          this.worldPop(e.what === 'throw' ? 'WILD THROW!' : 'BOBBLED!', p.sx, p.sy - 16, '#ffb703', 13);
        }
      } else if (e.type === 'pegMiss') {
        const rp = pathXY(e.runner.pos);
        const p = toScreen(rp.x, rp.y);
        this.worldPop('MISSED!', p.sx, p.sy - 16, '#7CFC9A', 13);
      } else if (e.type === 'runsWipedOut') {
        const p = toScreen(0, 0);
        this.worldPop("RUN DOESN'T COUNT", p.sx, p.sy - 34, '#ffb703', 12);
      }
      this.updateHud();
    }
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
          this.applyCountEvent('whiff', 'Held the wind-up too long. Swing and a miss.');
          break;
        }
        const pos = pitchPosition(this.pitch, (now - this.releaseTime) / 1000);
        if (pos.y < -F.catcherDepth) {
          this.pitchLive = false;
          this.applyCountEvent(
            this.pitch.isStrike ? 'calledStrike' : 'ball',
            this.pitch.isStrike ? 'Right down the middle and taken. Strike.' : 'Wide of the plate. Ball.',
          );
        }
        break;
      }
      case 'live': {
        const play = this.play!;
        let remaining = dt * CONFIG.ui.flightPlaybackSpeed;
        while (remaining > 1e-6 && !play.over) {
          const step = Math.min(SIM_STEP, remaining);
          play.step(step);
          remaining -= step;
        }
        this.emitBounces();
        this.showPlayEvents();
        if (play.over) this.finishPlay();
        break;
      }
      case 'call':
        if (elapsed >= CONFIG.ui.resultHold) {
          this.flight = null;
          this.setState('waiting');
        }
        break;
      case 'atBatOver':
        if (elapsed >= CONFIG.ui.nextKickerDelay) this.nextKicker();
        break;
      case 'sideRetired':
        break;
    }

    this.drawFrame(now, dt);
    this.updateCamera(dt);
    for (const c of this.clouds) {
      c.x += dt * 7;
      if (c.x - c.displayWidth / 2 > S.width + 50) c.x = -c.displayWidth / 2 - 50;
    }
  }

  /** Dust or grass puffs each time the kicked ball hits the ground. */
  private emitBounces(): void {
    const play = this.play;
    const f = this.flight;
    if (!play || !f || play.ball.kind !== 'flight') return;
    let touches = 0;
    let wasUp = false;
    for (let i = 1; i < f.points.length && f.points[i].t <= play.t; i++) {
      const up = f.points[i].z > 0.05;
      if (wasUp && !up) {
        touches++;
        if (touches > this.bouncesShown) {
          const p = toScreen(f.points[i].x, f.points[i].y);
          const d = Math.hypot(f.points[i].x, f.points[i].y);
          this.dust.setParticleTint(d < 95 && f.fair ? 0xd9a66d : 0x9be28f);
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
    const play = this.play;
    if (this.pitch && this.pitchLive) {
      ballPos = pitchPosition(this.pitch, (now - this.releaseTime) / 1000);
    } else if (play) {
      ballPos = play.ballPosition();
      if (play.ball.kind === 'flight' && this.flight) this.drawFlightTrack(g, play.t);
      if (this.flight?.overFence && play.t >= this.flight.landing.t) ballPos = null;
    } else if (this.state === 'windup' || this.state === 'waiting') {
      ballPos = { x: 1.2, y: F.pitchingDistance + 1, z: 1.5 }; // in the pitcher's hands
    } else if (this.state === 'call' || this.state === 'atBatOver' || this.state === 'sideRetired') {
      ballPos = { x: F.positions.C.x - 1, y: F.positions.C.y + 1.5, z: 1 }; // with the catcher
    }

    if (ballPos) {
      const b = this.ballScreen(ballPos);
      const r = S.ballRadiusPx * (1 + ballPos.z * S.ballHeightScale);
      g.fillStyle(0x000000, Math.max(0.12, 0.32 - ballPos.z * 0.004));
      g.fillEllipse(b.sx + ballPos.z * 0.25, b.sy + 2, r * 2.1, r * 1.2);
      const moving = this.pitchLive || (play && play.ball.kind !== 'held');
      if (moving) this.ball.rotation += dt * 12;
      this.ball.setVisible(true).setPosition(b.sx, b.by).setScale(((r / S.ballRadiusPx) * 0.8) / TS);
    } else {
      this.ball.setVisible(false);
    }

    this.animateDefense(now, ballPos);
    this.animateOffense(now, ballPos);
    this.drawKickerExtras(now, fx);

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
    if (this.state === 'live' || this.state === 'atBatOver' || this.state === 'sideRetired') return;
    const locked = this.state === 'pitch';
    const home = toScreen(0, 0);
    const zone = CONFIG.kick.aimZones[this.aimIndex];
    const deg = this.bunt ? (zone.deg / 30) * CONFIG.kick.bunt.maxSprayDeg : zone.deg;
    const lenFt = this.bunt ? 34 : 95;
    const color = this.bunt ? HUD.bunt : 0xffffff;
    const half = 7.5;
    const ang = (d: number) => Phaser.Math.DegToRad(d - 90);
    g.fillStyle(color, locked ? 0.08 : 0.16);
    g.slice(home.sx, home.sy, lenFt * S.pxPerFoot, ang(deg - half), ang(deg + half), false);
    g.fillPath();
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
    g.fillStyle(0xffffff, 0.3);
    for (let s = 0; s < Math.min(t, f.duration); s += 0.07) {
      const p = flightPositionAt(f, s);
      const sp = toScreen(p.x, p.y);
      g.fillCircle(sp.sx, sp.sy, 1.3);
    }
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
    if (t >= f.landing.t) {
      const lp = toScreen(f.landing.x, f.landing.y);
      const col = f.fair ? 0xffe066 : 0xff6b6b;
      g.lineStyle(2.5, col, 1);
      g.strokeCircle(lp.sx, lp.sy, 7);
      g.lineBetween(lp.sx - 4, lp.sy - 4, lp.sx + 4, lp.sy + 4);
      g.lineBetween(lp.sx - 4, lp.sy + 4, lp.sx + 4, lp.sy - 4);
    }
  }

  private animateDefense(now: number, ballPos: Vec3 | null): void {
    const home = toScreen(0, 0);
    const ready = this.pitchLive || this.state === 'windup';
    const ballScreen = ballPos ? toScreen(ballPos.x, ballPos.y) : home;
    const play = this.play;
    this.fielderSprites.forEach(({ sprite, pos }, i) => {
      let target: number;
      if (play) {
        const f = play.fielders[i];
        const p = toScreen(f.x, f.y);
        const moved = Math.hypot(p.sx - sprite.x, p.sy - sprite.y);
        sprite.setPosition(p.sx, p.sy);
        const holding = play.holder() === f;
        // run facing where they're going; otherwise watch the ball
        target =
          moved > 0.2 && !holding
            ? Math.atan2(toScreen(f.tx, f.ty).sy - p.sy, toScreen(f.tx, f.ty).sx - p.sx) + Math.PI / 2
            : Math.atan2(ballScreen.sy - p.sy, ballScreen.sx - p.sx) + Math.PI / 2;
        sprite.setScale(FIGURE_SCALE * (moved > 0.2 ? 1 + Math.abs(Math.sin(now / 60)) * 0.05 : 1));
      } else {
        // walk back to the regular spot between plays
        const spot = F.positions[pos];
        const p = toScreen(spot.x, spot.y);
        sprite.x += (p.sx - sprite.x) * 0.06;
        sprite.y += (p.sy - sprite.y) * 0.06;
        target = Math.atan2(home.sy - sprite.y, home.sx - sprite.x) + Math.PI / 2;
        const breathe = 1 + Math.sin(now / 420 + sprite.x) * 0.015;
        const crouch = ready && pos !== 'P' ? 1.05 : 1;
        sprite.setScale(FIGURE_SCALE * breathe * crouch);
      }
      sprite.rotation = Phaser.Math.Angle.RotateTo(sprite.rotation, target, 0.15);
    });
    if (this.state === 'windup') {
      const pitcher = this.fielderSprites.find((f) => f.pos === 'P')!.sprite;
      const k = (now - this.stateStart) / CONFIG.pitch.windupTime;
      pitcher.setScale(FIGURE_SCALE * (1 + Math.sin(k * Math.PI) * 0.2));
      pitcher.rotation += Math.sin(k * Math.PI * 2) * 0.05;
    }
  }

  private animateOffense(now: number, ballPos: Vec3 | null): void {
    const play = this.play;
    for (const l of this.runnerLabels) l.setVisible(false);
    if (play && this.state === 'live') {
      const g = this.groundGfx;
      const ballScreen = ballPos ? toScreen(ballPos.x, ballPos.y) : toScreen(0, 0);
      let label = 0;
      for (const r of play.runners) {
        const sprite = r.origin === 0 ? this.kickerSprite : this.runnerSprites[r.origin - 1];
        if (r.out || r.scored) {
          sprite.setAlpha(Math.max(0, sprite.alpha - 0.04));
          continue;
        }
        const p = pathXY(r.pos);
        const sp = toScreen(p.x, p.y);
        sprite.setVisible(true).setAlpha(1).setPosition(sp.sx, sp.sy);
        const moving = r.target !== r.pos && play.t >= r.startAt;
        const ahead = pathXY(Phaser.Math.Clamp(r.pos + Math.sign(r.target - r.pos) * 0.1, 0, 4));
        const as = toScreen(ahead.x, ahead.y);
        const face = moving
          ? Math.atan2(as.sy - sp.sy, as.sx - sp.sx) + Math.PI / 2
          : Math.atan2(ballScreen.sy - sp.sy, ballScreen.sx - sp.sx) + Math.PI / 2;
        sprite.rotation = Phaser.Math.Angle.RotateTo(sprite.rotation, face, 0.2) + (moving ? Math.sin(now / 55) * 0.12 : 0);
        sprite.setScale(FIGURE_SCALE * (moving ? 1 + Math.abs(Math.sin(now / 55)) * 0.06 : 1));
        // selection ring
        const chosen = this.selected === null || this.selected === r.id;
        if (this.flight?.fair || r.origin > 0) {
          g.lineStyle(chosen ? 2 : 1, chosen ? 0xffe066 : 0xffffff, chosen ? 0.95 : 0.35);
          g.strokeEllipse(sp.sx, sp.sy + 3, 22, 13);
          if (r.mustReturn) {
            g.lineStyle(2, 0xff6b6b, 0.9);
            g.strokeEllipse(sp.sx, sp.sy + 3, 26, 16);
          }
        }
        const lbl = this.runnerLabels[label++];
        if (lbl) {
          lbl.setText(r.mustReturn ? `${r.player.name} ↩` : r.player.name).setPosition(sp.sx, sp.sy - 11).setVisible(true);
          lbl.setColor(chosen ? '#ffe066' : '#ffffff');
        }
      }
      return;
    }
    // Between plays: base runners stand on their bases; the kicker runs up with the pitch.
    for (let i = 0; i < 3; i++) if (!this.half.bases[i]) this.runnerSprites[i].setVisible(false);
    this.animateKickerRunUp(now, ballPos);
  }

  private animateKickerRunUp(now: number, ballPos: Vec3 | null): void {
    const k = this.kickerSprite;
    if (this.state === 'atBatOver' || this.state === 'sideRetired') {
      // the kicker's at-bat is over; keep them where the play left them, fading if out
      return;
    }
    const U = CONFIG.runUp;
    let running = false;
    if (this.state === 'pitch' && this.pitch) {
      const t = (now - this.releaseTime) / (this.pitch.timeToPlate * 1000);
      const u = Phaser.Math.Clamp((t - U.startDelay) / (1 - U.startDelay), 0, 1);
      this.kickerFt = {
        x: Phaser.Math.Linear(U.start.x, U.plant.x, u),
        y: Phaser.Math.Linear(U.start.y, U.plant.y, u),
      };
      running = u > 0 && u < 1;
    } else if (this.state === 'waiting' || this.state === 'windup') {
      this.kickerFt.x += (U.start.x - this.kickerFt.x) * 0.08;
      this.kickerFt.y += (U.start.y - this.kickerFt.y) * 0.08;
    }
    const kp = toScreen(this.kickerFt.x, this.kickerFt.y);
    k.setPosition(kp.sx, kp.sy).setAlpha(1);
    const plant = toScreen(U.plant.x, U.plant.y);
    const start = toScreen(U.start.x, U.start.y);
    const runAngle = Math.atan2(plant.sy - start.sy, plant.sx - start.sx) + Math.PI / 2;
    void ballPos;
    this.kickerRot = Phaser.Math.Angle.RotateTo(this.kickerRot, runAngle, 0.12);
    k.rotation = this.kickerRot + (running ? Math.sin(now / 55) * 0.12 : 0);
    k.setScale(FIGURE_SCALE * (running ? 1 + Math.abs(Math.sin(now / 55)) * 0.06 : 1));
  }

  private drawKickerExtras(now: number, g: Phaser.GameObjects.Graphics): void {
    const k = this.kickerSprite;
    const since = now - this.kickTime;
    if (since < 220) {
      const p = since / 220;
      const swing = Phaser.Math.Easing.Cubic.Out(Math.min(1, p * 1.6));
      const ang = Math.PI / 2 + 0.6 - swing * 2.4;
      const hipX = k.x + 3;
      const hipY = k.y + 1;
      const fx = hipX + Math.cos(ang) * 15;
      const fy = hipY + Math.sin(ang) * 15;
      g.lineStyle(5, 0x1e3a8a, 1 - p * 0.6);
      g.lineBetween(hipX, hipY, fx, fy);
      g.fillStyle(0xffffff, 1 - p * 0.6);
      g.fillCircle(fx, fy, 3.5);
    }

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

export type { RunnerState };
