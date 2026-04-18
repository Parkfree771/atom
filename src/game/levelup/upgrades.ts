import { PlayerState, StatUpgradeChoice } from '../types';

// 스탯 강화 풀. 풀에서 무작위로 3~4개 뽑아 선택지로 제시한다.
// 모든 업그레이드는 player 객체에 대해 in-place로 효과를 적용한다.
interface UpgradeDef extends StatUpgradeChoice {
  apply: (player: PlayerState) => void;
}

export const UPGRADE_POOL: UpgradeDef[] = [
  {
    id: 'hp_flat_20',
    icon: '❤️',
    label: '최대 체력 +20',
    description: '최대 체력을 20 늘리고 20 회복한다.',
    apply: (p) => {
      p.maxHp += 20;
      p.hp = Math.min(p.maxHp, p.hp + 20);
    },
  },
  {
    id: 'hp_pct_10',
    icon: '🫀',
    label: '최대 체력 +10%',
    description: '최대 체력을 10% 증가시킨다.',
    apply: (p) => {
      const inc = Math.round(p.maxHp * 0.1);
      p.maxHp += inc;
      p.hp = Math.min(p.maxHp, p.hp + inc);
    },
  },
  {
    id: 'heal_full',
    icon: '✨',
    label: '완전 회복',
    description: '현재 체력을 최대치로 회복한다.',
    apply: (p) => {
      p.hp = p.maxHp;
    },
  },
  {
    id: 'speed_03',
    icon: '🏃',
    label: '이동 속도 +0.3',
    description: '이동 속도를 0.3 늘린다.',
    apply: (p) => {
      p.speed += 0.3;
    },
  },
  {
    id: 'speed_pct_10',
    icon: '👟',
    label: '이동 속도 +10%',
    description: '이동 속도를 10% 증가시킨다.',
    apply: (p) => {
      p.speed *= 1.1;
    },
  },
  {
    id: 'xp_gain_20',
    icon: '💎',
    label: '경험치 획득 +20%',
    description: '적 처치 시 얻는 경험치를 20% 더 받는다.',
    apply: (p) => {
      p.stats.xpGainMul *= 1.2;
    },
  },
  {
    id: 'damage_10',
    icon: '🗡️',
    label: '공격력 +10%',
    description: '모든 공격 데미지를 10% 증가시킨다.',
    apply: (p) => {
      p.stats.damageMul *= 1.1;
    },
  },
  {
    id: 'atk_speed_10',
    icon: '⚡',
    label: '공격 속도 +10%',
    description: '무기 발동 주기를 10% 단축한다.',
    apply: (p) => {
      p.stats.atkSpeedMul *= 1.1;
    },
  },
  {
    id: 'crit_5',
    icon: '🎯',
    label: '크리티컬 +5%',
    description: '크리티컬 확률을 5%p 증가시킨다 (상한 80%).',
    apply: (p) => {
      p.stats.critChance = Math.min(0.8, p.stats.critChance + 0.05);
    },
  },
];

const UPGRADE_MAP = new Map(UPGRADE_POOL.map((u) => [u.id, u]));

/** 스탯 업그레이드 풀에서 N개 무작위로 뽑아 선택지로 반환. 중복 없음. */
export function rollStatChoices(count: number = 3): StatUpgradeChoice[] {
  const shuffled = [...UPGRADE_POOL].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count).map(({ id, icon, label, description }) => ({
    id, icon, label, description,
  }));
}

/** 선택된 업그레이드를 player에 적용. */
export function applyStatChoice(player: PlayerState, choiceId: string): void {
  const def = UPGRADE_MAP.get(choiceId);
  if (def) def.apply(player);
}
