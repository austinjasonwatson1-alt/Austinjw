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
