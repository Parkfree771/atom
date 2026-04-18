import {
  PlayerState, EnemyState, EnemyProjectileState, ProjectileState, XPOrbState, ElementOrbState,
  EnemyType, ElementType, ENEMY_CONFIGS, PLAYER_SPEED,
  WORLD_W, WORLD_H, CANVAS_W, CANVAS_H, PICKUP_RANGE,
  ELEMENT_ORB_PICKUP_RANGE, ELEMENT_ORB_LIFETIME, ALL_ELEMENTS,
  createDefaultStats, createDefaultSkills,
} from './types';

export function createPlayer(): PlayerState {
  return {
    x: WORLD_W / 2,
    y: WORLD_H / 2,
    hp: 100,
    maxHp: 100,
    speed: PLAYER_SPEED,
    xp: 0,
    level: 1,
    xpToNext: 18,
    invincibleFrames: 0,
    weaponSlots: [
      { elements: [null, null, null], weapon: null, weaponTimer: 0 },
      { elements: [null, null, null], weapon: null, weaponTimer: 0 },
      { elements: [null, null, null], weapon: null, weaponTimer: 0 },
    ],
    activeSlotIndex: 0,
    kills: 0,
    score: 0,
    comboCount: 0,
    comboTimer: 0,
    stats: createDefaultStats(),
    skills: createDefaultSkills(),
  };
}

export function createEnemyProjectilePool(size: number): EnemyProjectileState[] {
  const pool: EnemyProjectileState[] = [];
  for (let i = 0; i < size; i++) {
    pool.push({ x: 0, y: 0, vx: 0, vy: 0, radius: 8, damage: 0, life: 0, color: 0xffffff, active: false });
  }
  return pool;
}

export function createEnemyPool(size: number): EnemyState[] {
  const pool: EnemyState[] = [];
  for (let i = 0; i < size; i++) {
    pool.push({
      x: 0, y: 0, hp: 0, maxHp: 0, speed: 0,
      type: 'grunt', color: 0, xp: 0,
      width: 0, height: 0, active: false, angle: 0,
    });
  }
  return pool;
}

export function spawnEnemy(pool: EnemyState[], type: EnemyType, playerX: number, playerY: number, cameraX: number, cameraY: number, wave: number = 1): boolean {
  const cfg = ENEMY_CONFIGS[type];
  let slot: EnemyState | null = null;
  for (const e of pool) {
    if (!e.active) { slot = e; break; }
  }
  if (!slot) return false;

  // Spawn from edges of visible area + margin
  const margin = 60;
  const side = Math.floor(Math.random() * 4);
  let sx: number, sy: number;
  const vl = cameraX;
  const vr = cameraX + CANVAS_W;
  const vt = cameraY;
  const vb = cameraY + CANVAS_H;

  switch (side) {
    case 0: // top
      sx = vl + Math.random() * CANVAS_W;
      sy = vt - margin;
      break;
    case 1: // bottom
      sx = vl + Math.random() * CANVAS_W;
      sy = vb + margin;
      break;
    case 2: // left
      sx = vl - margin;
      sy = vt + Math.random() * CANVAS_H;
      break;
    default: // right
      sx = vr + margin;
      sy = vt + Math.random() * CANVAS_H;
      break;
  }

  // Clamp to world bounds
  sx = Math.max(0, Math.min(WORLD_W, sx));
  sy = Math.max(0, Math.min(WORLD_H, sy));

  // 웨이브 스케일링: hp = baseHP × (1 + wave × 0.25). 웨이브가 올라갈수록 단단해짐.
  const scaledHp = Math.round(cfg.hp * (1 + wave * 0.25));
  slot.x = sx;
  slot.y = sy;
  slot.hp = scaledHp;
  slot.maxHp = scaledHp;
  slot.speed = cfg.speed;
  slot.type = cfg.type;
  slot.color = cfg.color;
  slot.xp = cfg.xp;
  slot.width = cfg.width;
  slot.height = cfg.height;
  slot.active = true;
  slot.angle = Math.atan2(playerY - sy, playerX - sx);
  slot.stunFrames = 0;
  slot.bossAttackTimer = type.startsWith('boss_') ? 120 : undefined;
  return true;
}

// ── separation(분리) 파라미터 ──
// 완전 겹침은 막지만 약간의 중첩은 허용 (뭉치지 않을 만큼만).
const SEPARATION_CELL = 40;
const SEPARATION_MIN_DIST = 20; // 중심점 간 최소 거리 (이보다 가까우면 서로 민다)
const SEPARATION_STRENGTH = 0.5; // 1.0이면 완전 분리, 0.5면 겹침 일부 허용

// hot path 재사용 버퍼 — 프레임당 수백 적이라 새 Map 할당 최소화
const _sepGrid: Map<number, number[]> = new Map();
const _sepBucketPool: number[][] = [];
let _sepBucketUsed = 0;

function _acquireBucket(): number[] {
  if (_sepBucketUsed < _sepBucketPool.length) {
    const arr = _sepBucketPool[_sepBucketUsed++];
    arr.length = 0;
    return arr;
  }
  const arr: number[] = [];
  _sepBucketPool.push(arr);
  _sepBucketUsed++;
  return arr;
}

function _resetSepGrid() {
  _sepGrid.clear();
  _sepBucketUsed = 0;
}

function _cellKey(cx: number, cy: number): number {
  // y 범위가 음수일 수 있으니 offset. 월드 -5000~5000 범위 가정.
  return (cx + 1000) * 10000 + (cy + 1000);
}

export function updateEnemies(enemies: EnemyState[], playerX: number, playerY: number) {
  // 1) 분리용 그리드 구축
  _resetSepGrid();
  const cell = SEPARATION_CELL;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (!e.active) continue;
    const cx = Math.floor(e.x / cell);
    const cy = Math.floor(e.y / cell);
    const key = _cellKey(cx, cy);
    let bucket = _sepGrid.get(key);
    if (!bucket) {
      bucket = _acquireBucket();
      _sepGrid.set(key, bucket);
    }
    bucket.push(i);
  }

  // 2) 이동 + 분리 푸시
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (!e.active) continue;

    // 스턴이면 이동/분리 스킵하고 카운터만 감소
    if (e.stunFrames && e.stunFrames > 0) {
      e.stunFrames--;
      continue;
    }

    // 분리 푸시 계산 (주변 3×3 셀 탐색)
    let pushX = 0;
    let pushY = 0;
    const cx = Math.floor(e.x / cell);
    const cy = Math.floor(e.y / cell);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const bucket = _sepGrid.get(_cellKey(cx + ox, cy + oy));
        if (!bucket) continue;
        for (let b = 0; b < bucket.length; b++) {
          const j = bucket[b];
          if (j === i) continue;
          const other = enemies[j];
          const ddx = e.x - other.x;
          const ddy = e.y - other.y;
          const dsq = ddx * ddx + ddy * ddy;
          if (dsq > SEPARATION_MIN_DIST * SEPARATION_MIN_DIST) continue;
          const d = Math.sqrt(dsq);
          if (d < 0.01) {
            // 완전 겹침 — 임의 방향으로 살짝 밀기
            pushX += (Math.random() - 0.5) * SEPARATION_MIN_DIST * SEPARATION_STRENGTH;
            pushY += (Math.random() - 0.5) * SEPARATION_MIN_DIST * SEPARATION_STRENGTH;
            continue;
          }
          const overlap = SEPARATION_MIN_DIST - d;
          pushX += (ddx / d) * overlap * SEPARATION_STRENGTH;
          pushY += (ddy / d) * overlap * SEPARATION_STRENGTH;
        }
      }
    }

    // 플레이어 추적 속도
    const dx = playerX - e.x;
    const dy = playerY - e.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    let seekX = 0, seekY = 0;
    if (dist > 0.5) {
      seekX = (dx / dist) * e.speed;
      seekY = (dy / dist) * e.speed;
      e.angle = Math.atan2(dy, dx);
    }

    e.x += seekX + pushX;
    e.y += seekY + pushY;
  }
}

export function createProjectilePool(size: number): ProjectileState[] {
  const pool: ProjectileState[] = [];
  for (let i = 0; i < size; i++) {
    pool.push({
      x: 0, y: 0, vx: 0, vy: 0, speed: 5,
      damage: 10, color: 0xFFFFFF, radius: 4,
      active: false, lifetime: 0, maxLifetime: 120, pierce: 0,
    });
  }
  return pool;
}

export function fireProjectile(
  pool: ProjectileState[], x: number, y: number,
  tx: number, ty: number, damage: number, color: number,
  speed: number = 5, radius: number = 4, pierce: number = 0
): boolean {
  let slot: ProjectileState | null = null;
  for (const p of pool) {
    if (!p.active) { slot = p; break; }
  }
  if (!slot) return false;

  const dx = tx - x;
  const dy = ty - y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 0.1) return false;

  slot.x = x;
  slot.y = y;
  slot.vx = (dx / dist) * speed;
  slot.vy = (dy / dist) * speed;
  slot.speed = speed;
  slot.damage = damage;
  slot.color = color;
  slot.radius = radius;
  slot.active = true;
  slot.lifetime = 0;
  slot.maxLifetime = 120;
  slot.pierce = pierce;
  return true;
}

export function updateProjectiles(pool: ProjectileState[]) {
  for (const p of pool) {
    if (!p.active) continue;
    p.x += p.vx;
    p.y += p.vy;
    p.lifetime++;
    if (p.lifetime > p.maxLifetime || p.x < -50 || p.x > WORLD_W + 50 || p.y < -50 || p.y > WORLD_H + 50) {
      p.active = false;
    }
  }
}

const MAX_XP_ORBS = 300;

export function createXPOrbPool(): XPOrbState[] {
  const pool: XPOrbState[] = [];
  for (let i = 0; i < MAX_XP_ORBS; i++) {
    pool.push({ x: 0, y: 0, value: 0, active: false });
  }
  return pool;
}

export function spawnXPOrb(pool: XPOrbState[], x: number, y: number, value: number) {
  for (const o of pool) {
    if (!o.active) {
      o.x = x + (Math.random() - 0.5) * 10;
      o.y = y + (Math.random() - 0.5) * 10;
      o.value = value;
      o.active = true;
      return;
    }
  }
}

export function updateXPOrbs(pool: XPOrbState[], player: PlayerState): number {
  let collected = 0;
  for (const o of pool) {
    if (!o.active) continue;
    const dx = player.x - o.x;
    const dy = player.y - o.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < PICKUP_RANGE) {
      // Float toward player
      const speed = 4;
      o.x += (dx / dist) * speed;
      o.y += (dy / dist) * speed;
      if (dist < 10) {
        player.xp += o.value;
        player.score += o.value;
        collected += o.value;
        o.active = false;
      }
    }
  }
  return collected;
}

// --- Element Orb Pool ---

const MAX_ELEMENT_ORBS = 100;

export function createElementOrbPool(): ElementOrbState[] {
  const pool: ElementOrbState[] = [];
  for (let i = 0; i < MAX_ELEMENT_ORBS; i++) {
    pool.push({ x: 0, y: 0, element: '불', life: 0, maxLife: 0, active: false });
  }
  return pool;
}

export function spawnElementOrb(pool: ElementOrbState[], x: number, y: number, element: ElementType) {
  for (const o of pool) {
    if (!o.active) {
      o.x = x + (Math.random() - 0.5) * 20;
      o.y = y + (Math.random() - 0.5) * 20;
      o.element = element;
      o.life = ELEMENT_ORB_LIFETIME;
      o.maxLife = ELEMENT_ORB_LIFETIME;
      o.active = true;
      return;
    }
  }
}

export function spawnRandomElementOrb(pool: ElementOrbState[], x: number, y: number) {
  const element = ALL_ELEMENTS[Math.floor(Math.random() * ALL_ELEMENTS.length)];
  spawnElementOrb(pool, x, y, element);
}

/** Update element orbs: decrement life, check pickup (no magnet). Returns picked up element or null. */
export function updateElementOrbs(pool: ElementOrbState[], player: PlayerState): ElementType | null {
  let pickedElement: ElementType | null = null;

  for (const o of pool) {
    if (!o.active) continue;
    o.life--;
    if (o.life <= 0) {
      o.active = false;
      continue;
    }

    // Check proximity pickup (no magnet - player must walk over)
    if (pickedElement === null) {
      const dx = player.x - o.x;
      const dy = player.y - o.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < ELEMENT_ORB_PICKUP_RANGE) {
        // Check if there's an available slot
        if (canPickupElement(player)) {
          pickedElement = o.element;
          o.active = false;
        }
      }
    }
  }

  return pickedElement;
}

/** Check if player has any empty element sub-slot in any weapon slot */
function canPickupElement(player: PlayerState): boolean {
  // First try active slot
  const activeSlot = player.weaponSlots[player.activeSlotIndex];
  if (activeSlot.weapon === null && activeSlot.elements.some(e => e === null)) {
    return true;
  }
  // Then try other slots
  for (let i = 0; i < 3; i++) {
    if (i === player.activeSlotIndex) continue;
    const slot = player.weaponSlots[i];
    if (slot.weapon === null && slot.elements.some(e => e === null)) {
      return true;
    }
  }
  return false;
}
