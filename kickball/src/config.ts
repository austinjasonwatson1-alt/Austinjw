// Every tunable number in the game lives here.
// Ratings are on a 1–100 scale. Distances are in feet, times in milliseconds
// unless the name says otherwise, speeds in feet per second.

export const CONFIG = {
  // ---------------------------------------------------------------- field
  field: {
    baseDistance: 60, // home to first, first to second, etc.
    pitchingDistance: 42, // mound to home
    fenceDistance: 200, // outfield fence, straight away
    fenceHeight: 6, // a ball crossing the fence lower than this bounces off it
    foulLineDeg: 45, // fair territory is -45..+45 degrees from straight away
    catcherDepth: 8, // a pitch is called ball or strike once it rolls this far past home
    // Default fielding spots in feet (x: + toward right field, y: + toward center field)
    positions: {
      P: { x: 0, y: 44 },
      C: { x: 1, y: -8 },
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
    renderScale: 2, // draw at 2x for sharp Retina screens; layout below is in 1x units
    textureScale: 4, // detail of the painted field and figures (covers renderScale x camera zoom)
    width: 1000,
    height: 720,
    homeX: 500,
    homeY: 572,
    pxPerFoot: 2.35,
    ballRadiusPx: 5,
    ballHeightScale: 0.035, // ball grows by this fraction per foot of height
    ballHeightLiftPx: 0.9, // ball drawn this many px above its shadow per foot
  },

  // ---------------------------------------------------------------- camera
  camera: {
    homeZoom: 1.8, // close-up framing on the infield for each pitch
    homeCenter: { x: 0, y: 37 }, // feet; the spot the at-bat camera centers on
    flightZoomMin: 1.15, // how far it pulls back for a long kick
    flightZoomFarFt: 170, // ball distance at which it reaches flightZoomMin
    flightLead: 0.25, // seconds the camera looks ahead of the ball
    followRate: 5, // higher = snappier camera moves
    zoomRate: 3,
  },

  // ---------------------------------------------------------------- kicker run-up
  runUp: {
    start: { x: -9, y: -6 }, // where the kicker waits, in feet
    plant: { x: -1.4, y: -1.8 }, // where the kicker arrives as the ball crosses the plate
    startDelay: 0.25, // fraction of the pitch before the kicker starts running
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
    // Where you can aim a pitch (ft from the middle of the plate)
    locations: [
      { name: 'Left edge', x: -1.0 },
      { name: 'Middle', x: 0 },
      { name: 'Right edge', x: 1.0 },
    ],
    scatterWorst: 1.6, // how far a pitch strays from the aim (ft) at Arm 1 ...
    scatterBest: 0.55, // ... and at Arm 100
    edgeQualityMult: 0.92, // kicks off the edge of the plate come off a little weaker
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
      speedMin: 62, // exit speed at Power 1
      speedMax: 88, // exit speed at Power 100
      launchDeg: 40,
      launchJitterDeg: 5,
      mishitLaunchRise: 16, // a poorly struck power kick pops up higher and shorter
    },
    liner: {
      speedMin: 58,
      speedMax: 84,
      launchDeg: 13,
      launchJitterDeg: 4,
      mishitLaunchDrop: 9, // a poorly struck liner turns into a grounder
    },
    bunt: {
      speedMin: 17,
      speedMax: 25,
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

  // ---------------------------------------------------------------- fielding and running
  fielding: {
    // Until Milestone 4 brings real opponents, every fielder uses these ratings.
    defenseRatings: { speed: 50, glove: 62, arm: 58 },
    runSpeedMin: 15, // ft/s at Speed 1 (runners and fielders)
    runSpeedMax: 24, // ft/s at Speed 100
    fielderSpeedMult: 0.78,
    reactionTime: 0.65, // seconds before fielders break on a kicked ball
    reachFt: 2.6, // how far a fielder can reach for the ball
    catchHeight: 7, // ball must be below this to be caught or fielded
    catchMin: 0.62, // clean catch chance on a fly at Glove 1 ...
    catchMax: 0.93, // ... and at Glove 100
    runningCatchMult: 0.85, // catch chance when the fielder arrives at the last moment
    hardLinerSpeed: 45, // balls in the air faster than this are hard to snag ...
    hardLinerMult: 0.55, // ... so the catch chance is multiplied by this
    pickupMin: 0.84, // clean pickup of a ground ball
    pickupMax: 0.98,
    hardGrounderSpeed: 38, // ground balls faster than this are harder to pick up
    hardGrounderMult: 0.88,
    receiveMin: 0.9, // catching a throw
    receiveMax: 0.99,
    receiveRadius: 4.5, // a throw is catchable if it arrives this close to a fielder
    throwSpeedMin: 36, // ft/s at Arm 1
    throwSpeedMax: 70, // ft/s at Arm 100
    releaseDelay: 0.45, // seconds to set and throw
    outMargin: 0.15, // the ball must beat the runner by this many seconds to try for the out
    pegRange: 38, // furthest a fielder will try to peg a runner
    pegHitMin: 0.35, // peg accuracy at Arm 1, point blank
    pegHitMax: 0.82, // peg accuracy at Arm 100, point blank
    pegMinChance: 0.45, // fielders only peg when the chance is at least this
    pegHitRadius: 3,
    tagRadius: 2.5,
    baseRadius: 2.5, // a fielder this close to a base is touching it
    errorStun: 0.7, // seconds a fielder needs to recover after a bobble
    looseKeep: 0.3, // share of the ball's speed kept when it pops loose
    decisionInterval: 0.15,
    settleTime: 0.8, // play ends once everyone is safe on a base this long
    maxPlayTime: 30,
    batterStartDelay: 0.25, // batter-runner leaves home this long after the kick
  },

  // ---------------------------------------------------------------- computer players
  ai: {
    swingAtStrike: 0.88,
    swingAtBall: 0.22, // chases a ball it can still reach
    timingSdWorst: 75, // timing miss (ms, standard deviation) at Contact 1 ...
    timingSdBest: 22, // ... and at Contact 100
    trickyPitchSdMult: 1.25, // bouncy and curving pitches throw off the timing
    buntChance: 0.05,
    runAggression: 0.25, // seconds of cushion a runner wants before taking an extra base
    runDecisionInterval: 0.25,
  },

  // ---------------------------------------------------------------- at-bat rules
  rules: {
    innings: 9, // 3, 5 or 7 can be picked on the lineup card
    inningChoices: [3, 5, 7, 9],
    minKickers: 10,
    maxKickers: 12,
    outsPerHalf: 3,
    strikesForOut: 3,
    foulsForOut: 4,
    ballsForWalk: 4,
  },

  // ---------------------------------------------------------------- feel / ui
  ui: {
    showTimingDebug: true, // shows "18 ms late" after each kick, for tuning
    resultHold: 1100, // how long a ball/strike/foul call stays up before the next pitch
    flightPlaybackSpeed: 1.3, // 1 = real time; higher plays ball flight faster
    shakePowerKick: 0.004, // camera shake on a well-struck power kick
    shakeHomeRun: 0.008,
    perfectTimingMs: 12, // within this of dead center shows PERFECT!
    nextKickerDelay: 2600, // pause after a play before the next kicker steps up (Space skips)
    playZoomNear: 1.55, // camera zoom during a live play with the ball in the infield
    playZoomFar: 1.12, // ... and with the ball deep in the outfield
  },
};

export type PitchType = keyof typeof CONFIG.pitch.types;
