// Every tunable number in the game lives here.
// Ratings-driven values use { r40, r99 }: the value at rating 40 and at rating 99,
// interpolated linearly (and extrapolated below 40, clamped to the 1–99 scale).

export type LevelKey = 'hs' | 'college' | 'nfl';

export interface LevelRules {
  label: string;
  hashWidthFt: number; // distance between the hash marks
  uprightWidthFt: number; // inside width between the uprights
  uprightHeightFt: number; // how far the uprights rise above the crossbar (visual only; scoring uses extended lines)
  xpDistanceYd: number; // kick distance of an extra point
  strongLegYd: number; // reference only: what counts as a strong leg at this level
}

export interface RatingSpec {
  r40: number;
  r99: number;
}

export const CONFIG = {
  levels: {
    hs: {
      label: 'High School',
      hashWidthFt: 53 + 4 / 12, // NFHS: hashes split the field into thirds
      uprightWidthFt: 23 + 4 / 12, // NFHS
      uprightHeightFt: 20,
      xpDistanceYd: 20, // snap from the 3-yard line
      strongLegYd: 45,
    },
    college: {
      label: 'College',
      hashWidthFt: 40, // NCAA since 1993
      uprightWidthFt: 18.5,
      uprightHeightFt: 30,
      xpDistanceYd: 20, // snap from the 3-yard line
      strongLegYd: 55,
    },
    nfl: {
      label: 'NFL',
      hashWidthFt: 18.5, // same as the uprights
      uprightWidthFt: 18.5,
      uprightHeightFt: 35,
      xpDistanceYd: 33, // snap from the 15-yard line since 2015
      strongLegYd: 60,
    },
  } satisfies Record<LevelKey, LevelRules>,

  field: {
    crossbarHeightFt: 10,
    halfWidthFt: 80, // 160 ft wide field
    endZoneDepthFt: 30,
    snapDepthYd: 7, // holder spot behind the line of scrimmage (FG distance = LOS + 10 + 7)
  },

  physics: {
    gravityFtS2: 32.174,
    dragK: 0.0016, // quadratic drag coefficient, per foot
    launchAngleDeg: 36,
    dtS: 1 / 240,
    maxFlightS: 7,
    ballContactRadiusFt: 0.7, // within this of an upright/crossbar the ball hits it
    groundRestitution: 0.35,
    groundFriction: 0.55,
    maxGroundBounces: 3,
  },

  wind: {
    effectScale: 1.0, // global multiplier on how hard wind pushes the ball
    gustSigma: 0.08, // hidden kick-to-kick variation in actual wind speed (fraction)
    dirJitterDeg: 5, // hidden variation in wind direction
  },

  strike: {
    // Accuracy meter stop position e runs from -1 (far left) to +1 (far right).
    insideMaxErrDeg: 0.9, // inside the sweet spot, error grows to this at the sweet spot's edge
    outsideErrDegPerUnit: 14, // extra launch-angle error per unit of meter beyond the sweet spot
    hookAccelPerUnit: 16, // sideways curve (ft/s^2) per unit beyond the sweet spot
  },

  meters: {
    aimRangeFt: 30, // aim marker can move this far either side of the goalpost centre
    aimKeySpeedFtS: 14,
    powerFillS: 1.0, // seconds from empty to the top (100%)
    powerMax: 1.15, // meter runs past the top into the overdrive zone, then falls back
    powerMinSpeedFrac: 0.45, // launch speed at 0% power, as a fraction of full power
    overdriveSpeedGain: 0.25, // launch speed gained per unit of power past the top
    overdriveSweetSpotShrink: 0.5, // sweet spot shrinks by this fraction at maximum overdrive
    accuracySweepS: 0.7, // seconds for the marker to cross the full bar once
    accuracyMaxPasses: 3, // after this many passes the swing goes off at the end of the bar
  },

  ratings: {
    maxRangeYd: { r40: 40, r99: 66 }, // calm-day full-power range (Power)
    sweetSpotHalf: { r40: 0.065, r99: 0.16 }, // half-width of the sweet spot, in meter units (Accuracy)
    windEffect: { r40: 1.0, r99: 0.6 }, // multiplier on wind push (Wind control)
    driftSigmaDeg: { r40: 0.8, r99: 0.12 }, // random drift on a well-struck kick (Consistency)
  } satisfies Record<string, RatingSpec>,

  block: {
    baseChance: 0.006,
    perYardOver40: 0.0006,
  },

  practice: {
    kickerName: 'Austin Watson',
    kicker: { power: 70, accuracy: 70, composure: 70, windControl: 70, consistency: 70 },
    minDistanceYd: 18,
    maxDistanceYd: 70,
    maxWindMph: 30,
    accent: '#f5b82e',
    kickerNumber: '3',
    // Team kits. Players are drawn dark and simple so the posts and ball stay the focus.
    team: { jersey: '#15213f', trim: '#f5b82e', pants: '#cfcabb', socks: '#15213f', helmet: '#15213f' },
    opponent: { jersey: '#5c1222', trim: '#f2f2f2', pants: '#d8d8d8', socks: '#5c1222', helmet: '#5c1222' },
  },

  kickerAnim: {
    // Seconds from locking the accuracy meter. The ball leaves the foot at contactS.
    stepsEndS: 0.52, // approach steps finish, plant foot down
    contactS: 0.74,
    followS: 0.98, // kicking leg at its highest
    settleS: 1.5, // back on both feet
  },

  slowMo: {
    marginFt: 2.5, // kicks passing within this of an upright or the crossbar go to slow motion
    timeScale: 0.22, // playback speed at the slowest
    leadS: 0.5, // flight seconds before the posts that the slowdown begins
    rampS: 0.18,
    holdS: 0.32, // flight seconds after the posts before speeding back up
    closeBackFt: 56, // push-in camera distance in front of the goal plane
    closeFocal: 1.05, // push-in focal length as a fraction of screen span
    letterbox: 0.085, // cinematic bars, fraction of screen height each
  },

  audio: {
    master: 0.8,
    crowdIdle: 0.22, // murmur while you line up
    crowdHush: 0.12, // as you start your approach
    crowdFlight: 0.5, // swell while the ball is in the air
    roar: 1.0,
    groan: 0.75,
  },

  presentation: {
    flightPlaybackSpeed: 1.0,
    cameraBackFt: 36, // camera distance behind the ball on a 20-yard kick
    cameraHeightFt: 9.5,
    focalBase: 0.74, // focal length as a fraction of screen width on a 20-yard kick
    focalPerYard: 0.011, // zoom in for longer kicks (camera pulls back to match)
    focalMax: 1.35,
    shakeOnContactS: 0.18,
    resultDelayS: 0.5, // pause after the ball settles before the next kick can start
  },
};
