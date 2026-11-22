import Phaser from 'phaser';
import { startApp } from './app';
import { CONFIG } from './config';
import { AtBatScene } from './scenes/AtBatScene';
import { HudScene } from './scenes/HudScene';

const S = CONFIG.screen;

// The canvas is renderScale times bigger than the layout; each scene's camera
// zooms by at least that much, so everything is drawn sharp on Retina screens.
const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: S.width * S.renderScale,
  height: S.height * S.renderScale,
  backgroundColor: '#2c6e37',
  antialias: true,
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: [HudScene, AtBatScene],
});
game.events.once('hud-ready', () => startApp(game));
