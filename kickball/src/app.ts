import type Phaser from 'phaser';
import { CONFIG } from './config';
import teamsData from './data/teams.json';
import type { Team } from './data/types';
import { GameState } from './core/game';
import { defaultLineup, type Lineup } from './core/lineup';
import { showBoxScore, showLineupCard } from './ui/screens';

/** Screen flow: lineup card, then the game, then the box score, then back. */
export function startApp(game: Phaser.Game): void {
  const teams = teamsData.teams as Team[];
  const mine = teams.find((t) => t.isPlayer)!;
  const opponents = teams.filter((t) => !t.isPlayer);
  let opponent = opponents[0];
  let innings = CONFIG.rules.innings;
  let lineup: Lineup = defaultLineup(mine);

  const lineupCard = () =>
    showLineupCard(mine, lineup, opponents, { opponent, innings }, (c) => {
      lineup = c.lineup;
      opponent = c.opponent;
      innings = c.innings;
      const state = new GameState(
        { team: mine, lineup, isPlayer: true, next: 0 },
        { team: opponent, lineup: defaultLineup(opponent), isPlayer: false, next: 0 },
        { innings },
      );
      game.scene.start('AtBat', { game: state, onEnd: (g: GameState) => showBoxScore(g, lineupCard) });
    });

  lineupCard();
}
