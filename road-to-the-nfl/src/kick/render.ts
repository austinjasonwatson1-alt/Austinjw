// Canvas drawing for the kick scene. Pure drawing: no game state changes here.

import { CONFIG } from '../config';
import { Camera, type ScreenPt } from './camera';
import { goalPlaneY, kickSpotX, sweetSpotHalf, windVectorFtS, type KickSetup, type KickerRatings, type Vec3 } from './physics';
import { Rng } from '../sim/rng';
import { at, celebratePose, drawFigure, figureDepth, frame, holderPose, kickerPose, linemanPose, rusherPose, type Figure, type Kit } from './figures';

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
  teamKit: Kit;
  oppKit: Kit;
  kickerNumber: string;
  kickerName: string;
  pressure: number; // 0..1 effective (after Composure), shakes the meters
  celebrateT: number | null; // seconds into a big-moment celebration
  board: [string, string]; // video board lines
  boardFlash: string | null; // big message on the board during a celebration
  endzone: string; // painted in the end zone
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

interface StadiumSpec {
  height: number;
  depth: number;
  crowd: number;
  sides: number;
  lights: number;
}

function fanPos(f: Fan, planeY: number, st: StadiumSpec): Vec3 {
  if (f.side === 0) return { x: -260 + 520 * f.u, y: planeY + 50 + st.depth * 0.95 * f.v, z: 4 + (st.height - 8) * f.v };
  const sgn = f.side === 1 ? -1 : 1;
  const sh = st.height * st.sides;
  return { x: sgn * (125 + st.depth * 0.95 * st.sides * f.v), y: -160 + (planeY + 210) * f.u, z: 4 + Math.max(4, sh - 8) * f.v };
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

  // Stands grow with the level: bleachers, a college bowl, an NFL stadium.
  const st: StadiumSpec = CONFIG.stadium[setup.level];
  const H = st.height;
  const D = st.depth;
  fillPoly(
    ctx,
    cam.polygon([
      { x: -280, y: planeY + 48, z: 0 },
      { x: 280, y: planeY + 48, z: 0 },
      { x: 280, y: planeY + 50 + D, z: H },
      { x: -280, y: planeY + 50 + D, z: H },
    ]),
    '#141a2b',
  );
  for (const sgn of [-1, 1]) {
    fillPoly(
      ctx,
      cam.polygon([
        { x: sgn * 122, y: -200, z: 0 },
        { x: sgn * 122, y: planeY + 50, z: 0 },
        { x: sgn * (125 + D * st.sides), y: planeY + 50, z: H * st.sides },
        { x: sgn * (125 + D * st.sides), y: -200, z: H * st.sides },
      ]),
      '#121827',
    );
  }
  const flashRate = 0.0015 + v.pressure * 0.006 + (v.celebrateT !== null ? 0.05 : 0) + (v.phase === 'flight' ? 0.004 : 0);
  if (v.celebrateT !== null) drawFireworks(ctx, w, h, v);
  // Crowd
  const crowd = ['#9aa0b0', '#2f3954', rgba(v.accent, 0.75), '#6b7389', '#454f6a', '#c9ccd6'];
  const every = Math.max(1, Math.round(1 / st.crowd));
  for (let i = 0; i < FANS.length; i += every) {
    const f = FANS[i];
    const p = cam.project(fanPos(f, planeY, st));
    if (!p || p.sx < -10 || p.sx > w + 10 || p.sy < -10 || p.sy > h) continue;
    const s = Math.min(4, Math.max(1, 1.1 * cam.scale(p.depth)));
    const bob = Math.sin(v.time * 3 + f.phase) * s * 0.15;
    ctx.fillStyle = crowd[f.c];
    ctx.fillRect(p.sx - s / 2, p.sy - s + bob, s, s);
    // Camera flashes: more of them in big moments
    const seedN = Math.sin(i * 12.9898 + Math.floor(v.time * 9) * 78.233) * 43758.5453;
    if (seedN - Math.floor(seedN) < flashRate) {
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.fillRect(p.sx - s, p.sy - s * 1.5, s * 2, s * 2);
    }
  }
  // Rim and lights. High school gets light poles on their own; bigger venues hang them off the rim.
  line3(ctx, cam, { x: -280, y: planeY + 50 + D, z: H }, { x: 280, y: planeY + 50 + D, z: H }, 3, '#0a0e18', 2);
  const lightSpots: Vec3[] =
    st.lights <= 2
      ? [
          { x: -150, y: planeY + 40, z: 70 },
          { x: 150, y: planeY + 40, z: 70 },
          { x: -150, y: planeY * 0.35, z: 70 },
          { x: 150, y: planeY * 0.35, z: 70 },
        ]
      : [-190, -60, 60, 190].map((lx) => ({ x: lx, y: planeY + 60 + D, z: H + 32 }));
  for (const L of lightSpots) {
    if (st.lights <= 2) line3(ctx, cam, { ...L, z: 0 }, L, 1.2, '#2a2f3a', 1.5);
    const p = cam.project(L);
    if (!p) continue;
    const r = Math.max(12, 30 * cam.scale(p.depth));
    const g = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, r * 4);
    g.addColorStop(0, 'rgba(255,250,235,0.9)');
    g.addColorStop(0.06, 'rgba(255,245,220,0.3)');
    g.addColorStop(1, 'rgba(255,240,210,0)');
    ctx.fillStyle = g;
    ctx.fillRect(p.sx - r * 4, p.sy - r * 4, r * 8, r * 8);
    ctx.fillStyle = '#fffdf3';
    ctx.fillRect(p.sx - r * 0.6, p.sy - r * 0.25, r * 1.2, r * 0.5);
    // Haze beam down onto the field
    const a = cam.project({ x: L.x * 0.25 - 30, y: planeY * 0.55, z: 0 });
    const b = cam.project({ x: L.x * 0.25 + 30, y: planeY * 0.55, z: 0 });
    if (a && b) {
      const beam = ctx.createLinearGradient(p.sx, p.sy, (a.sx + b.sx) / 2, (a.sy + b.sy) / 2);
      beam.addColorStop(0, 'rgba(255,248,225,0.10)');
      beam.addColorStop(1, 'rgba(255,248,225,0)');
      ctx.fillStyle = beam;
      ctx.beginPath();
      ctx.moveTo(p.sx - r * 0.5, p.sy);
      ctx.lineTo(p.sx + r * 0.5, p.sy);
      ctx.lineTo(b.sx, b.sy);
      ctx.lineTo(a.sx, a.sy);
      ctx.closePath();
      ctx.fill();
    }
  }
  drawBoard(ctx, cam, v, planeY, st);

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
  // End zone lettering and yard numbers
  if (v.endzone) {
    const m = 5;
    groundText(ctx, cam, v.endzone, { x: -half + 12, y: planeY - m }, { x: half - 12, y: planeY - m }, { x: -half + 12, y: goalLine + m }, rgba(v.accent, 0.9), 'rgba(255,255,255,0.85)');
  }
  for (let k = 10; k <= 50; k += 10) {
    const y = goalLine - k * 3;
    if (y < camY + 18) continue;
    const label = String(k);
    for (const sgn of [-1, 1]) {
      const cx = sgn * (half - 36);
      const W = 9;
      const Hn = 6;
      // Numbers face the sideline they sit next to.
      const dirY = sgn < 0 ? -1 : 1;
      const upX = sgn < 0 ? 1 : -1;
      const tl = { x: cx + (upX * Hn) / 2, y: y - (dirY * W) / 2 };
      const tr = { x: tl.x, y: tl.y + dirY * W };
      const bl = { x: tl.x - upX * Hn, y: tl.y };
      groundText(ctx, cam, label, tl, tr, bl, 'rgba(245,248,245,0.85)', null);
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
  const P = { team: v.teamKit, opponent: v.oppKit, kickerNumber: v.kickerNumber, kickerName: v.kickerName };
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
  // Protection: wing, five interior linemen and the snapper, wing (we see their backs).
  // In a big moment they sprint back and mob the kicker.
  const nums = ['72', '65', '58', '61', '76', '68', '79', '88', '85', '84', '47'];
  const spot0 = frame({ x: x0, y: 0, z: 0 }, dir);
  const mobCenter = at(spot0, -0.35, 1.4, 0);
  const protect: { u: number; v: number; bulk: number }[] = [];
  for (let k = -4; k <= 4; k++) protect.push({ u: k * 3.05, v: -1.3 - (Math.abs(k) === 4 ? 0.6 : 0), bulk: Math.abs(k) <= 3 ? 1.18 : 1.0 });
  protect.push({ u: -15.5, v: -3.3, bulk: 1 }, { u: 15.5, v: -3.3, bulk: 1 });
  protect.forEach((pl, i) => {
    const fr = lineFrame(pl.u, pl.v, 1);
    if (v.celebrateT !== null) {
      const ct = v.celebrateT;
      const prog = Math.max(0, Math.min(1, (ct - 0.15 - (i % 5) * 0.08) / 1.3));
      const e = prog * prog * (3 - 2 * prog);
      const ang = -1.75 + (i / (protect.length - 1)) * 3.5; // an arc on the far side of the kicker
      const rad = 2.6 + (i % 3) * 1.1;
      const target = at(frame(mobCenter, dir), Math.sin(ang) * rad, Math.cos(ang) * rad, 0);
      const pos = { x: fr.origin.x + (target.x - fr.origin.x) * e, y: fr.origin.y + (target.y - fr.origin.y) * e, z: 0 };
      const face = { x: mobCenter.x - pos.x || 0.01, y: mobCenter.y - pos.y || 0.01 };
      addFig({ pose: celebratePose(frame(pos, face), pl.bulk, v.time, i, e), kit: P.team, facing: e > 0.4 ? 'toward' : 'away', number: nums[i], bulk: pl.bulk });
      return;
    }
    addFig({ pose: linemanPose(fr, pl.bulk, v.time, i), kit: P.team, facing: 'away', number: nums[i], bulk: pl.bulk });
  });
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
  addFig({
    pose: v.celebrateT !== null && v.celebrateT > 0.4 ? celebratePose(frame(at(spot, 1.2, 0.6, 0), dir), 0.95, v.time, 3, 1) : holderPose(spot, v.time, v.sinceContact, made),
    kit: P.team,
    facing: 'away',
    number: '11',
    bulk: 0.95,
  });
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

  drawWeather(ctx, w, h, v);
  if (v.celebrateT !== null) drawConfetti(ctx, w, h, v);

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

const DROPS = (() => {
  const r = new Rng(77);
  return Array.from({ length: 260 }, () => ({ x: r.next(), y: r.next(), z: 0.3 + r.next() * 0.7, p: r.next() * 6.28 }));
})();

function drawWeather(ctx: CanvasRenderingContext2D, w: number, h: number, v: SceneView) {
  const kind = v.setup.weather ?? 'clear';
  if (kind !== 'rain' && kind !== 'snow') return;
  const wind = windVectorFtS(v.setup.windMph, v.setup.windToDeg);
  const drift = wind.x * 0.004;
  ctx.save();
  if (kind === 'rain') {
    ctx.strokeStyle = 'rgba(190,205,230,0.35)';
    ctx.lineCap = 'round';
    for (const d of DROPS) {
      const speed = 1.6 * d.z;
      const y = ((d.y + v.time * speed) % 1) * (h + 40) - 20;
      const x = (((d.x + drift * v.time * 60 * d.z) % 1) + 1) % 1 * w;
      ctx.lineWidth = d.z * 1.4;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + drift * 400 * d.z + 1, y + 18 * d.z);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(40,50,70,0.18)';
    ctx.fillRect(0, 0, w, h);
  } else {
    ctx.fillStyle = 'rgba(245,248,255,0.85)';
    for (const d of DROPS) {
      const speed = 0.12 * d.z;
      const y = ((d.y + v.time * speed) % 1) * (h + 20) - 10;
      const x = ((((d.x + drift * v.time * 20 * d.z + Math.sin(v.time + d.p) * 0.01) % 1) + 1) % 1) * w;
      ctx.beginPath();
      ctx.arc(x, y, 1 + d.z * 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(200,210,230,0.08)';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.restore();
}

/** Draw text into a ground (or wall) parallelogram given its projected top-left, top-right and bottom-left corners. */
function groundText(ctx: CanvasRenderingContext2D, cam: Camera, text: string, tl: { x: number; y: number }, tr: { x: number; y: number }, bl: { x: number; y: number }, fill: string, stroke: string | null) {
  const z = 0.03;
  const a = cam.project({ ...tl, z });
  const b = cam.project({ ...tr, z });
  const c = cam.project({ ...bl, z });
  if (!a || !b || !c) return;
  if (Math.hypot(b.sx - a.sx, b.sy - a.sy) < 6) return;
  wallText(ctx, a, b, c, text, fill, stroke);
}

function wallText(ctx: CanvasRenderingContext2D, a: ScreenPt, b: ScreenPt, c: ScreenPt, text: string, fill: string, stroke: string | null, boxH = 300) {
  ctx.save();
  ctx.transform(b.sx - a.sx, b.sy - a.sy, c.sx - a.sx, c.sy - a.sy, a.sx, a.sy);
  ctx.scale(1 / 1000, 1 / boxH);
  ctx.font = `700 ${boxH * 0.9}px Oswald, Impact, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(text).width;
  const sx = Math.min(1, 960 / Math.max(1, tw));
  ctx.translate(500, boxH / 2 + boxH * 0.04);
  ctx.scale(sx, 1);
  if (stroke) {
    ctx.lineWidth = boxH * 0.06;
    ctx.strokeStyle = stroke;
    ctx.strokeText(text, 0, 0);
  }
  ctx.fillStyle = fill;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

/** Video board above the far stands (on poles at a high school). */
function drawBoard(ctx: CanvasRenderingContext2D, cam: Camera, v: SceneView, planeY: number, st: { height: number; depth: number; lights: number }) {
  const hs = st.lights <= 2;
  const W = hs ? 44 : st.height > 100 ? 130 : 96;
  const H = hs ? 16 : st.height > 100 ? 38 : 28;
  // Big venues: a ribbon-style board set into the end zone stands, low enough to stay in frame.
  const y = hs ? planeY + 40 : planeY + 50 + st.depth * 0.3;
  const zb = hs ? 18 : st.height * 0.3 + 2;
  if (hs) {
    line3(ctx, cam, { x: -W * 0.35, y, z: 0 }, { x: -W * 0.35, y, z: zb }, 1, '#2a2f3a', 1.5);
    line3(ctx, cam, { x: W * 0.35, y, z: 0 }, { x: W * 0.35, y, z: zb }, 1, '#2a2f3a', 1.5);
  }
  const tl = cam.project({ x: -W / 2, y, z: zb + H });
  const tr = cam.project({ x: W / 2, y, z: zb + H });
  const bl = cam.project({ x: -W / 2, y, z: zb });
  const br = cam.project({ x: W / 2, y, z: zb });
  if (!tl || !tr || !bl || !br) return;
  ctx.fillStyle = '#05070d';
  ctx.beginPath();
  ctx.moveTo(tl.sx, tl.sy);
  ctx.lineTo(tr.sx, tr.sy);
  ctx.lineTo(br.sx, br.sy);
  ctx.lineTo(bl.sx, bl.sy);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = rgba(v.accent, 0.9);
  ctx.lineWidth = Math.max(1, (tr.sx - tl.sx) / 80);
  ctx.stroke();
  if (tr.sx - tl.sx < 30) return;
  const midL = { sx: (tl.sx + bl.sx) / 2, sy: (tl.sy + bl.sy) / 2, depth: tl.depth };
  const midR = { sx: (tr.sx + br.sx) / 2, sy: (tr.sy + br.sy) / 2, depth: tr.depth };
  if (v.boardFlash) {
    const on = Math.floor(v.time * 4) % 2 === 0;
    wallText(ctx, tl, tr, bl, v.boardFlash, on ? v.accent : '#ffffff', null);
    return;
  }
  wallText(ctx, tl, tr, midL, v.board[0], '#ffffff', null);
  wallText(ctx, midL, midR, bl, v.board[1], rgba(v.accent, 0.95), null);
}

const CONFETTI = (() => {
  const r = new Rng(9);
  return Array.from({ length: CONFIG.career.celebration.confetti }, () => ({ x: r.next(), delay: r.next() * 1.5, speed: 0.12 + r.next() * 0.18, c: r.int(0, 3), s: 4 + r.next() * 6, p: r.next() * 6.28 }));
})();

function drawConfetti(ctx: CanvasRenderingContext2D, w: number, h: number, v: SceneView) {
  const ct = v.celebrateT ?? 0;
  const colors = [v.accent, v.teamKit.jersey, '#ffffff', v.teamKit.trim];
  for (const c of CONFETTI) {
    const t = ct - c.delay;
    if (t < 0) continue;
    const y = -20 + t * c.speed * h;
    if (y > h + 20) continue;
    const x = c.x * w + Math.sin(t * 2.4 + c.p) * 26;
    const flip = Math.abs(Math.cos(t * 7 + c.p));
    ctx.fillStyle = colors[c.c];
    ctx.globalAlpha = Math.min(1, 1.5 - t / 6);
    ctx.fillRect(x - (c.s * flip) / 2, y, Math.max(1, c.s * flip), c.s * 0.6);
  }
  ctx.globalAlpha = 1;
}

const BURSTS = (() => {
  const r = new Rng(31);
  return Array.from({ length: CONFIG.career.celebration.fireworks }, (_, i) => ({ t: 0.25 + i * 0.55 + r.next() * 0.2, x: 0.12 + r.next() * 0.76, y: 0.06 + r.next() * 0.22, R: 55 + r.next() * 60, c: r.int(0, 2) }));
})();

/** Fireworks over the stadium. Exposed burst times keep sound and picture in sync. */
export const FIREWORK_TIMES = BURSTS.map((b) => b.t);

function drawFireworks(ctx: CanvasRenderingContext2D, w: number, h: number, v: SceneView) {
  const ct = v.celebrateT ?? 0;
  const colors = [v.accent, '#ffffff', v.teamKit.trim];
  for (const b of BURSTS) {
    const a = ct - b.t;
    if (a < -0.45 || a > 1.8) continue;
    const cx = b.x * w;
    const cy = b.y * h;
    if (a < 0) {
      // Rising trail
      const k = 1 + a / 0.45;
      ctx.fillStyle = 'rgba(255,240,200,0.9)';
      ctx.fillRect(cx - 1, cy + (1 - k) * h * 0.35, 2, 10);
      continue;
    }
    const r = b.R * (1 - Math.pow(1 - Math.min(1, a / 1.1), 3));
    ctx.globalAlpha = Math.max(0, 1 - a / 1.8);
    ctx.fillStyle = colors[b.c];
    for (let i = 0; i < 40; i++) {
      const ang = (i / 40) * Math.PI * 2;
      const px = cx + Math.cos(ang) * r;
      const py = cy + Math.sin(ang) * r + a * a * 22;
      ctx.beginPath();
      ctx.arc(px, py, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
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
  const live = v.phase === 'power' || v.phase === 'accuracy';
  const jig = live ? v.pressure * CONFIG.pressure.shakePx : 0;
  ctx.save();
  ctx.translate(Math.sin(v.time * 53) * jig, Math.cos(v.time * 61) * jig);
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
  const sHalf = sweetSpotHalf(v.kicker, v.powerLocked ?? Math.min(1, v.power), v.setup.weather);
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
