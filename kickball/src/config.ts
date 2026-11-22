// Every tunable number in the game lives here.
// Ratings are on a 1–100 scale. Distances are in feet, times in milliseconds
// unless the name says otherwise, speeds in feet per second.

export const CONFIG = {
  // ---------------------------------------------------------------- field
  field: {
    baseDistance: 60, // home to first, first to second, etc.
    pitchingDistance: 42, // mound to home
    fenceDistance: 200, // outfield fence, straight away
    foulLineDeg: 45, // fair territory is -45..+45 degrees from straight away
    catcherDepth: 8, // catcher stands this far behind home
    // Default fielding spots in feet (x: + toward right field, y: + toward center field)
    positions: {
      P: { x: 0, y: 44 },
      C: { x: 0, y: -9 },
      '1B': { x: 50, y: 56 },
      '2B': { x: 24, y: 90 },
      SS: { x: -24, y: 90 },
      '3B': { x: -50, y: 56 },
      LF: { x: -88, y: 132 },
      CF: { x: -32, y: 160 },
      RC: { x: 32, y: 160 },
      RF: { x: 88, y: 132 },
    } as Record<string, { x: number; y: number }>,
  },

  // ---------------------------------------------------------------- screen
  screen: {
    width: 1000,
    height: 720,
    homeX: 500,
    homeY: 572,
    pxPerFoot: 2.35,
    ballRadiusPx: 5,
    ballHeightScale: 0.035, // ball grows by this fraction per foot of height
    ballHeightLiftPx: 0.9, // ball drawn this many px above its shadow per foot
  },

  // ---------------------------------------------------------------- pitching
  pitch: {
    delayBeforePitch: 1100, // pause between pitches
    windupTime: 450, // pitcher animation before the ball leaves
    strikeChance: 0.7, // chance the pitcher hits the plate
    plateHalfWidth: 1.5, // feet either side of the middle that count as a strike
    missMin: 2.0, // a missed pitch lands this far off the middle ...
    missMax: 4.5, // ... up to this far
    reach: 3.5, // kicker can reach a ball this far off the middle
    offPlatePenalty: 0.85, // contact quality multiplier for kicking a ball off the plate
    types: {
      fast: { weight: 3, speed: 42, bounceHeight: 0, bounces: 0, curve: 0, timingMult: 1.0 },
      slow: { weight: 2, speed: 23, bounceHeight: 0, bounces: 0, curve: 0, timingMult: 1.0 },
      bouncy: { weight: 2, speed: 30, bounceHeight: 1.6, bounces: 3, curve: 0, timingMult: 0.85 },
      curving: { weight: 2, speed: 32, bounceHeight: 0, bounces: 0, curve: 5, timingMult: 0.9 },
    },
  },

  // ---------------------------------------------------------------- kicking
  kick: {
    // Timing. "delta" is release time minus the moment the ball crosses the plate.
    cleanWindowMin: 32, // half-width of the clean window at Contact 1
    cleanWindowMax: 80, // half-width of the clean window at Contact 100
    whiffBeyondClean: 125, // past the clean window by this much = swing and miss
    cleanDriftDeg: 10, // inside the clean window, timing nudges direction up to this much
    mishitDriftDegPerMs: 0.42, // outside the clean window, direction drifts this fast
    sprayJitterDeg: 3, // random spread on every kick
    // Quality (multiplies exit speed): perfect at center, falls off toward the edges
    qualityPerfectFrac: 0.5, // inside this fraction of the clean window = perfect
    qualityAtCleanEdge: 0.9,
    qualityAtWhiff: 0.62,

    // Aim zones, left to right (degrees from straight away; negative = left field)
    aimZones: [
      { name: 'Pull', deg: -30 },
      { name: 'Left-Center', deg: -15 },
      { name: 'Center', deg: 0 },
      { name: 'Right-Center', deg: 15 },
      { name: 'Opposite Field', deg: 30 },
    ],
    defaultAimIndex: 2,

    // Hold Space to wind up. Release = contact. Holding past this = power kick.
    powerHoldThreshold: 260,
    powerFullCharge: 650, // holding this long gives the full power bonus
    powerChargeMinFrac: 0.88, // power kick distance at the threshold, vs full charge

    power: {
      speedMin: 56, // exit speed at Power 1
      speedMax: 84, // exit speed at Power 100
      launchDeg: 40,
      launchJitterDeg: 5,
      mishitLaunchRise: 16, // a poorly struck power kick pops up higher and shorter
    },
    liner: {
      speedMin: 52,
      speedMax: 80,
      launchDeg: 13,
      launchJitterDeg: 4,
      mishitLaunchDrop: 9, // a poorly struck liner turns into a grounder
    },
    bunt: {
      speedMin: 24,
      speedMax: 32,
      launchDeg: 2,
      launchJitterDeg: 2,
      windowMult: 1.6, // bunting is easier to time
      maxSprayDeg: 35, // bunts never go wider than this before mistiming
    },
  },

  // ---------------------------------------------------------------- ball physics
  ball: {
    gravity: 32,
    drag: 0.07, // fraction of speed lost per second in the air
    bounceKeep: 0.32, // vertical speed kept on each bounce
    bounceFriction: 0.72, // horizontal speed kept on each bounce
    rollFriction: 15, // ft/s lost per second while rolling
    stopSpeed: 1.5,
    simStep: 1 / 120, // seconds
  },

  // ---------------------------------------------------------------- at-bat rules
  rules: {
    strikesForOut: 3,
    foulsForOut: 4,
    ballsForWalk: 4,
  },

  // ---------------------------------------------------------------- feel / ui
  ui: {
    showTimingDebug: true, // shows "18 ms late" after each kick, for tuning
    resultHold: 1100, // how long a ball/strike/foul call stays up before the next pitch
    flightPlaybackSpeed: 1.3, // 1 = real time; higher plays ball flight faster
  },
};

export type PitchType = keyof typeof CONFIG.pitch.types;
