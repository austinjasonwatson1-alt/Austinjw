# Kickball Season Game: Build Brief for Claude Code

Nov 21, 2026 · @Austin

## How to use this brief

Give Claude Code this whole brief, then make it build one milestone at a time.

1. Create an empty folder for the game and save this brief in it as BRIEF.md.
2. Open Claude Code in that folder and send the kickoff prompt below.
3. Play each milestone before approving the next. Describe what feels off in plain words, such as "the ball is too floaty."

Kickoff prompt:

> Read BRIEF.md. It is the full spec for a kickball season game.
> Before writing code, ask me anything that is unclear, then show me a short plan for Milestone 1 only.
> Build one milestone at a time and stop after each so I can play it.
> Keep every tunable number (speeds, ratings, timing windows, probabilities) in one config file.
> Do not add features that are not in the brief.

## Game concept

You run a rec-league kickball team through an 8-game season, trying to make the playoffs and win the championship.

It is a top-down 2D arcade game. You kick, run the bases and make the throws yourself, while the other ten teams' games are simulated around you. The tone is a rec-league sports broadcast: real stakes, played for laughs. A 9-inning game takes 15 to 20 minutes, and a full season with playoffs about 3 hours.

What has to be fun, in priority order:

1. The kick feels good, and timing and aim matter on every pitch.
2. Baserunning decisions are yours: send the runner or hold.
3. Every game moves the standings, so week 8 matters.

## Season structure

Twelve teams play 8 games each, six make the playoffs, and one wins the championship.

| Phase | Format |
|---|---|
| Regular season | 8 weeks, 6 games a week, every team plays once a week |
| Schedule | Round-robin pairing (circle method), using the first 8 of 11 rounds so no opponent repeats |
| Standings | Sorted by win percentage, with a tie counting as half a win |
| Tiebreakers | Head-to-head result, then run differential, then runs scored |
| Playoff round 1 | Top 6 seeds qualify. Seeds 1 and 2 get a bye. 3 plays 6, 4 plays 5 |
| Semifinals | Seed 1 plays the lowest remaining seed, seed 2 plays the other |
| Championship | One game for the trophy |

- You play your game each week. The other five are simulated from team ratings plus some randomness.
- A regular-season game tied after the last inning gets one extra inning, then ends as a tie. Playoff games continue until someone wins.
- If you miss the playoffs, the season ends on the final standings with a Run It Back button. If you lose in the playoffs, you see the bracket and your season stats.
- The season autosaves after every game.

## On-field gameplay

You control the kick, the runners and the throws. Fielders move to the ball on their own.

### Kicking

- The pitcher rolls the ball. Press Space to kick as it crosses the plate.
- Timing sets contact: early pulls the ball foul to the left, late pushes it foul to the right, and on time is a clean hit.
- Aim left or right before the pitch. Hold for a power kick, which goes farther in the air but is easier to catch. Tap for a liner, which is lower and faster but shorter.
- Pitches vary: fast, slow, bouncy and curving. Some miss the plate, so letting a bad one go is a real choice.
- The kicker's Contact rating widens the timing window. Power sets distance.

### Baserunning

- Forced runners advance automatically. On everything else you decide: one key sends all runners, one holds them, and you can select a single runner.
- A runner is out when thrown out at a base, tagged, or pegged with the ball.
- Each runner's Speed rating sets how fast they move.

### Defense

- Pick a pitch type and a location, then roll it.
- Fielders run to the ball automatically. Speed sets their range, and Glove sets the chance of a clean catch or pickup.
- Once a fielder has the ball, you choose: throw to a base, peg a runner, or hold it.
- Arm sets throw speed and peg accuracy. A missed peg keeps the ball live and lets runners take an extra base.

### Feedback

- The scoreboard is always visible: inning, outs, count, score and runners on base.
- After each play, show one line of result text, such as "Liner to left, single."

## Teams and rosters

The league is your team plus 11 opponents, and every player has five ratings from 1 to 10.

| Rating | What it does |
|---|---|
| Contact | Widens the kick timing window |
| Power | Kick distance |
| Speed | Baserunning pace and fielding range |
| Arm | Throw speed and peg accuracy |
| Glove | Catches and clean pickups |

**Your team: Don't Stop Balleving.** This is the kicking order and positions from the last full lineup. Ten play the field and all twelve kick. Fill in the ratings, or leave them blank and Claude Code will generate balanced ones you can edit in the data file.

| Order | Player | Kicks as | Position | Contact | Power | Speed | Arm | Glove |
|---|---|---|---|---|---|---|---|---|
| 1 | Trevor | Guy | CF | | | | | |
| 2 | Austin | Guy | 1B | | | | | |
| 3 | Abby | Girl | 2B | | | | | |
| 4 | Connor | Guy | P | | | | | |
| 5 | Christian | Guy | RF | | | | | |
| 6 | Julie | Girl | C | | | | | |
| 7 | Emre | Guy | RF, rotating with Christian | | | | | |
| 8 | Mitch | Guy | SS | | | | | |
| 9 | Alex | Girl | LF | | | | | |
| 10 | Zach | Guy | RC | | | | | |
| 11 | Kelly | Girl | 3B, rotating with Chloe | | | | | |
| 12 | Chloe | Girl | 3B | | | | | |

**Opponents.** Eleven teams sit in three tiers so the playoff race is real. The names are placeholders; swap in your real league's teams if you like.

| Tier | Teams | Average rating |
|---|---|---|
| Contenders (3) | Ballbarians, Roll Models, Base Invaders | 7 |
| Middle (5) | Sole Survivors, New Kicks on the Block, Toe Jammers, Grass Kickers, Kicking and Screaming | 5 to 6 |
| Bottom (3) | Balls on Parade, The Bunt Cakes, Recess Rejects | 4 |

- Each opponent gets 10 to 12 generated players, with enough girls to satisfy the kicking-order rule. Ratings sit near the tier average, plus one star player.
- All teams live in one JSON data file so names and ratings are easy to edit.
- Before each game, a lineup card screen sets the kicking order and field positions, with an Auto Lineup button.
- A difficulty setting (Rec, Competitive, Travel Ball) shifts opponent ratings by -1, 0 or +1.

## League rules

Games follow common rec kickball rules over 9 innings, plus your league's co-ed kicking order.

| Rule | Setting |
|---|---|
| Innings | 9, with a setting for 3, 5 or 7 |
| Outs | 3 per half-inning |
| Strikes | 3 strikes is an out. A whiff or a good pitch you let go is a strike |
| Fouls | 4 fouls in one at-bat is an out |
| Balls | 4 balls is a walk |
| Ways to get an out | Caught fly ball, force out at a base, tag, or peg |
| Fielders | 10: pitcher, catcher, four infielders, four outfielders |
| Kickers | 10 minimum, 12 maximum. Anyone not in the field rotates in each inning |
| Co-ed kicking order | A girl kicks after every 2 guys, so never 3 guys in a row. The lineup card and Auto Lineup both enforce it, for every team |
| Stealing and leading off | Not allowed |

House rule, as a toggle in settings: "no bunts for guys." A male player who bunts gets a yellow card shown on the lineup card.

## Screens and flow

Nine screens cover the game, and the season hub is home base between games.

1. **Title.** New Season, Continue, Settings.
2. **Season hub.** Next opponent, your record, a standings snapshot, and buttons for lineup, schedule and stats.
3. **Lineup card.** Kicking order and positions, drag to reorder, Auto Lineup. It blocks any order with 3 guys in a row or fewer than 10 kickers.
4. **Game.** The field, the scoreboard and the play result text.
5. **Box score.** Line score by inning, each player's line, and a player of the game.
6. **Week results.** The other five scores, then updated standings with the playoff line drawn under sixth place.
7. **Team stats.** Season average, hits, runs, RBI, home runs and errors for each of your players.
8. **Playoff bracket.** Seeds, results and your path.
9. **Season end.** A trophy screen if you win. Final standings and season stats if you don't, with Run It Back.

## Tech and constraints

Build it as a browser game that runs locally on your Mac. For a 2D game, this is the fastest setup for Claude Code to build and for you to test.

| Area | Choice |
|---|---|
| Stack | TypeScript, Phaser (latest stable version) and Vite |
| Run | npm install, then npm run dev. npm run build outputs a static site |
| Saving | Browser localStorage, one save slot, autosave after every game |
| Controls | Keyboard: arrow keys to aim and choose, Space to kick or confirm. Keep input in one module so touch controls can be added later |
| Art | Top-down 2D field drawn in code. Flat, bright, readable shapes. No external art files |
| Sound | Kick, catch, cheer and whistle, generated in code. Leave it until the polish milestone |
| Tuning | Every speed, timing window and probability lives in one config file |
| Tests | Unit tests for the schedule generator, standings and tiebreakers, playoff seeding and the game simulator |

Out of scope for version 1: online multiplayer, multiple seasons, trades, injuries, a draft, 3D and a mobile app.

## Build milestones

Seven milestones, each one playable, built in this order.

1. **One at-bat.** Field, pitch, timing kick, ball flight, fair or foul. Done when kicking feels good.
2. **One half-inning.** Runners, automatic fielders, every kind of out, and scoring.
3. **One full game.** Both halves, your defense controls, an AI opponent, the scoreboard and the box score.
4. **Teams and ratings.** The 12-team data file, ratings driving outcomes, and the lineup card.
5. **The season.** Schedule, simulated games, standings, season hub, team stats and autosave.
6. **Playoffs.** Seeding, bracket, championship and the season-end screens.
7. **Polish.** Art pass, sound, difficulty settings and the flavor below.

Flavor for milestone 7, to cut if it slows the build:

- **Broadcast commentary.** Text lines from two announcers, John on play-by-play and Collin as analyst, plus Collin's pregame score prediction.
- **Availability.** Each week, one or two players on any roster may show up late or not at all, forcing a lineup change. No team ever drops below 10.
- **Season awards.** MVP, Gold Glove, and Relegation Watch for your worst performer.
- **Yellow cards** shown on the lineup card.

## Decisions

These seven choices are settled. Two items are still open: the player ratings, and a check of the Kicks as column in the roster.

| Question | Decision |
|---|---|
| Play or manage? | You play: timing kicks, baserunning calls and throw choices |
| Where does it run? | In a browser, locally on your Mac |
| Whose team? | Don't Stop Balleving, with the real roster from the last full lineup |
| How many teams make the playoffs? | 6 of 12, with a bye for the top two seeds |
| How long is a game? | 9 innings |
| Which league rules? | 10 fielders, 10 to 12 kickers, a girl after every 2 guys, pegging, regular-season ties, no stealing |
| What tone? | Rec-league broadcast humor with John and Collin |
