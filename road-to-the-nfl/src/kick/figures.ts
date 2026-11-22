// Players drawn as jointed figures in world space, so they sit in the scene with real
// perspective. Dark, simple kits keep the eye on the posts and the ball.

import { CONFIG } from '../config';
import type { Camera, ScreenPt } from './camera';
import type { Vec3 } from './physics';

export interface Kit {
  jersey: string;
  trim: string;
  pants: string;
  socks: string;
  helmet: string;
}

export interface Pose {
  head: Vec3;
  lSh: Vec3;
  rSh: Vec3;
  lHip: Vec3;
  rHip: Vec3;
  lKnee: Vec3;
  rKnee: Vec3;
  lFoot: Vec3;
  rFoot: Vec3;
  lHand: Vec3;
  rHand: Vec3;
}

export interface Figure {
  pose: Pose;
  kit: Kit;
  facing: 'away' | 'toward';
  number: string;
  name?: string;
  bulk: number; // 1 = normal, linemen are bigger
}

// ---------------------------------------------------------------------------
// Local frame helpers: u = right, v = forward (facing), z = up.

export interface Frame {
  origin: Vec3;
  r: { x: number; y: number }; // unit right
  f: { x: number; y: number }; // unit forward
}

export function frame(origin: Vec3, facing: { x: number; y: number }): Frame {
  const l = Math.hypot(facing.x, facing.y) || 1;
  const f = { x: facing.x / l, y: facing.y / l };
  return { origin, f, r: { x: f.y, y: -f.x } };
}

export function at(fr: Frame, u: number, v: number, z: number): Vec3 {
  return { x: fr.origin.x + fr.r.x * u + fr.f.x * v, y: fr.origin.y + fr.r.y * u + fr.f.y * v, z: fr.origin.z + z };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) });

/** Knee between hip and foot, pushed forward (bent). */
function knee(fr: Frame, hip: Vec3, foot: Vec3, bend: number): Vec3 {
  const m = lerp3(hip, foot, 0.5);
  return { x: m.x + fr.f.x * bend, y: m.y + fr.f.y * bend, z: m.z + bend * 0.25 };
}

interface Body {
  pelvisU: number;
  pelvisV: number;
  pelvisZ: number;
  leanV: number; // shoulders forward of pelvis
  torso: number; // pelvis to shoulders
  lFoot: [number, number, number];
  rFoot: [number, number, number];
  lHand: [number, number, number];
  rHand: [number, number, number];
  kneeBendL: number;
  kneeBendR: number;
  width: number;
}

function build(fr: Frame, b: Body): Pose {
  const hipW = 0.42 * b.width;
  const shW = 0.95 * b.width;
  const lHip = at(fr, b.pelvisU - hipW, b.pelvisV, b.pelvisZ);
  const rHip = at(fr, b.pelvisU + hipW, b.pelvisV, b.pelvisZ);
  const lSh = at(fr, b.pelvisU - shW, b.pelvisV + b.leanV, b.pelvisZ + b.torso);
  const rSh = at(fr, b.pelvisU + shW, b.pelvisV + b.leanV, b.pelvisZ + b.torso);
  const head = at(fr, b.pelvisU, b.pelvisV + b.leanV * 1.15, b.pelvisZ + b.torso + 0.62);
  const lFoot = at(fr, ...b.lFoot);
  const rFoot = at(fr, ...b.rFoot);
  return {
    head,
    lSh,
    rSh,
    lHip,
    rHip,
    lFoot,
    rFoot,
    lKnee: knee(fr, lHip, lFoot, b.kneeBendL),
    rKnee: knee(fr, rHip, rFoot, b.kneeBendR),
    lHand: at(fr, ...b.lHand),
    rHand: at(fr, ...b.rHand),
  };
}

// ---------------------------------------------------------------------------
// Poses

/** Protection lineman in a two-point stance, seen from behind. */
export function linemanPose(fr: Frame, bulk: number, t: number, seed: number): Pose {
  const breathe = Math.sin(t * 2.2 + seed) * 0.04;
  return build(fr, {
    pelvisU: 0,
    pelvisV: 0,
    pelvisZ: 2.55 + breathe,
    leanV: 0.85,
    torso: 1.75,
    lFoot: [-0.85 * bulk, -0.1, 0],
    rFoot: [0.85 * bulk, -0.35, 0],
    lHand: [-0.75 * bulk, 1.25, 2.2],
    rHand: [0.75 * bulk, 1.25, 2.2],
    kneeBendL: 0.55,
    kneeBendR: 0.55,
    width: bulk,
  });
}

/** Rusher facing the kicker. sinceKick: seconds since contact (null before). */
export function rusherPose(fr: Frame, bulk: number, t: number, seed: number, sinceKick: number | null): Pose {
  if (sinceKick === null) {
    const sway = Math.sin(t * 3 + seed) * 0.05;
    return build(fr, {
      pelvisU: sway,
      pelvisV: 0,
      pelvisZ: 2.35,
      leanV: 1.0,
      torso: 1.7,
      lFoot: [-0.8 * bulk, 0.1, 0],
      rFoot: [0.8 * bulk, -0.45, 0],
      lHand: [-0.7 * bulk, 1.4, 1.2],
      rHand: [0.7 * bulk, 1.6, 1.1],
      kneeBendL: 0.6,
      kneeBendR: 0.6,
      width: bulk,
    });
  }
  // Fire off, rise, and leap with arms up to block it.
  const rise = clamp01(sinceKick / 0.22);
  const jumpT = clamp01((sinceKick - 0.1) / 0.75);
  const jump = Math.sin(jumpT * Math.PI) * (1.6 + (seed % 3) * 0.4);
  const fwd = ease(clamp01(sinceKick / 0.6)) * 2.2;
  const armUp = ease(rise);
  return build(fr, {
    pelvisU: 0,
    pelvisV: fwd,
    pelvisZ: lerp(2.35, 3.05, rise) + jump,
    leanV: lerp(1.0, 0.25, rise),
    torso: 1.85,
    lFoot: [-0.55 * bulk, fwd - 0.2, jump * 0.9],
    rFoot: [0.55 * bulk, fwd - 0.1, jump * 0.9],
    lHand: [lerp(-0.7, -0.75, armUp) * bulk, lerp(1.4, fwd + 0.6, armUp), lerp(1.2, 7.4, armUp) + jump],
    rHand: [lerp(0.7, 0.75, armUp) * bulk, lerp(1.6, fwd + 0.6, armUp), lerp(1.1, 7.4, armUp) + jump],
    kneeBendL: lerp(0.6, 0.25, rise),
    kneeBendR: lerp(0.6, 0.25, rise),
    width: bulk,
  });
}

/**
 * Holder kneeling to the kicker's right of the spot, left finger on the ball.
 * Frame origin is the ball spot, facing the posts.
 */
export function holderPose(fr: Frame, t: number, sinceKick: number | null, made: boolean | null): Pose {
  const after = sinceKick === null ? 0 : ease(clamp01((sinceKick - 0.35) / 0.5));
  const cheer = made === true ? ease(clamp01((sinceKick ?? 0) - 1.2)) : 0;
  const breathe = Math.sin(t * 2.1) * 0.03;
  const pz = lerp(1.25, 2.6, after) + breathe;
  return build(fr, {
    pelvisU: 2.0,
    pelvisV: lerp(-0.2, -0.4, after),
    pelvisZ: pz,
    leanV: lerp(0.15, 0.05, after),
    torso: 1.8,
    lFoot: [1.4, lerp(0.6, -0.1, after), 0], // left knee up, foot forward
    rFoot: [2.35, lerp(-1.6, -0.6, after), 0], // right knee down, shin flat
    lHand: sinceKick === null ? [0.12, 0.05, 1.05] : [lerp(0.6, 1.2, after), 0.4, lerp(1.4, 3.2, after) + cheer * 4.2],
    rHand: [lerp(2.6, 2.9, after), 0.3, lerp(2.0, 3.0, after) + cheer * 4.2],
    kneeBendL: lerp(1.3, 0.4, after),
    kneeBendR: lerp(-0.9, 0.3, after),
    width: 0.95,
  });
}

/**
 * The kicker. Frame origin is the ball spot, facing the posts. Right-footed, soccer style.
 * k: seconds since the accuracy meter locked (null while lining up).
 */
export function kickerPose(fr: Frame, t: number, k: number | null, result: { made: boolean } | null, sinceDecide: number | null): Pose {
  const A = CONFIG.kickerAnim;
  const start = { u: -4.4, v: -6.2 };
  const breathe = Math.sin(t * 2) * 0.03;

  if (k === null) {
    // Lined up, arms loose, eyes on the spot.
    return build(fr, {
      pelvisU: start.u,
      pelvisV: start.v,
      pelvisZ: 3.05 + breathe,
      leanV: 0.25,
      torso: 1.95,
      lFoot: [start.u - 0.45, start.v + 0.1, 0],
      rFoot: [start.u + 0.45, start.v - 0.55, 0],
      lHand: [start.u - 1.15, start.v + 0.25, 1.35],
      rHand: [start.u + 1.15, start.v + 0.1, 1.35],
      kneeBendL: 0.25,
      kneeBendR: 0.25,
      width: 0.92,
    });
  }

  const plant = { u: -1.15, v: -0.35 };
  const contactPelvis = { u: -0.85, v: -1.15 };
  // Pelvis path
  let pu: number;
  let pv: number;
  let pz = 3.0;
  if (k < A.contactS) {
    const s = ease(clamp01(k / A.contactS));
    pu = lerp(start.u, contactPelvis.u, s);
    pv = lerp(start.v, contactPelvis.v, s);
    // Bob with each step
    if (k < A.stepsEndS) pz += Math.abs(Math.sin((k / A.stepsEndS) * Math.PI * 2)) * 0.18 - 0.08;
    else pz -= 0.12 * clamp01((k - A.stepsEndS) / (A.contactS - A.stepsEndS));
  } else {
    const s = ease(clamp01((k - A.contactS) / (A.settleS - A.contactS)));
    pu = lerp(contactPelvis.u, -0.35, s);
    pv = lerp(contactPelvis.v, 1.4, s);
    pz += Math.sin(clamp01((k - A.contactS) / (A.settleS - A.contactS)) * Math.PI) * 0.45 - 0.12 * (1 - s);
  }

  // Feet: right, left, right, then plant left.
  const stepEnds = [0.25, 0.5, 0.75, 1].map((f) => f * A.stepsEndS);
  const lift = (a: number, b: number) => (k > a && k < b ? Math.sin(((k - a) / (b - a)) * Math.PI) * 0.55 : 0);
  const mv = (a: number, b: number) => ease(clamp01((k - a) / (b - a)));
  const L0 = { u: start.u - 0.45, v: start.v + 0.1 };
  const R0 = { u: start.u + 0.45, v: start.v - 0.55 };
  const R1 = { u: -2.9, v: -4.2 };
  const L1 = { u: -2.4, v: -2.6 };
  const R2 = { u: -1.5, v: -2.1 };
  let rU = lerp(lerp(R0.u, R1.u, mv(0, stepEnds[0])), R2.u, mv(stepEnds[1], stepEnds[2]));
  let rV = lerp(lerp(R0.v, R1.v, mv(0, stepEnds[0])), R2.v, mv(stepEnds[1], stepEnds[2]));
  let rZ = lift(0, stepEnds[0]) + lift(stepEnds[1], stepEnds[2]);
  if (mv(0, stepEnds[0]) >= 1 && k < stepEnds[1]) {
    rU = R1.u;
    rV = R1.v;
  }
  const lU = lerp(lerp(L0.u, L1.u, mv(stepEnds[0], stepEnds[1])), plant.u, mv(stepEnds[2], stepEnds[3]));
  const lV = lerp(lerp(L0.v, L1.v, mv(stepEnds[0], stepEnds[1])), plant.v, mv(stepEnds[2], stepEnds[3]));
  const lZ = lift(stepEnds[0], stepEnds[1]) + lift(stepEnds[2], stepEnds[3]);

  // Kicking leg swing: back, through the ball, up high, then down.
  let kneeR = 0.4;
  if (k >= A.stepsEndS) {
    const back = { u: -1.25, v: -2.9, z: 2.0 };
    const contact = { u: -0.05, v: -0.12, z: 0.35 };
    const high = { u: 0.35, v: 2.1, z: 4.7 };
    const down = { u: -0.05, v: 1.6, z: 0 };
    const backT = A.stepsEndS + (A.contactS - A.stepsEndS) * 0.4;
    let p: { u: number; v: number; z: number };
    if (k < backT) {
      const s = ease(clamp01((k - A.stepsEndS) / (backT - A.stepsEndS)));
      p = { u: lerp(R2.u, back.u, s), v: lerp(R2.v, back.v, s), z: lerp(0, back.z, s) };
      kneeR = lerp(0.4, -1.1, s); // heel up behind
    } else if (k < A.contactS) {
      const s = clamp01((k - backT) / (A.contactS - backT));
      const e = s * s;
      p = { u: lerp(back.u, contact.u, e), v: lerp(back.v, contact.v, e), z: lerp(back.z, contact.z, e) - Math.sin(s * Math.PI) * 0.9 };
      kneeR = lerp(-1.1, 0.9, e);
    } else if (k < A.followS) {
      const s = 1 - (1 - clamp01((k - A.contactS) / (A.followS - A.contactS))) ** 2;
      p = { u: lerp(contact.u, high.u, s), v: lerp(contact.v, high.v, s), z: lerp(contact.z, high.z, s) };
      kneeR = lerp(0.9, 0.1, s);
    } else {
      const s = ease(clamp01((k - A.followS) / (A.settleS - A.followS)));
      p = { u: lerp(high.u, down.u, s), v: lerp(high.v, down.v, s), z: lerp(high.z, down.z, s) };
      kneeR = lerp(0.1, 0.3, s);
    }
    rU = p.u;
    rV = p.v;
    rZ = p.z;
  }

  // Arms: left out for balance through the swing; then the reaction.
  const swing = clamp01((k - A.stepsEndS) / 0.15) * (1 - clamp01((k - A.settleS) / 0.3));
  let lHand: [number, number, number] = [lerp(pu - 1.1, pu - 2.4, swing), pv + lerp(0.2, 0.4, swing), lerp(1.4, 4.4, swing)];
  let rHand: [number, number, number] = [lerp(pu + 1.1, pu + 1.6, swing), pv + lerp(0.1, -1.0, swing), lerp(1.4, 3.0, swing)];
  let leanV = k < A.contactS ? lerp(0.35, -0.35, clamp01((k - A.stepsEndS) / (A.contactS - A.stepsEndS))) : lerp(-0.35, 0.2, clamp01((k - A.contactS) / 0.6));

  if (result && sinceDecide !== null && sinceDecide > 0) {
    const r = ease(clamp01(sinceDecide / 0.35));
    if (result.made) {
      const pump = Math.abs(Math.sin(sinceDecide * 7)) * 0.5;
      lHand = [lerp(lHand[0], pu - 0.9, r), lerp(lHand[1], pv + 0.2, r), lerp(lHand[2], 7.4 + pump, r)];
      rHand = [lerp(rHand[0], pu + 0.9, r), lerp(rHand[1], pv + 0.2, r), lerp(rHand[2], 7.4 + pump, r)];
      pz += Math.max(0, Math.sin(sinceDecide * 7)) * 0.25 * r;
    } else {
      // Hands to the helmet.
      lHand = [lerp(lHand[0], pu - 0.55, r), lerp(lHand[1], pv + 0.1, r), lerp(lHand[2], pz + 2.6, r)];
      rHand = [lerp(rHand[0], pu + 0.55, r), lerp(rHand[1], pv + 0.1, r), lerp(rHand[2], pz + 2.6, r)];
      leanV = lerp(leanV, 0.45, r);
    }
  }

  return build(fr, {
    pelvisU: pu,
    pelvisV: pv,
    pelvisZ: pz,
    leanV,
    torso: 1.95,
    lFoot: [lU, lV, lZ],
    rFoot: [rU, rV, rZ],
    lHand,
    rHand,
    kneeBendL: 0.4,
    kneeBendR: kneeR,
    width: 0.92,
  });
}

// ---------------------------------------------------------------------------
// Drawing

function limb(ctx: CanvasRenderingContext2D, cam: Camera, a: Vec3, b: Vec3, widthFt: number, color: string) {
  const pa = cam.project(a);
  const pb = cam.project(b);
  if (!pa || !pb) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.2, widthFt * cam.scale((pa.depth + pb.depth) / 2));
  ctx.beginPath();
  ctx.moveTo(pa.sx, pa.sy);
  ctx.lineTo(pb.sx, pb.sy);
  ctx.stroke();
}

function shadeHex(hex: string, amt: number): string {
  const h = hex.replace('#', '');
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  const f = (v: number) => Math.round(amt < 0 ? v * (1 + amt) : v + (255 - v) * amt);
  return `rgb(${f(c[0])},${f(c[1])},${f(c[2])})`;
}

export function figureDepth(cam: Camera, fig: Figure): number {
  const p = fig.pose;
  return cam.toCam(lerp3(p.lHip, p.rHip, 0.5)).y;
}

export function drawFigure(ctx: CanvasRenderingContext2D, cam: Camera, fig: Figure) {
  const { pose: p, kit } = fig;
  const pelvis = lerp3(p.lHip, p.rHip, 0.5);
  const pc = cam.project(pelvis);
  if (!pc) return;
  const s = cam.scale(pc.depth);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Ground shadow
  const g = cam.project({ x: pelvis.x, y: pelvis.y, z: 0 });
  if (g) {
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.beginPath();
    ctx.ellipse(g.sx, g.sy, Math.max(2, 1.5 * fig.bulk * s), Math.max(1, 0.4 * s), 0, 0, Math.PI * 2);
    ctx.fill();
  }

  const pantsDark = shadeHex(kit.pants, -0.28);
  const socks = kit.socks;
  const legs: [Vec3, Vec3, Vec3][] = [
    [p.lHip, p.lKnee, p.lFoot],
    [p.rHip, p.rKnee, p.rFoot],
  ];
  // Far leg first
  legs.sort((a, b) => cam.toCam(b[2]).y - cam.toCam(a[2]).y);
  for (const [hip, kn, ft] of legs) {
    limb(ctx, cam, hip, kn, 0.62 * fig.bulk, pantsDark);
    limb(ctx, cam, hip, kn, 0.5 * fig.bulk, kit.pants);
    const shinMid = lerp3(kn, ft, 0.35);
    limb(ctx, cam, kn, shinMid, 0.46 * fig.bulk, kit.pants);
    limb(ctx, cam, shinMid, ft, 0.4 * fig.bulk, socks);
    const pf = cam.project(ft);
    if (pf) {
      const fs = cam.scale(pf.depth);
      ctx.fillStyle = '#0b0b0d';
      ctx.beginPath();
      ctx.ellipse(pf.sx, pf.sy, Math.max(1.2, 0.32 * fs), Math.max(1, 0.2 * fs), 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Arms behind the torso when facing away
  const arms: [Vec3, Vec3][] = [
    [p.lSh, p.lHand],
    [p.rSh, p.rHand],
  ];
  const drawArms = () => {
    for (const [sh, hand] of arms) {
      const elbow = lerp3(sh, hand, 0.5);
      limb(ctx, cam, sh, elbow, 0.46 * fig.bulk, shadeHex(kit.jersey, -0.15));
      limb(ctx, cam, elbow, hand, 0.32 * fig.bulk, '#3a2a22');
      const ph = cam.project(hand);
      if (ph) {
        ctx.fillStyle = '#e8e6df';
        ctx.beginPath();
        ctx.arc(ph.sx, ph.sy, Math.max(1, 0.2 * cam.scale(ph.depth)), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };

  // Torso: shoulder pads wider than the waist.
  const torsoPts = [p.lSh, p.rSh, p.rHip, p.lHip].map((q) => cam.project(q));
  if (torsoPts.every((q): q is ScreenPt => q !== null)) {
    const [ls, rs, rh, lh] = torsoPts as ScreenPt[];
    const padOut = 0.28 * s * fig.bulk;
    const grad = ctx.createLinearGradient(0, Math.min(ls.sy, rs.sy), 0, Math.max(lh.sy, rh.sy));
    grad.addColorStop(0, shadeHex(kit.jersey, 0.12));
    grad.addColorStop(1, shadeHex(kit.jersey, -0.35));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(ls.sx - padOut, ls.sy + padOut * 0.3);
    ctx.quadraticCurveTo((ls.sx + rs.sx) / 2, Math.min(ls.sy, rs.sy) - padOut * 1.1, rs.sx + padOut, rs.sy + padOut * 0.3);
    ctx.lineTo(rh.sx + padOut * 0.15, rh.sy);
    ctx.lineTo(lh.sx - padOut * 0.15, lh.sy);
    ctx.closePath();
    ctx.fill();
    // Rim light from the stadium lights
    ctx.strokeStyle = 'rgba(255,248,225,0.28)';
    ctx.lineWidth = Math.max(1, 0.08 * s);
    ctx.beginPath();
    ctx.moveTo(ls.sx - padOut, ls.sy + padOut * 0.3);
    ctx.quadraticCurveTo((ls.sx + rs.sx) / 2, Math.min(ls.sy, rs.sy) - padOut * 1.1, rs.sx + padOut, rs.sy + padOut * 0.3);
    ctx.stroke();
    // Sleeve stripes
    ctx.fillStyle = kit.trim;
    const stripeW = Math.max(1, 0.12 * s);
    ctx.fillRect(ls.sx - padOut, ls.sy + padOut * 0.55, padOut * 0.7, stripeW);
    ctx.fillRect(rs.sx + padOut * 0.3, rs.sy + padOut * 0.55, padOut * 0.7, stripeW);

    // Nameplate and number
    const width = Math.hypot(rs.sx - ls.sx, rs.sy - ls.sy);
    const cx = (ls.sx + rs.sx + lh.sx + rh.sx) / 4;
    const top = (ls.sy + rs.sy) / 2;
    const bottom = (lh.sy + rh.sy) / 2;
    const ht = bottom - top;
    if (width > 9 && ht > 6) {
      ctx.fillStyle = kit.trim;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      let numY = top + ht * 0.45;
      if (fig.name && fig.facing === 'away' && width > 34) {
        ctx.font = `600 ${Math.max(6, ht * 0.15)}px Oswald, Impact, sans-serif`;
        ctx.fillText(fig.name.toUpperCase(), cx, top + ht * 0.17);
        numY = top + ht * 0.55;
      }
      ctx.font = `700 ${Math.max(6, ht * 0.5)}px Oswald, Impact, sans-serif`;
      ctx.lineWidth = Math.max(1, ht * 0.03);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.strokeText(fig.number, cx, numY);
      ctx.fillText(fig.number, cx, numY);
    }
  }

  // Facing away: arms after the torso only if hands are out to the side/up; facing toward: in front.
  drawArms();

  // Helmet
  const ph = cam.project(p.head);
  if (ph) {
    const hs = cam.scale(ph.depth);
    const r = Math.max(1.6, 0.47 * hs);
    const hg = ctx.createRadialGradient(ph.sx - r * 0.35, ph.sy - r * 0.4, r * 0.1, ph.sx, ph.sy, r);
    hg.addColorStop(0, shadeHex(kit.helmet, 0.35));
    hg.addColorStop(1, shadeHex(kit.helmet, -0.3));
    ctx.fillStyle = hg;
    ctx.beginPath();
    ctx.ellipse(ph.sx, ph.sy, r, r * 1.05, 0, 0, Math.PI * 2);
    ctx.fill();
    if (r > 3) {
      // Centre stripe
      ctx.strokeStyle = kit.trim;
      ctx.lineWidth = Math.max(1, r * 0.16);
      ctx.beginPath();
      ctx.moveTo(ph.sx, ph.sy - r * 1.02);
      ctx.lineTo(ph.sx, ph.sy + (fig.facing === 'away' ? r * 0.9 : -r * 0.2));
      ctx.stroke();
      if (fig.facing === 'toward') {
        // Facemask
        ctx.strokeStyle = 'rgba(200,200,205,0.85)';
        ctx.lineWidth = Math.max(1, r * 0.1);
        ctx.beginPath();
        ctx.moveTo(ph.sx - r * 0.65, ph.sy + r * 0.15);
        ctx.lineTo(ph.sx + r * 0.65, ph.sy + r * 0.15);
        ctx.moveTo(ph.sx - r * 0.55, ph.sy + r * 0.5);
        ctx.lineTo(ph.sx + r * 0.55, ph.sy + r * 0.5);
        ctx.moveTo(ph.sx, ph.sy + r * 0.1);
        ctx.lineTo(ph.sx, ph.sy + r * 0.8);
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}
