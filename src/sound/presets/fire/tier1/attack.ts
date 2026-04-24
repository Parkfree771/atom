/**
 * Fire tier-1 (Flamethrower) — locked-in ATTACK sound: Gas Torch.
 * Original 6-candidate set was pruned after user selection.
 */
import { playNoise, playOsc, group } from '../../../primitives';
import type { SoundVariant } from '../../../types';

const DEFAULT_DUR = 2.5;

export const fireTier1AttackGasTorch: SoundVariant = {
  id: 'fire-t1-atk-01',
  label: '가스 토치',
  description: '묵직한 프로판 토치 저음',
  play(duration = DEFAULT_DUR) {
    const body = playNoise({
      type: 'brown',
      duration: 1,
      loop: true,
      env: { attack: 0.05, decay: 0.08, sustain: 0.55, hold: duration, release: 0.18, peak: 0.75 },
      filter: { type: 'lowpass', freq: 650, q: 1.2 },
    });
    const sub = playOsc({
      type: 'sawtooth',
      freq: 55,
      env: { attack: 0.08, decay: 0.1, sustain: 0.18, hold: duration, release: 0.15, peak: 0.22 },
      filter: { type: 'lowpass', freq: 120, q: 0.7 },
    });
    return group([body, sub]);
  },
};
