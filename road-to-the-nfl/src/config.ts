// Every tunable number in the game lives here.
// Ratings-driven values use { r40, r99 }: the value at rating 40 and at rating 99,
// interpolated linearly (and extrapolated below 40, clamped to the 1–99 scale).

export type LevelKey = 'hs' | 'college' | 'nfl';
export type Weather = 'clear' | 'rain' | 'snow' | 'cold';

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
    swirl: { gustSigma: 0.3, dirJitterDeg: 40 }, // swirling stadiums: the read can lie
  },

  trajectory: {
    normal: { angleDeg: 36, windMult: 1, blockMult: 1, speedMult: 1 },
    high: { angleDeg: 42, windMult: 1.25, blockMult: 0.3, speedMult: 0.95 }, // hangs in the wind, clears the rush, a little shorter
    low: { angleDeg: 30, windMult: 0.72, blockMult: 2.6, speedMult: 1.04 }, // knifes through the wind, easier to tip
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
    maxRangeYd: { r40: 40, r99: 68 }, // calm-day full-power range (Power); overdrive and a tailwind add more
    sweetSpotHalf: { r40: 0.065, r99: 0.16 }, // half-width of the sweet spot, in meter units (Accuracy)
    windEffect: { r40: 1.0, r99: 0.6 }, // multiplier on wind push (Wind control)
    driftSigmaDeg: { r40: 0.8, r99: 0.12 }, // random drift on a well-struck kick (Consistency)
  } satisfies Record<string, RatingSpec>,

  block: {
    baseChance: 0.006,
    perYardOver40: 0.0006,
    rushMult: 1.5, // at full pressure the edge rush blocks this much more often
  },

  practice: {
    kickerName: 'Austin Watson',
    kicker: { power: 70, accuracy: 70, composure: 70, windControl: 70, consistency: 70 },
    minDistanceYd: 18,
    maxDistanceYd: 75,
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

  weather: {
    // range: fraction of calm-day distance kept (Power reduces the loss); sweet: sweet spot size multiplier
    clear: { label: 'Clear', range: 1, sweet: 1, tempF: [58, 78] },
    rain: { label: 'Rain', range: 0.95, sweet: 0.82, tempF: [45, 65] },
    snow: { label: 'Snow', range: 0.9, sweet: 0.78, tempF: [22, 32] },
    cold: { label: 'Cold', range: 0.94, sweet: 0.92, tempF: [18, 34] },
    powerShield: { r40: 1, r99: 0.45 }, // how much of the weather's distance loss you still feel, by Power
  },

  pressure: {
    speedGain: 0.55, // meters run this much faster at full pressure (before Composure)
    shake: 0.07, // accuracy marker wobble at full pressure, in meter units
    shakePx: 5, // visual meter shake
    composureFactor: { r40: 1, r99: 0.25 }, // how much of the pressure effect you feel, by Composure
    playoffBoost: 0.15,
  },

  icing: {
    chanceWhenAvailable: 0.55, // opponent ices a high-pressure kick when it has a timeout
    minPressure: 0.6,
    waitS: 2.6,
    speedGain: 0.12, // extra meter speed after being iced (before Composure)
  },

  stadium: {
    // Stands grow with the career: bleachers, a college bowl, an NFL stadium.
    hs: { height: 26, depth: 70, crowd: 0.22, sides: 0.35, lights: 2 },
    college: { height: 85, depth: 190, crowd: 0.8, sides: 0.85, lights: 4 },
    nfl: { height: 118, depth: 210, crowd: 1, sides: 1, lights: 4 },
  },

  career: {
    startAge: 16,
    startSkills: { power: 44, accuracy: 42, composure: 40, windControl: 41, consistency: 43 },
    startYear: 2026,
    retireAge: 45, // forced retirement
    agingStartAge: 34, // Power starts to slip
    agingPowerLoss: [2, 4], // per season, from agingStartAge
    agingTouchAge: 37, // Accuracy and Consistency start to slip
    agingTouchLoss: [1, 3],

    skillCost: [
      // cost per level when going FROM a rating below `below`
      { below: 60, cost: 1 },
      { below: 80, cost: 2 },
      { below: 90, cost: 3 },
      { below: 100, cost: 5 },
    ],

    points: {
      // Points can be fractional; the game shows whole points.
      levelMult: { hs: 1, college: 1, nfl: 0.65 }, // NFL seasons are long: each kick is worth less
      fgMade: 0.75,
      fg40: 0.5, // extra for 40-49
      fg50: 1, // extra for 50+
      pressureBonus: 1, // made kick with pressure >= 0.6
      perfectGame: 2, // at least 2 kicks, all made
      gameWinner: 3,
      careerLong: 1,
      drillPerMake: 0.75, // weekly drill, goes into the skill you pick
      campBase: 7, // offseason camp: the biggest single chunk of the year
      campPerMake: 2,
      awards: { allState: 4, allConference: 4, allAmerican: 6, nationalAward: 8, proBowl: 5, allPro: 7, champion: 5 },
    },

    trust: {
      start: { hs: 55, college: 45, nfl: 50 },
      makeBase: 3,
      makePerYdOver40: 0.4,
      missBase: -6,
      missShortExtra: -6, // misses inside 35 hurt more
      xpMiss: -8,
      pressureMult: 1.6, // clutch moments move trust more
      // The coach's kicking range: kicker range (in this weather) times this, by trust 0 → 100
      rangeFrac: { low: 0.8, high: 1.04 },
      desperationBonusYd: 6, // last play of a half/game: will try a longer one
    },

    sim: {
      quarterMin: 12, // minutes per quarter (HS); college/NFL use 15
      quarterMinBig: 15,
      drivesPerTeamApprox: 11,
      driveMinutes: [1.0, 4.8],
      // Drive results for an average offense vs average defense, by level
      hs: { td: 0.33, fgChance: 0.17, turnover: 0.13, safety: 0.006 },
      college: { td: 0.32, fgChance: 0.19, turnover: 0.12, safety: 0.005 },
      nfl: { td: 0.235, fgChance: 0.21, turnover: 0.11, safety: 0.004 },
      strengthEffect: 0.0045, // per point of offense-minus-defense strength
      twoMinuteFgBoost: 0.18, // late-game drives settle for kicks more often
      stallYardline: [3, 55], // where a stalled drive ends (opponent's yard line); 55 = a 72-yard try
      stallShape: 1.5, // higher = long tries rarer
      oppKickerRating: { hs: 45, college: 62, nfl: 78 },
      autoXpRating: true,
    },

    pressure: {
      base: 0.1,
      q4Close: 0.35, // 4th quarter, within 8
      lastTwoMin: 0.25,
      gameWinner: 0.5, // tie or down 1-2, final seconds
      xpCap: 0.35,
    },

    seasons: {
      hs: { games: 10, playoffWins: 6, playoffRounds: 4 },
      college: { games: 12, bowlWins: 6, playoffWins: 10, playoffRounds: 4 },
      nfl: { games: 17, playoffSeeds: 7, byeSeeds: 1, playoffRounds: 4 }, // top 7 in the conference; the 1 seed gets a bye
      // Your team's average strength vs an average opponent of 50 (college: vs same-tier opponents)
      teamEdge: { hs: 7, college: 10, nfl: 2 },
    },

    honors: {
      allState: { pct: 0.8, made: 10, long: 40 },
      allConference: { pct: 0.82, made: 14 },
      allAmerican: { pct: 0.87, made: 18, long: 50 },
      nationalAward: { pct: 0.9, made: 20, long: 52 },
      proBowl: { pct: 0.92, made: 29, long: 50 },
      allPro: { pct: 0.95, made: 32, long: 55 },
    },

    recruiting: {
      // Stars from a 0..100 score: overall, stats and the summer showcase
      starCuts: [35, 50, 62, 74], // >= each cut adds a star above 1 (2 stars minimum)
      showcaseDistances: [30, 35, 40, 45, 50],
    },

    camp: {
      kicks: [30, 38, 44, 48, 52],
      // Rival kicker overall by situation
      rival: { hsSenior: 50, smallSchool: 52, midSchool: 64, majorProgram: 74, nflIncumbent: 80, udfaVet: 74 },
    },

    draft: {
      showcaseDistances: [35, 40, 45, 50, 55, 60],
      draftedScore: 66, // stock needed to be drafted at all
      earlyScore: 80, // stock for round 5 instead of 6-7
    },

    nfl: {
      rookieSalary: [0.88, 1.1], // $M
      udfaSalary: 0.84,
      veteranSalaryPerOvr: 0.09, // $M per overall point above 70 on re-signing
      contractYears: { drafted: 4, udfa: 3, resign: [2, 4] },
      hotSeatPct: 0.75, // over the last 10 FG attempts: a rival comes to camp
      cutPct: 0.65, // worse than this over the last 10 attempts (or trust < cutTrust): cut
      cutTrust: 12,
      tryoutChancePerWeek: 0.3,
      seasonsUnsignedToRetire: 1,
    },

    portal: {
      // Offer tiers open up with your overall and last season's FG%.
      majorOvr: 66,
      majorPct: 0.8,
      midOvr: 56,
      offersMax: 4,
      withdrawTrustLoss: 15, // your coach moved on while you shopped around
      withdrawRivalEdge: 3, // the kicker he brought in is about this much better than you
    },

    hallOfFame: { points: 2300, honors: 8, longFg: 60 },

    records: {
      bonus: { school: 2, program: 3, conference: 4, fbs: 8, nfl: 6 }, // skill points for breaking a record
      // Real NFL record numbers (no names): longest FG, FGs in a game, in a season, in a career,
      // career points, consecutive FGs made.
      nfl: { longest: 66, gameFg: 8, seasonFg: 44, careerFg: 599, careerPts: 2673, streak: 44 },
      // Real FBS marks (no names): longest FG, FGs in a game, in a season, in a career, career kicking points.
      fbs: { longest: 67, gameFg: 7, seasonFg: 31, careerFg: 96, careerPts: 498 },
    },

    celebration: {
      confetti: 220,
      fireworks: 7,
      durationS: 6,
    },
  },

  story: {
    slump: { start: 0.7, decayPerGame: 0.18, composureHit: 18, accuracyHit: 6 },
    coachAsk: { windowYd: 7, vouchMake: 8, vouchMiss: -12, decline: -1 },
    hurry: { chance: 0.6, seconds: 4.5 }, // last-play kicks with no timeouts: aim before the snap
    snap: { chance: 0.035, badWeather: 0.08, windowS: 0.85, recoveredShift: 0.07, botchedShift: 0.38 },
  },

  venues: {
    // Open, windy stadiums where the wind swirls (the flags shift between your read and the kick)
    swirlTeams: ['NYJ', 'NYG', 'CLE', 'BUF', 'CHI', 'PIT', 'NE', 'SF', 'KC', 'BAL'],
    swirlChance: 0.15, // high school and college venues
    nightChance: { hs: 1, college: 0.5, nfl: 0.35 },
  },

  difficulty: {
    easy: { label: 'Easy', accuracy: 10, composure: 6, windControl: 6, consistency: 6, meterSpeed: 0.85 },
    normal: { label: 'Normal', accuracy: 0, composure: 0, windControl: 0, consistency: 0, meterSpeed: 1 },
    hard: { label: 'Hard', accuracy: -8, composure: -4, windControl: -4, consistency: -4, meterSpeed: 1.15 },
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
