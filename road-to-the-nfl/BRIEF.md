# Road to the NFL (Kicker Career): Build Brief

Nov 21, 2026 · @Austin

## How to use this brief

Give Claude Code this whole brief, then make it build one milestone at a time.

1. Create an empty folder for the game and save this brief in it as BRIEF.md.
2. Open Claude Code in that folder and send the kickoff prompt below.
3. Play each milestone before approving the next. Describe what feels off in plain words, such as "50-yarders are too easy."

Kickoff prompt:

> Read BRIEF.md. It is the full spec for a football kicker career game.
> Before writing code, ask me anything that is unclear, then show me a short plan for Milestone 1 only.
> Build one milestone at a time and stop after each so I can play it.
> The kick has to feel great before anything else gets built.
> Keep every tunable number (meter speeds, wind effect, skill costs, sim odds) in one config file.
> Do not add features that are not in the brief.

## Game concept

You are a field goal kicker working your way from high school to the NFL, and the only plays you ever play are your kicks.

Each game simulates on its own and stops when your team sends you out. You line up the kick, hit it, and the game moves on with your result on the scoreboard. Between games you spend skill points to become a better kicker, and between seasons your career moves forward: college offers, the draft, an NFL roster spot.

What has to be fun, in priority order:

1. The kick feels great, and a 52-yarder into the wind feels different from a chip shot.
2. Pressure is real. A game-winner with no time left plays harder than a first-quarter extra point.
3. Your kicker visibly improves. Kicks that were out of range in high school become routine.
4. The career has stakes. You can lose the job, go undrafted or get cut, and you can win it back.

## Career path

The career has four stages, and each one ends with someone deciding whether they want you.

| Stage | Length | Games each season | How you move on |
|---|---|---|---|
| High school | 2 seasons, junior and senior | 10, plus up to 4 playoff games | College offers arrive during senior year, based on your stats and star rating |
| College | Up to 4 seasons, with the option to leave after 3 | 12, plus the postseason | You declare for the NFL draft |
| The draft | One offseason | A kicking showcase in front of scouts | A team drafts you late, or you sign as an undrafted free agent |
| NFL | Until you retire or no team will sign you | 17, plus the playoffs | You win the job in camp, keep it, and chase records and a Super Bowl |

The career ends with a summary: total points, longest kick, honors, championships and a Hall of Fame verdict.

## The kick

Every kick is the same five steps, seen from behind the kicker looking at the goalposts.

1. **Read.** A situation card shows the distance, the hash (left, middle or right), the wind direction and speed, the weather, and the score and clock.
2. **Aim.** Move an aim marker left or right to allow for the wind and the angle.
3. **Power.** A meter fills, and you stop it near the top. Too little leaves the kick short. Going past the top adds distance but shrinks the accuracy window.
4. **Accuracy.** A marker sweeps across a bar, and you stop it in the sweet spot. Missing to either side hooks or slices the ball.
5. **Flight.** The ball flies with depth: it shrinks as it travels, casts a shadow and drifts with the wind. Results are good, wide left, wide right, short, off the upright, or (rarely) blocked.

What makes a kick hard:

| Factor | Effect |
|---|---|
| Distance | Longer kicks need more power and leave less room for error |
| Hash | A kick from the left or right hash comes in at an angle, which matters most on short kicks |
| Wind | Pushes the ball sideways, or adds and removes distance |
| Weather | Rain, snow and cold cut distance and narrow the sweet spot |
| Pressure | In big moments the meters speed up and shake, and the crowd gets louder |
| Icing | The opponent calls a timeout just before the kick. You wait, then start again with slightly faster meters |

A free-practice mode lets you kick from any distance, hash and wind setting.

## Game day

A game simulates drive by drive in a few seconds and stops only when your team sends you out to kick.

- **The ticker.** Between your kicks, a scoreboard and short drive summaries roll by: touchdown, punt, turnover, opponent field goal.
- **Your moments.** The sim stops for every field goal and extra point your team attempts. You kick, and the result goes straight onto the scoreboard.
- **Coach trust.** The coach decides whether to send you out, based on the distance, your range and how much he trusts you. Makes raise trust and misses lower it. Low trust means he punts or goes for it on kicks you could make. High trust gets you the 55-yarders and the game-winners.
- **Honest sim.** The game never forces a last-second kick. Close games produce them naturally, and your earlier kicks decide whether the game is close.
- **Extra points.** You kick them by default. A setting resolves them automatically from your ratings.
- **Not played.** Kickoffs, punts and every non-kicking snap are simulated.
- **After the game.** A summary shows the final score, a chart of your kicks, skill points earned and the change in coach trust.

A typical game has 3 to 6 kicks and takes 2 to 3 minutes.

## Skills and progression

You develop five skills, each rated 1 to 99, by earning skill points and choosing where to spend them.

| Skill | What it changes in the kick |
|---|---|
| Power | Maximum range, and how much distance wind and cold take away |
| Accuracy | The size of the sweet spot on the accuracy meter |
| Composure | How much pressure and icing speed up and shake the meters |
| Wind control | How far the wind moves the ball, and how precise the wind reading is |
| Consistency | How much random drift the ball has, even on a well-struck kick |

You start as a high school junior with ratings in the 40s and a range of about 40 yards. An overall rating, averaged from the five, drives your star rating, draft stock and starting coach trust.

### Earning points

- Made kicks, with more for long kicks and pressure kicks.
- Milestones: a perfect game, a game-winner, a new career long, season awards.
- Weekly practice: one short drill each week, aimed at the skill you pick.
- Offseason camps, which pay out the biggest single chunk of the year.

### Spending points

- Each level costs more as a skill climbs: 1 point per level below 60, 2 from 60 to 79, 3 from 80 to 89, and 5 from 90 up.
- Points can be saved, and spending is permanent.
- From about age 37, Power slowly declines, so late-career points go toward holding it up.

## Career systems

Five systems carry you between stages, and each one can go against you.

| System | How it works |
|---|---|
| Create a kicker | Name, hometown, high school name, kicking foot and jersey number |
| Recruiting | High school stats and a summer showcase set a star rating from 2 to 5. Offers come in tiers: a walk-on spot at a major program, a scholarship at a mid-level school, or the starting job at a small one. Bigger programs mean more exposure but a fight for the job |
| Winning the job | At every new team, a camp competition pits you against a rival kicker over a set of kicks. Lose and you are the backup: games sim quickly, you still practice and earn points, and you get a chance if the starter slumps or is hurt |
| The draft | A showcase of kicks from set distances, plus your college stats and awards, sets your draft stock. Kickers go late. Undrafted players choose among free-agent offers |
| NFL job security | A contract sets years and salary. A bad stretch brings a rival into camp, and a worse one gets you cut. Free agents attend tryouts for teams that need a kicker |

Honors to chase: all-state, all-conference, All-American, the national award for the top college kicker, Pro Bowl, All-Pro, a Super Bowl, the records for longest kick and career points, and the Hall of Fame.

Names: the 32 NFL teams and real colleges appear by name, as text only. High schools, rival kickers and every other player are generated.

## Level rules

The field itself changes as you move up, so each level asks something different of the kick.

| Rule | High school | College | NFL |
|---|---|---|---|
| Distance between hash marks | 53 ft 4 in | 40 ft | 18 ft 6 in |
| Width between the uprights | 23 ft 4 in | 18 ft 6 in | 18 ft 6 in |
| Extra point distance | 20 yards | 20 yards | 33 yards |
| Regular season | 10 games | 12 games | 17 games |
| Postseason | State playoffs, up to 4 rounds | Bowl game or the 24-team playoff | 14-team playoff and the Super Bowl |
| A strong leg at this level | 45 yards | 55 yards | 60 yards or more |

- High school has wide uprights but very wide hash marks, so short kicks from the hash come in at a sharp angle.
- College narrows the uprights. The NFL narrows the hashes and moves the extra point back.
- The college postseason uses the 24-team playoff announced for 2027 onward. The 2026 season still used 12 teams.
- Every number here lives in the config file. Have Claude Code confirm the extra point distances and the "strong leg" ranges, which are approximate.

Sources: hash mark widths, goalpost widths, 2026 NFL schedule, 24-team College Football Playoff.

## Screens

Twelve screens cover the game, and the career hub is home base.

1. **Start.** New Career, Continue and Free Practice, with three save slots.
2. **Create a kicker.** Name, hometown, school, kicking foot and number.
3. **Career hub.** Next game, team record, your season line, the coach trust meter, unspent skill points and news.
4. **Game ticker.** The scoreboard and drive summaries as the game simulates.
5. **Kick scene.** The situation card, the aim marker, both meters and the ball flight.
6. **Post-game.** Final score, a chart of your kicks, points earned and the trust change.
7. **Skills.** The five skills, their costs and what each next level changes.
8. **Practice.** The weekly drill and offseason camps.
9. **Offers.** College offers, draft results, free-agent offers and tryouts, depending on the stage.
10. **Depth chart.** You, your rival and the camp competition.
11. **Career stats.** Season-by-season lines, accuracy by distance, longest kick, honors and a trophy case.
12. **Career summary.** The final totals and the Hall of Fame verdict.

## Tech, design and scope

Build it as a browser game that runs locally on a Mac, with the kick scene on a canvas and everything else as regular screens.

| Area | Choice |
|---|---|
| Stack | TypeScript, React and Vite, with the kick scene drawn on an HTML canvas |
| Run | npm install, then npm run dev |
| Controls | Arrow keys or mouse to aim, Space or click to stop each meter. One-button timing, so touch can be added later |
| Game sim | A separate TypeScript module with a seeded random number generator and no UI code |
| Saving | Browser storage, three career slots, autosave after every game |
| Tuning | Every meter speed, wind effect, skill cost and sim probability lives in one config file |
| Tests | Sim scores look like real football at each level, coach decisions follow trust and range, skill costs add up, and each career transition works |

**Design bar.** It should look like a sports broadcast, not a web form.

- A proper score bug, a lower-third situation card and a big call when the kick is good.
- The stadium grows with the career: bleachers and Friday night lights, then a packed college bowl, then an NFL stadium.
- A ball tracer in flight, a shaking camera and a heartbeat under pressure, and crowd noise that swells and drops.
- Your current team's colors as the accent on every screen.

**Names and licensing.** NFL team and college names appear as text only, with no logos and no real players. Those names and logos are trademarks, so this setup is for personal play. Swap the team data file for generated names before sharing the game publicly or using it in a portfolio.

**Out of scope for version 1:** kickoffs, punts, onside kicks, playing any non-kicking snap, 3D graphics, endorsement money and multiplayer.

## Build milestones

Seven milestones, each one playable, built in this order.

1. **The kick.** One field goal scene with aim, power, accuracy, wind, distance and hash, in free-practice mode. Done when kicking feels great.
2. **A full game.** The drive sim and ticker, field goal and extra point moments, coach decisions, pressure and icing, and the post-game summary.
3. **Skills.** The five skills changing the kick, skill points, the skills screen and practice drills.
4. **High school.** Create a kicker, two seasons, a schedule, stats, playoffs and a star rating.
5. **Recruiting and college.** Offers, choosing a school, the camp competition, college seasons and awards.
6. **The draft and the NFL.** The showcase, the draft, contracts, camp battles, getting cut and tryouts, NFL seasons, the playoffs and the Super Bowl.
7. **Career and polish.** Aging, records, honors, retirement and the career summary, weather variety, stadium atmosphere, sound and the full design pass.

Spend the most time on milestone 1. If one kick is not fun on its own, a thousand of them across a career will not be.

## Defaults and open questions

This brief fills seven gaps with defaults. Change any answer and the matching section changes with it.
