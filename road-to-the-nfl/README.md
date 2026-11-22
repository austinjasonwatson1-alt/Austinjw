# Road to the NFL

A field goal kicker career game. The full spec is in [BRIEF.md](BRIEF.md).

**Status: Milestone 1 (the kick), free practice only.**

```bash
npm install
npm run dev        # opens the game in your browser
npm test           # physics tests
npm run probe                  # prints carry/drift numbers, handy while tuning
```

## Controls

| Step | Keys | Mouse |
|---|---|---|
| Aim | ← → | move over the posts |
| Set aim, stop power, stop accuracy | Space | click |
| Skip ahead during the flight | Space | click |
| After the kick | Space = again · N = new random spot · Esc = setup | buttons |

## Tuning

Every number lives in `src/config.ts`: meter speeds, the overdrive zone, sweet spot size by rating,
wind strength, launch angle, drag, block odds, camera. The practice kicker has every rating at 70.

## Layout

- `src/kick/physics.ts`: kick physics and results, with no UI code (tested in `tests/`)
- `src/kick/render.ts`, `camera.ts`: canvas drawing
- `src/kick/KickScene.tsx`: the five-step kick and input
- `src/screens/Practice.tsx`: free practice setup
