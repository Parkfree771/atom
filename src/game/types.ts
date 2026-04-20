export interface Vec2 {
  x: number;
  y: number;
}

export type ElementType = '빛' | '암흑' | '흙' | '불' | '물' | '전기';

export const ELEMENT_COLORS: Record<ElementType, string> = {
  '빛': '#fef08a',
  '암흑': '#7c3aed',
  '흙': '#a16207',
  '불': '#ef4444',
  '물': '#3b82f6',
  '전기': '#a78bfa',
};

export const ALL_ELEMENTS: ElementType[] = ['빛', '암흑', '흙', '불', '물', '전기'];

export type EnemyType =
  | 'grunt' | 'runner' | 'tank'                     // 중립 (원소 없음)
  | 'fire' | 'water' | 'earth' | 'light' | 'electric' | 'dark'  // 원소 변종
  | 'boss_water' | 'boss_fire' | 'boss_earth'       // 원소 보스 (거대, 느림, 역공)
  | 'boss_light' | 'boss_electric' | 'boss_dark';

export interface EnemyConfig {
  type: EnemyType;
  speed: number;
  hp: number;          // base HP. 실제 HP는 spawn 시 wave 스케일 적용
  color: number;
  xp: number;
  width: number;       // 원형 렌더 기준 직경 (= 2 × radius)
  height: number;      // 히트박스 호환용 — 원형은 width와 동일 값
  label: string;
}

export const ENEMY_CONFIGS: Record<EnemyType, EnemyConfig> = {
  // ── 중립 (회갈색 톤) ──
  grunt:  { type: 'grunt',  speed: 0.6,  hp: 30,  color: 0x78716c, xp: 8,  width: 22, height: 22, label: '잔챙이' },
  runner: { type: 'runner', speed: 1.25, hp: 18,  color: 0x57534e, xp: 10, width: 16, height: 16, label: '추격자' },
  tank:   { type: 'tank',   speed: 0.4,  hp: 100, color: 0x44403c, xp: 20, width: 32, height: 32, label: '탱크' },
  // ── 원소 변종 (원소 색상, 중형) ──
  fire:     { type: 'fire',     speed: 0.65, hp: 50, color: 0xef4444, xp: 14, width: 22, height: 22, label: '화염체' },
  water:    { type: 'water',    speed: 0.7,  hp: 55, color: 0x3b82f6, xp: 14, width: 22, height: 22, label: '수침체' },
  earth:    { type: 'earth',    speed: 0.45, hp: 90, color: 0xa16207, xp: 18, width: 26, height: 26, label: '암석체' },
  light:    { type: 'light',    speed: 0.8,  hp: 40, color: 0xfde047, xp: 14, width: 20, height: 20, label: '광체' },
  electric: { type: 'electric', speed: 0.9,  hp: 45, color: 0xa78bfa, xp: 16, width: 20, height: 20, label: '뇌체' },
  dark:     { type: 'dark',     speed: 0.55, hp: 130, color: 0x7c3aed, xp: 22, width: 28, height: 28, label: '암흑체' },
  // ── 원소 보스 (매우 거대 + 매우 느림 + 역공격) ──
  // HP는 base 값 → 실제 스폰 시 웨이브 스케일로 추가 강화됨. width/height는 렌더용 직경.
  boss_water:    { type: 'boss_water',    speed: 0.18, hp: 3500, color: 0x1d4ed8, xp: 300, width: 120, height: 120, label: '해일의 군주' },
  boss_fire:     { type: 'boss_fire',     speed: 0.20, hp: 3200, color: 0xdc2626, xp: 300, width: 115, height: 115, label: '화염의 군주' },
  boss_earth:    { type: 'boss_earth',    speed: 0.14, hp: 4500, color: 0x92400e, xp: 320, width: 140, height: 140, label: '대지의 군주' },
  boss_light:    { type: 'boss_light',    speed: 0.22, hp: 2800, color: 0xeab308, xp: 300, width: 110, height: 110, label: '광휘의 군주' },
  boss_electric: { type: 'boss_electric', speed: 0.24, hp: 2600, color: 0x7c3aed, xp: 300, width: 110, height: 110, label: '뇌전의 군주' },
  boss_dark:     { type: 'boss_dark',     speed: 0.16, hp: 4000, color: 0x4c1d95, xp: 320, width: 130, height: 130, label: '심연의 군주' },
};

export function isBossType(t: EnemyType): boolean {
  return t === 'boss_water' || t === 'boss_fire' || t === 'boss_earth'
    || t === 'boss_light' || t === 'boss_electric' || t === 'boss_dark';
}

export const BOSS_TO_ELEMENT: Partial<Record<EnemyType, ElementType>> = {
  boss_water: '물', boss_fire: '불', boss_earth: '흙',
  boss_light: '빛', boss_electric: '전기', boss_dark: '암흑',
};

export type WeaponEffectType = 'projectile' | 'aura' | 'beam' | 'explosion' | 'lightning' | 'wave';

export interface WeaponDef {
  name: string;
  elements: string; // sorted joined key e.g. "불,빛,흙"
  effectType: WeaponEffectType;
  damage: number;
  color: number;
  interval: number; // frames between activations
  description: string;
  uniqueId?: string; // unique renderer key for S/SS tier weapons
}

export interface WeaponSlotState {
  elements: (ElementType | null)[]; // [null, null, null]
  weapon: WeaponDef | null; // set when 3 elements combined
  weaponTimer: number;
}

export interface ElementOrbState {
  x: number;
  y: number;
  element: ElementType;
  life: number;
  maxLife: number;
  active: boolean;
}

export interface PlayerStats {
  /** 경험치 획득 배수 */
  xpGainMul: number;
  /** 기본 공격 / 무기 데미지 배수 */
  damageMul: number;
  /** 공격 속도 배수 (interval을 나눔) */
  atkSpeedMul: number;
  /** 크리티컬 확률 0~1 */
  critChance: number;
}

export function createDefaultStats(): PlayerStats {
  return { xpGainMul: 1.0, damageMul: 1.0, atkSpeedMul: 1.0, critChance: 0 };
}

export interface PlayerState {
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  speed: number;
  xp: number;
  level: number;
  xpToNext: number;
  invincibleFrames: number;
  weaponSlots: WeaponSlotState[];
  activeSlotIndex: number;
  kills: number;
  score: number;
  comboCount: number;
  comboTimer: number;
  stats: PlayerStats;
  skills: SkillState;
}

// ── 액티브 스킬 ──
// 원소 보스 처치 시 해금. 쿨타임 재사용. Q 키로 발동.
export type SkillId = 'water_tidal' | 'fire_inferno' | 'earth_quake' | 'light_judgment' | 'electric_storm' | 'dark_abyss';

export interface SkillSlot {
  unlocked: boolean;
  cooldown: number;      // 현재 쿨다운 남은 frames
  maxCooldown: number;   // 풀 쿨타임
}

export interface SkillState {
  water_tidal: SkillSlot;
  fire_inferno: SkillSlot;
  earth_quake: SkillSlot;
  light_judgment: SkillSlot;
  electric_storm: SkillSlot;
  dark_abyss: SkillSlot;
}

export function createDefaultSkills(): SkillState {
  const mk = (maxCd: number): SkillSlot => ({ unlocked: false, cooldown: 0, maxCooldown: maxCd });
  return {
    water_tidal:     mk(600),  // 10s
    fire_inferno:    mk(600),
    earth_quake:     mk(600),
    light_judgment:  mk(600),
    electric_storm:  mk(600),
    dark_abyss:      mk(600),
  };
}

// ── 적 발사체 (보스 역공격) ──
export interface EnemyProjectileState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  damage: number;
  life: number;     // remaining frames
  color: number;
  active: boolean;
  /** 보스 공격 variant (랜더·물리 분기). 기본 undefined=일반 투사체. */
  variant?:
    | 'water_wave'       // 큰 물방울
    | 'water_ring'       // 파동 링 조각
    | 'water_puddle'     // 지연 후 폭발 (바닥 마커)
    | 'water_wavefront'  // 사인파 진행 (sine oscillation)
    | 'fire_ball'        // 화염구
    | 'fire_spiral'      // 회전 spiral
    | 'fire_meteor'      // 하늘 낙하 (예고 후)
    | 'earth_rock'       // 큰 돌덩이 (느림, 큰 피해)
    | 'earth_shard'      // 작은 파편
    | 'earth_rupture'    // 지연 균열 폭발
    | 'electric_bolt'    // 직선 번개 (빠름)
    | 'electric_arc'     // 방사 스파크
    | 'electric_orb'     // 추적 구체
    | 'light_ray'        // 레이저 빔
    | 'light_holy'       // 방사 광선
    | 'light_judgment'   // 지연 수직 광선
    | 'dark_tendril'     // 촉수 (휘는 궤적)
    | 'dark_void'        // 검은 구체
    | 'dark_portal';     // 포털 스폰 마커
  /** 지연 투사체: 타이머 끝나면 실제 activate (착탄 대미지) — delay 동안은 예고/마커만 렌더 */
  delay?: number;
  /** 추적 투사체용: 가속 */
  homing?: boolean;
  /** 초기 생성 시 각도 (tendril 회전용) */
  spinAngle?: number;
  /** 스핀 속도 (tendril) */
  spinSpeed?: number;
  /** 사인파 이동: 직진 방향에 수직하는 sin 오실레이션 */
  waveBaseVx?: number;
  waveBaseVy?: number;
  wavePerpX?: number;
  wavePerpY?: number;
  waveAmp?: number;        // px 단위 피크 변위
  wavePhase?: number;      // 현재 위상
  wavePhaseSpeed?: number; // 프레임당 위상 증가
  /** 소멸/폭발 시 radial 서브-투사체 방출 (resonance lock 등) */
  onExpireSpawnCount?: number;
  onExpireSpawnSpeed?: number;
  onExpireSpawnLife?: number;
  onExpireSpawnRadius?: number;
  onExpireSpawnDamage?: number;
  onExpireSpawnColor?: number;
  onExpireSpawnVariant?: EnemyProjectileState['variant'];
}

// ── 레벨업 이벤트 시스템 ──
export type LevelEventKind = 'element_select' | 'element_place' | 'stat_upgrade';

export interface StatUpgradeChoice {
  id: string;
  icon: string;
  label: string;
  description: string;
}

export interface LevelEvent {
  kind: LevelEventKind;
  level: number;
  /** element_select / element_place: 플레이어에게 보여줄 랜덤 후보 (3장) */
  elementChoices?: ElementType[];
  /** element_select: 고정 타겟 무기 슬롯 (0/1/2) */
  targetWeaponIndex?: number;
  /** element_place: 현재 슬롯 스냅샷 (UI가 빈 칸 시각화에 사용) */
  slotsSnapshot?: (ElementType | null)[][];
  /** stat_upgrade: 3~4개 선택지 */
  statChoices?: StatUpgradeChoice[];
}

export type LevelEventResolution =
  | { kind: 'element_select'; element: ElementType }
  | { kind: 'element_place'; element: ElementType; weaponIndex: number; slotIndex: number }
  | { kind: 'stat_upgrade'; choiceId: string };

export interface EnemyState {
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  speed: number;
  type: EnemyType;
  color: number;
  xp: number;
  width: number;
  height: number;
  active: boolean;
  angle: number;
  /** 스턴 잔여 프레임 — 0보다 크면 이동 정지 (운석/기타 CC 효과) */
  stunFrames?: number;
  /** 보스 역공격 쿨다운 (frames) — 0이 되면 발사 */
  bossAttackTimer?: number;
}

export interface ProjectileState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  speed: number;
  damage: number;
  color: number;
  radius: number;
  active: boolean;
  lifetime: number;
  maxLifetime: number;
  pierce: number;
  elementType?: ElementType;        // 원소 타입 (렌더링 분기용)
  onHitEffect?: 'fire_splash';     // 적중 시 특수 효과
}

export interface XPOrbState {
  x: number;
  y: number;
  value: number;
  active: boolean;
}

export interface ParticleState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: number;
  size: number;
  active: boolean;
}

export interface GameState {
  player: PlayerState;
  enemies: EnemyState[];
  projectiles: ProjectileState[];
  enemyProjectiles: EnemyProjectileState[];
  xpOrbs: XPOrbState[];
  elementOrbs: ElementOrbState[];
  particles: ParticleState[];
  wave: number;
  waveTimer: number; // frames
  frameCount: number;
  autoAttackTimer: number;
  paused: boolean;
  gameOver: boolean;
  cameraX: number;
  cameraY: number;
  shakeX: number;
  shakeY: number;
  shakeFrames: number;
  waveAnnounceTimer: number;
  comboDisplayTimer: number;
  comboDisplayCount: number;
  weaponEffects: WeaponEffectState[];
  beamAngles: number[]; // per-slot beam angle
  levelUpTextTimer: number;
  /** 처리 대기 중인 레벨업 이벤트. null이면 없음. 값이 있으면 game is paused. */
  pendingLevelEvent: LevelEvent | null;
}

export interface WeaponEffectState {
  type: WeaponEffectType;
  uniqueId?: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  damage: number;
  color: number;
  life: number;
  maxLife: number;
  active: boolean;
  angle: number;
  hitEnemies: Set<number>;
}

// 모바일 가로모드(landscape phone) 기준 16:9 비율. 960×540 = 현재 정사각 720²와 유사한 가시 면적.
export const CANVAS_W = 960;
export const CANVAS_H = 540;
export const WORLD_W = 2000;
export const WORLD_H = 2000;
export const PICKUP_RANGE = 50;
export const ELEMENT_ORB_PICKUP_RANGE = 20;
export const INVINCIBLE_FRAMES = 60;
export const WAVE_DURATION = 30 * 60; // 30 seconds at 60fps
export const AUTO_ATTACK_INTERVAL = 30;
export const PLAYER_SPEED = 2;
export const PLAYER_WIDTH = 22;
export const PLAYER_HEIGHT = 14;
export const ELEMENT_ORB_DROP_CHANCE = 0.3;
export const ELEMENT_ORB_LIFETIME = 30 * 60; // 30 seconds at 60fps
