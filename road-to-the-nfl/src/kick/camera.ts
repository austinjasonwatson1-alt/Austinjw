import type { Vec3 } from './physics';

export const NEAR = 0.6;

export interface CamPt {
  x: number; // right
  y: number; // depth
  z: number; // up
}

export interface ScreenPt {
  sx: number;
  sy: number;
  depth: number;
}

export class Camera {
  readonly fwd: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;

  constructor(
    readonly pos: Vec3,
    target: Vec3,
    readonly f: number,
    readonly cx: number,
    readonly cy: number,
  ) {
    const dx = target.x - pos.x;
    const dy = target.y - pos.y;
    const dz = target.z - pos.z;
    const l = Math.hypot(dx, dy, dz);
    this.fwd = { x: dx / l, y: dy / l, z: dz / l };
    const rl = Math.hypot(this.fwd.y, this.fwd.x);
    this.right = { x: this.fwd.y / rl, y: -this.fwd.x / rl, z: 0 };
    const r = this.right;
    const f2 = this.fwd;
    this.up = { x: r.y * f2.z - r.z * f2.y, y: r.z * f2.x - r.x * f2.z, z: r.x * f2.y - r.y * f2.x };
  }

  toCam(p: Vec3): CamPt {
    const dx = p.x - this.pos.x;
    const dy = p.y - this.pos.y;
    const dz = p.z - this.pos.z;
    return {
      x: dx * this.right.x + dy * this.right.y + dz * this.right.z,
      y: dx * this.fwd.x + dy * this.fwd.y + dz * this.fwd.z,
      z: dx * this.up.x + dy * this.up.y + dz * this.up.z,
    };
  }

  projCam(c: CamPt): ScreenPt {
    return { sx: this.cx + (this.f * c.x) / c.y, sy: this.cy - (this.f * c.z) / c.y, depth: c.y };
  }

  project(p: Vec3): ScreenPt | null {
    const c = this.toCam(p);
    if (c.y < NEAR) return null;
    return this.projCam(c);
  }

  /** Screen size (px) of a world length at a given depth. */
  scale(depth: number): number {
    return this.f / depth;
  }

  /** Project a world polygon, clipped against the near plane. */
  polygon(pts: Vec3[]): ScreenPt[] {
    const cam = pts.map((p) => this.toCam(p));
    const out: CamPt[] = [];
    for (let i = 0; i < cam.length; i++) {
      const a = cam[i];
      const b = cam[(i + 1) % cam.length];
      const aIn = a.y >= NEAR;
      const bIn = b.y >= NEAR;
      if (aIn) out.push(a);
      if (aIn !== bIn) {
        const t = (NEAR - a.y) / (b.y - a.y);
        out.push({ x: a.x + (b.x - a.x) * t, y: NEAR, z: a.z + (b.z - a.z) * t });
      }
    }
    return out.map((c) => this.projCam(c));
  }
}
