/**
 * Dark tier-1 (Mini Gravity Well) — locked-in HIT sound: Swallowed Whisper.
 * Soft-attack, muffled low-pass sine — feels distant, absorbed by the well.
 */
import { playOsc, group } from '../../../primitives';
import type { SoundVariant } from '../../../types';

export const darkTier1HitSwallowed: SoundVariant = {
  id: 'dark-t1-hit-04',
  label: '삼켜진 속삭임',
  description: '멀리서 들리는 듯한 감쇠된 저음 임팩트',
  play() {
    const muffled = playOsc({
      type: 'sine',
      freq: 90,
      env: { attack: 0.08, decay: 0.04, sustain: 0.55, hold: 0.06, release: 0.22, peak: 0.55 },
      filter: { type: 'lowpass', freq: 180, q: 1.3 },
    });
    const lower = playOsc({
      type: 'sine',
      freq: 45,
      env: { attack: 0.08, decay: 0.04, sustain: 0.45, hold: 0.06, release: 0.22, peak: 0.4 },
    });
    return group([muffled, lower]);
  },
};
