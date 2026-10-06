# MLB Game Predictor

`mlb_predictor.py` predicts the winner of every game on an MLB slate. For each game it gives a win probability, an 80% uncertainty band and a one-line "Reason Why" backed by the stats.

```bash
pip install -r requirements.txt
python mlb_predictor.py                        # today's slate (ET); tries the live MLB Stats API, uses simulated data if unreachable
python mlb_predictor.py --date 2026-09-24
python mlb_predictor.py --source simulate      # offline demo slate
python mlb_predictor.py --train-csv history.csv --csv-out picks.csv
python -m pytest -q tests                      # offline test suite (mocked API)
```

## How it works

| Stage | What it does |
|---|---|
| **Ingestion** | Reads the schedule, probable starters, pitcher hand, pitcher season and last-30-day lines, team hitting splits vs LHP/RHP, bullpen or whole-staff pitching and home/road records from `statsapi.mlb.com`. Uses 12 parallel workers, retries and a cache. |
| **Features** | SP SIERA, SP xFIP, SP K-BB% over the last 30 days, park-adjusted wRC+ against the hand of the opposing starter, bullpen SIERA, home W% vs the opponent's road W%, team strength (Pythagorean W% from run differential), each starter's projected HR/9 in today's park (fly-ball rate × HR per air ball × HR park factor), and the run park factor. Every rate is regressed toward league average by sample size and carries a standard error. |
| **Model** | 60/40 blend of a Logistic Regression and a monotonic-constrained `HistGradientBoostingClassifier`, then a small log-odds shift for playoff status (`PLAYOFF_LOGIT_SHIFT`: a contender vs an eliminated or already-clinched club). |
| **Output** | Pick, tier (STRONG / LEAN / TOSS-UP), win probability, and an 80% Monte Carlo band from stat sample-size error. The Reason Why names the top logistic log-odds contributors that favor the pick. |

### Edge cases handled
- Postponed, cancelled and suspended games are listed but get no pick.
- A TBD or no-data starter is replaced by a slightly below-average proxy, with a note on the game.
- Early-season or call-up pitchers are blended with half-weighted prior-season stats.
- Pitchers with no appearances in the last 30 days fall back to their season K-BB%.
- Neutral-site games use a park factor of 100.
- Doubleheaders are labeled G1/G2.
- Completed games are graded HIT or MISS.
- Missing splits, bullpens or standings are filled with league averages, with a note on the game.
- A malformed game record is skipped without breaking the rest of the slate.
- If the API is down, the script uses simulated data (`--source auto`) or exits cleanly (`--source api`).

## Important caveats
- **Training data.** By default the model trains on a *structural baseline*. That is 30,000 games simulated from a run-expectancy model (Pythagenpat) with realistic measurement noise. Its weights are principled priors, not fitted to real outcomes. For real validation, supply `--train-csv` with historical rows. The CSV needs the columns in `FEATURES` plus `home_win`, and each row's features must be computed as of that game's date to avoid lookahead.
- **SIERA / xFIP.** The Stats API has no full batted-ball data. GB and FB are estimated from groundOuts and airOuts, and the results are re-centered to league constants. Expect small differences from the FanGraphs values.
- **Constants to refresh.** `LeagueConstants` (wOBA weights, FIP constant, league rates), `PARK_FACTORS` and `HR_PARK_FACTORS` should be refreshed each season.
- **Playoff shift.** The playoff-status adjustment is a hand-set prior, not a fitted effect.
- For research and entertainment only. This is not betting advice.

# Bristol Table Trainer

`casino_trainer/index.html` is a single-page, play-money trainer for blackjack, baccarat and roulette. Its rules are modeled on what's publicly reported for Hard Rock Bristol's tables. Open the file in any browser; it needs no build step or server. It's unofficial and not affiliated with the casino.

| Game | What it simulates |
|---|---|
| **Blackjack** | Six-deck shoe with a cut card. Choose a $10 or $15 table (6:5 blackjack) or a $25 table (3:2). Dealer hits soft 17. Double on any two cards and after splits, split up to 4 hands, aces split once with one card each, no surrender, insurance offered. A strategy coach grades every decision against basic strategy, and there's an optional Hi-Lo running/true count. |
| **Baccarat** | Eight-deck shoe. Play EZ Baccarat (no commission, Dragon 7 and Panda 8) or mini baccarat with a 5% commission. Includes a bead plate and an optional quiz on the third-card drawing rules. |
| **Roulette** | Double-zero or triple-zero wheel with an animated spin. Bet straight, split, street, corner, six line, top line (00 only) and every outside bet, with a $10 table minimum and a history board. |

A results strip above the blackjack table shows your last 30 hands (W, BJ, L, P), your win/push/loss rates next to the typical 43% / 9% / 48%, your current and longest streaks, and how many times you've won back to back. Each round is scored by its net result, so a split that wins one hand and loses the other counts as a push.

**Other players** (off by default, up to 6) adds CPU players to any game. At blackjack they take seats, get their own cards and play in deal order, so the shoe goes faster and your count includes their cards. You choose first base, middle or third base. Some of them play by the book and some make common mistakes, which are flagged as they happen. At baccarat they bet streaks, Banker, the chop or side bets. At roulette they put colored chips on the layout. Their money never affects your bankroll.

The bankroll ($1,000 to start) and stats are saved in the browser's local storage. The **Notes** tab covers table etiquette, hand signals, a basic strategy chart and house edges. The rules marked as assumed there are worth checking on the felt before you play.
