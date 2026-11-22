import Phaser from 'phaser';
import { CONFIG } from './config';
import { AtBatScene } from './scenes/AtBatScene';

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: CONFIG.screen.width,
  height: CONFIG.screen.height,
  backgroundColor: '#1e5a2c',
  antialias: true,
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: [AtBatScene],
});
