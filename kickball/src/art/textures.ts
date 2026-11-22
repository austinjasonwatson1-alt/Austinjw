import Phaser from 'phaser';
import { CONFIG } from '../config';
import { HAIR, SKIN, TEAM_COLORS } from './palette';

const TS = CONFIG.screen.textureScale;

function canvasTexture(
  scene: Phaser.Scene,
  key: string,
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
): void {
  if (scene.textures.exists(key)) return;
  const tex = scene.textures.createCanvas(key, Math.ceil(w * TS), Math.ceil(h * TS))!;
  const ctx = tex.getContext();
  ctx.scale(TS, TS);
  draw(ctx);
  tex.refresh();
}

/** Simple string hash, used to give each player a stable look. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export interface Look {
  skin: string;
  hair: string;
  ponytail: boolean;
  cap: boolean;
}

export function lookFor(name: string, girl: boolean): Look {
  const h = hash(name);
  const ponytail = girl && (h >>> 16) % 3 !== 0;
  return {
    skin: SKIN[h % SKIN.length],
    hair: HAIR[(h >>> 8) % HAIR.length],
    ponytail,
    cap: (h >>> 20) % 5 < 2,
  };
}

export const FIGURE_SIZE = 34;
const ATLAS = 'figures';
type TeamKey = keyof typeof TEAM_COLORS;

const frameName = (team: TeamKey, look: Look) =>
  `${team}-${look.skin}-${look.hair}-${look.ponytail ? 1 : 0}-${look.cap ? 1 : 0}`;

/**
 * Every player look for both teams, packed into one texture so all figures
 * draw in a single batch. Figures face "up"; rotate the sprite to face elsewhere.
 */
function buildFigureAtlas(scene: Phaser.Scene): void {
  if (scene.textures.exists(ATLAS)) return;
  const looks: { team: TeamKey; look: Look }[] = [];
  for (const team of Object.keys(TEAM_COLORS) as TeamKey[])
    for (const skin of SKIN)
      for (const hair of HAIR)
        for (const ponytail of [false, true])
          for (const cap of [false, true]) looks.push({ team, look: { skin, hair, ponytail, cap } });
  const cols = 24;
  const rows = Math.ceil(looks.length / cols);
  const S = FIGURE_SIZE;
  const tex = scene.textures.createCanvas(ATLAS, cols * S * TS, rows * S * TS)!;
  const ctx = tex.getContext();
  ctx.scale(TS, TS);
  looks.forEach(({ team, look }, i) => {
    const x = (i % cols) * S;
    const y = Math.floor(i / cols) * S;
    ctx.save();
    ctx.translate(x, y);
    drawFigure(ctx, TEAM_COLORS[team], look);
    ctx.restore();
    tex.add(frameName(team, look), 0, x * TS, y * TS, S * TS, S * TS);
  });
  tex.refresh();
}

function drawFigure(ctx: CanvasRenderingContext2D, c: (typeof TEAM_COLORS)[TeamKey], look: Look): void {
  const S = FIGURE_SIZE;
  const cx = S / 2;
  const cy = S / 2 + 1;
  // soft shadow
  const sh = ctx.createRadialGradient(cx + 2, cy + 3, 2, cx + 2, cy + 3, 14);
  sh.addColorStop(0, 'rgba(0,0,0,0.4)');
  sh.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = sh;
  ctx.beginPath();
  ctx.ellipse(cx + 2, cy + 3, 14, 12, 0, 0, Math.PI * 2);
  ctx.fill();
  // shoes peeking out in front
  ctx.fillStyle = '#1f2937';
  for (const sx of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(cx + sx * 4.2, cy - 6.5, 2.1, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(cx + sx * 4.2 - 1.2, cy - 8.4, 2.4, 0.9);
    ctx.fillStyle = '#1f2937';
  }
  // arms reaching forward
  ctx.fillStyle = look.skin;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 0.8;
  for (const sx of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(cx + sx * 10, cy - 4, 2.8, 4.2, sx * 0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  // torso / shoulders
  const body = ctx.createLinearGradient(cx, cy - 7, cx, cy + 8);
  body.addColorStop(0, lighten(c.jersey, 0.3));
  body.addColorStop(1, c.jersey);
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.ellipse(cx, cy + 1.5, 11, 7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.6;
  ctx.stroke();
  // ponytail (behind the head = toward the bottom)
  if (look.ponytail) {
    ctx.fillStyle = look.hair;
    ctx.beginPath();
    ctx.ellipse(cx, cy + 7.5, 2.4, 3.8, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // head: face toward the front, hair over the back
  ctx.fillStyle = look.skin;
  ctx.beginPath();
  ctx.arc(cx, cy - 1, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = look.hair;
  ctx.beginPath();
  ctx.arc(cx, cy - 1, 6, -Math.PI * 0.05, Math.PI * 1.05);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.arc(cx, cy - 1, 6, 0, Math.PI * 2);
  ctx.stroke();
  // ball cap in team color, brim toward the front
  if (look.cap) {
    ctx.fillStyle = '#111827';
    ctx.beginPath();
    ctx.ellipse(cx, cy - 6.3, 4.6, 2.6, 0, Math.PI, 0);
    ctx.fill();
    const capG = ctx.createRadialGradient(cx - 1.5, cy - 3, 0.5, cx, cy - 1, 6.2);
    capG.addColorStop(0, lighten(c.dark, 0.25));
    capG.addColorStop(1, c.dark);
    ctx.fillStyle = capG;
    ctx.beginPath();
    ctx.arc(cx, cy - 1, 6.1, 0, Math.PI * 2);
    ctx.fill();
    // panel seams
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 7);
    ctx.lineTo(cx, cy + 5);
    ctx.stroke();
  }
  // highlight
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.arc(cx - 2, cy - 3.5, 1.6, 0, Math.PI * 2);
  ctx.fill();
}

/** Adds a player figure image. Returns the sprite; change look with setPlayerLook. */
export function addFigure(scene: Phaser.Scene, x: number, y: number, team: TeamKey, look: Look): Phaser.GameObjects.Image {
  buildFigureAtlas(scene);
  return scene.add.image(x, y, ATLAS, frameName(team, look));
}

export function setFigureLook(img: Phaser.GameObjects.Image, team: TeamKey, look: Look): void {
  img.setTexture(ATLAS, frameName(team, look));
}

export function makeStaticTextures(scene: Phaser.Scene): void {
  // The kickball: red rubber with pebbled texture and a highlight
  canvasTexture(scene, 'ball', 16, 16, (ctx) => {
    const g = ctx.createRadialGradient(6, 5.5, 0.5, 8, 8, 7.5);
    g.addColorStop(0, '#ff8f8f');
    g.addColorStop(0.45, '#e63946');
    g.addColorStop(1, '#9d1c27');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(8, 8, 7.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(120,10,20,0.35)';
    for (let i = 0; i < 14; i++) {
      const a = i * 2.39;
      const r = 2 + (i % 4) * 1.3;
      ctx.beginPath();
      ctx.arc(8 + Math.cos(a) * r, 8 + Math.sin(a) * r, 0.55, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.arc(8, 8, 5, -0.4, 1.2);
    ctx.stroke();
  });

  // Particles
  canvasTexture(scene, 'spark', 8, 8, (ctx) => {
    const g = ctx.createRadialGradient(4, 4, 0, 4, 4, 4);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 8, 8);
  });
  canvasTexture(scene, 'puff', 12, 12, (ctx) => {
    const g = ctx.createRadialGradient(6, 6, 0, 6, 6, 6);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 12, 12);
  });
  // Soft cloud shadow that drifts over the park
  canvasTexture(scene, 'cloud', 160, 100, (ctx) => {
    const blobs = [
      [50, 55, 38],
      [85, 45, 42],
      [118, 58, 34],
      [70, 68, 30],
      [100, 70, 28],
    ];
    for (const [x, y, r] of blobs) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(0,0,0,0.5)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 160, 100);
    }
  });
  canvasTexture(scene, 'confetti', 4, 3, (ctx) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 4, 3);
  });
}

function lighten(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift: number) => {
    const v = (n >> shift) & 255;
    return Math.round(v + (255 - v) * amt);
  };
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}
