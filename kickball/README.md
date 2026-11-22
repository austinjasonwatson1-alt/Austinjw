# Kickball Season

A top-down kickball season game for Don't Stop Balleving. The full spec is in [BRIEF.md](BRIEF.md).

## Run it

```bash
npm install
npm run dev
```

`npm run build` makes a static site in `dist/`. `npm test` runs the unit tests.

## Controls (Milestone 2: one half-inning)

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
