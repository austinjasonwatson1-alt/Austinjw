import Phaser from 'phaser';
import { CONFIG } from '../config';
import { seededRng } from '../core/rng';
import { FONT, PAL } from './palette';

const S = CONFIG.screen;
const F = CONFIG.field;
const P = S.pxPerFoot;
const R = S.renderScale;
const DEG = Math.PI / 180;

type Pt = { sx: number; sy: number };
const toScreen = (x: number, y: number): Pt => ({ sx: S.homeX + x * P, sy: S.homeY - y * P });

// Canvas angle for a spray angle (0 = straight away, + = right field)
const canvasAngle = (deg: number) => (deg - 90) * DEG;
const FAIR_START = canvasAngle(-F.foulLineDeg);
const FAIR_END = canvasAngle(F.foulLineDeg);

function sector(ctx: CanvasRenderingContext2D, r0Ft: number, r1Ft: number, a0: number, a1: number): void {
  ctx.beginPath();
  ctx.arc(S.homeX, S.homeY, r1Ft * P, a0, a1, false);
  if (r0Ft > 0) ctx.arc(S.homeX, S.homeY, r0Ft * P, a1, a0, true);
  else ctx.lineTo(S.homeX, S.homeY);
  ctx.closePath();
}

function speckle(ctx: CanvasRenderingContext2D, rng: () => number, n: number, colors: string[], size: number): void {
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = colors[Math.floor(rng() * colors.length)];
    ctx.fillRect(rng() * S.width, rng() * S.height, size, size);
  }
}

function tree(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(x + r * 0.35, y + r * 0.4, r * 1.05, r * 0.9, 0, 0, Math.PI * 2);
  ctx.fill();
  const blobs: [number, number, number, string][] = [
    [0, 0, 1, PAL.treeDark],
    [-0.3, -0.25, 0.7, PAL.tree],
    [0.3, -0.1, 0.6, PAL.tree],
    [-0.1, -0.4, 0.42, PAL.treeLight],
    [0.25, -0.35, 0.3, PAL.treeLight],
  ];
  for (const [dx, dy, rr, col] of blobs) {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(x + dx * r, y + dy * r, rr * r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Paints the whole ballpark once into a texture and adds it as the backdrop. */
export function createField(scene: Phaser.Scene): void {
  const key = 'field';
  if (!scene.textures.exists(key)) {
    const tex = scene.textures.createCanvas(key, S.width * R, S.height * R)!;
    const ctx = tex.getContext();
    ctx.scale(R, R);
    paint(ctx);
    tex.refresh();
  }
  scene.add.image(0, 0, key).setOrigin(0).setScale(1 / R);
}

function paint(ctx: CanvasRenderingContext2D): void {
  const rng = seededRng(20261121);
  const fence = F.fenceDistance;

  // --- park backdrop
  ctx.fillStyle = PAL.park;
  ctx.fillRect(0, 0, S.width, S.height);
  speckle(ctx, rng, 5000, ['rgba(0,0,0,0.07)', 'rgba(255,255,255,0.05)'], 1.5);

  // foul territory grass near the field
  ctx.fillStyle = PAL.foulGrass;
  ctx.beginPath();
  ctx.arc(S.homeX, S.homeY, (fence + 8) * P, canvasAngle(-80), canvasAngle(80));
  ctx.lineTo(S.homeX, S.homeY + 60);
  ctx.closePath();
  ctx.fill();

  // --- bleachers and crowd beyond the fence
  const rows = 5;
  for (let i = rows - 1; i >= 0; i--) {
    const r = fence + 14 + i * 5.5;
    ctx.strokeStyle = i % 2 === 0 ? PAL.seatA : PAL.seatB;
    ctx.lineWidth = 5.5 * P;
    ctx.beginPath();
    ctx.arc(S.homeX, S.homeY, r * P, canvasAngle(-41), canvasAngle(41));
    ctx.stroke();
  }
  ctx.strokeStyle = PAL.stands;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(S.homeX, S.homeY, (fence + 11.5) * P, canvasAngle(-41.5), canvasAngle(41.5));
  ctx.stroke();
  const shirts = ['#ef4444', '#3b82f6', '#facc15', '#22c55e', '#f97316', '#a855f7', '#ffffff', '#ec4899', '#14b8a6'];
  const skins = ['#f6d1b0', '#d39b6a', '#a8714a', '#7a4b2c'];
  for (let i = 0; i < rows; i++) {
    const r = (fence + 14 + i * 5.5) * P;
    for (let a = -40; a <= 40; a += 1.35 + rng() * 0.6) {
      if (rng() < 0.3) continue;
      const ang = canvasAngle(a);
      const x = S.homeX + Math.cos(ang) * r;
      const y = S.homeY + Math.sin(ang) * r;
      ctx.fillStyle = shirts[Math.floor(rng() * shirts.length)];
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = skins[Math.floor(rng() * skins.length)];
      ctx.beginPath();
      ctx.arc(x, y - 0.5, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // --- trees along the edges of the park
  const treeSpots: [number, number, number][] = [];
  for (let i = 0; i < 9; i++) treeSpots.push([20 + rng() * 85, 170 + i * 52 + rng() * 20, 17 + rng() * 9]);
  for (let i = 0; i < 9; i++) treeSpots.push([S.width - 20 - rng() * 85, 170 + i * 52 + rng() * 20, 17 + rng() * 9]);
  treeSpots.push([150, 120, 20], [S.width - 150, 120, 22], [60, 110, 18], [S.width - 60, 100, 19]);
  for (const [x, y, r] of treeSpots) tree(ctx, x, y, r);

  // --- fair territory: checkerboard mowing
  ctx.save();
  sector(ctx, 0, fence, FAIR_START, FAIR_END);
  ctx.clip();
  const ringFt = 18;
  const wedgeDeg = 7.5;
  for (let r = 0, i = 0; r < fence; r += ringFt, i++) {
    for (let a = -F.foulLineDeg, j = 0; a < F.foulLineDeg; a += wedgeDeg, j++) {
      ctx.fillStyle = (i + j) % 2 === 0 ? PAL.grassA : PAL.grassB;
      sector(ctx, r, Math.min(fence, r + ringFt), canvasAngle(a), canvasAngle(a + wedgeDeg));
      ctx.fill();
    }
  }
  speckle(ctx, rng, 6000, ['rgba(0,0,0,0.06)', 'rgba(255,255,255,0.06)'], 1.2);
  // soft vignette toward the fence
  const vg = ctx.createRadialGradient(S.homeX, S.homeY, 60 * P, S.homeX, S.homeY, fence * P);
  vg.addColorStop(0, 'rgba(255,255,255,0.05)');
  vg.addColorStop(1, 'rgba(0,0,0,0.12)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, S.width, S.height);
  ctx.restore();

  // --- warning track and fence
  ctx.fillStyle = PAL.track;
  sector(ctx, fence - 10, fence, FAIR_START, FAIR_END);
  ctx.fill();
  ctx.save();
  sector(ctx, fence - 10, fence, FAIR_START, FAIR_END);
  ctx.clip();
  speckle(ctx, rng, 2500, ['rgba(0,0,0,0.12)', 'rgba(255,255,255,0.1)'], 1.2);
  ctx.restore();
  ctx.lineCap = 'butt';
  ctx.strokeStyle = PAL.fence;
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(S.homeX, S.homeY, fence * P + 3, FAIR_START, FAIR_END);
  ctx.stroke();
  ctx.strokeStyle = PAL.fenceTop;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(S.homeX, S.homeY, fence * P + 6.5, FAIR_START, FAIR_END);
  ctx.stroke();
  // distance markers painted on the fence
  ctx.font = `bold 11px ${FONT}`;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const a of [-30, 0, 30]) {
    const ang = canvasAngle(a);
    const r = fence * P + 3;
    ctx.save();
    ctx.translate(S.homeX + Math.cos(ang) * r, S.homeY + Math.sin(ang) * r);
    ctx.rotate(ang + Math.PI / 2);
    ctx.fillText(String(fence), 0, 0.5);
    ctx.restore();
  }

  // --- infield dirt
  const dirtGrad = ctx.createRadialGradient(S.homeX, S.homeY, 0, S.homeX, S.homeY, 95 * P);
  dirtGrad.addColorStop(0, PAL.dirtLight);
  dirtGrad.addColorStop(1, PAL.dirt);
  ctx.fillStyle = dirtGrad;
  sector(ctx, 0, 95, FAIR_START, FAIR_END);
  ctx.fill();
  // grass lip where dirt meets the outfield
  ctx.strokeStyle = 'rgba(40,90,40,0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(S.homeX, S.homeY, 95 * P, FAIR_START, FAIR_END);
  ctx.stroke();

  // home plate dirt circle
  ctx.fillStyle = PAL.dirt;
  ctx.beginPath();
  ctx.arc(S.homeX, S.homeY, 13 * P, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  sector(ctx, 0, 95, FAIR_START, FAIR_END);
  ctx.moveTo(S.homeX + 13 * P, S.homeY);
  ctx.arc(S.homeX, S.homeY, 13 * P, 0, Math.PI * 2);
  ctx.clip('nonzero');
  speckle(ctx, rng, 7000, ['rgba(90,50,20,0.18)', 'rgba(255,230,190,0.18)'], 1.1);
  ctx.restore();

  // infield grass with diagonal stripes
  const b = F.baseDistance / Math.SQRT2;
  const inset = 9;
  const diamond = [toScreen(0, inset * 1.4), toScreen(b - inset, b), toScreen(0, 2 * b - inset * 1.4), toScreen(-(b - inset), b)];
  ctx.save();
  ctx.beginPath();
  diamond.forEach((p, i) => (i ? ctx.lineTo(p.sx, p.sy) : ctx.moveTo(p.sx, p.sy)));
  ctx.closePath();
  ctx.fillStyle = PAL.infieldGrassA;
  ctx.fill();
  ctx.clip();
  ctx.fillStyle = PAL.infieldGrassB;
  const stripe = 9 * P;
  for (let k = -20; k < 20; k += 2) {
    ctx.save();
    ctx.translate(S.homeX, S.homeY - b * P);
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(k * stripe, -400, stripe, 800);
    ctx.restore();
  }
  ctx.restore();

  // mound
  const mound = toScreen(0, F.pitchingDistance);
  const mg = ctx.createRadialGradient(mound.sx - 3, mound.sy - 3, 1, mound.sx, mound.sy, 7 * P);
  mg.addColorStop(0, PAL.dirtLight);
  mg.addColorStop(1, PAL.dirtDark);
  ctx.fillStyle = mg;
  ctx.beginPath();
  ctx.arc(mound.sx, mound.sy, 7 * P, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = PAL.chalk;
  ctx.fillRect(mound.sx - 5, mound.sy - 1.2, 10, 2.4);

  // --- chalk: foul lines, batter's boxes, catcher's box, on-deck circles
  ctx.strokeStyle = PAL.chalk;
  ctx.lineWidth = 2;
  for (const sgn of [-1, 1]) {
    const a = canvasAngle(sgn * F.foulLineDeg);
    const start = 4 * P;
    const far = (fence + 2) * P;
    ctx.beginPath();
    ctx.moveTo(S.homeX + Math.cos(a) * start, S.homeY + Math.sin(a) * start);
    ctx.lineTo(S.homeX + Math.cos(a) * far, S.homeY + Math.sin(a) * far);
    ctx.stroke();
  }
  ctx.lineWidth = 1.3;
  ctx.globalAlpha = 0.85;
  for (const sgn of [-1, 1]) {
    const tl = toScreen(sgn > 0 ? 1.6 : -4.6, 3);
    ctx.strokeRect(tl.sx, tl.sy, 3 * P, 6 * P);
  }
  const cb = toScreen(-2.2, -3.2);
  ctx.beginPath();
  ctx.moveTo(cb.sx, cb.sy);
  ctx.lineTo(cb.sx, cb.sy + 8 * P);
  ctx.lineTo(cb.sx + 4.4 * P, cb.sy + 8 * P);
  ctx.lineTo(cb.sx + 4.4 * P, cb.sy);
  ctx.stroke();
  ctx.globalAlpha = 1;
  for (const sgn of [-1, 1]) {
    const od = toScreen(sgn * 34, -6);
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.beginPath();
    ctx.arc(od.sx, od.sy, 3 * P, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // strike zone guide
  const zl = toScreen(-CONFIG.pitch.plateHalfWidth, 0);
  const zr = toScreen(CONFIG.pitch.plateHalfWidth, 0);
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.setLineDash([3, 3]);
  ctx.strokeRect(zl.sx, zl.sy - 6, zr.sx - zl.sx, 12);
  ctx.setLineDash([]);

  // --- bases with shadows
  for (const [x, y] of [
    [b, b],
    [0, 2 * b],
    [-b, b],
  ]) {
    const p = toScreen(x, y);
    ctx.save();
    ctx.translate(p.sx, p.sy);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(-4, -2.5, 8.5, 8.5);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(-5, -5, 10, 10);
    ctx.strokeStyle = '#cfd8dc';
    ctx.lineWidth = 1;
    ctx.strokeRect(-5, -5, 10, 10);
    ctx.restore();
  }
  // home plate
  const hp = [
    [-1.2, 0.6],
    [1.2, 0.6],
    [1.2, -0.3],
    [0, -1.2],
    [-1.2, -0.3],
  ].map(([x, y]) => toScreen(x, y));
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  hp.forEach((p, i) => (i ? ctx.lineTo(p.sx + 1, p.sy + 1.5) : ctx.moveTo(p.sx + 1, p.sy + 1.5)));
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  hp.forEach((p, i) => (i ? ctx.lineTo(p.sx, p.sy) : ctx.moveTo(p.sx, p.sy)));
  ctx.closePath();
  ctx.fill();

  // --- backstop fence behind home
  ctx.strokeStyle = PAL.backstop;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(S.homeX, S.homeY, 20 * P, canvasAngle(130), canvasAngle(230));
  ctx.stroke();
  ctx.strokeStyle = 'rgba(200,210,220,0.35)';
  ctx.lineWidth = 1;
  for (let a = 132; a <= 228; a += 4) {
    const ang = canvasAngle(a);
    ctx.beginPath();
    ctx.moveTo(S.homeX + Math.cos(ang) * 20 * P, S.homeY + Math.sin(ang) * 20 * P);
    ctx.lineTo(S.homeX + Math.cos(ang) * 23 * P, S.homeY + Math.sin(ang) * 23 * P);
    ctx.stroke();
  }

  // --- dugouts (home on the first-base side, visitors on third)
  for (const [sgn, roof] of [
    [1, PAL.dugoutRoofHome],
    [-1, PAL.dugoutRoofAway],
  ] as [number, string][]) {
    const c = toScreen(sgn * 92, -4);
    ctx.save();
    ctx.translate(c.sx, c.sy);
    ctx.rotate(sgn * -0.12);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(-78, -8, 160, 26);
    ctx.fillStyle = PAL.dugout;
    ctx.fillRect(-80, -10, 160, 22);
    ctx.fillStyle = '#8b6b4f';
    ctx.fillRect(-76, -2, 152, 7);
    ctx.fillStyle = roof;
    ctx.fillRect(-80, 8, 160, 7);
    ctx.restore();
  }
}

/** Where bench players sit, in screen pixels. */
export function benchSpots(count: number): { sx: number; sy: number; rot: number }[] {
  const c = toScreen(92, -4);
  const out: { sx: number; sy: number; rot: number }[] = [];
  for (let i = 0; i < count; i++) {
    const dx = -70 + (140 / Math.max(1, count - 1)) * i;
    const rot = -0.12;
    out.push({ sx: c.sx + Math.cos(rot) * dx, sy: c.sy + Math.sin(rot) * dx + 1, rot });
  }
  return out;
}

export { toScreen };
