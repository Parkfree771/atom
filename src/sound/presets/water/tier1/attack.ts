/**
 * Water tier-1 (Wave Field) — locked-in ATTACK sound: Wave Undulation.
 * Bandpass 500→1100 sweep on pink noise + brown lowpass 320 for body.
 */
import { playNoise, group } from '../../../primitives';
import type { SoundVariant } from '../../../types';

const DEFAULT_DUR = 2.5;

export const waterTier1AttackWaveUndulation: SoundVariant = {
  id: 'water-t1-atk-02',
  label: '일렁이는 파도',
  description: '해변의 잔물결 — 서서히 올라갔다 내려오는 필터',
  play(duration = DEFAULT_DUR) {
    const wave = playNoise({
      type: 'pink',
      duration: 1,
      loop: true,
      env: { attack: 0.35, decay: 0.15, sustain: 0.55, hold: duration, release: 0.35, peak: 0.6 },
      filter: { type: 'bandpass', freq: 500, q: 1.4, freqEnd: 1100 },
    });
    const lower = playNoise({
      type: 'brown',
      duration: 1,
      loop: true,
      env: { attack: 0.35, decay: 0.15, sustain: 0.35, hold: duration, release: 0.35, peak: 0.4 },
      filter: { type: 'lowpass', freq: 320, q: 0.9 },
    });
    return group([wave, lower]);
  },
};
