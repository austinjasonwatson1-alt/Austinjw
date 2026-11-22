export interface Player {
  name: string;
  kicksAs: 'guy' | 'girl';
  position: string;
  contact: number;
  power: number;
  speed: number;
  arm: number;
  glove: number;
  generated?: boolean;
}

export interface Team {
  id: string;
  name: string;
  isPlayer?: boolean;
  players: Player[];
}
