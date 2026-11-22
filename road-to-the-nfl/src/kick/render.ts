// Canvas drawing for the kick scene. Pure drawing: no game state changes here.

import { CONFIG } from '../config';
import { Camera, type ScreenPt } from './camera';
import { goalPlaneY, kickSpotX, sweetSpotHalf, windVectorFtS, type KickSetup, type KickerRatings, type Vec3 } from './physics';
import { Rng } from '../sim/rng';
import { at, drawFigure, figureDepth, frame, holderPose, kickerPose, linemanPose, rusherPose, type Figure } from './figures';

export type Phase = 'aim' | 'power' | 'accuracy' | 'flight' | 'result';

export interface SceneView {
  setup: KickSetup;
  kicker: KickerRatings;
  accent: string;
  time: number; // seconds since scene start (flags, crowd shimmer, pulses)
  phase: Phase;
  aimX: number;
  ball: Vec3; // current ball position
  ballSpin: number; // radians of end-over-end rotation
  ballHeld: boolean; // still on the hold
  tracer: Vec3[];
  sinceContact: number | null; // seconds since the ball left the foot
  sinceLock: number | null; // seconds since the accuracy meter locked (snap + approach)
  sinceDecide: number | null; // seconds since the result was decided
  made: boolean | null;
  slowBlend: number; // 0..1 slow-motion push-in
  lookBoost: number; // camera tilt-up to follow the ball, ft
  shake: number; // 0..1
  power: number; // current power meter value
  powerLocked: number | null;
  accuracy: number; // current accuracy marker, -1..1
  accuracyLocked: number | null;
}

// ---------------------------------------------------------------------------
// Camera

export interface SlowCam {
  blend: number; // 0..1
  focus: Vec3; // where the ball meets the goal plane
  ball: Vec3;
}

export function buildCamera(w: number, h: number, setup: KickSetup, lookBoost: number, shake: number, time: number, slow?: SlowCam): Camera {
  const pr = CONFIG.presentation;
  const planeY = goalPlaneY(setup.distanceYd);
  const x0 = kickSpotX(setup.level, setup.hash);
  const zoom = Math.min(pr.focalMax, pr.focalBase + pr.focalPerYard * Math.max(0, setup.distanceYd - 20));
  const span = Math.min(w, h * 1.7);
  const f = span * zoom;
  const back = pr.cameraBackFt * (zoom / pr.focalBase);
  const height = pr.cameraHeightFt * (zoom / pr.focalBase) ** 0.5;
  // Line up behind the ball, facing the centre of the posts.
  const dx = 0 - x0;
  const dy = planeY;
  const l = Math.hypot(dx, dy);
  const sx = shake * Math.sin(time * 91) * 0.35;
  const sz = shake * Math.cos(time * 77) * 0.3;
  let pos = { x: x0 - (dx / l) * back + sx, y: -(dy / l) * back, z: height + sz };
  let target = { x: 0, y: planeY, z: 12 + lookBoost };
  let focal = f;
  let cy = h * 0.4;
  if (slow && slow.blend > 0) {
    // Push in behind the ball as it reaches the posts.
    const S = CONFIG.slowMo;
    const b = slow.blend * slow.blend * (3 - 2 * slow.blend);
    const cpos = { x: slow.ball.x * 0.55 + slow.focus.x * 0.45, y: Math.max(pos.y + 5, planeY - S.closeBackFt), z: Math.max(6, slow.focus.z - 1) };
    const ctgt = { x: slow.focus.x * 0.85, y: planeY, z: slow.focus.z + 1.5 };
    pos = { x: pos.x + (cpos.x - pos.x) * b + sx * 2, y: pos.y + (cpos.y - pos.y) * b, z: pos.z + (cpos.z - pos.z) * b + sz * 2 };
    target = { x: target.x + (ctgt.x - target.x) * b, y: planeY, z: target.z + (ctgt.z - target.z) * b };
    focal = f + (span * S.closeFocal - f) * b;
    cy = h * (0.4 + 0.08 * b);
  }
  return new Camera(pos, target, focal, w / 2, cy);
}

// ---------------------------------------------------------------------------
// Static crowd speckle, generated once

interface Fan {
  u: number;
  v: number;
  c: number;
  side: 0 | 1 | 2; // back, left, right
  phase: number;
}
const FANS: Fan[] = (() => {
  const r = new Rng(4242);
  const out: Fan[] = [];
  for (let i = 0; i < 1500; i++) out.push({ u: r.next(), v: r.next(), c: r.int(0, 5), side: 0, phase: r.next() * 6.28 });
  for (let i = 0; i < 1300; i++) out.push({ u: r.next(), v: r.next(), c: r.int(0, 5), side: (1 + (i % 2)) as 1 | 2, phase: r.next() * 6.28 });
  return out;
})();

function fanPos(f: Fan, planeY: number): Vec3 {
  if (f.side === 0) return { x: -260 + 520 * f.u, y: planeY + 50 + 200 * f.v, z: 4 + 110 * f.v };
  const sgn = f.side === 1 ? -1 : 1;
  return { x: sgn * (125 + 200 * f.v), y: -160 + (planeY + 210) * f.u, z: 4 + 110 * f.v };
}

// ---------------------------------------------------------------------------
// Helpers

function fillPoly(ctx: CanvasRenderingContext2D, pts: ScreenPt[], style: string | CanvasGradient) {
  if (pts.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].sx, pts[0].sy);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].sx, pts[i].sy);
  ctx.closePath();
  ctx.fillStyle = style;
  ctx.fill();
}

function quad(cam: Camera, x0: number, x1: number, y0: number, y1: number, z = 0): ScreenPt[] {
  return cam.polygon([
    { x: x0, y: y0, z },
    { x: x1, y: y0, z },
    { x: x1, y: y1, z },
    { x: x0, y: y1, z },
  ]);
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

function line3(ctx: CanvasRenderingContext2D, cam: Camera, a: Vec3, b: Vec3, widthFt: number, color: string, minPx = 1) {
  const pa = cam.project(a);
  const pb = cam.project(b);
  if (!pa || !pb) return;
  const d = (pa.depth + pb.depth) / 2;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(minPx, widthFt * cam.scale(d));
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(pa.sx, pa.sy);
  ctx.lineTo(pb.sx, pb.sy);
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Scene

export function drawScene(ctx: CanvasRenderingContext2D, cam: Camera, w: number, h: number, v: SceneView) {
  const { setup } = v;
  const level = CONFIG.levels[setup.level];
  const planeY = goalPlaneY(setup.distanceYd);
  const goalLine = planeY - CONFIG.field.endZoneDepthFt;
  const half = CONFIG.field.halfWidthFt;
  const x0 = kickSpotX(setup.level, setup.hash);
  const camY = cam.pos.y;

  // Sky
  const sky = ctx.createLinearGradient(0, 0, 0, h * 0.6);
  sky.addColorStop(0, '#04060f');
  sky.addColorStop(0.6, '#0b1430');
  sky.addColorStop(1, '#1b2850');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // Stands (back, then sides)
  const standBack = cam.polygon([
    { x: -280, y: planeY + 48, z: 0 },
    { x: 280, y: planeY + 48, z: 0 },
    { x: 280, y: planeY + 260, z: 118 },
    { x: -280, y: planeY + 260, z: 118 },
  ]);
  fillPoly(ctx, standBack, '#141a2b');
  for (const sgn of [-1, 1]) {
    fillPoly(
      ctx,
      cam.polygon([
        { x: sgn * 122, y: -200, z: 0 },
        { x: sgn * 122, y: planeY + 50, z: 0 },
        { x: sgn * 335, y: planeY + 50, z: 118 },
        { x: sgn * 335, y: -200, z: 118 },
      ]),
      '#121827',
    );
  }
  // Crowd
  const crowd = ['#9aa0b0', '#2f3954', rgba(v.accent, 0.75), '#6b7389', '#454f6a', '#c9ccd6'];
  for (const f of FANS) {
    const p = cam.project(fanPos(f, planeY));
    if (!p || p.sx < -10 || p.sx > w + 10 || p.sy < -10 || p.sy > h) continue;
    const s = Math.min(4, Math.max(1, 1.1 * cam.scale(p.depth)));
    const bob = Math.sin(v.time * 3 + f.phase) * s * 0.15;
    ctx.fillStyle = crowd[f.c];
    ctx.fillRect(p.sx - s / 2, p.sy - s + bob, s, s);
  }
  // Rim of the bowl and light banks
  line3(ctx, cam, { x: -280, y: planeY + 260, z: 118 }, { x: 280, y: planeY + 260, z: 118 }, 3, '#0a0e18', 2);
  for (const lx of [-190, -60, 60, 190]) {
    const p = cam.project({ x: lx, y: planeY + 270, z: 150 });
    if (!p) continue;
    const r = Math.max(14, 40 * cam.scale(p.depth));
    const g = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, r * 4);
    g.addColorStop(0, 'rgba(255,250,235,0.9)');
    g.addColorStop(0.06, 'rgba(255,245,220,0.3)');
    g.addColorStop(1, 'rgba(255,240,210,0)');
    ctx.fillStyle = g;
    ctx.fillRect(p.sx - r * 4, p.sy - r * 4, r * 8, r * 8);
    ctx.fillStyle = '#fffdf3';
    ctx.fillRect(p.sx - r * 0.6, p.sy - r * 0.25, r * 1.2, r * 0.5);
  }

  // Ground
  fillPoly(ctx, quad(cam, -400, 400, camY - 50, planeY + 49), '#1c3a1f');
  fillPoly(ctx, quad(cam, -half - 6, half + 6, camY - 50, planeY + 30), '#2b6a2f');
  // Mowing stripes, 5 yards each, from the goal line back
  for (let i = 0, y = goalLine; y > camY - 40; i++, y -= 15) {
    fillPoly(ctx, quad(cam, -half, half, y - 15, y), i % 2 === 0 ? '#2f7a33' : '#2a6d2e');
  }
  // End zone
  fillPoly(ctx, quad(cam, -half, half, goalLine, planeY), '#2a6d2e');
  fillPoly(ctx, quad(cam, -half, half, goalLine, planeY), rgba(v.accent, 0.28));

  const white = 'rgba(245,248,245,0.92)';
  // Sidelines and border
  for (const sgn of [-1, 1]) fillPoly(ctx, quad(cam, sgn * half, sgn * (half + 6), camY - 50, planeY + 6), white);
  fillPoly(ctx, quad(cam, -half - 6, half + 6, planeY, planeY + 6), white);
  // Goal line and yard lines
  fillPoly(ctx, quad(cam, -half, half, goalLine, goalLine + 0.67), white);
  for (let y = goalLine - 15; y > camY - 40; y -= 15) fillPoly(ctx, quad(cam, -half, half, y - 0.17, y + 0.17), white);
  // Hash marks every yard
  const hx = level.hashWidthFt / 2;
  for (let y = goalLine - 3; y > camY - 30; y -= 3) {
    if (Math.abs((goalLine - y) % 15) < 0.01) continue;
    for (const sgn of [-1, 1]) {
      fillPoly(ctx, quad(cam, sgn * hx - (sgn > 0 ? 0 : 2), sgn * hx + (sgn > 0 ? 2 : 0), y - 0.17, y + 0.17), white);
      fillPoly(ctx, quad(cam, sgn * (half - 1), sgn * (half - 3), y - 0.17, y + 0.17), white);
    }
  }
  // Broadcast line-of-scrimmage graphic
  const los = CONFIG.field.snapDepthYd * 3;
  fillPoly(ctx, quad(cam, -half, half, los - 0.35, los + 0.35, 0.02), 'rgba(60,140,255,0.85)');

  // Aim guide on the ground
  if (v.phase === 'aim' || v.phase === 'power' || v.phase === 'accuracy') {
    const pa = cam.project({ x: x0, y: 2, z: 0.05 });
    const pb = cam.project({ x: v.aimX, y: planeY, z: 0.05 });
    if (pa && pb) {
      ctx.save();
      ctx.setLineDash([10, 10]);
      ctx.lineDashOffset = -v.time * 30;
      ctx.strokeStyle = rgba(v.accent, 0.55);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(pa.sx, pa.sy);
      ctx.lineTo(pb.sx, pb.sy);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Ball shadow
  if (!v.ballHeld) {
    const sp = cam.project({ x: v.ball.x, y: v.ball.y, z: 0 });
    if (sp) {
      const s = cam.scale(sp.depth);
      const a = Math.max(0.08, 0.45 - v.ball.z / 120);
      ctx.fillStyle = `rgba(0,0,0,${a})`;
      ctx.beginPath();
      ctx.ellipse(sp.sx, sp.sy, Math.max(1.5, 0.9 * s), Math.max(0.8, 0.35 * s), 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Depth-sorted things: players, goalposts, ball
  type Drawable = { depth: number; draw: () => void };
  const items: Drawable[] = [];

  const dir = { x: -x0, y: planeY };
  const P = CONFIG.practice;
  const addFig = (fig: Figure) => {
    const d = figureDepth(cam, fig);
    if (d < 1) return;
    items.push({ depth: d, draw: () => drawFigure(ctx, cam, fig) });
  };
  const lineFrame = (u: number, vOff: number, facing: 1 | -1) => {
    const base = frame({ x: x0, y: 0, z: 0 }, dir);
    return frame(at(base, u, los + vOff, 0), { x: dir.x * facing, y: dir.y * facing });
  };
  const rushK = v.sinceLock === null ? null : v.sinceLock - 0.25 < 0 ? null : v.sinceLock - 0.25;
  // Protection: wing, five interior linemen and the snapper, wing (we see their backs)
  const nums = ['72', '65', '58', '61', '76', '68', '79', '88', '85'];
  for (let k = -4; k <= 4; k++) {
    const bulk = Math.abs(k) <= 3 ? 1.18 : 1.0;
    const fr = lineFrame(k * 3.05, -1.3 - (Math.abs(k) === 4 ? 0.6 : 0), 1);
    addFig({ pose: linemanPose(fr, bulk, v.time, k), kit: P.team, facing: 'away', number: nums[k + 4], bulk });
  }
  for (const sgn of [-1, 1]) {
    const fr = lineFrame(sgn * 15.5, -3.3, 1);
    addFig({ pose: linemanPose(fr, 1, v.time, sgn * 7), kit: P.team, facing: 'away', number: sgn < 0 ? '84' : '47', bulk: 1 });
  }
  // The rush (facing us)
  const dnums = ['91', '97', '55', '93', '99', '94', '95', '52', '90', '44', '98'];
  for (let k = -4; k <= 4; k++) {
    const bulk = Math.abs(k) <= 2 ? 1.15 : 1.02;
    const fr = lineFrame(k * 3.3 + 1.6, 3 + Math.abs(k) * 0.25, -1);
    addFig({ pose: rusherPose(fr, bulk, v.time, k + 4, rushK), kit: P.opponent, facing: 'toward', number: dnums[k + 4], bulk });
  }
  for (const sgn of [-1, 1]) {
    const fr = lineFrame(sgn * 18.5, 2.4, -1);
    addFig({ pose: rusherPose(fr, 1, v.time, sgn + 5, rushK), kit: P.opponent, facing: 'toward', number: sgn < 0 ? '44' : '98', bulk: 1 });
  }
  // Holder and kicker, framed on the ball spot facing the posts
  const spot = frame({ x: x0, y: 0, z: 0 }, dir);
  const made = v.made;
  addFig({ pose: holderPose(spot, v.time, v.sinceContact, made), kit: P.team, facing: 'away', number: '11', bulk: 0.95 });
  addFig({
    pose: kickerPose(spot, v.time, v.sinceLock, made === null ? null : { made }, v.sinceDecide),
    kit: P.team,
    facing: 'away',
    number: P.kickerNumber,
    name: P.kickerName.split(' ').slice(-1)[0],
    bulk: 0.92,
  });

  // Goalposts
  const postDepth = cam.toCam({ x: 0, y: planeY, z: 10 }).y;
  items.push({ depth: postDepth, draw: () => drawGoalposts(ctx, cam, v, planeY, level.uprightWidthFt / 2, level.uprightHeightFt) });

  // Ball and tracer
  const bc = cam.toCam(v.ball);
  items.push({ depth: bc.y - 0.01, draw: () => drawBall(ctx, cam, v) });

  items.sort((a, b) => b.depth - a.depth);
  for (const it of items) it.draw();

  // Aim reticle
  if (v.phase === 'aim' || v.phase === 'power' || v.phase === 'accuracy') {
    const p = cam.project({ x: v.aimX, y: planeY, z: 14 });
    if (p) {
      const pulse = v.phase === 'aim' ? 1 + Math.sin(v.time * 6) * 0.08 : 1;
      const r = Math.max(10, Math.min(28, 2.4 * cam.scale(p.depth))) * pulse;
      ctx.save();
      ctx.shadowColor = v.accent;
      ctx.shadowBlur = 12;
      ctx.strokeStyle = v.accent;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p.sx - r * 1.6, p.sy);
      ctx.lineTo(p.sx - r * 0.45, p.sy);
      ctx.moveTo(p.sx + r * 0.45, p.sy);
      ctx.lineTo(p.sx + r * 1.6, p.sy);
      ctx.moveTo(p.sx, p.sy - r * 1.6);
      ctx.lineTo(p.sx, p.sy - r * 0.45);
      ctx.moveTo(p.sx, p.sy + r * 0.45);
      ctx.lineTo(p.sx, p.sy + r * 1.6);
      ctx.stroke();
      ctx.fillStyle = v.accent;
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // Vignette
  const vg = ctx.createRadialGradient(w / 2, h * 0.45, Math.min(w, h) * 0.35, w / 2, h * 0.5, Math.max(w, h) * 0.8);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, w, h);

  // Slow-motion: darken the edges and bring in cinematic bars.
  if (v.slowBlend > 0) {
    const b = v.slowBlend;
    const sv = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.max(w, h) * 0.75);
    sv.addColorStop(0, 'rgba(0,0,0,0)');
    sv.addColorStop(1, `rgba(0,0,0,${0.55 * b})`);
    ctx.fillStyle = sv;
    ctx.fillRect(0, 0, w, h);
    const bar = h * CONFIG.slowMo.letterbox * b;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, bar);
    ctx.fillRect(0, h - bar, w, bar);
  }
}

function shade(hex: string, amt: number): string {
  const [r, g, b] = hexToRgb(hex);
  const f = (c: number) => Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt);
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

function drawGoalposts(ctx: CanvasRenderingContext2D, cam: Camera, v: SceneView, planeY: number, half: number, uprightH: number) {
  const yellow = '#f4d63b';
  const bar = 10;
  const back = 6;
  // Padded base and gooseneck
  line3(ctx, cam, { x: 0, y: planeY + back, z: 0 }, { x: 0, y: planeY + back, z: 6 }, 1.6, shade(v.accent, -0.3), 2);
  line3(ctx, cam, { x: 0, y: planeY + back, z: 6 }, { x: 0, y: planeY + back, z: bar - 1 }, 0.55, yellow, 1.5);
  line3(ctx, cam, { x: 0, y: planeY + back, z: bar - 1 }, { x: 0, y: planeY, z: bar }, 0.55, yellow, 1.5);
  // Crossbar and uprights
  line3(ctx, cam, { x: -half, y: planeY, z: bar }, { x: half, y: planeY, z: bar }, 0.45, yellow, 1.5);
  for (const sgn of [-1, 1]) {
    line3(ctx, cam, { x: sgn * half, y: planeY, z: bar }, { x: sgn * half, y: planeY, z: bar + uprightH }, 0.35, yellow, 1.5);
    drawFlag(ctx, cam, v, { x: sgn * half, y: planeY, z: bar + uprightH }, sgn);
  }
}

function drawFlag(ctx: CanvasRenderingContext2D, cam: Camera, v: SceneView, top: Vec3, seed: number) {
  const { setup } = v;
  const wv = windVectorFtS(setup.windMph, setup.windToDeg);
  const sp = Math.hypot(wv.x, wv.y);
  const strength = Math.min(1, setup.windMph / 18);
  const dirx = sp > 0 ? wv.x / sp : 0;
  const diry = sp > 0 ? wv.y / sp : 0;
  const len = 4.2;
  const pts: ScreenPt[] = [];
  const n = 6;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const flap = Math.sin(v.time * (5 + strength * 9) + t * 5 + seed) * 0.55 * t * (0.3 + strength);
    const droop = -(1 - strength) * t * len * 0.95;
    const out = t * len * (0.15 + 0.85 * strength);
    const p = cam.project({ x: top.x + dirx * out - diry * flap * 0.3, y: top.y + diry * out + dirx * flap * 0.3, z: top.z + droop + flap * 0.4 - 0.2 });
    if (!p) return;
    pts.push(p);
  }
  ctx.strokeStyle = '#ff5a1f';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const pw = cam.scale(pts[0].depth);
  ctx.lineWidth = Math.max(2, 0.6 * pw);
  ctx.beginPath();
  ctx.moveTo(pts[0].sx, pts[0].sy);
  for (const p of pts.slice(1)) ctx.lineTo(p.sx, p.sy);
  ctx.stroke();
}

function drawBall(ctx: CanvasRenderingContext2D, cam: Camera, v: SceneView) {
  // Tracer
  if (v.tracer.length > 1) {
    const pts = v.tracer.map((p) => cam.project(p)).filter((p): p is ScreenPt => p !== null);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 1; i < pts.length; i++) {
      const a = i / pts.length;
      ctx.strokeStyle = rgba(v.accent, 0.12 + 0.75 * a);
      ctx.lineWidth = Math.max(1.5, Math.min(7, 0.5 * cam.scale(pts[i].depth)));
      ctx.beginPath();
      ctx.moveTo(pts[i - 1].sx, pts[i - 1].sy);
      ctx.lineTo(pts[i].sx, pts[i].sy);
      ctx.stroke();
    }
    ctx.restore();
  }
  const p = cam.project(v.ball);
  if (!p) return;
  const s = cam.scale(p.depth);
  let rx: number;
  let ry: number;
  let rot = 0;
  if (v.ballHeld) {
    rx = 0.36 * s;
    ry = 0.58 * s;
    rot = -0.12;
  } else {
    const c = Math.abs(Math.cos(v.ballSpin));
    rx = 0.36 * s;
    ry = (0.36 + 0.24 * c) * s;
  }
  rx = Math.max(1.6, rx);
  ry = Math.max(1.6, ry);
  ctx.save();
  ctx.translate(p.sx, p.sy - (v.ballHeld ? ry : 0));
  ctx.rotate(rot);
  const g = ctx.createRadialGradient(-rx * 0.3, -ry * 0.3, 0, 0, 0, Math.max(rx, ry));
  g.addColorStop(0, '#a5592c');
  g.addColorStop(1, '#4d2210');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  if (ry > 4) {
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = Math.max(1, rx * 0.12);
    ctx.beginPath();
    ctx.moveTo(0, -ry * 0.35);
    ctx.lineTo(0, ry * 0.35);
    ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Meters (screen space)

export function drawMeters(ctx: CanvasRenderingContext2D, w: number, h: number, v: SceneView) {
  const m = CONFIG.meters;
  const compact = w < 640;

  // POWER: vertical, right side
  const showPower = v.phase !== 'aim';
  const pw = compact ? 18 : 24;
  const ph = Math.min(h * 0.46, 340);
  const px = w - (compact ? 40 : 70);
  const py = h * 0.5 - ph / 2;
  ctx.save();
  ctx.globalAlpha = showPower ? (v.phase === 'flight' || v.phase === 'result' ? 0.75 : 1) : 0.35;
  panel(ctx, px - 12, py - 34, pw + 24, ph + 62);
  const valToY = (val: number) => py + ph - (val / m.powerMax) * ph;
  const topY = valToY(1);
  // track
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(px, py, pw, ph);
  ctx.fillStyle = 'rgba(255,70,50,0.22)';
  ctx.fillRect(px, py, pw, topY - py);
  // fill
  const val = v.powerLocked ?? v.power;
  if (showPower) {
    const fy = valToY(val);
    const g = ctx.createLinearGradient(0, py + ph, 0, py);
    g.addColorStop(0, '#2bd46a');
    g.addColorStop((0.75 / m.powerMax), '#e8e23a');
    g.addColorStop(1 / m.powerMax, '#ffb21f');
    g.addColorStop(1, '#ff3b2f');
    ctx.fillStyle = g;
    ctx.fillRect(px, fy, pw, py + ph - fy);
  }
  // top line
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(px - 6, topY);
  ctx.lineTo(px + pw + 6, topY);
  ctx.stroke();
  if (v.powerLocked !== null) {
    const ly = valToY(v.powerLocked);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(px - 10, ly);
    ctx.lineTo(px - 2, ly - 6);
    ctx.lineTo(px - 2, ly + 6);
    ctx.fill();
  }
  ctx.fillStyle = '#fff';
  ctx.font = `600 ${compact ? 10 : 12}px Oswald, Impact, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('POWER', px + pw / 2, py - 14);
  ctx.font = `700 ${compact ? 12 : 15}px Oswald, Impact, sans-serif`;
  ctx.fillText(showPower ? `${Math.round(val * 100)}` : '—', px + pw / 2, py + ph + 20);
  ctx.restore();

  // ACCURACY: horizontal, bottom centre
  const showAcc = v.phase === 'accuracy' || v.phase === 'flight' || v.phase === 'result';
  const aw = Math.min(560, w * (compact ? 0.8 : 0.5));
  const ah = compact ? 16 : 20;
  const ax = w / 2 - aw / 2;
  const ay = h - (compact ? 96 : 64);
  ctx.save();
  ctx.globalAlpha = showAcc ? (v.phase === 'accuracy' ? 1 : 0.8) : v.phase === 'power' ? 0.45 : 0.2;
  panel(ctx, ax - 14, ay - 30, aw + 28, ah + 44);
  const sHalf = sweetSpotHalf(v.kicker, v.powerLocked ?? Math.min(1, v.power));
  const toX = (e: number) => ax + ((e + 1) / 2) * aw;
  const g = ctx.createLinearGradient(ax, 0, ax + aw, 0);
  g.addColorStop(0, '#b3261e');
  g.addColorStop(0.5 - sHalf * 1.2, '#e3a21a');
  g.addColorStop(0.5, '#e3c21a');
  g.addColorStop(0.5 + sHalf * 1.2, '#e3a21a');
  g.addColorStop(1, '#b3261e');
  ctx.fillStyle = g;
  ctx.fillRect(ax, ay, aw, ah);
  // sweet spot
  ctx.fillStyle = '#29d16b';
  ctx.fillRect(toX(-sHalf), ay - 3, toX(sHalf) - toX(-sHalf), ah + 6);
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.fillRect(toX(0) - 1, ay - 3, 2, ah + 6);
  // marker
  if (showAcc) {
    const mx = toX(v.accuracyLocked ?? v.accuracy);
    ctx.shadowColor = '#fff';
    ctx.shadowBlur = 10;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(mx - 2.5, ay - 9, 5, ah + 18);
    ctx.beginPath();
    ctx.moveTo(mx - 7, ay - 14);
    ctx.lineTo(mx + 7, ay - 14);
    ctx.lineTo(mx, ay - 6);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  ctx.fillStyle = '#fff';
  ctx.font = `600 ${compact ? 10 : 12}px Oswald, Impact, sans-serif`;
  ctx.textAlign = 'left';
  ctx.fillText('ACCURACY', ax, ay - 14);
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fillText(compact ? 'HOOK ◀   ▶ SLICE' : 'HOOK ◀            ▶ SLICE', ax + aw, ay - 14);
  ctx.restore();
}

function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.fillStyle = 'rgba(6,10,22,0.72)';
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 8);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.stroke();
}
