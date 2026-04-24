/**
 * Earth tier-1 (Quicksand Field) — locked-in ATTACK sound: Earthquake Rumble.
 * Original 6-candidate set was pruned after user selection.
 */
import { playNoise, playOsc, group } from '../../../primitives';
import type { SoundVariant } from '../../../types';

const DEFAULT_DUR = 2.5;

export const earthTier1AttackQuake: SoundVariant = {
  id: 'earth-t1-atk-03',
  label: '지진 울림',
  description: '초저음 지진 — 땅이 진동하는 공포',
  play(duration = DEFAULT_DUR) {
    const sub = playOsc({
      type: 'sawtooth',
      freq: 38,
      env: { attack: 0.15, decay: 0.1, sustain: 0.45, hold: duration, release: 0.35, peak: 0.55 },
      filter: { type: 'lowpass', freq: 120, q: 0.8 },
    });
    const rumble = playNoise({
      type: 'brown',
      duration: 1,
      loop: true,
      env: { attack: 0.15, decay: 0.1, sustain: 0.55, hold: duration, release: 0.3, peak: 0.65 },
      filter: { type: 'lowpass', freq: 280, q: 1.1 },
    });
    return group([sub, rumble]);
  },
};
