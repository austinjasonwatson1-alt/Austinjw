import { CONFIG } from '../config';

export interface FlightPoint {
  t: number;
  x: number;
  y: number;
  z: number;
}

export interface Flight {
  points: FlightPoint[];
  duration: number;
  landing: { x: number; y: number; distance: number; t: number }; // first time it touches down
  rest: { x: number; y: number; distance: number };
  maxHeight: number;
  fair: boolean;
  overFence: boolean;
}

const B = CONFIG.ball;

export function isFairAngle(sprayDeg: number): boolean {
  return Math.abs(sprayDeg) <= CONFIG.field.foulLineDeg;
}

/** Simulates the kicked ball from home plate until it stops. */
export function simulateFlight(sprayDeg: number, launchDeg: number, exitSpeed: number): Flight {
  const dir = (sprayDeg * Math.PI) / 180;
  const up = (launchDeg * Math.PI) / 180;
  const horiz = exitSpeed * Math.cos(up);
  let vx = horiz * Math.sin(dir);
  let vy = horiz * Math.cos(dir);
  let vz = exitSpeed * Math.sin(up);
  let x = 0,
    y = 0,
    z = 0.5,
    t = 0;
  const dt = B.simStep;
  const fair = isFairAngle(sprayDeg);
  const fence = CONFIG.field.fenceDistance;
  const points: FlightPoint[] = [{ t, x, y, z }];
  let landing: Flight['landing'] | null = null;
  let maxHeight = z;
  let overFence = false;
  let rolling = false;
  let prevDist = 0;

  while (t < 20) {
    t += dt;
    if (!rolling) {
      const k = 1 - B.drag * dt;
      vx *= k;
      vy *= k;
      vz = vz * k - B.gravity * dt;
      x += vx * dt;
      y += vy * dt;
      z += vz * dt;
      maxHeight = Math.max(maxHeight, z);
      if (z <= 0) {
        z = 0;
        if (!landing) {
          const distance = Math.hypot(x, y);
          landing = { x, y, distance, t };
          if (fair && distance >= fence) {
            overFence = true;
            points.push({ t, x, y, z });
            break;
          }
        }
        if (Math.abs(vz) > 4) {
          vz = -vz * B.bounceKeep;
          vx *= B.bounceFriction;
          vy *= B.bounceFriction;
        } else {
          vz = 0;
          rolling = true;
        }
      }
    } else {
      const speed = Math.hypot(vx, vy);
      const next = speed - B.rollFriction * dt;
      if (next <= B.stopSpeed) {
        points.push({ t, x, y, z: 0 });
        break;
      }
      vx *= next / speed;
      vy *= next / speed;
      x += vx * dt;
      y += vy * dt;
    }
    // A fair ball that reaches the fence low (on the ground or below the top) stops there.
    const d = Math.hypot(x, y);
    const crossing = d >= fence && prevDist < fence;
    prevDist = d;
    if (fair && crossing && z < CONFIG.field.fenceHeight) {
      x *= fence / d;
      y *= fence / d;
      points.push({ t, x, y, z });
      if (!landing) landing = { x, y, distance: fence, t };
      break;
    }
    points.push({ t, x, y, z });
  }

  const last = points[points.length - 1];
  return {
    points,
    duration: last.t,
    landing: landing ?? { x: last.x, y: last.y, distance: Math.hypot(last.x, last.y), t: last.t },
    rest: { x: last.x, y: last.y, distance: Math.hypot(last.x, last.y) },
    maxHeight,
    fair,
    overFence,
  };
}

/** Position along a simulated flight at time t (seconds). */
export function flightPositionAt(f: Flight, t: number): FlightPoint {
  if (t >= f.duration) return f.points[f.points.length - 1];
  const i = Math.min(f.points.length - 1, Math.max(0, Math.floor(t / B.simStep)));
  return f.points[i];
}

/** Path of a ball rolling along the ground from (x, y) at velocity (vx, vy), until it stops. */
export function rollPath(x: number, y: number, vx: number, vy: number, t0: number): FlightPoint[] {
  const pts: FlightPoint[] = [{ t: t0, x, y, z: 0 }];
  let t = t0;
  const dt = B.simStep * 2;
  let speed = Math.hypot(vx, vy);
  const fence = CONFIG.field.fenceDistance;
  while (speed > B.stopSpeed && t < t0 + 15) {
    t += dt;
    const next = speed - B.rollFriction * dt;
    vx *= next / speed;
    vy *= next / speed;
    speed = next;
    x += vx * dt;
    y += vy * dt;
    const d = Math.hypot(x, y);
    if (d > fence) {
      x *= fence / d;
      y *= fence / d;
      pts.push({ t, x, y, z: 0 });
      break;
    }
    pts.push({ t, x, y, z: 0 });
  }
  return pts;
}
