/**
 * Light tier-1 (Laser Beam) — locked-in ATTACK sound: Charge + Release.
 * CC0 sample from OpenGameArt. Triggered on CHARGING phase start so release aligns
 * with the beam-fire visual.
 */
import { playSample } from '../../../samplePlayer';
import type { SoundVariant } from '../../../types';

export const lightTier1AttackCharge: SoundVariant = {
  id: 'light-t1-atk-01',
  label: '차지 + 방전',
  description: '빛 입자 모이기 → 방출 (샘플 길이 8s, 사이클마다 재시작)',
  play() {
    return playSample(
      'light-atk-charge',
      '/sounds/light/tier1/attacks/chargestart.wav',
      { volume: 0.85 },
    );
  },
};
