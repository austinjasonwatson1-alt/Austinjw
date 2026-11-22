# Kickball Season

A top-down kickball season game for Don't Stop Balleving. The full spec is in [BRIEF.md](BRIEF.md).

## Run it

```bash
npm install
npm run dev
```

`npm run build` makes a static site in `dist/`. `npm test` runs the unit tests.

## Controls

| Key | What it does |
|---|---|
| ← / → | Aim before the pitch: Pull, Left-Center, Center, Right-Center, Opposite Field |
| ↓ / ↑ | Bunt stance / normal stance |
| Hold Space | Wind up. Release = contact. Held past the white line = power kick |
| Tap Space | Liner |
| → (ball in play) | Send runners one more base |
| ← (ball in play) | Hold runners, or send them back to the last base |
| ↑ / ↓ (ball in play) | Pick a single runner, or all runners |
| Space (after the at-bat) | Next kicker right away |

On defense:

| Key | What it does |
|---|---|
| ← / → | Pitch type: fast, slow, bouncy, curving |
| ↑ / ↓ | Where to aim it: left edge, middle, right edge |
| Space | Roll the pitch |
| ← / → (your fielder has the ball) | Choose 1st, 2nd, 3rd, home, peg, or hold |
| Space (your fielder has the ball) | Throw, peg, or hold |

Before each game the lineup card sets the kicking order (drag rows), positions, who sits, the opponent and the
number of innings. Auto Lineup builds a legal one. It won't let you play with 3 guys in a row or fewer than 10 kickers.

`node scripts/gen-teams.mjs` regenerates the 11 opponent rosters (it overwrites edits to them).

Timing sets direction: early pulls toward left field, late pushes toward right. Too early or too late is a whiff.

## Where things live

- `src/config.ts`: every tunable number (pitch speeds, timing windows, kick distances, physics)
- `src/data/teams.json`: rosters and ratings (1 to 100). Players marked `"generated": true` have made-up ratings
- `src/input.ts`: all keyboard input, in one place so touch controls can be added later
- `src/core/`: game logic with no drawing (pitches, kick timing, ball flight, the count)
- `src/art/`: the ballpark, player figures, ball and colors, all drawn in code
- `src/scenes/`: the Phaser screens and the scoreboard

## Web version

`web/play.html` is a start page that loads the built game from `assets/game.js`. After `npm run build`,
it's published together with `dist/assets/game.js` as a claude.ai page, so the game can be played from a link.
