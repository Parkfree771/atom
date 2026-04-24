/**
 * Light tier-1 (Laser Beam) — locked-in HIT sound: Shimmer.
 * Two close sines (3100 + 3160) for beating + triangle upper (6200).
 */
import { playOsc, group } from '../../../primitives';
import type { SoundVariant } from '../../../types';

export const lightTier1HitShimmer: SoundVariant = {
  id: 'light-t1-hit-04',
  label: '광채 쉬머',
  description: '빠르게 떨리는 고주파 — 반짝이는 느낌',
  play() {
    const a = playOsc({
      type: 'sine',
      freq: 3100,
      env: { attack: 0.003, decay: 0.02, sustain: 0.3, hold: 0.05, release: 0.15, peak: 0.35 },
    });
    const b = playOsc({
      type: 'sine',
      freq: 3160,
      env: { attack: 0.003, decay: 0.02, sustain: 0.3, hold: 0.05, release: 0.15, peak: 0.35 },
    });
    const upperA = playOsc({
      type: 'triangle',
      freq: 6200,
      env: { attack: 0.004, decay: 0.02, sustain: 0.18, hold: 0.05, release: 0.12, peak: 0.18 },
    });
    return group([a, b, upperA]);
  },
};
