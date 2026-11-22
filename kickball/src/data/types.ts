export interface Player {
  name: string;
  kicksAs: 'guy' | 'girl';
  position: string; // usual spot from the data file; 'Bench' for a sub
  contact: number;
  power: number;
  speed: number;
  arm: number;
  glove: number;
  generated?: boolean;
  star?: boolean;
}

export interface Team {
  id: string;
  name: string;
  isPlayer?: boolean;
  tier?: string;
  players: Player[];
}
