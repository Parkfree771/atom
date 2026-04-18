import { EnemyState, ProjectileState, PlayerState, WeaponEffectState, ElementOrbState, PLAYER_WIDTH, PLAYER_HEIGHT, ELEMENT_ORB_PICKUP_RANGE } from './types';

const CELL_SIZE = 64;
// 정수 키 패킹 — cx/cy에 오프셋 더해서 양수 구간으로 이동시킨 후 비트 시프트.
// WORLD_W/H ~ 수천 px → cx,cy는 -16..+128 정도 → OFFSET 2^14로 충분.
const KEY_OFFSET = 1 << 14; // 16384
const KEY_SHIFT = 16;       // cy 슬롯 여유 (-16384..+16383)

function packKey(cx: number, cy: number): number {
  return ((cx + KEY_OFFSET) << KEY_SHIFT) | (cy + KEY_OFFSET);
}

export class SpatialHash {
  // 정수 키 (문자열 할당 제거)
  private cells: Map<number, number[]> = new Map();
  // 쿼리 결과 재사용 버퍼. caller는 다음 query 호출 전에 사용 완료해야 함.
  private _queryResult: number[] = [];
  // 중복 체크용 visited 버전. 정수 버퍼 하나를 재사용 (versioned marking — clear 불필요).
  private _visited: Int32Array = new Int32Array(0);
  private _visitedVersion = 0;

  clear() {
    this.cells.clear();
  }

  insert(index: number, x: number, y: number, w: number, h: number) {
    const minCx = Math.floor((x - w / 2) / CELL_SIZE);
    const maxCx = Math.floor((x + w / 2) / CELL_SIZE);
    const minCy = Math.floor((y - h / 2) / CELL_SIZE);
    const maxCy = Math.floor((y + h / 2) / CELL_SIZE);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const k = packKey(cx, cy);
        let arr = this.cells.get(k);
        if (!arr) { arr = []; this.cells.set(k, arr); }
        arr.push(index);
      }
    }
  }

  /**
   * 범위 내 인덱스 반환. 반환 배열은 **재사용 버퍼**이므로 다음 query 호출 전까지만 유효.
   * totalCount: 풀 크기 (enemies.length 등). visited 버퍼 크기 설정용.
   */
  query(x: number, y: number, w: number, h: number, totalCount: number): number[] {
    const result = this._queryResult;
    result.length = 0;

    // visited 버퍼 크기 보장 + 버전 증가 (clear 없이 중복 제거)
    if (this._visited.length < totalCount) {
      this._visited = new Int32Array(Math.max(totalCount, this._visited.length * 2, 64));
      this._visitedVersion = 0;
    }
    this._visitedVersion++;
    // 오버플로우 시 재초기화 (매우 드묾 — 20억 호출 후)
    if (this._visitedVersion === 0) {
      this._visited.fill(0);
      this._visitedVersion = 1;
    }
    const visited = this._visited;
    const ver = this._visitedVersion;

    const minCx = Math.floor((x - w / 2) / CELL_SIZE);
    const maxCx = Math.floor((x + w / 2) / CELL_SIZE);
    const minCy = Math.floor((y - h / 2) / CELL_SIZE);
    const maxCy = Math.floor((y + h / 2) / CELL_SIZE);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const arr = this.cells.get(packKey(cx, cy));
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
          const idx = arr[i];
          if (visited[idx] !== ver) {
            visited[idx] = ver;
            result.push(idx);
          }
        }
      }
    }
    return result;
  }
}

export function rectOverlap(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number
): boolean {
  return Math.abs(ax - bx) < (aw + bw) / 2 && Math.abs(ay - by) < (ah + bh) / 2;
}

export function circleRectOverlap(
  cx: number, cy: number, cr: number,
  rx: number, ry: number, rw: number, rh: number
): boolean {
  const dx = Math.abs(cx - rx);
  const dy = Math.abs(cy - ry);
  if (dx > rw / 2 + cr || dy > rh / 2 + cr) return false;
  if (dx <= rw / 2 || dy <= rh / 2) return true;
  const cornerDist = (dx - rw / 2) ** 2 + (dy - rh / 2) ** 2;
  return cornerDist <= cr * cr;
}

export function checkProjectileEnemyCollisions(
  projectiles: ProjectileState[],
  enemies: EnemyState[],
  hash: SpatialHash
): Array<{ pi: number; ei: number }> {
  const hits: Array<{ pi: number; ei: number }> = [];
  const total = enemies.length;
  for (let pi = 0; pi < projectiles.length; pi++) {
    const p = projectiles[pi];
    if (!p.active) continue;
    const candidates = hash.query(p.x, p.y, p.radius * 2, p.radius * 2, total);
    // 주의: candidates는 재사용 버퍼 — 다음 query 호출 전에 사용 완료
    for (let ci = 0; ci < candidates.length; ci++) {
      const ei = candidates[ci];
      const e = enemies[ei];
      if (!e.active) continue;
      if (circleRectOverlap(p.x, p.y, p.radius, e.x, e.y, e.width, e.height)) {
        hits.push({ pi, ei });
        if (p.pierce <= 0) break;
      }
    }
  }
  return hits;
}

export function checkPlayerEnemyCollisions(
  player: PlayerState,
  enemies: EnemyState[],
  hash: SpatialHash
): number[] {
  if (player.invincibleFrames > 0) return [];
  const candidates = hash.query(player.x, player.y, PLAYER_WIDTH + 10, PLAYER_HEIGHT + 10, enemies.length);
  const hits: number[] = [];
  for (let ci = 0; ci < candidates.length; ci++) {
    const ei = candidates[ci];
    const e = enemies[ei];
    if (!e.active) continue;
    if (rectOverlap(player.x, player.y, PLAYER_WIDTH, PLAYER_HEIGHT, e.x, e.y, e.width, e.height)) {
      hits.push(ei);
    }
  }
  return hits;
}

export function checkWeaponEffectEnemyCollisions(
  effects: WeaponEffectState[],
  enemies: EnemyState[],
  hash: SpatialHash
): Array<{ wi: number; ei: number }> {
  const hits: Array<{ wi: number; ei: number }> = [];
  const total = enemies.length;
  for (let wi = 0; wi < effects.length; wi++) {
    const w = effects[wi];
    if (!w.active) continue;
    const r = w.radius;
    const candidates = hash.query(w.x, w.y, r * 2, r * 2, total);
    // hitEnemies 체크 전에 후보를 복사해야 함 — 다음 query 전까지만 유효
    // 여기서는 이 루프 안에서만 쓰이고 추가 query가 없으므로 직접 순회 OK
    for (let ci = 0; ci < candidates.length; ci++) {
      const ei = candidates[ci];
      if (w.hitEnemies.has(ei)) continue;
      const e = enemies[ei];
      if (!e.active) continue;
      const dx = w.x - e.x;
      const dy = w.y - e.y;
      if (dx * dx + dy * dy < (r + Math.max(e.width, e.height) / 2) ** 2) {
        hits.push({ wi, ei });
      }
    }
  }
  return hits;
}
