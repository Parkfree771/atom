import { GameState, EnemyType, PlayerState } from './types';
import { spawnEnemy } from './entities';

/**
 * 몬스터 상한: 무한 스폰 컨셉이지만 렌더/충돌 부하 때문에 최종 캡은 500.
 *
 * 스케일 축:
 *  - 기본 베이스: 40
 *  - 레벨 보너스: level * 1.5 (상한 +200 @ Lv.135)
 *  - **원소 보너스**: 채워진 원소 칸 수(0~9) × 25 → 9칸 다 채우면 +225 (핵심 축)
 *  - 웨이브 보너스: 난이도 변화 여지용 wave * 10
 *
 * 목표 곡선 (원소 칸 기준):
 *   0칸 (Lv 1~9):   40~55
 *   3칸 (Lv 10~30): 80~130
 *   6칸 (Lv 40~70): 220~330
 *   9칸 (Lv 90~):   400~500 (상한)
 */
const POOL_SIZE = 800;
const HARD_CAP = 500;

function countFilledElementSlots(player: PlayerState): number {
  let n = 0;
  for (const slot of player.weaponSlots) {
    for (const el of slot.elements) {
      if (el !== null) n++;
    }
  }
  return n;
}

export function getMaxEnemies(state: GameState): number {
  const elemCount = countFilledElementSlots(state.player);
  const base = 40;
  const levelBonus = Math.min(state.player.level * 1.5, 200);
  const elemBonus = elemCount * 25;
  const waveBonus = state.wave * 10;
  return Math.min(HARD_CAP, Math.floor(base + levelBonus + elemBonus + waveBonus));
}

/** 프레임 사이 스폰 간격. 원소/레벨 진행에 따라 짧아진다. */
function getSpawnInterval(state: GameState): number {
  const elemCount = countFilledElementSlots(state.player);
  const raw = 30 - elemCount * 2 - Math.floor(state.player.level / 10);
  return Math.max(3, raw);
}

/** 한 번 스폰할 때 뿌릴 수. 진행도에 비례. */
function getBatchSize(state: GameState): number {
  const elemCount = countFilledElementSlots(state.player);
  const levelTerm = Math.floor(state.player.level / 20);
  return Math.min(12, 2 + elemCount + levelTerm);
}

/**
 * 웨이브별 적 타입 해금 테이블 + 가중치.
 * 진행 감각: 중립만 → 물/불 변종 → 흙/빛 변종 → 전기/암흑 + 엘리트.
 * Lv 30(≈W11 전후) 이후 모든 타입 풀리며 호드 재미.
 */
interface TypeWeight { type: EnemyType; weight: number; }

function getSpawnTable(wave: number): TypeWeight[] {
  if (wave <= 3) {
    // 초반: 잔챙이 위주 + 간혹 추격자
    return [
      { type: 'grunt', weight: 7 },
      { type: 'runner', weight: 3 },
    ];
  }
  if (wave <= 6) {
    // W4~6: 물/불 변종 등장 + 탱크 소량
    return [
      { type: 'grunt', weight: 5 },
      { type: 'runner', weight: 3 },
      { type: 'tank', weight: 1 },
      { type: 'fire', weight: 2 },
      { type: 'water', weight: 2 },
    ];
  }
  if (wave <= 10) {
    // W7~10: 흙/빛 추가
    return [
      { type: 'grunt', weight: 4 },
      { type: 'runner', weight: 3 },
      { type: 'tank', weight: 2 },
      { type: 'fire', weight: 2 },
      { type: 'water', weight: 2 },
      { type: 'earth', weight: 2 },
      { type: 'light', weight: 2 },
    ];
  }
  // W11+: 전기/암흑까지 전 속성. 중립 비중 낮추고 원소 비중↑ = 호드 파티
  return [
    { type: 'grunt', weight: 3 },
    { type: 'runner', weight: 2 },
    { type: 'tank', weight: 2 },
    { type: 'fire', weight: 3 },
    { type: 'water', weight: 3 },
    { type: 'earth', weight: 3 },
    { type: 'light', weight: 3 },
    { type: 'electric', weight: 3 },
    { type: 'dark', weight: 2 },
  ];
}

function pickEnemyType(wave: number): EnemyType {
  const table = getSpawnTable(wave);
  const total = table.reduce((s, t) => s + t.weight, 0);
  let r = Math.random() * total;
  for (const entry of table) {
    r -= entry.weight;
    if (r <= 0) return entry.type;
  }
  return table[0].type;
}

export function spawnWaveEnemies(state: GameState) {
  const { frameCount, player, enemies, wave } = state;
  const interval = getSpawnInterval(state);
  if (frameCount % interval !== 0) return;

  let activeCount = 0;
  for (let i = 0; i < enemies.length; i++) {
    if (enemies[i].active) activeCount++;
  }
  const max = getMaxEnemies(state);
  if (activeCount >= max) return;

  const batchSize = getBatchSize(state);
  for (let i = 0; i < batchSize && activeCount < max; i++) {
    const type = pickEnemyType(wave);
    spawnEnemy(enemies, type, player.x, player.y, state.cameraX, state.cameraY, wave);
    activeCount++;
  }
}

export { POOL_SIZE as ENEMY_POOL_SIZE };
