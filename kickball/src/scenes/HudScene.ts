import Phaser from 'phaser';
import { CONFIG } from '../config';
import teamsData from '../data/teams.json';
import type { Team } from '../data/types';
import { Hud } from './Hud';

const S = CONFIG.screen;

/** Screen-fixed overlay. Runs on top of the field so the field camera can zoom and pan freely. */
export class HudScene extends Phaser.Scene {
  hud!: Hud;

  constructor() {
    super('Hud');
  }

  create(): void {
    this.cameras.main.setZoom(S.renderScale).centerOn(S.width / 2, S.height / 2);
    this.addVignette();
    const team = (teamsData.teams as Team[]).find((t) => t.isPlayer)!;
    this.hud = new Hud(this, team.name);
    this.scene.launch('AtBat');
    this.scene.bringToTop();
  }

  private addVignette(): void {
    if (!this.textures.exists('vignette')) {
      const tex = this.textures.createCanvas('vignette', S.width, S.height)!;
      const ctx = tex.getContext();
      const g = ctx.createRadialGradient(S.width / 2, S.height / 2, S.height * 0.35, S.width / 2, S.height / 2, S.width * 0.72);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.38)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, S.width, S.height);
      tex.refresh();
    }
    this.add.image(0, 0, 'vignette').setOrigin(0).setDepth(0);
  }
}
