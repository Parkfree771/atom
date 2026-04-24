/**
 * Earth tier-1 (Quicksand Field) — locked-in HIT sound: Earth Thud.
 * Original 6-candidate set was pruned after user selection.
 */
import { playNoise, playOsc, group } from '../../../primitives';
import type { SoundVariant } from '../../../types';

export const earthTier1HitThud: SoundVariant = {
  id: 'earth-t1-hit-02',
  label: '흙더미 쿵',
  description: '묵직한 흙 덩어리가 떨어지는 저음 임팩트',
  play() {
    const thud = playOsc({
      type: 'sine',
      freq: 90,
      freqEnd: 30,
      env: { attack: 0.002, decay: 0.05, sustain: 0, release: 0.22, peak: 0.85 },
      filter: { type: 'lowpass', freq: 200, q: 1 },
    });
    const body = playNoise({
      type: 'brown',
      duration: 0.3,
      env: { attack: 0.005, decay: 0.04, sustain: 0.4, hold: 0.04, release: 0.18, peak: 0.6 },
      filter: { type: 'lowpass', freq: 550, q: 1.2 },
    });
    return group([thud, body]);
  },
};
