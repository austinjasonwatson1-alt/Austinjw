"use client";

// Soft two-note cues so the author knows recording started or stopped without
// looking at the phone. Rising = started, falling = stopped. Played before the
// mic opens and after it closes, so the cues never end up in the recording.

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

function play(notes: number[]): Promise<void> {
  const ac = audio();
  if (!ac || ac.state !== "running") return Promise.resolve();
  const step = 0.13;
  notes.forEach((freq, i) => {
    const t = ac.currentTime + i * step;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.18, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + step + 0.06);
    osc.connect(gain).connect(ac.destination);
    osc.start(t);
    osc.stop(t + step + 0.08);
  });
  return new Promise((r) => setTimeout(r, notes.length * step * 1000 + 80));
}

/** Call from a tap so iPhone allows sound later in the session. */
export function primeTones() {
  audio();
}
export const startTone = () => play([659.25, 987.77]); // E5 -> B5
export const stopTone = () => play([987.77, 659.25]); // B5 -> E5
