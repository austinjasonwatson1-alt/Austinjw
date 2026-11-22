// Synthesized stadium sound. No audio files: everything is built from oscillators and noise.
// The AudioContext starts on the first user gesture (browsers require it).

import { CONFIG } from '../config';

const MUTE_KEY = 'rtn.muted';

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private crowdGain: GainNode | null = null;
  private crowdFilter: BiquadFilterNode | null = null;
  private crowdSrcs: AudioBufferSourceNode[] = [];
  private pink: AudioBuffer | null = null;
  private brown: AudioBuffer | null = null;
  muted = readMuted();

  /** Call from a user gesture. Safe to call repeatedly. */
  start() {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      this.ctx = ctx;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      comp.connect(ctx.destination);
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : CONFIG.audio.master;
      this.master.connect(comp);
      this.pink = this.makeNoise(4, 'pink');
      this.brown = this.makeNoise(4, 'brown');
      this.startCrowd();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    try {
      localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0');
    } catch {
      /* storage blocked: mute still works for this session */
    }
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : CONFIG.audio.master, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  private makeNoise(seconds: number, kind: 'pink' | 'brown'): AudioBuffer {
    const ctx = this.ctx!;
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
      for (let i = 0; i < n; i++) {
        const w = Math.random() * 2 - 1;
        if (kind === 'pink') {
          b0 = 0.99886 * b0 + w * 0.0555179;
          b1 = 0.99332 * b1 + w * 0.0750759;
          b2 = 0.969 * b2 + w * 0.153852;
          b3 = 0.8665 * b3 + w * 0.3104856;
          b4 = 0.55 * b4 + w * 0.5329522;
          b5 = -0.7616 * b5 - w * 0.016898;
          d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
          b6 = w * 0.115926;
        } else {
          last = (last + 0.02 * w) / 1.02;
          d[i] = last * 3.5;
        }
      }
      // Fade the loop seam.
      const f = Math.floor(ctx.sampleRate * 0.05);
      for (let i = 0; i < f; i++) {
        const g = i / f;
        d[i] *= g;
        d[n - 1 - i] *= g;
      }
    }
    return buf;
  }

  private startCrowd() {
    const ctx = this.ctx!;
    this.crowdGain = ctx.createGain();
    this.crowdGain.gain.value = CONFIG.audio.crowdIdle;
    this.crowdFilter = ctx.createBiquadFilter();
    this.crowdFilter.type = 'lowpass';
    this.crowdFilter.frequency.value = 2600;
    this.crowdFilter.connect(this.crowdGain);
    this.crowdGain.connect(this.master!);

    // Two offset layers of filtered noise sound like a large, distant crowd.
    for (const [buf, freq, q, gain, offset] of [
      [this.pink!, 650, 0.6, 0.9, 0],
      [this.pink!, 1500, 1.1, 0.45, 1.7],
      [this.brown!, 300, 0.7, 0.6, 0.9],
    ] as const) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = freq;
      bp.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = gain;
      // Slow swell so it murmurs rather than hisses.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.13 + Math.random() * 0.2;
      const lfoAmt = ctx.createGain();
      lfoAmt.gain.value = gain * 0.25;
      lfo.connect(lfoAmt).connect(g.gain);
      lfo.start();
      src.connect(bp).connect(g).connect(this.crowdFilter);
      src.start(0, offset);
      this.crowdSrcs.push(src);
    }
  }

  /** Crowd bed level, 0..1, eased over `seconds`. */
  crowd(level: number, seconds = 0.6) {
    if (!this.ctx || !this.crowdGain) return;
    this.crowdGain.gain.setTargetAtTime(level, this.ctx.currentTime, Math.max(0.01, seconds / 3));
  }

  /** Slow-motion: drop the crowd's pitch and muffle it (0 = normal, 1 = full slow-mo). */
  slowMo(amount: number) {
    if (!this.ctx || !this.crowdFilter) return;
    const t = this.ctx.currentTime;
    for (const s of this.crowdSrcs) s.playbackRate.setTargetAtTime(1 - 0.45 * amount, t, 0.08);
    this.crowdFilter.frequency.setTargetAtTime(2600 - 2000 * amount, t, 0.08);
  }

  private env(g: GainNode, t: number, peak: number, attack: number, decay: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private noiseBurst(t: number, type: BiquadFilterType, freq: number, q: number, peak: number, attack: number, decay: number, buf?: AudioBuffer) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buf ?? this.pink!;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    this.env(g, t, peak, attack, decay);
    src.connect(f).connect(g).connect(this.master!);
    src.start(t, Math.random() * 2);
    src.stop(t + attack + decay + 0.05);
    return { src, f, g };
  }

  private tone(t: number, type: OscillatorType, f0: number, f1: number, glide: number, peak: number, attack: number, decay: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + glide);
    const g = ctx.createGain();
    this.env(g, t, peak, attack, decay);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + attack + decay + 0.05);
  }

  /** Foot meets ball. strength 0..1.2 */
  thump(strength: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const s = Math.max(0.4, Math.min(1.2, strength));
    this.tone(t, 'sine', 190, 46, 0.1, 0.95 * s, 0.002, 0.26);
    this.tone(t, 'triangle', 420, 120, 0.04, 0.35 * s, 0.001, 0.07);
    this.noiseBurst(t, 'bandpass', 2200, 0.9, 0.7 * s, 0.001, 0.05); // leather pop
    this.noiseBurst(t, 'lowpass', 500, 0.7, 0.5 * s, 0.002, 0.18, this.brown!); // body
  }

  step() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(t, 'lowpass', 700, 0.8, 0.22, 0.003, 0.06, this.brown!);
    this.noiseBurst(t, 'bandpass', 3200, 2, 0.05, 0.001, 0.03);
  }

  /** Ball hitting the turf. speed 0..1 */
  thud(speed: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const v = Math.max(0.15, Math.min(1, speed));
    this.tone(t, 'sine', 110, 55, 0.07, 0.3 * v, 0.002, 0.12);
    this.noiseBurst(t, 'lowpass', 600, 0.7, 0.25 * v, 0.002, 0.08, this.brown!);
  }

  /** Ball off the goalpost. */
  clang() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const partials: [number, number, number][] = [
      [512, 0.55, 1.6],
      [1243, 0.35, 1.1],
      [2187, 0.22, 0.8],
      [3410, 0.13, 0.5],
      [4630, 0.07, 0.35],
    ];
    for (const [f, a, d] of partials) this.tone(t, 'sine', f, f * 0.995, d, a, 0.001, d);
    this.noiseBurst(t, 'highpass', 2500, 0.7, 0.6, 0.001, 0.04);
  }

  block() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(t, 'bandpass', 1400, 0.8, 0.8, 0.001, 0.06);
    this.tone(t, 'sine', 150, 60, 0.08, 0.6, 0.002, 0.15);
  }

  /** Deep whoomp as slow motion kicks in. */
  slowMoHit() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(t, 'sine', 70, 38, 0.6, 0.55, 0.05, 1.1);
    this.noiseBurst(t, 'lowpass', 300, 0.6, 0.3, 0.12, 0.9, this.brown!);
  }

  /** Crowd explodes. size 0..1.5 */
  roar(size = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const amp = CONFIG.audio.roar * size;
    for (const [freq, q, peak] of [
      [900, 0.5, 0.9],
      [2000, 0.8, 0.5],
      [400, 0.6, 0.6],
    ] as const) {
      const src = ctx.createBufferSource();
      src.buffer = this.pink!;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak * amp, t + 0.35);
      g.gain.setTargetAtTime(peak * amp * 0.7, t + 0.35, 0.8);
      g.gain.setTargetAtTime(0.0001, t + 2.6, 0.9);
      src.connect(f).connect(g).connect(this.master!);
      src.start(t, Math.random());
      src.stop(t + 6.5);
    }
    // Whistles and shouts poking out of the roar.
    for (let i = 0; i < 9; i++) {
      const st = t + 0.15 + Math.random() * 2;
      const f0 = 1700 + Math.random() * 1300;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f0, st);
      o.frequency.linearRampToValueAtTime(f0 * (0.9 + Math.random() * 0.25), st + 0.5);
      const vib = ctx.createOscillator();
      vib.frequency.value = 5 + Math.random() * 3;
      const vibAmt = ctx.createGain();
      vibAmt.gain.value = 30;
      vib.connect(vibAmt).connect(o.frequency);
      const g = ctx.createGain();
      this.env(g, st, 0.05 * amp, 0.05, 0.5 + Math.random() * 0.4);
      o.connect(g).connect(this.master!);
      o.start(st);
      vib.start(st);
      o.stop(st + 1.2);
      vib.stop(st + 1.2);
    }
  }

  /** Crowd "awww". */
  groan() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const amp = CONFIG.audio.groan;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(amp, t + 0.25);
    out.gain.setTargetAtTime(0.0001, t + 0.9, 0.45);
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.value = 600;
    f1.Q.value = 2.5;
    f1.frequency.linearRampToValueAtTime(420, t + 1.6);
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.value = 1000;
    f2.Q.value = 3;
    f2.frequency.linearRampToValueAtTime(750, t + 1.6);
    f1.connect(out);
    f2.connect(out);
    out.connect(this.master!);
    for (let i = 0; i < 14; i++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const base = 120 + Math.random() * 130;
      o.frequency.setValueAtTime(base * 1.06, t);
      o.frequency.exponentialRampToValueAtTime(base * 0.8, t + 1.8);
      const g = ctx.createGain();
      g.gain.value = 0.05;
      o.connect(g);
      g.connect(f1);
      g.connect(f2);
      o.start(t + Math.random() * 0.12);
      o.stop(t + 3);
    }
    const n = this.noiseBurst(t, 'bandpass', 700, 0.8, 0.35 * amp, 0.2, 1.6);
    n.f.frequency.linearRampToValueAtTime(450, t + 1.6);
  }
}

export const sound = new SoundEngine();
