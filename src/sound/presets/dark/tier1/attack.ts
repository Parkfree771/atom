/**
 * Dark tier-1 (Mini Gravity Well) — locked-in ATTACK sound: Void Growl.
 * Triangle 38→44Hz pitch wobble + sine 80→72Hz, all pure-tone low drone.
 */
import { playOsc, group } from '../../../primitives';
import type { SoundVariant } from '../../../types';

const DEFAULT_DUR = 2.5;

export const darkTier1AttackVoidGrowl: SoundVariant = {
  id: 'dark-t1-atk-06',
  label: '공허의 그라울',
  description: '묵직한 저주파 그라울 + 느린 피치 흔들림',
  play(duration = DEFAULT_DUR) {
    const core = playOsc({
      type: 'triangle',
      freq: 38,
      freqEnd: 44,
      env: { attack: 0.5, decay: 0.15, sustain: 0.55, hold: duration, release: 0.4, peak: 0.6 },
      filter: { type: 'lowpass', freq: 140, q: 0.9 },
    });
    const wobble = playOsc({
      type: 'sine',
      freq: 80,
      freqEnd: 72,
      env: { attack: 0.5, decay: 0.15, sustain: 0.35, hold: duration, release: 0.4, peak: 0.35 },
      filter: { type: 'lowpass', freq: 180, q: 0.7 },
    });
    return group([core, wobble]);
  },
};
