import Phaser from 'phaser';
import { CONFIG } from '../config';
import type { Count } from '../core/count';
import type { Player } from '../data/types';
import { FONT, FONT_BODY, HUD } from '../art/palette';

const S = CONFIG.screen;
export type Tone = 'good' | 'bad' | 'neutral';

const TONE_COLOR: Record<Tone, number> = { good: HUD.good, bad: HUD.bad, neutral: HUD.neutral };

/** Broadcast-style scoreboard bug, pitch tag and lower-third result banner. */
export class Hud {
  private scene: Phaser.Scene;
  private gfx: Phaser.GameObjects.Graphics;
  private teamText: Phaser.GameObjects.Text;
  private orderText: Phaser.GameObjects.Text;
  private nameText: Phaser.GameObjects.Text;
  private tagText: Phaser.GameObjects.Text;
  private ratingTexts: Phaser.GameObjects.Text[];
  private countLabels: Phaser.GameObjects.Text[];
  private aimText: Phaser.GameObjects.Text;
  private stanceText: Phaser.GameObjects.Text;
  private pitchLabel: Phaser.GameObjects.Text;
  private pitchText: Phaser.GameObjects.Text;
  private lower: Phaser.GameObjects.Container;
  private lowerGfx: Phaser.GameObjects.Graphics;
  private resultText: Phaser.GameObjects.Text;
  private timingText: Phaser.GameObjects.Text;
  private promptText: Phaser.GameObjects.Text;
  private helpText: Phaser.GameObjects.Text;
  private runsText: Phaser.GameObjects.Text;
  private situation = { runs: 0, outs: 0, bases: [false, false, false] };

  private ratings = { contact: 0, power: 0 };
  private count: Count = { balls: 0, strikes: 0, fouls: 0 };
  private bunt = false;

  constructor(scene: Phaser.Scene, teamName: string) {
    this.scene = scene;
    this.gfx = scene.add.graphics().setDepth(100);
    const t = (x: number, y: number, size: number, color = '#ffffff', font = FONT) =>
      this.text(x, y, '', { fontFamily: font, fontSize: `${size}px`, color }).setDepth(101);

    this.teamText = t(34, 21, 12, '#ffffff').setText(teamName.toUpperCase());
    this.orderText = t(26, 44, 18, '#f2c230');
    this.nameText = t(62, 44, 20);
    this.tagText = t(312, 49, 10, '#93c5fd', FONT_BODY).setOrigin(1, 0);
    this.ratingTexts = [t(26, 76, 10, '#cbd5e1', FONT_BODY), t(172, 76, 10, '#cbd5e1', FONT_BODY)];
    this.countLabels = ['B', 'S', 'F'].map((l, i) => t(26 + i * 98, 98, 13, '#e2e8f0').setText(l));
    this.aimText = t(26, 124, 12, '#e2e8f0', FONT_BODY);
    this.stanceText = t(312, 124, 11, '#ffffff').setOrigin(1, 0);

    this.pitchLabel = t(S.width - 196, 20, 9, '#94a3b8', FONT_BODY).setText('PITCH');
    this.pitchText = t(S.width - 196, 31, 15);
    t(S.width - 196, 68, 9, '#94a3b8', FONT_BODY).setText('RUNS');
    this.runsText = t(S.width - 196, 80, 26, '#ffffff');
    t(S.width - 62, 68, 9, '#94a3b8', FONT_BODY).setText('OUTS');

    // Lower third
    this.lower = scene.add.container(0, 0).setDepth(110);
    this.lowerGfx = scene.add.graphics();
    this.resultText = this.text(S.width / 2 + 4, S.height - 70, '', {
      fontFamily: FONT,
      fontSize: '19px',
      color: '#ffffff',
      align: 'center',
      wordWrap: { width: 640 },
    }).setOrigin(0.5);
    this.lower.add([this.lowerGfx, this.resultText]);
    this.lower.setVisible(false);

    this.timingText = this.text(S.width / 2, S.height - 106, '', {
      fontFamily: FONT_BODY,
      fontSize: '12px',
      color: '#ffe066',
      fontStyle: 'bold',
      stroke: '#000000',
      strokeThickness: 3,
    })
      .setOrigin(0.5)
      .setDepth(111);
    this.promptText = this.text(S.width / 2, S.height - 34, '', {
      fontFamily: FONT,
      fontSize: '14px',
      color: '#ffe066',
      stroke: '#000000',
      strokeThickness: 4,
    })
      .setOrigin(0.5)
      .setDepth(111);
    this.helpText = this.text(S.width / 2, S.height - 8, '', {
      fontFamily: FONT_BODY,
      fontSize: '10px',
      color: '#d8f3dc',
      fontStyle: 'bold',
      stroke: '#000000',
      strokeThickness: 2,
    })
      .setOrigin(0.5, 1)
      .setAlpha(0.85)
      .setDepth(101);
    this.setHelp('kick');

    this.redraw();
  }

  private text(x: number, y: number, s: string, style: Phaser.Types.GameObjects.Text.TextStyle): Phaser.GameObjects.Text {
    return this.scene.add.text(x, y, s, style).setResolution(S.renderScale);
  }

  setKicker(order: number, p: Player): void {
    this.orderText.setText(`#${order}`);
    this.nameText.setText(p.name.toUpperCase());
    this.tagText.setText(p.kicksAs === 'girl' ? 'GIRL' : 'GUY');
    this.ratings = { contact: p.contact, power: p.power };
    this.ratingTexts[0].setText(`CON ${p.contact}`);
    this.ratingTexts[1].setText(`POW ${p.power}`);
    this.redraw();
  }

  setCount(c: Count): void {
    this.count = { ...c };
    this.redraw();
  }

  setAim(zoneName: string, bunt: boolean): void {
    this.aimText.setText(`AIM   ◀  ${zoneName.toUpperCase()}  ▶`);
    this.bunt = bunt;
    this.stanceText.setText(bunt ? 'BUNT' : 'KICK');
    this.redraw();
  }

  setPitch(type: string | null, mph?: number): void {
    this.pitchText.setText(type ? `${type.toUpperCase()}${mph ? `   ${Math.round(mph)} MPH` : ''}` : '—');
  }

  setHelp(mode: 'kick' | 'run', selected = 'ALL RUNNERS'): void {
    this.helpText.setText(
      mode === 'kick'
        ? '←/→ AIM     ↓ BUNT STANCE     ↑ NORMAL STANCE     HOLD SPACE = POWER     TAP SPACE = LINER     RELEASE = KICK'
        : `→ SEND     ← HOLD / GO BACK     ↑/↓ PICK RUNNER  ·  NOW: ${selected}`,
    );
    this.helpText.setColor(mode === 'kick' ? '#d8f3dc' : '#ffe066');
  }

  setSituation(runs: number, outs: number, bases: boolean[]): void {
    this.situation = { runs, outs, bases: [...bases] };
    this.runsText.setText(String(runs));
    this.redraw();
  }

  setTiming(s: string): void {
    this.timingText.setText(s);
  }

  setPrompt(s: string): void {
    this.promptText.setText(s);
    this.scene.tweens.killTweensOf(this.promptText);
    this.promptText.setAlpha(1);
    if (s) this.scene.tweens.add({ targets: this.promptText, alpha: 0.45, duration: 650, yoyo: true, repeat: -1 });
  }

  showResult(s: string, tone: Tone): void {
    this.resultText.setText(s);
    const w = Math.min(700, Math.max(320, this.resultText.width + 70));
    const h = Math.max(44, this.resultText.height + 20);
    const x = S.width / 2 - w / 2;
    const y = S.height - 70 - h / 2;
    const g = this.lowerGfx;
    g.clear();
    g.fillStyle(0x000000, 0.35);
    g.fillRoundedRect(x + 3, y + 4, w, h, 8);
    g.fillStyle(HUD.navy, 0.94);
    g.fillRoundedRect(x, y, w, h, 8);
    g.fillStyle(TONE_COLOR[tone], 1);
    g.fillRoundedRect(x, y, 9, h, { tl: 8, bl: 8, tr: 0, br: 0 });
    g.fillStyle(0xffffff, 0.06);
    g.fillRoundedRect(x, y, w, h / 2, { tl: 8, tr: 8, bl: 0, br: 0 });
    this.lower.setVisible(true);
    this.scene.tweens.killTweensOf(this.lower);
    this.lower.setAlpha(0).setY(16);
    this.scene.tweens.add({ targets: this.lower, alpha: 1, y: 0, duration: 200, ease: 'Back.Out' });
  }

  clearResult(): void {
    this.lower.setVisible(false);
  }

  /** Big pop-up word like PERFECT! or HOME RUN! */
  pop(s: string, x: number, y: number, color: string, size = 26): void {
    const t = this.text(x, y, s, {
      fontFamily: FONT,
      fontSize: `${size}px`,
      color,
      stroke: '#000000',
      strokeThickness: 6,
    })
      .setOrigin(0.5)
      .setDepth(120)
      .setScale(0.4);
    this.scene.tweens.add({ targets: t, scale: 1, duration: 220, ease: 'Back.Out' });
    this.scene.tweens.add({ targets: t, y: y - 30, alpha: 0, delay: 650, duration: 450, onComplete: () => t.destroy() });
  }

  private redraw(): void {
    const g = this.gfx;
    g.clear();
    // Scoreboard bug
    const x = 14;
    const y = 14;
    const w = 310;
    g.fillStyle(0x000000, 0.35);
    g.fillRoundedRect(x + 3, y + 4, w, 132, 10);
    g.fillStyle(HUD.navy, 0.93);
    g.fillRoundedRect(x, y, w, 132, 10);
    g.fillStyle(HUD.band, 1);
    g.fillRoundedRect(x, y, w, 24, { tl: 10, tr: 10, bl: 0, br: 0 });
    g.fillStyle(HUD.accent, 1);
    g.fillRect(x + 10, y + 7, 6, 10);
    g.fillStyle(0xffffff, 0.06);
    g.fillRect(x, y + 24, w, 1);

    // Rating bars
    const bar = (bx: number, val: number, color: number) => {
      g.fillStyle(HUD.navyLight, 1);
      g.fillRoundedRect(bx, 91, 80, 5, 2.5);
      g.fillStyle(color, 1);
      g.fillRoundedRect(bx, 91, Math.max(5, (80 * val) / 100), 5, 2.5);
    };
    bar(72, this.ratings.contact, 0x38bdf8);
    bar(218, this.ratings.power, 0xfb923c);

    // Count dots
    const R = CONFIG.rules;
    const dots = (bx: number, n: number, max: number, color: number) => {
      for (let i = 0; i < max; i++) {
        const cx = bx + i * 15;
        if (i < n) {
          g.fillStyle(color, 1);
          g.fillCircle(cx, 107, 5.5);
        } else {
          g.lineStyle(1.5, 0x64748b, 1);
          g.strokeCircle(cx, 107, 5);
        }
      }
    };
    dots(46, this.count.balls, R.ballsForWalk - 1, HUD.ball);
    dots(144, this.count.strikes, R.strikesForOut - 1, HUD.strike);
    dots(242, this.count.fouls, R.foulsForOut - 1, HUD.foul);

    // Stance pill
    const pillW = this.stanceText.width + 14;
    g.fillStyle(this.bunt ? HUD.bunt : 0x334155, 1);
    g.fillRoundedRect(x + w - 12 - pillW + 7, 121, pillW, 18, 9);
    this.stanceText.setX(x + w - 12);

    // Pitch tag
    g.fillStyle(0x000000, 0.35);
    g.fillRoundedRect(S.width - 207, 18, 196, 40, 8);
    g.fillStyle(HUD.navy, 0.93);
    g.fillRoundedRect(S.width - 210, 14, 196, 40, 8);
    g.fillStyle(HUD.accent, 1);
    g.fillRoundedRect(S.width - 210, 14, 5, 40, { tl: 8, bl: 8, tr: 0, br: 0 });

    // Situation: runs, bases, outs
    const sx = S.width - 210;
    const sy = 60;
    g.fillStyle(0x000000, 0.35);
    g.fillRoundedRect(sx + 3, sy + 4, 196, 58, 8);
    g.fillStyle(HUD.navy, 0.93);
    g.fillRoundedRect(sx, sy, 196, 58, 8);
    const cx = sx + 100;
    const cy = sy + 31;
    const diamond = (x: number, y: number, on: boolean) => {
      const r = 7.5;
      const pts = [new Phaser.Math.Vector2(x, y - r), new Phaser.Math.Vector2(x + r, y), new Phaser.Math.Vector2(x, y + r), new Phaser.Math.Vector2(x - r, y)];
      if (on) {
        g.fillStyle(HUD.accent, 1);
        g.fillPoints(pts, true);
      } else {
        g.lineStyle(1.5, 0x64748b, 1);
        g.strokePoints(pts, true);
      }
    };
    diamond(cx + 13, cy, this.situation.bases[0]);
    diamond(cx, cy - 13, this.situation.bases[1]);
    diamond(cx - 13, cy, this.situation.bases[2]);
    for (let i = 0; i < CONFIG.rules.outsPerHalf; i++) {
      const ox = sx + 152 + i * 14;
      if (i < this.situation.outs) {
        g.fillStyle(HUD.strike, 1);
        g.fillCircle(ox, sy + 38, 5);
      } else {
        g.lineStyle(1.5, 0x64748b, 1);
        g.strokeCircle(ox, sy + 38, 4.5);
      }
    }
  }
}
