# Road to the NFL

A field goal kicker career game. The full spec is in [BRIEF.md](BRIEF.md).

**Status: career mode and free practice.** Create a kicker, then play high school (2 seasons), college (up to 4),
the draft and an NFL career until you retire or no team will sign you.

```bash
npm install
npm run dev        # opens the game in your browser
npm test           # physics tests
npm run probe                  # prints carry/drift numbers, handy while tuning
npm run build:page -- out.html  # the whole game as one HTML page, for hosting
npm run sim:games              # average scores and kicks per game at each level
npm run sim:careers            # plays 8 simulated careers and prints how they went
```

## Controls

| Step | Keys | Mouse |
|---|---|---|
| Aim | ← → | move over the posts |
| Set aim, stop power, stop accuracy | Space | click |
| Skip ahead during the flight | Space | click |
| After the kick | Space = again · N = new random spot · Esc = setup | buttons |
| Sound on/off | M | speaker button |

## Tuning

Every number lives in `src/config.ts`: meter speeds, the overdrive zone, sweet spot size by rating,
wind strength, launch angle, drag, block odds, camera, the kicker's approach timing (`kickerAnim`),
slow motion (`slowMo`), sound levels (`audio`) and team kits. The practice kicker has every rating at 70.

## Career mode

- **Game day:** the game sims drive by drive and stops whenever the coach sends you out. Coach trust (makes raise it,
  misses lower it) sets how far he'll send you out from. Late, close kicks bring pressure (faster, shakier meters and a
  heartbeat), and the other team may call timeout to ice you. Composure softens both.
- **Skills:** made kicks, perfect games, game-winners, career longs, awards and offseason camps earn skill points.
  Costs are 1/2/3/5 per level (below 60 / 60-79 / 80-89 / 90+). A weekly drill trains one skill.
- **Career:** camp battles at every new team (lose and you're the backup, or cut in the NFL), recruiting stars and
  offers, the draft or undrafted free agency, contracts, hot seats, cuts and tryouts, aging from your mid-thirties,
  honors, titles and a Hall of Fame verdict.
- **Saving:** three slots in browser storage, saved after every game and decision.

## Layout

- `src/kick/physics.ts`: kick physics and results, with no UI code (tested in `tests/`)
- `src/kick/render.ts`, `camera.ts`: canvas drawing
- `src/kick/figures.ts`: players, holder and the kicker's approach and swing
- `src/audio/sound.ts`: synthesized stadium sound (no audio files)
- `src/kick/KickScene.tsx`: the five-step kick and input
- `src/screens/Practice.tsx`: free practice setup
- `src/career/`: the career, with no UI code: `gamesim.ts` (drive sim), `career.ts` (seasons, offers, draft, contracts),
  `progression.ts` (skills, costs, coach range), `data.ts` (team names), `save.ts` (three slots)
- `src/screens/career/`: hub, game day, kick series (camps, showcases, tryouts, drills) and the other career screens
