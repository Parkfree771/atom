import * as PIXI from 'pixi.js';
import {
  GameState, CANVAS_W, CANVAS_H, WORLD_W, WORLD_H,
  PLAYER_WIDTH, PLAYER_HEIGHT, ELEMENT_COLORS, ElementType,
  isBossType,
} from './types';
import { drawBoss } from './renderer_boss';

export function createGameGraphics(stage: PIXI.Container) {
  // Layer structure
  // stage children order: worldContainer → overlayLayer → playerLayer → uiContainer
  // playerLayer는 overlayLayer(스크린 이펙트)보다 위에 있어 모든 이펙트 위에 캐릭터가 그려짐
  const worldContainer = new PIXI.Container();
  const overlayLayer = new PIXI.Container();  // 스크린 좌표 이펙트용 (카메라 변환 안 받음)
  const playerLayer = new PIXI.Container();   // 월드 좌표지만 모든 이펙트 위에 그려짐 (카메라 변환은 applyCamera에서)
  const uiContainer = new PIXI.Container();
  stage.addChild(worldContainer);
  stage.addChild(overlayLayer);
  stage.addChild(playerLayer);
  stage.addChild(uiContainer);

  // Sub-layers inside world
  const groundLayer = new PIXI.Container();
  const entityLayer = new PIXI.Container();
  const effectLayer = new PIXI.Container();
  const particleLayer = new PIXI.Container();
  worldContainer.addChild(groundLayer);
  worldContainer.addChild(entityLayer);
  worldContainer.addChild(effectLayer);
  worldContainer.addChild(particleLayer);

  return { worldContainer, uiContainer, groundLayer, entityLayer, effectLayer, particleLayer, playerLayer, overlayLayer };
}

export function drawGround(g: PIXI.Graphics, _isDark: boolean) {
  g.clear();
  // 흰색 계열 배경 + 연한 회색 격자
  const bgColor = 0xFAFBFC;
  const gridMinor = 0xE5E9EF;
  const gridMajor = 0xCBD2DB;
  g.beginFill(bgColor);
  g.drawRect(0, 0, WORLD_W, WORLD_H);
  g.endFill();

  // Grid lines — minor 50px, major 250px
  const minor = 50;
  const major = 250;
  g.lineStyle(1, gridMinor, 0.65);
  for (let x = 0; x <= WORLD_W; x += minor) {
    if (x % major === 0) continue;
    g.moveTo(x, 0);
    g.lineTo(x, WORLD_H);
  }
  for (let y = 0; y <= WORLD_H; y += minor) {
    if (y % major === 0) continue;
    g.moveTo(0, y);
    g.lineTo(WORLD_W, y);
  }
  g.lineStyle(1.5, gridMajor, 0.75);
  for (let x = 0; x <= WORLD_W; x += major) {
    g.moveTo(x, 0);
    g.lineTo(x, WORLD_H);
  }
  for (let y = 0; y <= WORLD_H; y += major) {
    g.moveTo(0, y);
    g.lineTo(WORLD_W, y);
  }

  // World border
  g.lineStyle(2, 0xF87171, 0.7);
  g.drawRect(0, 0, WORLD_W, WORLD_H);
}

// ── Player HP/XP 바 (캐릭터 밑에 월드 좌표로 그림) ──
export function drawPlayerBars(g: PIXI.Graphics, state: GameState) {
  g.clear();
  const p = state.player;
  const BAR_W = 56;
  const BAR_H = 5;
  const BAR_GAP = 2;
  const Y_OFFSET = 44; // 스프라이트 아래

  const x0 = p.x - BAR_W / 2;
  const y0 = p.y + Y_OFFSET;
  const y1 = y0 + BAR_H + BAR_GAP;

  // 바 배경 (어두운 테두리)
  g.beginFill(0x0b1020, 0.55);
  g.drawRoundedRect(x0 - 2, y0 - 2, BAR_W + 4, BAR_H * 2 + BAR_GAP + 4, 4);
  g.endFill();

  // HP 슬롯 배경
  g.beginFill(0x1e293b, 0.9);
  g.drawRoundedRect(x0, y0, BAR_W, BAR_H, 2);
  g.endFill();
  // HP 채움
  const hpRatio = Math.max(0, p.hp / p.maxHp);
  const hpColor = hpRatio > 0.5 ? 0x4ade80 : hpRatio > 0.25 ? 0xfbbf24 : 0xf87171;
  if (hpRatio > 0) {
    g.beginFill(hpColor, 0.95);
    g.drawRoundedRect(x0, y0, BAR_W * hpRatio, BAR_H, 2);
    g.endFill();
  }

  // XP 슬롯 배경
  g.beginFill(0x1e293b, 0.9);
  g.drawRoundedRect(x0, y1, BAR_W, BAR_H, 2);
  g.endFill();
  // XP 채움
  const xpRatio = Math.min(1, p.xp / p.xpToNext);
  if (xpRatio > 0) {
    g.beginFill(0x22d3ee, 0.95);
    g.drawRoundedRect(x0, y1, BAR_W * xpRatio, BAR_H, 2);
    g.endFill();
  }
}

// ── 원자 모형 플레이어 (sprite) ──
// atom1.webp = 기본 (완성된 슬롯 0)
// atom2.webp = 슬롯 1개 완성
// atom3.webp = 슬롯 2개 완성
// atom4.webp = 슬롯 3개 완성 (모든 무기 완성)
// Science icons created by Freepik - Flaticon (https://www.flaticon.com/free-icons/science)

const PLAYER_SPRITE_SIZE = 72; // 표시 크기 (px). 히트박스(PLAYER_WIDTH/HEIGHT)와 무관
const ATOM_URLS = [
  '/game/atom1.webp',
  '/game/atom2.webp',
  '/game/atom3.webp',
  '/game/atom4.webp',
];
const _atomTextures: (PIXI.Texture | null)[] = [null, null, null, null];

function _getAtomTexture(tier: number): PIXI.Texture | null {
  const t = Math.max(0, Math.min(3, tier));
  const cached = _atomTextures[t];
  // 캐시된 텍스처가 destroy돼서 baseTexture가 null일 수 있음 (Next.js dev hot reload)
  if (cached && cached.baseTexture) return cached;
  // 전역 TextureCache의 잔여 파괴된 엔트리 제거 후 재생성
  try { delete (PIXI.utils.TextureCache as Record<string, PIXI.Texture>)[ATOM_URLS[t]]; } catch {}
  const fresh = PIXI.Texture.from(ATOM_URLS[t]);
  if (!fresh.baseTexture) return null;
  _atomTextures[t] = fresh;
  return fresh;
}

export function createPlayerSprite(): PIXI.Sprite {
  // Texture.EMPTY로 안전하게 시작 → drawPlayer에서 atom 텍스처 로드되면 교체
  const s = new PIXI.Sprite(PIXI.Texture.EMPTY);
  s.anchor.set(0.5, 0.5);
  s.width = PLAYER_SPRITE_SIZE;
  s.height = PLAYER_SPRITE_SIZE;
  return s;
}

// 완성된 슬롯 수 세기 — 3원소가 모두 채워지면 완성
// (slot.weapon은 WEAPON_DEFS 엔트리가 있는 조합만 세팅되므로 완성 판정에 부적합)
function _completedSlotCount(state: GameState): number {
  let n = 0;
  for (const slot of state.player.weaponSlots) {
    let filled = 0;
    for (const el of slot.elements) if (el !== null) filled++;
    if (filled === 3) n++;
  }
  return n;
}

export function drawPlayer(sprite: PIXI.Sprite, state: GameState) {
  const { player } = state;

  // 무적 깜빡임
  if (player.invincibleFrames > 0 && Math.floor(player.invincibleFrames / 4) % 2 === 0) {
    sprite.alpha = 0.4;
  } else {
    sprite.alpha = 1;
  }

  // 완성 슬롯 수에 따라 텍스처 스왑 (baseTexture가 살아있을 때만)
  const tier = _completedSlotCount(state);
  const tex = _getAtomTexture(tier);
  if (tex && tex.baseTexture && sprite.texture !== tex) {
    sprite.texture = tex;
    sprite.width = PLAYER_SPRITE_SIZE;
    sprite.height = PLAYER_SPRITE_SIZE;
  }

  sprite.x = player.x;
  sprite.y = player.y;
}

// 적 렌더 캐시: 직전 프레임에 그린 HP 값을 기록.
// 같은 HP면 Graphics 재그리기 스킵 (위치/회전만 갱신).
const _enemyLastHp: number[] = [];
const _enemyLastMaxHp: number[] = [];
const CULL_MARGIN = 80;

export function drawEnemies(container: PIXI.Container, state: GameState, enemyGraphics: PIXI.Graphics[]) {
  const { enemies, cameraX, cameraY } = state;
  while (enemyGraphics.length < enemies.length) {
    const g = new PIXI.Graphics();
    container.addChild(g);
    enemyGraphics.push(g);
    _enemyLastHp.push(-1);
    _enemyLastMaxHp.push(-1);
  }

  const viewLeft = cameraX - CULL_MARGIN;
  const viewRight = cameraX + CANVAS_W + CULL_MARGIN;
  const viewTop = cameraY - CULL_MARGIN;
  const viewBottom = cameraY + CANVAS_H + CULL_MARGIN;

  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    const g = enemyGraphics[i];
    if (!e.active) {
      g.visible = false;
      _enemyLastHp[i] = -1;
      continue;
    }
    // Viewport culling — 화면 밖 적은 숨김 (update는 계속 돌아감)
    if (e.x < viewLeft || e.x > viewRight || e.y < viewTop || e.y > viewBottom) {
      g.visible = false;
      continue;
    }
    g.visible = true;

    // ── 보스: 매 프레임 커스텀 렌더 (애니메이션 위해 dirty-check 무시) ──
    if (isBossType(e.type)) {
      drawBoss(g, e, state.frameCount);
      _enemyLastHp[i] = e.hp;
      _enemyLastMaxHp[i] = e.maxHp;
      g.x = e.x;
      g.y = e.y;
      g.rotation = 0;  // 보스는 회전 안 함 (실루엣이 고정 방향)
      continue;
    }

    // Dirty check — HP/maxHp 변경 있을 때만 재그리기
    if (e.hp !== _enemyLastHp[i] || e.maxHp !== _enemyLastMaxHp[i]) {
      g.clear();
      const r = e.width / 2;
      // 원소 변종: 바깥 글로우 링으로 원소 티내기
      const isElemental = e.type === 'fire' || e.type === 'water' || e.type === 'earth'
        || e.type === 'light' || e.type === 'electric' || e.type === 'dark';
      if (isElemental) {
        g.beginFill(e.color, 0.25);
        g.drawCircle(0, 0, r + 3);
        g.endFill();
      }
      g.beginFill(e.color);
      g.drawCircle(0, 0, r);
      g.endFill();

      if (e.hp < e.maxHp) {
        const barW = e.width;
        const barH = 3;
        const barY = -r - 7;
        g.beginFill(0x333333);
        g.drawRect(-barW / 2, barY, barW, barH);
        g.endFill();
        g.beginFill(0xFF4444);
        g.drawRect(-barW / 2, barY, barW * (e.hp / e.maxHp), barH);
        g.endFill();
      }
      _enemyLastHp[i] = e.hp;
      _enemyLastMaxHp[i] = e.maxHp;
    }

    g.x = e.x;
    g.y = e.y;
    g.rotation = e.angle;
  }
}

export function drawProjectiles(container: PIXI.Container, state: GameState, projGraphics: PIXI.Graphics[]) {
  const { projectiles } = state;
  while (projGraphics.length < projectiles.length) {
    const g = new PIXI.Graphics();
    container.addChild(g);
    projGraphics.push(g);
  }

  for (let i = 0; i < projectiles.length; i++) {
    const p = projectiles[i];
    const g = projGraphics[i];
    if (!p.active) { g.visible = false; continue; }
    g.visible = true;
    g.clear();

    if (p.elementType === '전기') {
      // ── 전기 투사체: 코어 + 지지직 번개 ──
      const r = p.radius;
      // 외곽 전기 글로우
      g.beginFill(0x818cf8, 0.15);
      g.drawCircle(0, 0, r + 6);
      g.endFill();
      // 코어
      g.beginFill(0xa78bfa, 0.8);
      g.drawCircle(0, 0, r);
      g.endFill();
      g.beginFill(0xe0e7ff, 0.9);
      g.drawCircle(0, 0, r * 0.5);
      g.endFill();

      // 지지직 전기 아크 3~4개 (투사체에서 주변으로 짧은 번개)
      const arcCount = 3 + (state.frameCount % 2);
      for (let a = 0; a < arcCount; a++) {
        const angle = Math.random() * Math.PI * 2;
        const len = r + 4 + Math.random() * 10;
        const ex = Math.cos(angle) * len;
        const ey = Math.sin(angle) * len;
        const segs = 3;
        // 글로우 패스
        g.lineStyle(2.5, 0x818cf8, 0.3);
        g.moveTo(0, 0);
        for (let s = 1; s <= segs; s++) {
          const t = s / segs;
          const jx = (Math.random() - 0.5) * 6;
          const jy = (Math.random() - 0.5) * 6;
          if (s === segs) g.lineTo(ex, ey);
          else g.lineTo(ex * t + jx, ey * t + jy);
        }
        // 코어 패스
        g.lineStyle(1, 0xe0e7ff, 0.7);
        g.moveTo(0, 0);
        for (let s = 1; s <= segs; s++) {
          const t = s / segs;
          const jx = (Math.random() - 0.5) * 5;
          const jy = (Math.random() - 0.5) * 5;
          if (s === segs) g.lineTo(ex, ey);
          else g.lineTo(ex * t + jx, ey * t + jy);
        }
        g.lineStyle(0);
      }

      // 꼬리 잔상 (이동 반대 방향)
      const tailLen = 12;
      const tailAngle = Math.atan2(-p.vy, -p.vx);
      g.lineStyle(2, 0xa78bfa, 0.25);
      g.moveTo(0, 0);
      g.lineTo(Math.cos(tailAngle) * tailLen, Math.sin(tailAngle) * tailLen);
      g.lineStyle(0);

    } else if (p.elementType === '불') {
      // ── 불 투사체: 화염구 + 불꼬리 ──
      const r = p.radius;
      // 외곽 열기 글로우
      g.beginFill(0xf97316, 0.12);
      g.drawCircle(0, 0, r + 5);
      g.endFill();
      // 화염 외곽
      g.beginFill(0xdc2626, 0.7);
      g.drawCircle(0, 0, r);
      g.endFill();
      // 내부 오렌지
      g.beginFill(0xf97316, 0.8);
      g.drawCircle(0, 0, r * 0.65);
      g.endFill();
      // 코어 (밝은 노랑)
      g.beginFill(0xfbbf24, 0.9);
      g.drawCircle(0, 0, r * 0.3);
      g.endFill();

      // 불꼬리 — 이동 반대 방향으로 화염 파티클들
      const tailAngle = Math.atan2(-p.vy, -p.vx);
      const tailCount = 5;
      for (let t = 0; t < tailCount; t++) {
        const td = 4 + t * 4;
        const spread = (Math.sin(state.frameCount * 0.3 + t * 1.5) - 0.5) * 4;
        const tx = Math.cos(tailAngle) * td + Math.sin(tailAngle) * spread;
        const ty = Math.sin(tailAngle) * td - Math.cos(tailAngle) * spread;
        const tSize = r * (1 - t / tailCount) * 0.7;
        const tColor = t < 2 ? 0xf97316 : 0xef4444;
        g.beginFill(tColor, 0.5 * (1 - t / tailCount));
        g.drawCircle(tx, ty, tSize);
        g.endFill();
      }

    } else {
      // ── 기본 투사체 ──
      g.beginFill(p.color, 0.9);
      g.drawCircle(0, 0, p.radius);
      g.endFill();
      g.beginFill(0xFFFFFF, 0.4);
      g.drawCircle(0, 0, p.radius * 0.5);
      g.endFill();
      // 글로우
      g.beginFill(p.color, 0.15);
      g.drawCircle(0, 0, p.radius + 3);
      g.endFill();
    }

    g.x = p.x;
    g.y = p.y;
  }
}

export function drawXPOrbs(container: PIXI.Container, state: GameState, orbGraphics: PIXI.Graphics[]) {
  const { xpOrbs } = state;
  while (orbGraphics.length < xpOrbs.length) {
    const g = new PIXI.Graphics();
    container.addChild(g);
    orbGraphics.push(g);
  }

  for (let i = 0; i < xpOrbs.length; i++) {
    const o = xpOrbs[i];
    const g = orbGraphics[i];
    if (!o.active) { g.visible = false; continue; }
    g.visible = true;
    g.clear();
    // Glow
    g.beginFill(0x7ED957, 0.3);
    g.drawCircle(0, 0, 7);
    g.endFill();
    g.beginFill(0x7ED957);
    g.drawCircle(0, 0, 4);
    g.endFill();
    g.x = o.x;
    g.y = o.y;
  }
}

export function drawElementOrbs(container: PIXI.Container, state: GameState, elementOrbGraphics: PIXI.Graphics[]) {
  const { elementOrbs } = state;
  while (elementOrbGraphics.length < elementOrbs.length) {
    const g = new PIXI.Graphics();
    container.addChild(g);
    elementOrbGraphics.push(g);
  }

  for (let i = 0; i < elementOrbs.length; i++) {
    const o = elementOrbs[i];
    const g = elementOrbGraphics[i];
    if (!o.active) { g.visible = false; continue; }
    g.visible = true;
    g.clear();

    const colorHex = ELEMENT_COLORS[o.element];
    const color = parseInt(colorHex.replace('#', ''), 16);

    // Fade when close to expiring (last 3 seconds)
    const fadeThreshold = 3 * 60;
    let alpha = 1;
    if (o.life < fadeThreshold) {
      const blinkRate = Math.max(4, Math.floor(o.life / 10));
      alpha = (Math.floor(o.life / blinkRate) % 2 === 0) ? 0.3 : 0.8;
    }

    // Pulsing size
    const pulse = 1 + Math.sin(state.frameCount * 0.08 + i) * 0.15;
    const baseRadius = 10;
    const radius = baseRadius * pulse;

    // Outer glow
    g.beginFill(color, 0.2 * alpha);
    g.drawCircle(0, 0, radius + 6);
    g.endFill();

    // Main circle
    g.beginFill(color, 0.7 * alpha);
    g.drawCircle(0, 0, radius);
    g.endFill();

    // Inner bright core
    g.beginFill(0xFFFFFF, 0.5 * alpha);
    g.drawCircle(0, 0, radius * 0.4);
    g.endFill();

    // Border
    g.lineStyle(1.5, color, 0.9 * alpha);
    g.drawCircle(0, 0, radius);

    g.x = o.x;
    g.y = o.y;
  }
}

// ── 적 투사체 (보스 역공격) 렌더 ──
export function drawEnemyProjectiles(g: PIXI.Graphics, state: GameState) {
  g.clear();
  const projs = state.enemyProjectiles;
  const t = state.frameCount;
  for (let i = 0; i < projs.length; i++) {
    const p = projs[i];
    if (!p.active) continue;

    // ── 지연 예고 (delay>0): 변형별 마커 렌더 ──
    if (p.delay !== undefined && p.delay > 0) {
      const k = 1 - p.delay / Math.max(p.delay + 1, 30);  // 대략 차오르는 비율
      const v = p.variant;
      if (v === 'water_puddle') {
        // 바닥 물 웅덩이 — 수면 라인
        g.beginFill(0x1e3a8a, 0.28 + k * 0.25);
        g.drawEllipse(p.x, p.y + p.radius * 0.1, p.radius * (0.7 + k * 0.3), p.radius * 0.35 * (0.7 + k * 0.3));
        g.endFill();
        g.lineStyle(2, 0x38bdf8, 0.8);
        g.drawEllipse(p.x, p.y, p.radius * (0.85 + Math.sin(t * 0.3) * 0.04), p.radius * 0.45);
        g.lineStyle(0);
      } else if (v === 'fire_meteor') {
        // 낙하 마커 — 타겟 링 + 위쪽 red glow 접근
        g.lineStyle(3, 0xdc2626, 0.5 + k * 0.45);
        g.drawCircle(p.x, p.y, p.radius * (0.7 + k * 0.3));
        g.lineStyle(1.5, 0xf97316, 0.8);
        g.drawCircle(p.x, p.y, p.radius * 0.45);
        g.lineStyle(0);
        // 하늘에서 떨어지는 불덩이 (y 위쪽)
        const fallY = p.y - 240 * (1 - k);
        g.beginFill(0xdc2626, 0.9);
        g.drawCircle(p.x, fallY, 10);
        g.endFill();
        g.beginFill(0xfbbf24, 0.9);
        g.drawCircle(p.x, fallY, 5);
        g.endFill();
      } else if (v === 'earth_rupture') {
        // 균열 성장 라인 — 중심에서 방사
        const cracks = 6;
        for (let c = 0; c < cracks; c++) {
          const a = (c / cracks) * Math.PI * 2;
          const len = p.radius * k;
          g.lineStyle(3, 0x451a03, 0.8);
          g.moveTo(p.x, p.y);
          g.lineTo(p.x + Math.cos(a) * len, p.y + Math.sin(a) * len);
          g.lineStyle(1.4, 0xdc2626, 0.85);
          g.moveTo(p.x, p.y);
          g.lineTo(p.x + Math.cos(a) * len, p.y + Math.sin(a) * len);
        }
        g.lineStyle(0);
      } else if (v === 'light_judgment') {
        // 빛의 예고 링 + 위에서 내려오는 광선 (점증)
        g.lineStyle(2.5, 0xfde047, 0.55 + k * 0.4);
        g.drawCircle(p.x, p.y, p.radius * (0.6 + k * 0.4));
        g.lineStyle(0);
        const beamTopY = p.y - 400;
        const beamW = 10 + k * 12;
        g.beginFill(0xfde047, 0.20 + k * 0.35);
        g.drawRect(p.x - beamW / 2, beamTopY, beamW, (p.y - beamTopY));
        g.endFill();
        g.beginFill(0xffffff, 0.22 + k * 0.4);
        g.drawRect(p.x - beamW * 0.3, beamTopY, beamW * 0.6, (p.y - beamTopY));
        g.endFill();
      } else if (v === 'dark_portal') {
        // 어두운 포털 회전 고리
        const rot = t * 0.12;
        const R = p.radius * (0.5 + k * 0.5);
        g.lineStyle(3, 0x020010, 0.95);
        g.drawCircle(p.x, p.y, R);
        g.lineStyle(2, 0x7e22ce, 0.65);
        g.arc(p.x, p.y, R * 0.85, rot, rot + Math.PI * 1.2);
        g.lineStyle(1.5, 0xa855f7, 0.55);
        g.arc(p.x, p.y, R * 0.65, -rot, -rot + Math.PI * 1.0);
        g.lineStyle(0);
        g.beginFill(0x020010, 0.85);
        g.drawCircle(p.x, p.y, R * 0.45);
        g.endFill();
      } else {
        // 기타 — 단순 경고 링
        g.lineStyle(2, p.color, 0.55 + k * 0.4);
        g.drawCircle(p.x, p.y, p.radius);
        g.lineStyle(0);
      }
      continue;
    }

    // ── 지연 폭발 순간 (delay=undefined 직후, 나머지 life) — 폭발 시각 ──
    if (p.vx === 0 && p.vy === 0 && p.life <= 20 && p.life > 0) {
      const v = p.variant;
      const pulse = p.life / 20;  // 20→0 페이드
      if (v === 'water_puddle') {
        g.beginFill(0x38bdf8, 0.65 * pulse);
        g.drawCircle(p.x, p.y, p.radius * (1 + (1 - pulse) * 0.4));
        g.endFill();
        g.beginFill(0x7dd3fc, 0.8 * pulse);
        g.drawCircle(p.x, p.y, p.radius * 0.55);
        g.endFill();
      } else if (v === 'fire_meteor') {
        g.beginFill(0xfbbf24, 0.8 * pulse);
        g.drawCircle(p.x, p.y, p.radius * (1 + (1 - pulse) * 0.6));
        g.endFill();
        g.beginFill(0xf97316, 0.8 * pulse);
        g.drawCircle(p.x, p.y, p.radius * 0.75);
        g.endFill();
        g.beginFill(0xdc2626, 0.8 * pulse);
        g.drawCircle(p.x, p.y, p.radius * 0.45);
        g.endFill();
      } else if (v === 'earth_rupture') {
        g.beginFill(0xdc2626, 0.6 * pulse);
        g.drawCircle(p.x, p.y, p.radius * 0.9);
        g.endFill();
        g.beginFill(0xfbbf24, 0.7 * pulse);
        g.drawCircle(p.x, p.y, p.radius * 0.55);
        g.endFill();
      } else if (v === 'light_judgment') {
        // 수직 광선 (터진 후)
        g.beginFill(0xfef9c3, 0.9 * pulse);
        g.drawRect(p.x - 14, p.y - 400, 28, 420);
        g.endFill();
        g.beginFill(0xffffff, 0.95 * pulse);
        g.drawRect(p.x - 6, p.y - 400, 12, 420);
        g.endFill();
      } else if (v === 'dark_portal') {
        g.beginFill(0x020010, 0.9 * pulse);
        g.drawCircle(p.x, p.y, p.radius * 1.1);
        g.endFill();
        g.beginFill(0x7e22ce, 0.7 * pulse);
        g.drawCircle(p.x, p.y, p.radius * 0.7);
        g.endFill();
        g.beginFill(0xa855f7, 0.8 * pulse);
        g.drawCircle(p.x, p.y, p.radius * 0.4);
        g.endFill();
      } else {
        g.beginFill(p.color, 0.7 * pulse);
        g.drawCircle(p.x, p.y, p.radius);
        g.endFill();
      }
      continue;
    }

    // ── 일반 주행 투사체 — variant별 렌더 ──
    drawBossProjectile(g, p, t);
  }
}

// 보스 투사체 variant별 실시간 렌더
function drawBossProjectile(g: PIXI.Graphics, p: GameState['enemyProjectiles'][number], t: number) {
  const v = p.variant;
  const r = p.radius;
  switch (v) {
    case 'water_wave': {
      // 거대 물방울
      g.beginFill(0x1e3a8a, 0.3);
      g.drawCircle(p.x, p.y, r + 7);
      g.endFill();
      g.beginFill(0x2563eb, 0.85);
      g.drawCircle(p.x, p.y, r);
      g.endFill();
      g.beginFill(0x60a5fa, 0.8);
      g.drawCircle(p.x - r * 0.2, p.y - r * 0.25, r * 0.55);
      g.endFill();
      g.beginFill(0xe0f2fe, 0.8);
      g.drawCircle(p.x - r * 0.3, p.y - r * 0.35, r * 0.22);
      g.endFill();
      break;
    }
    case 'water_ring': {
      g.beginFill(0x38bdf8, 0.35);
      g.drawCircle(p.x, p.y, r + 3);
      g.endFill();
      g.beginFill(0x0ea5e9, 0.88);
      g.drawCircle(p.x, p.y, r);
      g.endFill();
      g.beginFill(0xbae6fd, 0.85);
      g.drawCircle(p.x - r * 0.25, p.y - r * 0.25, r * 0.4);
      g.endFill();
      break;
    }
    case 'fire_ball': {
      g.beginFill(0xf97316, 0.18);
      g.drawCircle(p.x, p.y, r + 6);
      g.endFill();
      g.beginFill(0xdc2626, 0.88);
      g.drawCircle(p.x, p.y, r);
      g.endFill();
      g.beginFill(0xf97316, 0.9);
      g.drawCircle(p.x, p.y, r * 0.65);
      g.endFill();
      g.beginFill(0xfbbf24, 0.95);
      g.drawCircle(p.x, p.y, r * 0.35);
      g.endFill();
      // 꼬리 3개 (이동 반대)
      const speed = Math.hypot(p.vx, p.vy) || 1;
      const ta = Math.atan2(-p.vy, -p.vx);
      for (let k = 1; k <= 3; k++) {
        const td = k * 4;
        const tx = p.x + Math.cos(ta) * td;
        const ty = p.y + Math.sin(ta) * td;
        const tr = r * (1 - k * 0.22);
        g.beginFill(0xf97316, 0.5 - k * 0.12);
        g.drawCircle(tx, ty, tr);
        g.endFill();
      }
      void speed;
      break;
    }
    case 'fire_spiral': {
      g.beginFill(0xdc2626, 0.22);
      g.drawCircle(p.x, p.y, r + 4);
      g.endFill();
      g.beginFill(0xea580c, 0.9);
      g.drawCircle(p.x, p.y, r);
      g.endFill();
      g.beginFill(0xfbbf24, 0.9);
      g.drawCircle(p.x, p.y, r * 0.5);
      g.endFill();
      break;
    }
    case 'earth_rock': {
      // 각진 7각형
      const sides = 7;
      const pts: number[] = [];
      const rot = (p.x * 0.003 + p.y * 0.005) % (Math.PI * 2); // 고정 회전
      for (let k = 0; k < sides; k++) {
        const a = rot + (k / sides) * Math.PI * 2;
        const rr = r * (0.85 + 0.25 * (k % 3 === 0 ? 1 : 0));
        pts.push(p.x + Math.cos(a) * rr, p.y + Math.sin(a) * rr);
      }
      g.beginFill(0x451a03, 0.95);
      g.drawPolygon(pts);
      g.endFill();
      g.beginFill(0x78350f, 0.85);
      const inner = pts.map((v, i) => i % 2 === 0 ? p.x + (v - p.x) * 0.7 : p.y + (v - p.y) * 0.7);
      g.drawPolygon(inner);
      g.endFill();
      // 돌 표면 crack
      g.lineStyle(1.2, 0x1c0a03, 0.85);
      g.moveTo(p.x - r * 0.4, p.y - r * 0.2);
      g.lineTo(p.x + r * 0.2, p.y + r * 0.3);
      g.lineStyle(0);
      break;
    }
    case 'earth_shard': {
      // 작은 조각 — 삼각형
      const ang = Math.atan2(p.vy, p.vx);
      const pts = [
        p.x + Math.cos(ang) * r, p.y + Math.sin(ang) * r,
        p.x + Math.cos(ang + Math.PI * 0.8) * r * 0.7, p.y + Math.sin(ang + Math.PI * 0.8) * r * 0.7,
        p.x + Math.cos(ang - Math.PI * 0.8) * r * 0.7, p.y + Math.sin(ang - Math.PI * 0.8) * r * 0.7,
      ];
      g.beginFill(0x78350f, 0.95);
      g.drawPolygon(pts);
      g.endFill();
      g.beginFill(0xa16207, 0.85);
      g.drawCircle(p.x, p.y, r * 0.4);
      g.endFill();
      break;
    }
    case 'electric_bolt': {
      // 짧은 zigzag
      const ang = Math.atan2(p.vy, p.vx);
      const len = r * 4;
      const segs = 6;
      const nx = Math.cos(ang), ny = Math.sin(ang);
      const px1 = -ny, py1 = nx;
      // glow
      g.lineStyle(r * 1.2, 0x7c3aed, 0.35);
      g.moveTo(p.x - nx * len * 0.5, p.y - ny * len * 0.5);
      for (let s = 1; s < segs; s++) {
        const tt = s / segs - 0.5;
        const jit = ((s * 23 + t * 3) % 7) - 3;
        g.lineTo(p.x + nx * len * tt + px1 * jit, p.y + ny * len * tt + py1 * jit);
      }
      g.lineTo(p.x + nx * len * 0.5, p.y + ny * len * 0.5);
      // core
      g.lineStyle(r * 0.45, 0xe0d8ff, 0.95);
      g.moveTo(p.x - nx * len * 0.5, p.y - ny * len * 0.5);
      for (let s = 1; s < segs; s++) {
        const tt = s / segs - 0.5;
        const jit = ((s * 17 + t * 5) % 5) - 2.5;
        g.lineTo(p.x + nx * len * tt + px1 * jit, p.y + ny * len * tt + py1 * jit);
      }
      g.lineTo(p.x + nx * len * 0.5, p.y + ny * len * 0.5);
      g.lineStyle(0);
      break;
    }
    case 'electric_arc': {
      g.beginFill(0x7c3aed, 0.3);
      g.drawCircle(p.x, p.y, r + 5);
      g.endFill();
      g.beginFill(0xa855f7, 0.9);
      g.drawCircle(p.x, p.y, r);
      g.endFill();
      g.beginFill(0xc4b5fd, 0.9);
      g.drawCircle(p.x, p.y, r * 0.5);
      g.endFill();
      // 방사 스파크
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + t * 0.2;
        g.lineStyle(1.2, 0xe0d8ff, 0.85);
        g.moveTo(p.x, p.y);
        g.lineTo(p.x + Math.cos(a) * (r + 6), p.y + Math.sin(a) * (r + 6));
      }
      g.lineStyle(0);
      break;
    }
    case 'electric_orb': {
      // 큰 추적 구체 + 스핀 arc
      g.beginFill(0x4c1d95, 0.32);
      g.drawCircle(p.x, p.y, r + 8);
      g.endFill();
      g.beginFill(0x581c87, 0.92);
      g.drawCircle(p.x, p.y, r);
      g.endFill();
      g.beginFill(0x7c3aed, 0.85);
      g.drawCircle(p.x, p.y, r * 0.7);
      g.endFill();
      g.beginFill(0xc4b5fd, 0.9);
      g.drawCircle(p.x, p.y, r * 0.4);
      g.endFill();
      g.beginFill(0xe0d8ff, 0.9);
      g.drawCircle(p.x, p.y, r * 0.2);
      g.endFill();
      // 스핀 아크
      g.lineStyle(1.5, 0xa855f7, 0.8);
      g.arc(p.x, p.y, r + 3, t * 0.1, t * 0.1 + Math.PI * 0.9);
      g.lineStyle(1, 0xe0d8ff, 0.7);
      g.arc(p.x, p.y, r - 1, -t * 0.15, -t * 0.15 + Math.PI * 0.7);
      g.lineStyle(0);
      break;
    }
    case 'light_ray': {
      // 얇은 빛줄기 (발사 방향으로 긴)
      const ang = Math.atan2(p.vy, p.vx);
      const len = r * 5;
      const nx = Math.cos(ang), ny = Math.sin(ang);
      const pxp = -ny, pyp = nx;
      const headW = r, tailW = r * 0.25;
      const pts = [
        p.x + nx * len - pxp * tailW, p.y + ny * len - pyp * tailW,
        p.x + nx * len + pxp * tailW, p.y + ny * len + pyp * tailW,
        p.x - nx * len + pxp * headW, p.y - ny * len + pyp * headW,
        p.x - nx * len - pxp * headW, p.y - ny * len - pyp * headW,
      ];
      g.beginFill(0xfde047, 0.4);
      g.drawPolygon(pts);
      g.endFill();
      g.beginFill(0xfef9c3, 0.9);
      g.drawCircle(p.x, p.y, r * 0.8);
      g.endFill();
      break;
    }
    case 'light_holy': {
      g.beginFill(0xfbbf24, 0.25);
      g.drawCircle(p.x, p.y, r + 5);
      g.endFill();
      g.beginFill(0xf59e0b, 0.9);
      g.drawCircle(p.x, p.y, r);
      g.endFill();
      g.beginFill(0xfde047, 0.92);
      g.drawCircle(p.x, p.y, r * 0.65);
      g.endFill();
      g.beginFill(0xffffff, 0.85);
      g.drawCircle(p.x, p.y, r * 0.3);
      g.endFill();
      break;
    }
    case 'dark_tendril': {
      // 촉수 — 머리 + 꼬리 (트레일)
      g.beginFill(0x020010, 0.88);
      g.drawCircle(p.x, p.y, r);
      g.endFill();
      g.beginFill(0x3b0764, 0.85);
      g.drawCircle(p.x, p.y, r * 0.65);
      g.endFill();
      g.beginFill(0x7e22ce, 0.85);
      g.drawCircle(p.x, p.y, r * 0.35);
      g.endFill();
      // 꼬리 (반대 방향)
      const ta = Math.atan2(-p.vy, -p.vx);
      for (let k = 1; k <= 4; k++) {
        const td = k * 5;
        const tx = p.x + Math.cos(ta) * td;
        const ty = p.y + Math.sin(ta) * td;
        g.beginFill(0x3b0764, 0.6 - k * 0.12);
        g.drawCircle(tx, ty, r * (1 - k * 0.18));
        g.endFill();
      }
      break;
    }
    case 'dark_void': {
      // 검은 구체
      g.beginFill(0x020010, 0.25);
      g.drawCircle(p.x, p.y, r + 10);
      g.endFill();
      g.beginFill(0x020010, 0.98);
      g.drawCircle(p.x, p.y, r);
      g.endFill();
      g.beginFill(0x3b0764, 0.85);
      g.drawCircle(p.x, p.y, r * 0.7);
      g.endFill();
      g.beginFill(0x7e22ce, 0.7);
      g.drawCircle(p.x, p.y, r * 0.4);
      g.endFill();
      // 중심에 빨간 포인트
      g.beginFill(0xdc2626, 0.95);
      g.drawCircle(p.x, p.y, r * 0.12);
      g.endFill();
      break;
    }
    default: {
      // 폴백 — 기존 원형
      g.beginFill(p.color, 0.25);
      g.drawCircle(p.x, p.y, p.radius + 6);
      g.endFill();
      g.beginFill(p.color, 0.9);
      g.drawCircle(p.x, p.y, p.radius);
      g.endFill();
      g.beginFill(0xffffff, 0.6);
      g.drawCircle(p.x - p.radius * 0.3, p.y - p.radius * 0.3, p.radius * 0.4);
      g.endFill();
      break;
    }
  }
}

// ── 파티클: ParticleContainer + 캐싱 텍스처로 배치 렌더 ──
// 500개 Graphics.clear+drawCircle (500 draw call) → 1 batch draw call
let _particleTexture: PIXI.Texture | null = null;
function _getParticleTexture(renderer: PIXI.IRenderer): PIXI.Texture {
  if (_particleTexture && _particleTexture.baseTexture) return _particleTexture;
  // 16x16 흰색 원 텍스처 (tint로 색상 제어)
  const g = new PIXI.Graphics();
  g.beginFill(0xffffff, 1);
  g.drawCircle(8, 8, 7);
  g.endFill();
  const rt = PIXI.RenderTexture.create({ width: 16, height: 16, resolution: 2 });
  renderer.render(g, { renderTexture: rt });
  g.destroy();
  _particleTexture = rt;
  return rt;
}

export interface ParticleRenderState {
  container: PIXI.ParticleContainer;
  sprites: PIXI.Sprite[];
}

export function createParticleRenderer(parent: PIXI.Container, renderer: PIXI.IRenderer, maxParticles: number): ParticleRenderState {
  const container = new PIXI.ParticleContainer(maxParticles, {
    scale: true,
    position: true,
    rotation: false,
    uvs: false,
    tint: true,
  });
  parent.addChild(container);

  const tex = _getParticleTexture(renderer);
  const sprites: PIXI.Sprite[] = [];
  for (let i = 0; i < maxParticles; i++) {
    const s = new PIXI.Sprite(tex);
    s.anchor.set(0.5);
    s.visible = false;
    container.addChild(s);
    sprites.push(s);
  }
  return { container, sprites };
}

export function drawParticles(particleRenderer: ParticleRenderState, state: GameState) {
  const { particles } = state;
  const sprites = particleRenderer.sprites;
  const n = Math.min(particles.length, sprites.length);
  for (let i = 0; i < n; i++) {
    const p = particles[i];
    const s = sprites[i];
    if (!p.active) {
      if (s.visible) s.visible = false;
      continue;
    }
    if (!s.visible) s.visible = true;
    const alpha = p.life / p.maxLife;
    // Sprite 16x16 텍스처. p.size는 반경 → scale = (p.size*alpha) / 7 (텍스처 반경 7)
    const sc = (p.size * alpha) / 7;
    s.x = p.x;
    s.y = p.y;
    s.alpha = alpha;
    s.scale.x = sc;
    s.scale.y = sc;
    if (s.tint !== p.color) s.tint = p.color;
  }
}

/** Draw a jagged lightning bolt between two local-space points */
function drawJaggedBolt(
  g: PIXI.Graphics,
  x0: number, y0: number, x1: number, y1: number,
  segments: number, jitter: number,
  colorOuter: number, alphaOuter: number, widthOuter: number,
  colorInner: number, alphaInner: number, widthInner: number,
) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const points: { x: number; y: number }[] = [{ x: x0, y: y0 }];
  for (let s = 1; s < segments; s++) {
    const t = s / segments;
    points.push({
      x: x0 + dx * t + (Math.random() - 0.5) * jitter,
      y: y0 + dy * t + (Math.random() - 0.5) * jitter,
    });
  }
  points.push({ x: x1, y: y1 });

  // Outer glow pass
  g.lineStyle(widthOuter, colorOuter, alphaOuter);
  g.moveTo(points[0].x, points[0].y);
  for (let p = 1; p < points.length; p++) g.lineTo(points[p].x, points[p].y);

  // Inner core pass
  g.lineStyle(widthInner, colorInner, alphaInner);
  g.moveTo(points[0].x, points[0].y);
  for (let p = 1; p < points.length; p++) g.lineTo(points[p].x, points[p].y);

  return points;
}

/** Glow layer Graphics -- drawn with PixiJS ADD blend mode for light effects */
let _glowGraphics: PIXI.Graphics | null = null;
function getGlowGraphics(container: PIXI.Container): PIXI.Graphics {
  if (!_glowGraphics || _glowGraphics.destroyed) {
    _glowGraphics = new PIXI.Graphics();
    _glowGraphics.blendMode = PIXI.BLEND_MODES.ADD;
    container.addChild(_glowGraphics);
  }
  return _glowGraphics;
}

// ── Main draw function ──

export function drawWeaponEffects(container: PIXI.Container, state: GameState, effectGraphics: PIXI.Graphics[]) {
  const { weaponEffects } = state;
  while (effectGraphics.length < weaponEffects.length) {
    const g = new PIXI.Graphics();
    container.addChild(g);
    effectGraphics.push(g);
  }

  // Glow layer (ADD blend)
  const glow = getGlowGraphics(container);
  glow.clear();

  for (let i = 0; i < weaponEffects.length; i++) {
    const e = weaponEffects[i];
    const g = effectGraphics[i];
    if (!e.active) { g.visible = false; continue; }
    g.visible = true;
    g.clear();
    const alpha = e.life / e.maxLife;
    const t = 1 - alpha; // progress 0->1

    // ── 커스텀 이펙트는 EffectManager가 처리 → generic 렌더링 스킵 ──
    // 커스텀 이펙트(EffectManager 관할)는 generic 렌더링 스킵
    if (e.uniqueId && e.uniqueId.startsWith('auto_')) {
      g.visible = false;
      continue;
    }

    // ── Generic effect rendering ──
    switch (e.type) {
      // --- AURA ---
      case 'aura': {
        // Breathing radius
        const breathe = 1 + Math.sin(state.frameCount * 0.1) * 0.08;
        const r = e.radius * breathe;

        // Dark center (space distortion feel)
        g.beginFill(0x000000, 0.35 * alpha);
        g.drawCircle(0, 0, r * 0.5);
        g.endFill();

        // Inner fill
        g.beginFill(e.color, 0.12 * alpha);
        g.drawCircle(0, 0, r);
        g.endFill();

        // Outer ring
        g.lineStyle(2.5, e.color, 0.6 * alpha);
        g.drawCircle(0, 0, r);

        // Edge glow (ADD blend)
        glow.beginFill(e.color, 0.18 * alpha);
        glow.drawCircle(e.x, e.y, r + 6);
        glow.endFill();

        // Orbiting particles (8 particles)
        const particleCount = 8;
        for (let p = 0; p < particleCount; p++) {
          const a = (state.frameCount * 0.03) + (p / particleCount) * Math.PI * 2;
          const pr = r * (0.75 + Math.sin(state.frameCount * 0.05 + p) * 0.2);
          const px = Math.cos(a) * pr;
          const py = Math.sin(a) * pr;
          const pSize = 2 + Math.sin(state.frameCount * 0.08 + p * 1.3) * 1;
          g.beginFill(e.color, 0.7 * alpha);
          g.drawCircle(px, py, pSize);
          g.endFill();
        }

        // Inner bright core glow (ADD)
        glow.beginFill(e.color, 0.25 * alpha);
        glow.drawCircle(e.x, e.y, r * 0.35);
        glow.endFill();
        break;
      }

      // --- EXPLOSION ---
      case 'explosion': {
        const progress = t;
        const expandR = e.radius * Math.min(progress * 2, 1);

        // Initial bright white flash (first 30% of life)
        if (progress < 0.3) {
          const flashAlpha = (0.3 - progress) / 0.3;
          glow.beginFill(0xFFFFFF, 0.6 * flashAlpha);
          glow.drawCircle(e.x, e.y, expandR * 0.4);
          glow.endFill();
        }

        // Main fill
        g.beginFill(e.color, 0.25 * alpha);
        g.drawCircle(0, 0, expandR);
        g.endFill();

        // Shockwave ring 1
        const ring1R = e.radius * Math.min(progress * 1.5, 1);
        const ring1Alpha = Math.max(0, 1 - progress * 1.5);
        g.lineStyle(3, e.color, 0.8 * ring1Alpha);
        g.drawCircle(0, 0, ring1R);

        // Shockwave ring 2 (delayed)
        if (progress > 0.2) {
          const p2 = (progress - 0.2) / 0.8;
          const ring2R = e.radius * Math.min(p2 * 1.3, 1) * 0.85;
          const ring2Alpha = Math.max(0, 1 - p2 * 1.5);
          g.lineStyle(2, 0xFFFFFF, 0.5 * ring2Alpha);
          g.drawCircle(0, 0, ring2R);
        }

        // Debris particles scattered outward
        const debrisCount = 10;
        const seed = Math.floor(e.x * 7 + e.y * 13);
        for (let d = 0; d < debrisCount; d++) {
          const da = ((seed + d * 137) % 360) * Math.PI / 180;
          const dd = expandR * (0.5 + ((seed + d * 53) % 100) / 200);
          const dAlpha = Math.max(0, alpha - 0.2);
          const dSize = 1.5 + (d % 3);
          const dx = Math.cos(da) * dd;
          const dy = Math.sin(da) * dd;
          g.beginFill(e.color, 0.7 * dAlpha);
          if (d % 2 === 0) {
            g.drawRect(dx - dSize / 2, dy - dSize / 2, dSize, dSize);
          } else {
            g.drawCircle(dx, dy, dSize * 0.6);
          }
          g.endFill();
        }
        break;
      }

      // --- BEAM ---
      case 'beam': {
        const beamLen = e.radius;
        const pulse = 1 + Math.sin(state.frameCount * 0.15) * 0.15;

        // Outer glow (wide, transparent)
        g.lineStyle(14 * pulse, e.color, 0.15);
        g.moveTo(-beamLen, 0);
        g.lineTo(beamLen, 0);

        // Mid layer (medium, colored)
        g.lineStyle(6 * pulse, e.color, 0.5);
        g.moveTo(-beamLen, 0);
        g.lineTo(beamLen, 0);

        // Inner core (thin, white)
        g.lineStyle(2 * pulse, 0xFFFFFF, 0.8);
        g.moveTo(-beamLen, 0);
        g.lineTo(beamLen, 0);

        g.rotation = e.angle;

        // Origin orb at player position (drawn in glow layer, world coords)
        const originX = e.x - Math.cos(e.angle) * beamLen;
        const originY = e.y - Math.sin(e.angle) * beamLen;
        glow.beginFill(0xFFFFFF, 0.5);
        glow.drawCircle(originX, originY, 6);
        glow.endFill();
        glow.beginFill(e.color, 0.3);
        glow.drawCircle(originX, originY, 10);
        glow.endFill();

        // Particles along beam
        const pCount = 6;
        for (let p = 0; p < pCount; p++) {
          const pt = (p + (state.frameCount * 0.05) % 1) / pCount;
          const px = -beamLen + beamLen * 2 * pt;
          const py = (Math.random() - 0.5) * 6;
          g.beginFill(0xFFFFFF, 0.4 + Math.random() * 0.3);
          g.drawCircle(px, py, 1 + Math.random());
          g.endFill();
        }
        break;
      }

      // --- LIGHTNING ---
      case 'lightning': {
        const ldx = e.vx - e.x;
        const ldy = e.vy - e.y;

        // Main bolt
        const mainPts = drawJaggedBolt(
          g, 0, 0, ldx, ldy,
          7, 20,
          e.color, 0.4 * alpha, 6,
          0xFFFFFF, 0.9 * alpha, 2,
        );

        // Branch bolts (30% chance per segment)
        for (let s = 1; s < mainPts.length - 1; s++) {
          if (Math.random() < 0.3) {
            const branchLen = 15 + Math.random() * 20;
            const branchAngle = Math.atan2(ldy, ldx) + (Math.random() - 0.5) * 1.5;
            const bx2 = mainPts[s].x + Math.cos(branchAngle) * branchLen;
            const by2 = mainPts[s].y + Math.sin(branchAngle) * branchLen;
            drawJaggedBolt(
              g, mainPts[s].x, mainPts[s].y, bx2, by2,
              3, 10,
              e.color, 0.25 * alpha, 3,
              0xFFFFFF, 0.6 * alpha, 1,
            );
          }
        }

        // Flash at start and end points (ADD glow)
        const flashA = Math.min(alpha * 2, 1);
        glow.beginFill(0xFFFFFF, 0.5 * flashA);
        glow.drawCircle(e.x, e.y, 6);
        glow.endFill();
        glow.beginFill(e.color, 0.4 * flashA);
        glow.drawCircle(e.vx, e.vy, 8);
        glow.endFill();
        break;
      }

      // --- WAVE ---
      case 'wave': {
        const waveAngle = e.angle;
        const perpX = -Math.sin(waveAngle);
        const perpY = Math.cos(waveAngle);
        const waveWidth = e.radius * 2.5;

        // Multiple particles forming a "wall"
        const wallCount = 8;
        for (let w = 0; w < wallCount; w++) {
          const wt = (w / (wallCount - 1)) - 0.5;
          const sineOffset = Math.sin(wt * Math.PI * 2 + state.frameCount * 0.15) * 4;
          const px = perpX * wt * waveWidth + Math.cos(waveAngle) * sineOffset;
          const py = perpY * wt * waveWidth + Math.sin(waveAngle) * sineOffset;
          const pSize = 3 + Math.sin(state.frameCount * 0.1 + w) * 1;
          g.beginFill(e.color, 0.6 * alpha);
          g.drawCircle(px, py, pSize);
          g.endFill();
        }

        // Foam/splash at wave front
        const foamCount = 5;
        for (let f = 0; f < foamCount; f++) {
          const ft = ((f + 0.5) / foamCount - 0.5);
          const fx = perpX * ft * waveWidth + (Math.random() - 0.5) * 6;
          const fy = perpY * ft * waveWidth + (Math.random() - 0.5) * 6;
          g.beginFill(0xFFFFFF, 0.4 * alpha);
          g.drawCircle(fx + Math.cos(waveAngle) * 3, fy + Math.sin(waveAngle) * 3, 1.5);
          g.endFill();
        }

        // Trailing droplets behind
        const trailCount = 4;
        for (let tr = 0; tr < trailCount; tr++) {
          const trOffset = -(tr + 1) * 6;
          const trx = Math.cos(waveAngle) * trOffset + (Math.random() - 0.5) * 8;
          const tr_y = Math.sin(waveAngle) * trOffset + (Math.random() - 0.5) * 8;
          g.beginFill(e.color, 0.25 * alpha);
          g.drawCircle(trx, tr_y, 1.5);
          g.endFill();
        }

        // Glow on wave front
        glow.beginFill(e.color, 0.12 * alpha);
        glow.drawCircle(e.x, e.y, e.radius * 1.5);
        glow.endFill();
        break;
      }

      // --- DEFAULT / PROJECTILE ---
      default: {
        g.beginFill(e.color, 0.5 * alpha);
        g.drawCircle(0, 0, e.radius);
        g.endFill();
        glow.beginFill(e.color, 0.2 * alpha);
        glow.drawCircle(e.x, e.y, e.radius + 3);
        glow.endFill();
      }
    }

    if (e.type !== 'beam') {
      g.rotation = 0;
    }
    g.x = e.x;
    g.y = e.y;
  }
}

export function updateCamera(state: GameState) {
  state.cameraX = state.player.x - CANVAS_W / 2;
  state.cameraY = state.player.y - CANVAS_H / 2;

  // Clamp
  state.cameraX = Math.max(0, Math.min(WORLD_W - CANVAS_W, state.cameraX));
  state.cameraY = Math.max(0, Math.min(WORLD_H - CANVAS_H, state.cameraY));

  // Screen shake
  if (state.shakeFrames > 0) {
    state.shakeX = (Math.random() - 0.5) * state.shakeFrames * 1.5;
    state.shakeY = (Math.random() - 0.5) * state.shakeFrames * 1.5;
    state.shakeFrames--;
  } else {
    state.shakeX = 0;
    state.shakeY = 0;
  }
}

export function applyCamera(worldContainer: PIXI.Container, state: GameState, playerLayer?: PIXI.Container) {
  const x = -state.cameraX + state.shakeX;
  const y = -state.cameraY + state.shakeY;
  worldContainer.x = x;
  worldContainer.y = y;
  if (playerLayer) {
    playerLayer.x = x;
    playerLayer.y = y;
  }
}
