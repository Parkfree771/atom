/**
 * Water tier-1 (Wave Field) — locked-in HIT sound: Small Droplet.
 * Volume tuned down per user request ("너무 크지 않게").
 */
import { playNoise, playOsc, group } from '../../../primitives';
import type { SoundVariant } from '../../../types';

export const waterTier1HitDroplet: SoundVariant = {
  id: 'water-t1-hit-01',
  label: '작은 물방울',
  description: '한 방울 플롭 — 피치 상승 버블감 (볼륨 톤다운)',
  play() {
    // Peak dropped 0.6 → 0.4, release shortened 0.1 → 0.08
    const drop = playOsc({
      type: 'sine',
      freq: 180,
      freqEnd: 520,
      env: { attack: 0.005, decay: 0.02, sustain: 0.35, hold: 0.025, release: 0.08, peak: 0.4 },
      filter: { type: 'lowpass', freq: 900, q: 1.2 },
    });
    const plop = playNoise({
      type: 'pink',
      duration: 0.08,
      env: { attack: 0.003, decay: 0.015, sustain: 0, release: 0.05, peak: 0.22 },
      filter: { type: 'lowpass', freq: 1000, q: 1.3 },
    });
    return group([drop, plop]);
  },
};
