import * as PIXI from 'pixi.js';
import {
  GameState, CANVAS_W, CANVAS_H, WORLD_W, WORLD_H,
  PLAYER_WIDTH, PLAYER_HEIGHT, ELEMENT_COLORS, ElementType,
  isBossType,
} from './types';
import { drawBoss, getElectricGlowFilter, getLightGlowFilter } from './renderer_boss';

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
// 보스 전용 glow 레이어 (ADD blend mode) — 빛나는 코어/링 overlay용
const _bossGlowGraphics: PIXI.Graphics[] = [];

export function drawEnemies(container: PIXI.Container, state: GameState, enemyGraphics: PIXI.Graphics[]) {
  const { enemies, cameraX, cameraY } = state;
  while (enemyGraphics.length < enemies.length) {
    const g = new PIXI.Graphics();
    container.addChild(g);
    enemyGraphics.push(g);
    // 보스 glow 슬롯도 병렬로 준비 (재사용 풀)
    const glow = new PIXI.Graphics();
    glow.blendMode = PIXI.BLEND_MODES.ADD;
    glow.visible = false;
    container.addChild(glow);
    _bossGlowGraphics.push(glow);
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
    const glow = _bossGlowGraphics[i];
    if (!e.active) {
      g.visible = false;
      if (glow) glow.visible = false;
      _enemyLastHp[i] = -1;
      continue;
    }
    // Viewport culling — 화면 밖 적은 숨김 (update는 계속 돌아감)
    if (e.x < viewLeft || e.x > viewRight || e.y < viewTop || e.y > viewBottom) {
      g.visible = false;
      if (glow) glow.visible = false;
      continue;
    }
    g.visible = true;

    // ── 보스: 매 프레임 커스텀 렌더 (애니메이션 위해 dirty-check 무시) ──
    if (isBossType(e.type)) {
      // Electric/Light 보스: g 자체에 GlowFilter 적용 → 진짜 bloom
      if (e.type === 'boss_electric') {
        if (!g.filters || g.filters.length !== 1 || (g.filters[0] as unknown) !== getElectricGlowFilter()) {
          g.filters = [getElectricGlowFilter()];
        }
      } else if (e.type === 'boss_light') {
        if (!g.filters || g.filters.length !== 1 || (g.filters[0] as unknown) !== getLightGlowFilter()) {
          g.filters = [getLightGlowFilter()];
        }
      } else {
        if (g.filters && g.filters.length > 0) g.filters = null;
      }
      glow.visible = true;
      glow.clear();
      drawBoss(g, e, state.frameCount, glow);
      _enemyLastHp[i] = e.hp;
      _enemyLastMaxHp[i] = e.maxHp;
      g.x = e.x;
      g.y = e.y;
      g.rotation = 0;  // 보스는 회전 안 함 (실루엣이 고정 방향)
      glow.x = e.x;
      glow.y = e.y;
      glow.rotation = 0;
      continue;
    }
    // 보스 아니면 glow 숨김
    if (glow) glow.visible = false;
    // 필터도 제거 (슬롯 재사용 시)
    if (g.filters && g.filters.length > 0) g.filters = null;

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
    const g = projGraphics[i] as PIXI.Graphics & { _projSig?: string };
    if (!p.active) { g.visible = false; continue; }
    g.visible = true;

    // 기본 투사체(정적)만 sig 캐시로 redraw 스킵. 전기/불은 jitter 있으므로 매 프레임.
    const isDynamic = p.elementType === '전기' || p.elementType === '불';
    if (isDynamic) {
      g._projSig = undefined;
      g.clear();
    } else {
      const sig = `b:${p.color}:${p.radius}`;
      if (g._projSig !== sig) {
        g._projSig = sig;
        g.clear();
      } else {
        g.x = p.x;
        g.y = p.y;
        continue;
      }
    }

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
export function drawEnemyProjectiles(g: PIXI.Graphics, glow: PIXI.Graphics, state: GameState) {
  g.clear();
  glow.clear();
  const projs = state.enemyProjectiles;
  const t = state.frameCount;
  for (let i = 0; i < projs.length; i++) {
    const p = projs[i];
    if (!p.active) continue;

    // ── 지연 예고 (delay>0): 변형별 마커 렌더 ──
    if (p.delay !== undefined && p.delay > 0) {
      const k = 1 - p.delay / Math.max(p.delay + 1, 30);  // 대략 차오르는 비율
      const v = p.variant;
      if (v === 'water_tidal_preview' && (p.vx !== 0 || p.vy !== 0)) {
        // ── 비행 phase: 보스에서 target으로 이동 중인 충전 orb ──
        const spd = Math.sqrt(p.vx * p.vx + p.vy * p.vy) || 1;
        const dirX = p.vx / spd;
        const dirY = p.vy / spd;
        const R = p.radius * 0.38;  // 비행 중은 작게 (도착 시 확장)
        // 뒤로 expanding wavefront 링 4개 (진행파 — 올챙이 꼬리 X)
        for (let ring = 0; ring < 4; ring++) {
          const rp = ((t + ring * 10) % 40) / 40;
          const rad = R * (0.9 + rp * 1.6);
          const al = (1 - rp) * 0.55;
          const backDist = R * 1.6 * rp;
          const cx = p.x - dirX * backDist;
          const cy = p.y - dirY * backDist;
          g.lineStyle(2.0 * (1 - rp) + 0.5, lerpWaterColor(0.2 + rp * 0.5), al);
          g.drawCircle(cx, cy, rad);
        }
        g.lineStyle(0);
        // 회전 mini hex (도착 후 확장될 containment 예고)
        const miniHexRot = t * 0.12;
        g.lineStyle(1.4, lerpWaterColor(0.25), 0.88);
        for (let i = 0; i <= 6; i++) {
          const a = miniHexRot + (i / 6) * Math.PI * 2;
          const hx = p.x + Math.cos(a) * R * 1.5;
          const hy = p.y + Math.sin(a) * R * 1.5;
          if (i === 0) g.moveTo(hx, hy); else g.lineTo(hx, hy);
        }
        g.lineStyle(0);
        // 코어 bloom
        glow.beginFill(lerpWaterColor(0.0), 0.75);
        glow.drawCircle(p.x, p.y, R * 2.0);
        glow.endFill();
        glow.beginFill(lerpWaterColor(0.0), 1.0);
        glow.drawCircle(p.x, p.y, R * 1.2);
        glow.endFill();
        // 코어 4겹 (충전 중 호흡)
        const corePulse = 0.94 + Math.sin(t * 0.22) * 0.08;
        g.beginFill(lerpWaterColor(0.55), 0.94); g.drawCircle(p.x, p.y, R * 1.1);              g.endFill();
        g.beginFill(lerpWaterColor(0.25), 0.94); g.drawCircle(p.x, p.y, R * 0.80 * corePulse); g.endFill();
        g.beginFill(lerpWaterColor(0.10), 0.96); g.drawCircle(p.x, p.y, R * 0.52 * corePulse); g.endFill();
        g.beginFill(lerpWaterColor(0.0),  1.0);  g.drawCircle(p.x, p.y, R * 0.28 * corePulse); g.endFill();
      } else if (v === 'water_tidal_preview') {
        // Tidal Mesh Field 예고 — hex reticle + 수축 링 + core pulse (no white).
        const R = p.radius;
        // 외곽 hazard 링 (희미)
        g.lineStyle(1.8 - k * 0.4, lerpWaterColor(0.8), 0.35 + k * 0.3);
        g.drawCircle(p.x, p.y, R * (0.95 + k * 0.1));
        g.lineStyle(0);
        // 수축 링 3단 (phase 엇갈림) — 잠김 sensation
        for (let ri = 0; ri < 3; ri++) {
          const phase = ((t + ri * 20) % 60) / 60;
          const rr = R * (1.25 - phase * 0.85);
          const al = (1 - phase) * (0.35 + k * 0.4);
          g.lineStyle(2.0 - phase * 1.2, lerpWaterColor(0.25), al);
          g.drawCircle(p.x, p.y, rr);
        }
        g.lineStyle(0);
        // Hex containment reticle (보스 frame DNA — 회전)
        const hexRot = t * 0.025;
        const hexR = R * (0.82 + k * 0.12);
        g.lineStyle(1.9, lerpWaterColor(0.15), 0.55 + k * 0.40);
        for (let i = 0; i <= 6; i++) {
          const a = hexRot + (i / 6) * Math.PI * 2;
          const hx = p.x + Math.cos(a) * hexR;
          const hy = p.y + Math.sin(a) * hexR;
          if (i === 0) g.moveTo(hx, hy); else g.lineTo(hx, hy);
        }
        g.lineStyle(0);
        // hex 모서리 6개 node
        for (let i = 0; i < 6; i++) {
          const a = hexRot + (i / 6) * Math.PI * 2;
          const hx = p.x + Math.cos(a) * hexR;
          const hy = p.y + Math.sin(a) * hexR;
          glow.beginFill(lerpWaterColor(0.0), 0.6 + k * 0.3);
          glow.drawCircle(hx, hy, 4.2);
          glow.endFill();
          g.beginFill(lerpWaterColor(0.05), 0.88 + k * 0.1);
          g.drawCircle(hx, hy, 2.0);
          g.endFill();
        }
        // 중심 atom core (차징 pulse)
        const corePulse = 0.5 + k * 0.5 + Math.sin(t * 0.25) * 0.1;
        glow.beginFill(lerpWaterColor(0.0), 0.4 + k * 0.4);
        glow.drawCircle(p.x, p.y, R * 0.35 * corePulse);
        glow.endFill();
        g.beginFill(lerpWaterColor(0.55), 0.90); g.drawCircle(p.x, p.y, R * 0.22 * corePulse); g.endFill();
        g.beginFill(lerpWaterColor(0.25), 0.92); g.drawCircle(p.x, p.y, R * 0.14 * corePulse); g.endFill();
        g.beginFill(lerpWaterColor(0.05), 0.95); g.drawCircle(p.x, p.y, R * 0.07 * corePulse); g.endFill();
        // 8방 tick mark (계기판 DNA)
        g.lineStyle(1.4, lerpWaterColor(0.15), 0.55 + k * 0.3);
        for (let tk = 0; tk < 8; tk++) {
          const a = hexRot * 0.4 + (tk / 8) * Math.PI * 2;
          const ca = Math.cos(a), sa = Math.sin(a);
          const inR = R * 0.55;
          const outR = R * 0.72;
          g.moveTo(p.x + ca * inR, p.y + sa * inR);
          g.lineTo(p.x + ca * outR, p.y + sa * outR);
        }
        g.lineStyle(0);
      } else if (v === 'electric_chain_strike') {
        // Chain Strike PREVIEW — 시작점/끝점 diamond plate만 표시, 아직 전기 X.
        //    strike 때 prev→current 로 전기 흐름.
        const ox = p.originX ?? p.x;
        const oy = p.originY ?? p.y;
        const R = p.radius;
        // 가이드 선 (preview 전용 — thin, 점점 진해짐)
        g.lineStyle(1.3, lerpElectricColor(0.75), 0.25 + k * 0.25);
        g.moveTo(ox, oy); g.lineTo(p.x, p.y);
        g.lineStyle(0);
        // 타겟 plate (diamond, dark outline)
        drawDiamondPlate(g, p.x, p.y, R * 0.55, k);
      } else if (v === 'electric_arc_rail') {
        // Arc Rail PREVIEW — 시작점(보스) + 끝점 diamond plate만. 선은 thin 가이드.
        //    strike 때 전기가 rail 전체 흐름.
        const ox = p.originX ?? p.x;
        const oy = p.originY ?? p.y;
        const tx = p.targetX ?? p.x;
        const ty = p.targetY ?? p.y;
        const R = p.radius;
        // Main renderer (rail 위에서 가장 앞쪽 projectile만 endpoint 그림)
        const dxa = p.x - ox, dya = p.y - oy;
        const dl = Math.sqrt(dxa*dxa + dya*dya);
        const tLen = Math.sqrt((tx-ox)*(tx-ox) + (ty-oy)*(ty-oy)) || 1;
        const fracOnRail = dl / tLen;
        if (fracOnRail < 0.40) {
          // thin 가이드 선 (preview — 전기 X)
          g.lineStyle(1.6, lerpElectricColor(0.78), 0.28 + k * 0.30);
          g.moveTo(ox, oy); g.lineTo(tx, ty);
          g.lineStyle(0);
          // 끝점 plate (시작점은 보스 본체 기준 내부니까 생략 가능, but 혼동 방지로 그림)
          drawDiamondPlate(g, ox, oy, R * 0.45, k);
          drawDiamondPlate(g, tx, ty, R * 0.55, k);
        }
        // 이 projectile의 hit point marker (작은 diamond)
        drawDiamondPlate(g, p.x, p.y, R * 0.40, k);
      } else if (v === 'electric_dual_terminal') {
        // Dual Terminal PREVIEW — pole diamond plate 2개 + 가이드 선 between.
        //    strike 때 전기가 pole 사이 흐름.
        const R = p.radius;
        const isMidOnly = p.originX === undefined && p.targetX === undefined;
        if (!isMidOnly) {
          // pole plate
          drawDiamondPlate(g, p.x, p.y, R * 0.65, k);
        }
        // pole A (targetX 있음) — 가이드 선 + 상대 pole plate
        if (p.targetX !== undefined && p.targetY !== undefined) {
          g.lineStyle(1.6, lerpElectricColor(0.78), 0.28 + k * 0.30);
          g.moveTo(p.x, p.y); g.lineTo(p.targetX, p.targetY);
          g.lineStyle(0);
        }
        // mid — 작은 x-mark (hit 경고, 점점 진해짐)
        if (isMidOnly) {
          const crossSize = R * (0.32 + k * 0.25);
          g.lineStyle(2.0, lerpElectricColor(0.88), 0.35 + k * 0.40);
          g.moveTo(p.x - crossSize, p.y - crossSize);
          g.lineTo(p.x + crossSize, p.y + crossSize);
          g.moveTo(p.x + crossSize, p.y - crossSize);
          g.lineTo(p.x - crossSize, p.y + crossSize);
          g.lineStyle(0);
        }
      } else if (v === 'light_prism_main') {
        // Prism Main PREVIEW — 보스→midpoint 가이드 선 + 두 endpoint plate.
        const ox = p.originX ?? p.x;
        const oy = p.originY ?? p.y;
        const R = p.radius;
        // 가이드 선 (thin gold, telegraph)
        g.lineStyle(1.6, lerpLightColor(0.70), 0.28 + k * 0.32);
        g.moveTo(ox, oy); g.lineTo(p.x, p.y);
        g.lineStyle(0);
        // 시작점 (보스 side) + midpoint plate
        drawGoldPlate(g, ox, oy, R * 0.45, k);
        drawGoldPlate(g, p.x, p.y, R * 0.60, k);
      } else if (v === 'light_prism_branch') {
        // Prism Branch PREVIEW — midpoint(origin)→endpoint(target) 가이드 선 + endpoint plate.
        const ox = p.originX ?? p.x;
        const oy = p.originY ?? p.y;
        const tx = p.targetX ?? p.x;
        const ty = p.targetY ?? p.y;
        const R = p.radius;
        g.lineStyle(1.4, lerpLightColor(0.72), 0.25 + k * 0.30);
        g.moveTo(ox, oy); g.lineTo(tx, ty);
        g.lineStyle(0);
        // endpoint plate (target)
        drawGoldPlate(g, tx, ty, R * 0.50, k);
        // hit point marker (작은 plate)
        drawGoldPlate(g, p.x, p.y, R * 0.35, k);
      } else if (v === 'light_halo') {
        // Halo Ring PREVIEW — node diamond plate가 formation.
        const R = p.radius;
        drawGoldPlate(g, p.x, p.y, R * 0.50, k);
        // 보스 쪽 얇은 radial 선 (ring formation indicator)
        const ox = p.originX ?? p.x;
        const oy = p.originY ?? p.y;
        g.lineStyle(1.0, lerpLightColor(0.78), 0.22 + k * 0.25);
        g.moveTo(ox, oy); g.lineTo(p.x, p.y);
        g.lineStyle(0);
      } else if (v === 'light_pillar') {
        // Sun Pillar PREVIEW — 지상 원 + 위에서 내려오는 가이드 선.
        const R = p.radius;
        // 지상 landing circle (점점 명확)
        g.lineStyle(2.0, lerpLightColor(0.62), 0.45 + k * 0.40);
        g.drawCircle(p.x, p.y, R * (0.95 + k * 0.10));
        g.lineStyle(0);
        // 수축 inner ring (예고 강화)
        for (let ri = 0; ri < 2; ri++) {
          const phase = ((t + ri * 20) % 45) / 45;
          const rr = R * (1.25 - phase * 0.80);
          const al = (1 - phase) * (0.35 + k * 0.35);
          g.lineStyle(1.5 - phase * 0.8, lerpLightColor(0.50), al);
          g.drawCircle(p.x, p.y, rr);
        }
        g.lineStyle(0);
        // 수직 guide line (위에서부터 내려오는 빛 기둥 표시)
        const beamTopY = p.y - 400;
        const beamW = 8 + k * 10;
        // Thin dashed-like guide (implement as short segments)
        const segH = 20;
        for (let sy = beamTopY; sy < p.y - 20; sy += segH * 2) {
          g.lineStyle(beamW * 0.4, lerpLightColor(0.70), 0.35 + k * 0.35);
          g.moveTo(p.x, sy);
          g.lineTo(p.x, Math.min(sy + segH, p.y - 20));
        }
        g.lineStyle(0);
        // 중심 marker
        drawGoldPlate(g, p.x, p.y, R * 0.30, k);
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
    const v0 = p.variant;
    const isExplosionFlash = (
      v0 === 'water_tidal_preview' ||
      v0 === 'electric_chain_strike' || v0 === 'electric_arc_rail' ||
      v0 === 'electric_dual_terminal' ||
      v0 === 'light_prism_main' || v0 === 'light_prism_branch' ||
      v0 === 'light_pillar' ||
      v0 === 'dark_portal'
    );
    if (isExplosionFlash && p.vx === 0 && p.vy === 0 && p.life <= 20 && p.life > 0) {
      const v = p.variant;
      const pulse = p.life / 20;  // 20→0 페이드
      if (v === 'water_tidal_preview') {
        // Tidal Mesh 폭발 flash — hex frame이 순간 밝아지며 팽창, mesh 스폰 예고.
        const expand = 1 + (1 - pulse) * 0.4;
        const R = p.radius;
        // 중심 burst
        glow.beginFill(lerpWaterColor(0.0), 0.85 * pulse);
        glow.drawCircle(p.x, p.y, R * 0.65 * expand);
        glow.endFill();
        glow.beginFill(lerpWaterColor(0.0), pulse);
        glow.drawCircle(p.x, p.y, R * 0.35 * expand);
        glow.endFill();
        g.beginFill(lerpWaterColor(0.15), 0.9 * pulse);
        g.drawCircle(p.x, p.y, R * 0.28 * expand);
        g.endFill();
        g.beginFill(lerpWaterColor(0.05), 0.95 * pulse);
        g.drawCircle(p.x, p.y, R * 0.14);
        g.endFill();
        // Hex frame 확장 (순간 bright)
        const hexRot = t * 0.05;
        g.lineStyle(2.6 * pulse + 0.6, lerpWaterColor(0.1), 0.95 * pulse);
        for (let i = 0; i <= 6; i++) {
          const a = hexRot + (i / 6) * Math.PI * 2;
          const hx = p.x + Math.cos(a) * R * 0.95 * expand;
          const hy = p.y + Math.sin(a) * R * 0.95 * expand;
          if (i === 0) g.moveTo(hx, hy); else g.lineTo(hx, hy);
        }
        g.lineStyle(0);
        // 확장 shockwave 링
        g.lineStyle(3 * pulse + 0.5, lerpWaterColor(0.3), 0.85 * pulse);
        g.drawCircle(p.x, p.y, R * (1 + (1 - pulse) * 1.1));
        g.lineStyle(0);
      } else if (v === 'electric_chain_strike') {
        // Chain Strike STRIKE — prev→current 사이로 지그재그 전기 흐름 + diamond 확장.
        const ox = p.originX ?? p.x;
        const oy = p.originY ?? p.y;
        const R = p.radius;
        const flickSeed = Math.floor(t * 0.5);
        // 지그재그 전기 (3겹 — outer glow, mid, bright core)
        drawZigzagBolt(g, ox, oy, p.x, p.y, 12, 14,
          lerpElectricColor(0.92), 4.5 * pulse + 1.2, 0.82 * pulse, flickSeed * 13 + 7);
        drawZigzagBolt(g, ox, oy, p.x, p.y, 12, 8,
          lerpElectricColor(0.55), 2.2 * pulse + 0.5, 0.95 * pulse, flickSeed * 17 + 3);
        drawZigzagBolt(g, ox, oy, p.x, p.y, 12, 4,
          lerpElectricColor(0.20), 1.0 * pulse + 0.3, pulse, flickSeed * 23 + 11);
        // Diamond plate 확장
        const expandR = R * (0.85 + (1 - pulse) * 0.25);
        drawDiamondPlate(g, p.x, p.y, expandR, pulse);
      } else if (v === 'electric_arc_rail') {
        // Arc Rail STRIKE — rail 전체 지그재그 전기 + endpoint diamond bright.
        const ox = p.originX ?? p.x;
        const oy = p.originY ?? p.y;
        const tx = p.targetX ?? p.x;
        const ty = p.targetY ?? p.y;
        const R = p.radius;
        const dxa = p.x - ox, dya = p.y - oy;
        const dl = Math.sqrt(dxa*dxa + dya*dya);
        const tLen = Math.sqrt((tx-ox)*(tx-ox) + (ty-oy)*(ty-oy)) || 1;
        const fracOnRail = dl / tLen;
        if (fracOnRail < 0.40) {
          const flickSeed = Math.floor(t * 0.4);
          // 전체 rail 지그재그 (3겹)
          drawZigzagBolt(g, ox, oy, tx, ty, 22, 22,
            lerpElectricColor(0.92), 6 * pulse + 1.5, 0.80 * pulse, flickSeed * 13 + 7);
          drawZigzagBolt(g, ox, oy, tx, ty, 22, 13,
            lerpElectricColor(0.55), 2.6 * pulse + 0.7, pulse, flickSeed * 17 + 3);
          drawZigzagBolt(g, ox, oy, tx, ty, 22, 6,
            lerpElectricColor(0.20), 1.1 * pulse + 0.3, pulse, flickSeed * 23 + 11);
          // Endpoint diamond (확장)
          drawDiamondPlate(g, ox, oy, R * 0.55 * (1 + (1-pulse) * 0.4), pulse);
          drawDiamondPlate(g, tx, ty, R * 0.65 * (1 + (1-pulse) * 0.4), pulse);
        }
        // hit point diamond 확장
        drawDiamondPlate(g, p.x, p.y, R * 0.50 * (1 + (1-pulse) * 0.4), pulse);
      } else if (v === 'electric_dual_terminal') {
        // Dual Terminal STRIKE — pole 사이로 지그재그 전기 + pole 확장.
        const R = p.radius;
        const isMidOnly = p.originX === undefined && p.targetX === undefined;
        if (!isMidOnly) {
          drawDiamondPlate(g, p.x, p.y, R * 0.80 * (1 + (1-pulse) * 0.3), pulse);
        }
        if (p.targetX !== undefined && p.targetY !== undefined) {
          const flickSeed = Math.floor(t * 0.4);
          drawZigzagBolt(g, p.x, p.y, p.targetX, p.targetY, 18, 24,
            lerpElectricColor(0.92), 5.5 * pulse + 1.2, 0.80 * pulse, flickSeed * 13 + 7);
          drawZigzagBolt(g, p.x, p.y, p.targetX, p.targetY, 18, 14,
            lerpElectricColor(0.55), 2.4 * pulse + 0.6, pulse, flickSeed * 17 + 3);
          drawZigzagBolt(g, p.x, p.y, p.targetX, p.targetY, 18, 7,
            lerpElectricColor(0.20), 1.0 * pulse + 0.3, pulse, flickSeed * 23 + 11);
        }
        if (isMidOnly) {
          // mid x-mark strong flash
          const crossSize = R * 0.72;
          g.lineStyle(4 * pulse + 1, lerpElectricColor(0.92), 0.88 * pulse);
          g.moveTo(p.x - crossSize, p.y - crossSize);
          g.lineTo(p.x + crossSize, p.y + crossSize);
          g.moveTo(p.x + crossSize, p.y - crossSize);
          g.lineTo(p.x - crossSize, p.y + crossSize);
          g.lineStyle(1.8 * pulse, lerpElectricColor(0.55), pulse);
          g.moveTo(p.x - crossSize, p.y - crossSize);
          g.lineTo(p.x + crossSize, p.y + crossSize);
          g.moveTo(p.x + crossSize, p.y - crossSize);
          g.lineTo(p.x - crossSize, p.y + crossSize);
          g.lineStyle(0);
        }
      } else if (v === 'light_prism_main') {
        // Prism Main STRIKE — 보스→midpoint bright gold beam.
        const ox = p.originX ?? p.x;
        const oy = p.originY ?? p.y;
        const R = p.radius;
        // beam 3겹 (outer glow + mid + core)
        g.lineStyle(5.5 * pulse + 1.5, lerpLightColor(0.65), 0.55 * pulse);
        g.moveTo(ox, oy); g.lineTo(p.x, p.y);
        g.lineStyle(2.8 * pulse + 0.8, lerpLightColor(0.35), 0.85 * pulse);
        g.moveTo(ox, oy); g.lineTo(p.x, p.y);
        g.lineStyle(1.2 * pulse + 0.4, lerpLightColor(0.15), pulse);
        g.moveTo(ox, oy); g.lineTo(p.x, p.y);
        g.lineStyle(0);
        // endpoint plate expansion
        drawGoldPlate(g, ox, oy, R * 0.50 * (1 + (1-pulse) * 0.3), pulse);
        drawGoldPlate(g, p.x, p.y, R * 0.75 * (1 + (1-pulse) * 0.4), pulse);
      } else if (v === 'light_prism_branch') {
        // Prism Branch STRIKE — midpoint→endpoint bright gold beam.
        const ox = p.originX ?? p.x;
        const oy = p.originY ?? p.y;
        const tx = p.targetX ?? p.x;
        const ty = p.targetY ?? p.y;
        const R = p.radius;
        g.lineStyle(4.5 * pulse + 1.2, lerpLightColor(0.62), 0.55 * pulse);
        g.moveTo(ox, oy); g.lineTo(tx, ty);
        g.lineStyle(2.2 * pulse + 0.6, lerpLightColor(0.30), 0.88 * pulse);
        g.moveTo(ox, oy); g.lineTo(tx, ty);
        g.lineStyle(1.0 * pulse + 0.3, lerpLightColor(0.12), pulse);
        g.moveTo(ox, oy); g.lineTo(tx, ty);
        g.lineStyle(0);
        // endpoint flash
        drawGoldPlate(g, tx, ty, R * 0.60 * (1 + (1-pulse) * 0.4), pulse);
        // hit point flash
        drawGoldPlate(g, p.x, p.y, R * 0.48 * (1 + (1-pulse) * 0.4), pulse);
      } else if (v === 'light_pillar') {
        // Sun Pillar STRIKE — 수직 빛 기둥 (위에서 내려오는 bright column + 지상 burst).
        const R = p.radius;
        const beamTopY = p.y - 400;
        const colH = p.y - beamTopY;
        const beamW = 30 * pulse + 14;
        // 기둥 3겹 (outer glow, mid, bright core)
        g.beginFill(lerpLightColor(0.62), 0.52 * pulse);
        g.drawRect(p.x - beamW / 2, beamTopY, beamW, colH);
        g.endFill();
        g.beginFill(lerpLightColor(0.32), 0.80 * pulse);
        g.drawRect(p.x - beamW * 0.55, beamTopY, beamW * 0.55 * 2, colH);
        g.endFill();
        g.beginFill(lerpLightColor(0.10), pulse);
        g.drawRect(p.x - beamW * 0.25, beamTopY, beamW * 0.50, colH);
        g.endFill();
        // 지상 원 burst (확장)
        const expand = 1 + (1 - pulse) * 0.55;
        g.beginFill(lerpLightColor(0.45), 0.65 * pulse);
        g.drawCircle(p.x, p.y, R * 0.85 * expand);
        g.endFill();
        g.beginFill(lerpLightColor(0.20), 0.85 * pulse);
        g.drawCircle(p.x, p.y, R * 0.50 * expand);
        g.endFill();
        g.beginFill(lerpLightColor(0.05), pulse);
        g.drawCircle(p.x, p.y, R * 0.25);
        g.endFill();
        // 6방 radial gold spark (지상 impact)
        g.lineStyle(2.4 * pulse + 0.6, lerpLightColor(0.35), 0.88 * pulse);
        for (let sp = 0; sp < 6; sp++) {
          const a = (sp / 6) * Math.PI * 2 + t * 0.02;
          const sparkR = R * (1.0 + (1 - pulse) * 0.6);
          g.moveTo(p.x + Math.cos(a) * R * 0.5, p.y + Math.sin(a) * R * 0.5);
          g.lineTo(p.x + Math.cos(a) * sparkR, p.y + Math.sin(a) * sparkR);
        }
        g.lineStyle(0);
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
      }
      continue;
    }

    // ── 일반 주행 투사체 — variant별 렌더 ──
    drawBossProjectile(g, glow, p, t);
  }
}

// ═══════════════════════════════════════════════════════════════════
// 물 팔레트 — 흰색 금지. sky-500이 최고 밝기.
// ═══════════════════════════════════════════════════════════════════
const WATER_STOPS: Array<[number, number, number, number]> = [
  [0.00,  14, 165, 233], // sky-500 (최고)
  [0.20,  56, 189, 248], // sky-400
  [0.40,  96, 165, 250], // blue-400
  [0.60,  59, 130, 246], // blue-500
  [0.80,  37,  99, 235], // blue-600
  [1.00,  30,  58, 138], // blue-900 (최저)
];
function lerpWaterColor(tFrac: number): number {
  const tc = Math.max(0, Math.min(1, tFrac));
  for (let i = 1; i < WATER_STOPS.length; i++) {
    const [t1, r1, g1, b1] = WATER_STOPS[i];
    if (tc <= t1) {
      const [t0, r0, g0, b0] = WATER_STOPS[i - 1];
      const k = (tc - t0) / (t1 - t0);
      return (
        (Math.round(r0 + (r1 - r0) * k) << 16) |
        (Math.round(g0 + (g1 - g0) * k) <<  8) |
         Math.round(b0 + (b1 - b0) * k)
      );
    }
  }
  const [, r, g, b] = WATER_STOPS[WATER_STOPS.length - 1];
  return (r << 16) | (g << 8) | b;
}

// ═══════════════════════════════════════════════════════════════════
// 불 팔레트 — 흰색 금지. yellow-300이 최고 밝기.
// ═══════════════════════════════════════════════════════════════════
const FIRE_STOPS: Array<[number, number, number, number]> = [
  [0.00, 253, 224,  71], // yellow-300 (최고)
  [0.18, 251, 191,  36], // amber-400
  [0.40, 249, 115,  22], // orange-500
  [0.60, 234,  88,  12], // orange-600
  [0.78, 220,  38,  38], // red-600
  [0.92, 153,  27,  27], // red-800
  [1.00,  69,  10,  10], // red-950 (최저)
];
function lerpFireColor(tFrac: number): number {
  const tc = Math.max(0, Math.min(1, tFrac));
  for (let i = 1; i < FIRE_STOPS.length; i++) {
    const [t1, r1, g1, b1] = FIRE_STOPS[i];
    if (tc <= t1) {
      const [t0, r0, g0, b0] = FIRE_STOPS[i - 1];
      const k = (tc - t0) / (t1 - t0);
      return (
        (Math.round(r0 + (r1 - r0) * k) << 16) |
        (Math.round(g0 + (g1 - g0) * k) <<  8) |
         Math.round(b0 + (b1 - b0) * k)
      );
    }
  }
  const [, r, g, b] = FIRE_STOPS[FIRE_STOPS.length - 1];
  return (r << 16) | (g << 8) | b;
}

// ═══════════════════════════════════════════════════════════════════
// 흙 팔레트 — 흰색 금지. amber-300이 최고 밝기.
// ═══════════════════════════════════════════════════════════════════
const EARTH_STOPS: Array<[number, number, number, number]> = [
  [0.00, 252, 211,  77], // amber-300 (최고 — warm rim lit)
  [0.18, 251, 191,  36], // amber-400
  [0.36, 217, 119,   6], // amber-600
  [0.54, 180,  83,   9], // amber-700
  [0.72, 146,  64,  14], // amber-800
  [0.88, 120,  53,  15], // amber-900
  [1.00,  69,  26,   3], // amber-950 (최저 dark soil)
];
function lerpEarthColor(tFrac: number): number {
  const tc = Math.max(0, Math.min(1, tFrac));
  for (let i = 1; i < EARTH_STOPS.length; i++) {
    const [t1, r1, g1, b1] = EARTH_STOPS[i];
    if (tc <= t1) {
      const [t0, r0, g0, b0] = EARTH_STOPS[i - 1];
      const k = (tc - t0) / (t1 - t0);
      return (
        (Math.round(r0 + (r1 - r0) * k) << 16) |
        (Math.round(g0 + (g1 - g0) * k) <<  8) |
         Math.round(b0 + (b1 - b0) * k)
      );
    }
  }
  const [, r, g, b] = EARTH_STOPS[EARTH_STOPS.length - 1];
  return (r << 16) | (g << 8) | b;
}

// ═══════════════════════════════════════════════════════════════════
// 전기 팔레트 — violet 중심, 최고 밝기 violet-50 (흰색 대신).
// ═══════════════════════════════════════════════════════════════════
const ELECTRIC_STOPS: Array<[number, number, number, number]> = [
  [0.00, 248, 246, 255], // pale near-white violet (최고 밝기 — 번쩍)
  [0.12, 224, 231, 255], // indigo-50
  [0.26, 196, 181, 253], // violet-300
  [0.44, 167, 139, 250], // violet-400
  [0.62, 139,  92, 246], // violet-500
  [0.80, 109,  40, 217], // violet-700
  [1.00,  46,  16, 101], // violet-900 (최저)
];
function lerpElectricColor(tFrac: number): number {
  const tc = Math.max(0, Math.min(1, tFrac));
  for (let i = 1; i < ELECTRIC_STOPS.length; i++) {
    const [t1, r1, g1, b1] = ELECTRIC_STOPS[i];
    if (tc <= t1) {
      const [t0, r0, g0, b0] = ELECTRIC_STOPS[i - 1];
      const k = (tc - t0) / (t1 - t0);
      return (
        (Math.round(r0 + (r1 - r0) * k) << 16) |
        (Math.round(g0 + (g1 - g0) * k) <<  8) |
         Math.round(b0 + (b1 - b0) * k)
      );
    }
  }
  const [, r, g, b] = ELECTRIC_STOPS[ELECTRIC_STOPS.length - 1];
  return (r << 16) | (g << 8) | b;
}

// ── 지그재그 번개 — deterministic LCG seed 기반 jagged line ──
function drawZigzagBolt(
  g: PIXI.Graphics,
  sx: number, sy: number, tx: number, ty: number,
  segs: number, jitter: number,
  color: number, thick: number, alpha: number,
  seed: number,
) {
  const dx = tx - sx, dy = ty - sy;
  let s = seed | 0;
  g.lineStyle(thick, color, alpha);
  g.moveTo(sx, sy);
  // perpendicular for jitter
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  const perpX = -dy / dist, perpY = dx / dist;
  for (let i = 1; i < segs; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const jit = ((s % 131) / 131 - 0.5) * jitter;
    const frac = i / segs;
    g.lineTo(sx + dx * frac + perpX * jit, sy + dy * frac + perpY * jit);
  }
  g.lineTo(tx, ty);
  g.lineStyle(0);
}

// ═══════════════════════════════════════════════════════════════════
// 빛 팔레트 — yellow/gold 기반, 흰 배경 대응 (yellow-600~800 주 사용).
// ═══════════════════════════════════════════════════════════════════
const LIGHT_STOPS: Array<[number, number, number, number]> = [
  [0.00, 254, 240, 138], // yellow-200 (최고 bright, 희미 — 흰 배경서 안 보임)
  [0.15, 253, 224,  71], // yellow-300
  [0.32, 250, 204,  21], // yellow-400
  [0.50, 202, 138,   4], // yellow-600 (흰 바닥에서 또렷)
  [0.68, 161,  98,   7], // yellow-700
  [0.85, 113,  63,  18], // yellow-800
  [1.00,  66,  32,   6], // yellow-900 (최저 deep gold)
];
function lerpLightColor(tFrac: number): number {
  const tc = Math.max(0, Math.min(1, tFrac));
  for (let i = 1; i < LIGHT_STOPS.length; i++) {
    const [t1, r1, g1, b1] = LIGHT_STOPS[i];
    if (tc <= t1) {
      const [t0, r0, g0, b0] = LIGHT_STOPS[i - 1];
      const k = (tc - t0) / (t1 - t0);
      return (
        (Math.round(r0 + (r1 - r0) * k) << 16) |
        (Math.round(g0 + (g1 - g0) * k) <<  8) |
         Math.round(b0 + (b1 - b0) * k)
      );
    }
  }
  const [, r, g, b] = LIGHT_STOPS[LIGHT_STOPS.length - 1];
  return (r << 16) | (g << 8) | b;
}

// ── Gold plate (빛 공격 endpoint marker — diamond plate의 warm 버전) ──
function drawGoldPlate(
  g: PIXI.Graphics,
  cx: number, cy: number, R: number,
  intensity: number,
) {
  const rot = Math.PI / 4;
  const pts: number[] = [
    cx + Math.cos(rot) * R,               cy + Math.sin(rot) * R,
    cx + Math.cos(rot + Math.PI/2) * R,   cy + Math.sin(rot + Math.PI/2) * R,
    cx + Math.cos(rot + Math.PI) * R,     cy + Math.sin(rot + Math.PI) * R,
    cx + Math.cos(rot + Math.PI*1.5) * R, cy + Math.sin(rot + Math.PI*1.5) * R,
  ];
  g.lineStyle(2.2, lerpLightColor(0.82), 0.60 + intensity * 0.35);
  g.drawPolygon(pts);
  g.lineStyle(0);
  g.beginFill(lerpLightColor(0.55), 0.30 + intensity * 0.45);
  const shrinkPts = [
    cx + Math.cos(rot) * R * 0.85,               cy + Math.sin(rot) * R * 0.85,
    cx + Math.cos(rot + Math.PI/2) * R * 0.85,   cy + Math.sin(rot + Math.PI/2) * R * 0.85,
    cx + Math.cos(rot + Math.PI) * R * 0.85,     cy + Math.sin(rot + Math.PI) * R * 0.85,
    cx + Math.cos(rot + Math.PI*1.5) * R * 0.85, cy + Math.sin(rot + Math.PI*1.5) * R * 0.85,
  ];
  g.drawPolygon(shrinkPts);
  g.endFill();
  g.beginFill(lerpLightColor(0.92), 0.92);
  g.drawCircle(cx, cy, R * 0.18);
  g.endFill();
}

// ── Diamond plate (전기 공격 endpoint marker) ──
// 흰 배경 대응: dark violet outline + 중간 톤 fill + 중심 dark dot
function drawDiamondPlate(
  g: PIXI.Graphics,
  cx: number, cy: number, R: number,
  intensity: number,  // 0~1 점점 진해짐
) {
  const rot = Math.PI / 4;
  const pts: number[] = [
    cx + Math.cos(rot) * R,               cy + Math.sin(rot) * R,
    cx + Math.cos(rot + Math.PI/2) * R,   cy + Math.sin(rot + Math.PI/2) * R,
    cx + Math.cos(rot + Math.PI) * R,     cy + Math.sin(rot + Math.PI) * R,
    cx + Math.cos(rot + Math.PI*1.5) * R, cy + Math.sin(rot + Math.PI*1.5) * R,
  ];
  // outer dark violet outline (crisp on white bg)
  g.lineStyle(2.2, lerpElectricColor(0.92), 0.60 + intensity * 0.35);
  g.drawPolygon(pts);
  g.lineStyle(0);
  // 중간 톤 fill (점점 진해짐)
  g.beginFill(lerpElectricColor(0.60), 0.30 + intensity * 0.45);
  const shrinkPts = [
    cx + Math.cos(rot) * R * 0.85,               cy + Math.sin(rot) * R * 0.85,
    cx + Math.cos(rot + Math.PI/2) * R * 0.85,   cy + Math.sin(rot + Math.PI/2) * R * 0.85,
    cx + Math.cos(rot + Math.PI) * R * 0.85,     cy + Math.sin(rot + Math.PI) * R * 0.85,
    cx + Math.cos(rot + Math.PI*1.5) * R * 0.85, cy + Math.sin(rot + Math.PI*1.5) * R * 0.85,
  ];
  g.drawPolygon(shrinkPts);
  g.endFill();
  // 중심 dark dot (focal point)
  g.beginFill(lerpElectricColor(1.0), 0.92);
  g.drawCircle(cx, cy, R * 0.18);
  g.endFill();
}

// ── 균열 line (zigzag) — deterministic LCG seed 기반 지그재그 ──
function drawCrackLine(
  g: PIXI.Graphics,
  sx: number, sy: number, ang: number, len: number,
  thickness: number, color: number, alpha: number,
  seed: number,
) {
  if (len < 1) return;
  const SEGS = 6;
  const dirX = Math.cos(ang), dirY = Math.sin(ang);
  const perpX = -dirY, perpY = dirX;
  let s = seed | 0;
  g.lineStyle(thickness, color, alpha);
  g.moveTo(sx, sy);
  for (let i = 1; i <= SEGS; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const jit = ((s % 131) / 131 - 0.5) * len * 0.10;
    const frac = i / SEGS;
    g.lineTo(sx + dirX * len * frac + perpX * jit, sy + dirY * len * frac + perpY * jit);
  }
  g.lineStyle(0);
}

// 기울어진 타원 전체 스트로크 (보스 renderer_boss.ts와 동일 기법)
function strokeTiltedEllipseAt(
  g: PIXI.Graphics,
  cx: number, cy: number, aR: number, bR: number, tilt: number,
) {
  const segs = 32;
  const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
  const x0 = aR * cosT + cx;
  const y0 = aR * sinT + cy;
  g.moveTo(x0, y0);
  for (let i = 1; i <= segs; i++) {
    const ang = (i / segs) * Math.PI * 2;
    const ex = Math.cos(ang) * aR;
    const ey = Math.sin(ang) * bR;
    g.lineTo(ex * cosT - ey * sinT + cx, ex * sinT + ey * cosT + cy);
  }
}

// 궤도 반쪽 스트로크 — sin(ang) 기준 back/front 분리 (보스 3D 폐색 기법)
function strokeOrbitHalf(
  g: PIXI.Graphics,
  cx: number, cy: number,
  aR: number, bR: number,
  tilt: number, rotPhase: number, drawBack: boolean,
  color: number, thickness: number, alpha: number,
) {
  const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
  const segs = 32;
  let inSeg = false;
  g.lineStyle(thickness, color, alpha);
  for (let i = 0; i <= segs; i++) {
    const phi = (i / segs) * Math.PI * 2;
    const ang = phi + rotPhase;
    const isBack = Math.sin(ang) < 0;
    if (isBack !== drawBack) { inSeg = false; continue; }
    const ex = Math.cos(ang) * aR;
    const ey = Math.sin(ang) * bR;
    const x = cx + ex * cosT - ey * sinT;
    const y = cy + ex * sinT + ey * cosT;
    if (!inSeg) { g.moveTo(x, y); inSeg = true; }
    else g.lineTo(x, y);
  }
  g.lineStyle(0);
}

// ═══════════════════════════════════════════════════════════════════
// mini Tesla Nucleus atom — 전기 보스 축소판 (amber + cyan + violet 3궤도).
// 전기 공격 투사체 공통 body.
// ═══════════════════════════════════════════════════════════════════
function drawMiniElectricAtom(
  g: PIXI.Graphics, glow: PIXI.Graphics,
  cx: number, cy: number, R: number, t: number,
) {
  // 3궤도 — 보스 5궤도 → 핵심 3개 (amber warm / cyan cool / violet)
  type Orbit = {
    aR: number; bR: number; tilt: number; rotPhase: number;
    colBack: number; colFront: number; thickBack: number; thickFront: number;
    electronCol: number;
  };
  const orbits: Orbit[] = [
    { aR: R * 1.24, bR: R * 0.46, tilt:  0.10, rotPhase:  t * 0.090,  // 회전 속도 UP
      colBack: 0xb45309, colFront: 0xfbbf24, thickBack: 1.0, thickFront: 1.8,
      electronCol: 0xfde047 },
    { aR: R * 1.10, bR: R * 0.32, tilt: -0.62, rotPhase: -t * 0.115,
      colBack: 0x0369a1, colFront: 0x67e8f9, thickBack: 0.9, thickFront: 1.5,
      electronCol: 0x67e8f9 },
    { aR: R * 0.98, bR: R * 0.24, tilt:  0.95, rotPhase:  t * 0.100,
      colBack: 0x7c3aed, colFront: 0xc4b5fd, thickBack: 0.9, thickFront: 1.5,
      electronCol: 0xc4b5fd },
  ];

  // ── 1. 궤도 BACK 반쪽 ──
  for (const o of orbits) {
    strokeOrbitHalf(g, cx, cy, o.aR, o.bR, o.tilt, o.rotPhase, true,
      o.colBack, o.thickBack * 1.5, 0.52);
    strokeOrbitHalf(g, cx, cy, o.aR, o.bR, o.tilt, o.rotPhase, true,
      o.colBack, o.thickBack * 0.6, 0.42);
  }

  // ── 2. 코어 bloom 대폭 강화 (ADD) — rapidPulse 로 깜빡임 ──
  const rapidPulse = 0.75 + Math.sin(t * 0.55) * 0.25;  // 10Hz 강한 깜빡임
  glow.beginFill(lerpElectricColor(0.0), 0.75 * rapidPulse);
  glow.drawCircle(cx, cy, R * 1.35);
  glow.endFill();
  glow.beginFill(lerpElectricColor(0.0), 1.0);
  glow.drawCircle(cx, cy, R * 0.85);
  glow.endFill();
  glow.beginFill(lerpElectricColor(0.10), 1.0 * rapidPulse);
  glow.drawCircle(cx, cy, R * 0.48);
  glow.endFill();

  // ── 3. 코어 6겹 (pale violet + white-hot core + corePulse) ──
  const corePulse = 0.90 + Math.sin(t * 0.40) * 0.10;
  g.beginFill(lerpElectricColor(0.70), 0.96); g.drawCircle(cx, cy, R * 0.58);               g.endFill();
  g.beginFill(lerpElectricColor(0.48), 0.95); g.drawCircle(cx, cy, R * 0.44 * corePulse);   g.endFill();
  g.beginFill(lerpElectricColor(0.28), 0.95); g.drawCircle(cx, cy, R * 0.33 * corePulse);   g.endFill();
  g.beginFill(lerpElectricColor(0.14), 0.96); g.drawCircle(cx, cy, R * 0.23 * corePulse);   g.endFill();
  g.beginFill(lerpElectricColor(0.04), 0.98); g.drawCircle(cx, cy, R * 0.14 * corePulse);   g.endFill();
  g.beginFill(lerpElectricColor(0.0),  1.0);  g.drawCircle(cx, cy, R * 0.07);               g.endFill();

  // ── 4. 궤도 FRONT 반쪽 (motion blur 2단) ──
  for (const o of orbits) {
    for (let mb = 0; mb < 2; mb++) {
      const rotOff = o.rotPhase - mb * 0.08;
      const aS = 1 - mb * 0.35;
      strokeOrbitHalf(g, cx, cy, o.aR, o.bR, o.tilt, rotOff, false,
        o.colFront, o.thickFront * 1.8 * aS, 0.60 * aS);
      strokeOrbitHalf(g, cx, cy, o.aR, o.bR, o.tilt, rotOff, false,
        o.colFront, o.thickFront * 0.7 * aS, 0.95 * aS);
    }
  }

  // ── 5. 전자 3개 (z-sort, glow halo 크게) ──
  const drawEl = (o: Orbit, phaseOff: number, sz: number) => {
    const cosT = Math.cos(o.tilt), sinT = Math.sin(o.tilt);
    const ang = o.rotPhase + phaseOff;
    const isBack = Math.sin(ang) < 0;
    const ex = Math.cos(ang) * o.aR;
    const ey = Math.sin(ang) * o.bR;
    const eX = cx + ex * cosT - ey * sinT;
    const eY = cy + ex * sinT + ey * cosT;
    const dep = isBack ? 0.42 : 1.0;
    glow.beginFill(o.electronCol, 0.75 * dep);
    glow.drawCircle(eX, eY, sz * 2.6 * dep);
    glow.endFill();
    g.beginFill(o.electronCol, 0.95 * dep);
    g.drawCircle(eX, eY, sz * dep);
    g.endFill();
    g.beginFill(lerpElectricColor(0.0), dep);
    g.drawCircle(eX, eY, sz * 0.50 * dep);
    g.endFill();
  };
  drawEl(orbits[0], 0,              R * 0.14);
  drawEl(orbits[1], Math.PI * 0.65, R * 0.12);
  drawEl(orbits[2], Math.PI * 1.15, R * 0.12);

  // ── 6. Star cross gleam (prominent + flicker) ──
  const gleamLen = R * (1.55 + Math.sin(t * 0.15) * 0.15);
  const gleamFlick = 0.75 + Math.sin(t * 0.40) * 0.25;  // 깜빡임
  for (let d = 0; d < 4; d++) {
    const a = d * Math.PI / 2 + t * 0.012;
    const ca = Math.cos(a), sa = Math.sin(a);
    const pX = -sa, pY = ca;
    g.beginFill(lerpElectricColor(0.26), 0.65 * gleamFlick);
    g.drawPolygon([
      cx + ca * gleamLen,         cy + sa * gleamLen,
      cx + pX * R * 0.055,         cy + pY * R * 0.055,
      cx - ca * gleamLen,         cy - sa * gleamLen,
      cx - pX * R * 0.055,         cy - pY * R * 0.055,
    ]);
    g.endFill();
    g.beginFill(lerpElectricColor(0.0), 0.95 * gleamFlick);
    g.drawPolygon([
      cx + ca * gleamLen * 0.90,  cy + sa * gleamLen * 0.90,
      cx + pX * R * 0.018,         cy + pY * R * 0.018,
      cx - ca * gleamLen * 0.90,  cy - sa * gleamLen * 0.90,
      cx - pX * R * 0.018,         cy - pY * R * 0.018,
    ]);
    g.endFill();
  }

  // ── 7. 간헐적 Discharge Arcs — Tesla coil 순간 방전 (연속 zigzag X) ──
  // 20 프레임 주기 중 처음 3 프레임만 짧은 arc 3개 표시 → 전기 특유 flash sensation
  const dischargeCycle = 20;
  const cyclePos = t % dischargeCycle;
  if (cyclePos < 3) {
    const seedBase = Math.floor(t / dischargeCycle);
    const intensity = 1 - cyclePos / 3;  // 첫 프레임 최대 → 3프레임에 0
    for (let d = 0; d < 3; d++) {
      let s = (seedBase * 7919 + d * 2654435) & 0x7fffffff;
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const ang = ((s % 628) / 100);
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const armLen = R * (0.85 + ((s % 31) / 100));
      const tipX = cx + Math.cos(ang) * armLen;
      const tipY = cy + Math.sin(ang) * armLen;
      // glow at tip
      glow.beginFill(0xe0d8ff, 0.75 * intensity);
      glow.drawCircle(tipX, tipY, R * 0.22 * intensity);
      glow.endFill();
      // Short 2-segment arc (zigzag 아님, 짧은 직선 pair)
      g.lineStyle(R * 0.10 * intensity, 0xc4b5fd, 0.88 * intensity);
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const mX = cx + Math.cos(ang) * armLen * 0.5 + (((s % 131) / 131) - 0.5) * R * 0.12;
      const mY = cy + Math.sin(ang) * armLen * 0.5 + (((s * 31 % 131) / 131) - 0.5) * R * 0.12;
      g.moveTo(cx, cy); g.lineTo(mX, mY); g.lineTo(tipX, tipY);
      g.lineStyle(R * 0.04 * intensity, lerpElectricColor(0.0), 0.95 * intensity);
      g.moveTo(cx, cy); g.lineTo(mX, mY); g.lineTo(tipX, tipY);
      g.lineStyle(0);
    }
  }

  // ── 8. Sparkle flecks (밝고 많이 — 4→8개) ──
  for (let k = 0; k < 8; k++) {
    const seedA = (k * 137.508) % (Math.PI * 2);
    const seedR = R * (0.78 + ((k * 23) % 11) * 0.04);
    const drift = t * 0.015 + k * 0.4;
    const spx = cx + Math.cos(seedA + Math.sin(drift) * 0.3) * seedR;
    const spy = cy + Math.sin(seedA + Math.sin(drift) * 0.3) * seedR;
    const flick = Math.sin(t * 0.18 + k * 1.3);
    if (flick < 0.1) continue;
    const intensity = (flick - 0.1) / 0.9;
    glow.beginFill(0x67e8f9, 0.45 * intensity);
    glow.drawCircle(spx, spy, R * 0.12 * intensity);
    glow.endFill();
    g.beginFill(lerpElectricColor(0.15), 0.80 * intensity);
    g.drawCircle(spx, spy, R * 0.07 * intensity);
    g.endFill();
    g.beginFill(lerpElectricColor(0.0), intensity);
    g.drawCircle(spx, spy, R * 0.035 * intensity);
    g.endFill();
  }
}

// 보스 투사체 variant별 실시간 렌더
function drawBossProjectile(g: PIXI.Graphics, glow: PIXI.Graphics, p: GameState['enemyProjectiles'][number], t: number) {
  const v = p.variant;
  const r = p.radius;
  switch (v) {
    case 'water_resonance_pulse': {
      // 미니 Phase Resonator atom — 꼬리 없이 순수 atom 모형만 (trail 제거).
      const R = r;
      // ── 궤도 정의 (2개, 교차 tilt) ──
      const TILT = 0.52;
      const ORB_A = R * 0.92;
      const ORB_B = R * 0.46;
      const rotA = t * 0.055;
      const rotB = -t * 0.072 + Math.PI * 0.65;
      // ── 궤도 BACK 반 (코어 뒤) ──
      strokeOrbitHalf(g, p.x, p.y, ORB_A, ORB_B,  TILT, rotA, true, lerpWaterColor(0.75), 1.2, 0.48);
      strokeOrbitHalf(g, p.x, p.y, ORB_A, ORB_B, -TILT, rotB, true, lerpWaterColor(0.75), 1.2, 0.48);
      // ── 6각 containment frame + corner node ──
      const hexRot = t * 0.035;
      const hexR = R * 1.12;
      g.lineStyle(1.6, lerpWaterColor(0.55), 0.72);
      for (let i = 0; i <= 6; i++) {
        const a = hexRot + (i / 6) * Math.PI * 2;
        const hx = p.x + Math.cos(a) * hexR;
        const hy = p.y + Math.sin(a) * hexR;
        if (i === 0) g.moveTo(hx, hy); else g.lineTo(hx, hy);
      }
      g.lineStyle(0);
      for (let i = 0; i < 6; i++) {
        const a = hexRot + (i / 6) * Math.PI * 2;
        const hx = p.x + Math.cos(a) * hexR;
        const hy = p.y + Math.sin(a) * hexR;
        glow.beginFill(lerpWaterColor(0.0), 0.65);
        glow.drawCircle(hx, hy, 3.0);
        glow.endFill();
        g.beginFill(lerpWaterColor(0.1), 0.92);
        g.drawCircle(hx, hy, 1.7);
        g.endFill();
      }
      // ── 코어 bloom (외곽 glow) ──
      glow.beginFill(lerpWaterColor(0.0), 0.42);
      glow.drawCircle(p.x, p.y, R * 1.0);
      glow.endFill();
      glow.beginFill(lerpWaterColor(0.0), 0.78);
      glow.drawCircle(p.x, p.y, R * 0.55);
      glow.endFill();
      // ── 코어 5겹 concentric (corePulse) ──
      const corePulse = 0.94 + Math.sin(t * 0.12) * 0.06;
      g.beginFill(lerpWaterColor(0.95), 0.95); g.drawCircle(p.x, p.y, R * 0.56);                 g.endFill();
      g.beginFill(lerpWaterColor(0.70), 0.94); g.drawCircle(p.x, p.y, R * 0.44 * corePulse);     g.endFill();
      g.beginFill(lerpWaterColor(0.50), 0.92); g.drawCircle(p.x, p.y, R * 0.33 * corePulse);     g.endFill();
      g.beginFill(lerpWaterColor(0.28), 0.94); g.drawCircle(p.x, p.y, R * 0.22 * corePulse);     g.endFill();
      g.beginFill(lerpWaterColor(0.08), 0.97); g.drawCircle(p.x, p.y, R * 0.13 * corePulse);     g.endFill();
      g.beginFill(lerpWaterColor(0.0),  1.0);  g.drawCircle(p.x, p.y, R * 0.06);                 g.endFill();
      // ── 궤도 FRONT 반 (코어 위) — motion blur 2단 ──
      for (let mb = 0; mb < 2; mb++) {
        const off = mb * 0.08;
        const aS = 1 - mb * 0.35;
        strokeOrbitHalf(g, p.x, p.y, ORB_A, ORB_B,  TILT, rotA - off, false, lerpWaterColor(0.15), 2.0 * aS, 0.90 * aS);
        strokeOrbitHalf(g, p.x, p.y, ORB_A, ORB_B, -TILT, rotB - off, false, lerpWaterColor(0.15), 2.0 * aS, 0.90 * aS);
      }
      // ── 전자 2개 (궤도 위, z-sort) ──
      const drawElectron = (tilt: number, rotPhase: number, phaseOff: number, col: number) => {
        const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
        const aAng = rotPhase + phaseOff;
        const isBack = Math.sin(aAng) < 0;
        const ex = Math.cos(aAng) * ORB_A;
        const ey = Math.sin(aAng) * ORB_B;
        const ex2 = p.x + ex * cosT - ey * sinT;
        const ey2 = p.y + ex * sinT + ey * cosT;
        const dep = isBack ? 0.45 : 1.0;
        const sz = (isBack ? 2.0 : 3.0) * dep;
        glow.beginFill(col, 0.55 * dep);
        glow.drawCircle(ex2, ey2, sz * 2.0);
        glow.endFill();
        g.beginFill(col, 0.95 * dep);
        g.drawCircle(ex2, ey2, sz);
        g.endFill();
        g.beginFill(lerpWaterColor(0.05), dep);
        g.drawCircle(ex2, ey2, sz * 0.5);
        g.endFill();
      };
      drawElectron(TILT, rotA, 0,               lerpWaterColor(0.0));
      drawElectron(-TILT, rotB, Math.PI * 0.65, lerpWaterColor(0.12));
      break;
    }
    case 'water_harmonic_beam': {
      // Phase Helix — 미니 Phase Resonator atom (3개 중 하나).
      // baseline 주위로 큰 amplitude 사인 이동 (120° 위상차) → 브레이딩 helix.
      // 개별 trail ribbon 포함.
      const R = r; // 12
      const baseVx = p.waveBaseVx ?? p.vx;
      const baseVy = p.waveBaseVy ?? p.vy;
      const spd = Math.sqrt(baseVx * baseVx + baseVy * baseVy) || 1;
      const dirX = baseVx / spd;
      const dirY = baseVy / spd;
      const perpX = p.wavePerpX ?? -dirY;
      const perpY = p.wavePerpY ?? dirX;
      const amp = p.waveAmp ?? 0;
      const phase = p.wavePhase ?? 0;
      const phaseSpeed = p.wavePhaseSpeed ?? 0;

      // ── Trail: 과거 위치 역산 (wave 공식 그대로 거꾸로 돌림) ──
      // 현재 위치 기준 k 프레임 전 wavePhase = phase - k·phaseSpeed
      // 과거 perp 오프셋 차 = sin(pastPhase) - sin(currentPhase)
      {
        const TRAIL_SEGS = 20;
        let prevTX = p.x, prevTY = p.y;
        const sinCurrent = Math.sin(phase);
        for (let k = 1; k <= TRAIL_SEGS; k++) {
          const s = k / TRAIL_SEGS;
          const kBack = k * 1.0;                              // 1 프레임 step
          const pastPhase = phase - kBack * phaseSpeed;
          const perpOff = (Math.sin(pastPhase) - sinCurrent) * amp;
          const tx = p.x - dirX * kBack * spd + perpX * perpOff;
          const ty = p.y - dirY * kBack * spd + perpY * perpOff;
          const env = Math.sin((1 - s) * Math.PI * 0.95 + 0.05);
          const colT = 0.15 + s * 0.65;
          // outer glow
          glow.lineStyle(R * 0.85 * env, lerpWaterColor(colT), 0.50 * env);
          glow.moveTo(prevTX, prevTY); glow.lineTo(tx, ty);
          // mid
          g.lineStyle(R * 0.42 * env, lerpWaterColor(Math.max(0.05, colT - 0.12)), 0.80 * env);
          g.moveTo(prevTX, prevTY); g.lineTo(tx, ty);
          // core (front 40%만)
          if (s < 0.42) {
            g.lineStyle(R * 0.17 * env, lerpWaterColor(0.0), 0.92 * env);
            g.moveTo(prevTX, prevTY); g.lineTo(tx, ty);
          }
          prevTX = tx; prevTY = ty;
        }
        g.lineStyle(0);
      }

      // ── 미니 atom 본체 (보스 DNA 축소판) ──
      const TILT = 0.52;
      const ORB_A = R * 0.92;
      const ORB_B = R * 0.44;
      const rotA = t * 0.075;
      const rotB = -t * 0.095 + Math.PI * 0.5;

      // 궤도 BACK 반 (코어 뒤)
      strokeOrbitHalf(g, p.x, p.y, ORB_A, ORB_B,  TILT, rotA, true, lerpWaterColor(0.72), 1.1, 0.48);
      strokeOrbitHalf(g, p.x, p.y, ORB_A, ORB_B, -TILT, rotB, true, lerpWaterColor(0.72), 1.1, 0.48);

      // 코어 bloom (glow)
      glow.beginFill(lerpWaterColor(0.0), 0.72);
      glow.drawCircle(p.x, p.y, R * 0.95);
      glow.endFill();
      glow.beginFill(lerpWaterColor(0.0), 1.0);
      glow.drawCircle(p.x, p.y, R * 0.50);
      glow.endFill();

      // 코어 4겹 concentric (A보다 가벼움)
      const corePulse = 0.94 + Math.sin(t * 0.15) * 0.06;
      g.beginFill(lerpWaterColor(0.72), 0.94); g.drawCircle(p.x, p.y, R * 0.58);              g.endFill();
      g.beginFill(lerpWaterColor(0.40), 0.94); g.drawCircle(p.x, p.y, R * 0.42 * corePulse);  g.endFill();
      g.beginFill(lerpWaterColor(0.15), 0.96); g.drawCircle(p.x, p.y, R * 0.27 * corePulse);  g.endFill();
      g.beginFill(lerpWaterColor(0.0),  1.0);  g.drawCircle(p.x, p.y, R * 0.14 * corePulse);  g.endFill();

      // 궤도 FRONT 반 (코어 위)
      strokeOrbitHalf(g, p.x, p.y, ORB_A, ORB_B,  TILT, rotA, false, lerpWaterColor(0.15), 1.7, 0.92);
      strokeOrbitHalf(g, p.x, p.y, ORB_A, ORB_B, -TILT, rotB, false, lerpWaterColor(0.15), 1.7, 0.92);

      // 전자 1개 (궤도 A 위, z-sort)
      const eAng = rotA;
      const eBack = Math.sin(eAng) < 0;
      const cosT = Math.cos(TILT), sinT = Math.sin(TILT);
      const eX = Math.cos(eAng) * ORB_A;
      const eY = Math.sin(eAng) * ORB_B;
      const eX2 = p.x + eX * cosT - eY * sinT;
      const eY2 = p.y + eX * sinT + eY * cosT;
      const eDep = eBack ? 0.45 : 1.0;
      const eSize = (eBack ? 2.0 : 2.8) * eDep;
      glow.beginFill(lerpWaterColor(0.0), 0.55 * eDep);
      glow.drawCircle(eX2, eY2, eSize * 2.0);
      glow.endFill();
      g.beginFill(lerpWaterColor(0.0), 0.95 * eDep);
      g.drawCircle(eX2, eY2, eSize);
      g.endFill();
      g.beginFill(lerpWaterColor(0.08), eDep);
      g.drawCircle(eX2, eY2, eSize * 0.5);
      g.endFill();
      break;
    }
    case 'water_tidal_mesh': {
      // 지면 확산 mesh — 4-ring log-spacing, ring-to-ring fan triangulation.
      // life=70 → 0. prog 0→1로 mesh가 밖으로 expand.
      const maxLife = 70;
      const prog = Math.max(0, Math.min(1, 1 - p.life / maxLife));
      const R = r; // 110 max
      const meshExpand = Math.min(1, prog * 1.15);  // 약간 일찍 full extent
      // ── ring 정의 (log-spacing + 느린 undulation) ──
      const ringDefs = [
        { count: 10, radius: 0.28, phaseOffset: 0.00 },
        { count: 14, radius: 0.56, phaseOffset: 0.25 },
        { count: 18, radius: 0.82, phaseOffset: 0.55 },
        { count: 22, radius: 1.05, phaseOffset: 0.85 },
      ];
      const nodeX: number[] = [];
      const nodeY: number[] = [];
      const ringStart: number[] = [];
      for (let ri = 0; ri < ringDefs.length; ri++) {
        const ring = ringDefs[ri];
        ringStart.push(nodeX.length);
        for (let k = 0; k < ring.count; k++) {
          const nodeSeed = ((k * 73 + ri * 53) % 97) / 97;
          const baseA = (k / ring.count) * Math.PI * 2 + ring.phaseOffset;
          // 3-freq undulation (player WaterEffect 기법)
          const rWob = 1
            + Math.sin(t * 0.08 + k * 1.7 + ring.phaseOffset * 4) * 0.08
            + Math.sin(t * 0.12 - k * 0.83 + ring.phaseOffset * 6) * 0.04
            + (nodeSeed - 0.5) * 0.12;
          const rr = R * ring.radius * meshExpand * rWob;
          nodeX.push(p.x + Math.cos(baseA) * rr);
          nodeY.push(p.y + Math.sin(baseA) * rr);
        }
      }
      ringStart.push(nodeX.length);
      // ── Fan triangulation FILLS (LCG seed 변주 + sine undulate color) ──
      const alphaOverall = (1 - prog * 0.35);
      for (let ri = 0; ri < ringDefs.length - 1; ri++) {
        const aS = ringStart[ri], aE = ringStart[ri + 1];
        const bS = ringStart[ri + 1], bE = ringStart[ri + 2];
        const aCount = aE - aS;
        const bCount = bE - bS;
        let triSeed = (ri * 131 + 17) | 0;
        for (let i = 0; i < aCount; i++) {
          const a0x = nodeX[aS + i], a0y = nodeY[aS + i];
          const iNext = (i + 1) % aCount;
          const a1x = nodeX[aS + iNext], a1y = nodeY[aS + iNext];
          const bStart = Math.floor((i / aCount) * bCount);
          const bEnd = Math.floor(((i + 1) / aCount) * bCount);
          for (let j = bStart; j < bEnd; j++) {
            const j0 = j % bCount, j1 = (j + 1) % bCount;
            triSeed = (triSeed * 1103515245 + 12345) & 0x7fffffff;
            const colT = 0.25 + ((triSeed % 131) / 131) * 0.70;
            const a = (0.10 + ((triSeed >> 7) % 131) / 131 * 0.25) * alphaOverall;
            g.beginFill(lerpWaterColor(colT), a);
            g.drawPolygon([a0x, a0y, nodeX[bS + j0], nodeY[bS + j0], nodeX[bS + j1], nodeY[bS + j1]]);
            g.endFill();
          }
          // bridge
          triSeed = (triSeed * 1103515245 + 12345) & 0x7fffffff;
          const bEndJ = bEnd % bCount;
          const colT2 = 0.25 + ((triSeed % 131) / 131) * 0.70;
          const a2 = (0.10 + ((triSeed >> 7) % 131) / 131 * 0.25) * alphaOverall;
          g.beginFill(lerpWaterColor(colT2), a2);
          g.drawPolygon([a0x, a0y, a1x, a1y, nodeX[bS + bEndJ], nodeY[bS + bEndJ]]);
          g.endFill();
        }
      }
      // ── Ring polygon edges ──
      g.lineStyle(1.1, lerpWaterColor(0.2), 0.70 * alphaOverall);
      for (let ri = 0; ri < ringDefs.length; ri++) {
        const sI = ringStart[ri], eI = ringStart[ri + 1];
        for (let i = sI; i < eI; i++) {
          const nxt = (i + 1 < eI) ? i + 1 : sI;
          g.moveTo(nodeX[i], nodeY[i]);
          g.lineTo(nodeX[nxt], nodeY[nxt]);
        }
      }
      g.lineStyle(0);
      // ── Inter-ring 삼각 edges (fan) ──
      g.lineStyle(0.85, lerpWaterColor(0.15), 0.55 * alphaOverall);
      for (let ri = 0; ri < ringDefs.length - 1; ri++) {
        const aS = ringStart[ri], aE = ringStart[ri + 1];
        const bS = ringStart[ri + 1], bE = ringStart[ri + 2];
        const aCount = aE - aS, bCount = bE - bS;
        for (let i = 0; i < aCount; i++) {
          const ax = nodeX[aS + i], ay = nodeY[aS + i];
          const bStart = Math.floor((i / aCount) * bCount);
          const bEnd = Math.floor(((i + 1) / aCount) * bCount);
          for (let j = bStart; j <= bEnd; j++) {
            const jm = j % bCount;
            g.moveTo(ax, ay); g.lineTo(nodeX[bS + jm], nodeY[bS + jm]);
          }
        }
      }
      g.lineStyle(0);
      // ── 노드 dot (전자 sparkle — golden-ratio flicker) ──
      for (let i = 0; i < nodeX.length; i++) {
        const nx = nodeX[i], ny = nodeY[i];
        const flick = 0.6 + Math.sin(t * 0.18 + i * 2.399963) * 0.4;
        glow.beginFill(lerpWaterColor(0.0), 0.55 * flick * alphaOverall);
        glow.drawCircle(nx, ny, 3.4);
        glow.endFill();
        g.beginFill(lerpWaterColor(0.05), 0.92 * alphaOverall);
        g.drawCircle(nx, ny, 1.7);
        g.endFill();
      }
      // ── 확장 shockwave 링 2개 (phase 다름) ──
      for (let wv = 0; wv < 2; wv++) {
        const wPhase = ((prog + wv * 0.45) % 1);
        const wR = R * (0.18 + wPhase * 0.92);
        const wA = (1 - wPhase) * 0.55 * alphaOverall;
        g.lineStyle(2.0 * (1 - wPhase) + 0.5, lerpWaterColor(0.25), wA);
        g.drawCircle(p.x, p.y, wR);
      }
      g.lineStyle(0);
      // ── 중심 atom core (5겹 concentric + corePulse) ──
      const corePulse = 1 + Math.sin(prog * Math.PI * 3.2) * 0.15;
      glow.beginFill(lerpWaterColor(0.0), 0.6 * alphaOverall);
      glow.drawCircle(p.x, p.y, R * 0.22 * corePulse);
      glow.endFill();
      g.beginFill(lerpWaterColor(0.55), 0.85 * alphaOverall); g.drawCircle(p.x, p.y, R * 0.18 * corePulse); g.endFill();
      g.beginFill(lerpWaterColor(0.30), 0.90 * alphaOverall); g.drawCircle(p.x, p.y, R * 0.13 * corePulse); g.endFill();
      g.beginFill(lerpWaterColor(0.12), 0.93 * alphaOverall); g.drawCircle(p.x, p.y, R * 0.09 * corePulse); g.endFill();
      g.beginFill(lerpWaterColor(0.0),  0.96 * alphaOverall); g.drawCircle(p.x, p.y, R * 0.05 * corePulse); g.endFill();
      break;
    }
    case 'fire_plasma_pulse': {
      // 미니 Plasma Star atom — 12방 flame spike + 12각 frame + 궤도 + 전자 + 코어.
      // 꼬리 없음. warm 팔레트. flicker + 빠른 spin.
      const R = r;
      // ── 외곽 flame corona (확장 링, 얇은 stroke — muddy bg 방지) ──
      {
        const CORONA_CYCLE = 40;
        for (let ring = 0; ring < 3; ring++) {
          const ph = ((t + ring * 14) % CORONA_CYCLE) / CORONA_CYCLE;
          const rad = R * (1.15 + ph * 0.85);
          const al = (1 - ph) * 0.45;
          g.lineStyle(2.0 - ph * 1.2, lerpFireColor(0.5), al);
          g.drawCircle(p.x, p.y, rad);
        }
        g.lineStyle(0);
      }
      // ── 12방 flame spike 실루엣 (3겹 nested triangles) ──
      const spikeN = 12;
      const halfBase = Math.PI / spikeN;
      const baseSR = R * 0.78;
      for (let k = 0; k < spikeN; k++) {
        const a = (k / spikeN) * Math.PI * 2 + t * 0.06;
        const flicker = 0.72 + (Math.sin(t * 0.28 + k * 1.3) * 0.5 + 0.5) * 0.55;
        const tipR = R * (1.34 * flicker);
        // outer red triangle
        const ca = Math.cos(a), sa = Math.sin(a);
        const aL = a - halfBase * 0.92, aR = a + halfBase * 0.92;
        g.beginFill(lerpFireColor(0.85), 0.92);
        g.drawPolygon([
          p.x + ca * tipR,                  p.y + sa * tipR,
          p.x + Math.cos(aL) * baseSR,       p.y + Math.sin(aL) * baseSR,
          p.x + Math.cos(aR) * baseSR,       p.y + Math.sin(aR) * baseSR,
        ]);
        g.endFill();
        // mid orange triangle
        const aL2 = a - halfBase * 0.72, aR2 = a + halfBase * 0.72;
        g.beginFill(lerpFireColor(0.50), 0.93);
        g.drawPolygon([
          p.x + ca * tipR * 0.82,                p.y + sa * tipR * 0.82,
          p.x + Math.cos(aL2) * baseSR * 1.01,    p.y + Math.sin(aL2) * baseSR * 1.01,
          p.x + Math.cos(aR2) * baseSR * 1.01,    p.y + Math.sin(aR2) * baseSR * 1.01,
        ]);
        g.endFill();
        // inner amber triangle
        const aL3 = a - halfBase * 0.48, aR3 = a + halfBase * 0.48;
        g.beginFill(lerpFireColor(0.22), 0.92);
        g.drawPolygon([
          p.x + ca * tipR * 0.62,                p.y + sa * tipR * 0.62,
          p.x + Math.cos(aL3) * baseSR * 1.02,    p.y + Math.sin(aL3) * baseSR * 1.02,
          p.x + Math.cos(aR3) * baseSR * 1.02,    p.y + Math.sin(aR3) * baseSR * 1.02,
        ]);
        g.endFill();
      }
      // ── 12각 frame (보스 frame DNA — 회전) ──
      const f12Rot = t * 0.05;
      const f12R = R * 0.78;
      g.lineStyle(1.5, lerpFireColor(0.28), 0.70);
      for (let i = 0; i <= spikeN; i++) {
        const a = f12Rot + (i / spikeN) * Math.PI * 2;
        const fx = p.x + Math.cos(a) * f12R;
        const fy = p.y + Math.sin(a) * f12R;
        if (i === 0) g.moveTo(fx, fy); else g.lineTo(fx, fy);
      }
      g.lineStyle(0);
      // 12 corner node
      for (let i = 0; i < spikeN; i++) {
        const a = f12Rot + (i / spikeN) * Math.PI * 2;
        const fx = p.x + Math.cos(a) * f12R;
        const fy = p.y + Math.sin(a) * f12R;
        glow.beginFill(lerpFireColor(0.0), 0.62);
        glow.drawCircle(fx, fy, 2.8);
        glow.endFill();
        g.beginFill(lerpFireColor(0.08), 0.90);
        g.drawCircle(fx, fy, 1.4);
        g.endFill();
      }
      // ── 궤도 BACK 반쪽 (3D 폐색, 빠른 rotation) ──
      const TILT = 0.52;
      const ORB_A = R * 0.95;
      const ORB_B = R * 0.48;
      const rotA = t * 0.085;                         // water(0.055)보다 빠름
      const rotB = -t * 0.105 + Math.PI * 0.65;
      strokeOrbitHalf(g, p.x, p.y, ORB_A, ORB_B,  TILT, rotA, true, lerpFireColor(0.62), 1.1, 0.50);
      strokeOrbitHalf(g, p.x, p.y, ORB_A, ORB_B, -TILT, rotB, true, lerpFireColor(0.62), 1.1, 0.50);
      // ── 코어 bloom (ADD) ──
      glow.beginFill(lerpFireColor(0.0), 0.50);
      glow.drawCircle(p.x, p.y, R * 1.0);
      glow.endFill();
      glow.beginFill(lerpFireColor(0.0), 0.85);
      glow.drawCircle(p.x, p.y, R * 0.55);
      glow.endFill();
      // ── 6-layer warm core + corePulse (fire는 더 많은 layer) ──
      const corePulse = 0.93 + Math.sin(t * 0.20) * 0.07;
      g.beginFill(lerpFireColor(0.92), 0.95); g.drawCircle(p.x, p.y, R * 0.58);                g.endFill();
      g.beginFill(lerpFireColor(0.72), 0.94); g.drawCircle(p.x, p.y, R * 0.46 * corePulse);    g.endFill();
      g.beginFill(lerpFireColor(0.52), 0.93); g.drawCircle(p.x, p.y, R * 0.36 * corePulse);    g.endFill();
      g.beginFill(lerpFireColor(0.32), 0.94); g.drawCircle(p.x, p.y, R * 0.25 * corePulse);    g.endFill();
      g.beginFill(lerpFireColor(0.12), 0.97); g.drawCircle(p.x, p.y, R * 0.15 * corePulse);    g.endFill();
      g.beginFill(lerpFireColor(0.0),  1.0);  g.drawCircle(p.x, p.y, R * 0.07);                g.endFill();
      // ── 궤도 FRONT 반쪽 (motion blur 2단) ──
      for (let mb = 0; mb < 2; mb++) {
        const off = mb * 0.08;
        const aS = 1 - mb * 0.35;
        strokeOrbitHalf(g, p.x, p.y, ORB_A, ORB_B,  TILT, rotA - off, false, lerpFireColor(0.12), 1.9 * aS, 0.90 * aS);
        strokeOrbitHalf(g, p.x, p.y, ORB_A, ORB_B, -TILT, rotB - off, false, lerpFireColor(0.12), 1.9 * aS, 0.90 * aS);
      }
      // ── 전자 2개 (z-sort) ──
      const drawEl = (tilt: number, rotPhase: number, phaseOff: number, col: number) => {
        const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
        const ea = rotPhase + phaseOff;
        const isBack = Math.sin(ea) < 0;
        const ex = Math.cos(ea) * ORB_A;
        const ey = Math.sin(ea) * ORB_B;
        const eX = p.x + ex * cosT - ey * sinT;
        const eY = p.y + ex * sinT + ey * cosT;
        const dep = isBack ? 0.45 : 1.0;
        const sz = (isBack ? 2.0 : 3.0) * dep;
        glow.beginFill(col, 0.55 * dep);
        glow.drawCircle(eX, eY, sz * 2.0);
        glow.endFill();
        g.beginFill(col, 0.95 * dep);
        g.drawCircle(eX, eY, sz);
        g.endFill();
        g.beginFill(lerpFireColor(0.0), dep);
        g.drawCircle(eX, eY, sz * 0.5);
        g.endFill();
      };
      drawEl(TILT, rotA, 0,               lerpFireColor(0.0));
      drawEl(-TILT, rotB, Math.PI * 0.65, lerpFireColor(0.15));
      break;
    }
    case 'fire_solar_flare': {
      // Twin Comet Cross — 곡선 경로 + circular back-calc trail.
      // spinAngle = 현재 velocity 방향, spinSpeed = 곡률.
      // 원형 back-calc: 궤도 center + R_circle * (cos(past θ), sin(past θ)).
      const R = r;
      const spd = Math.sqrt(p.vx * p.vx + p.vy * p.vy) || 1;
      const spinAng = p.spinAngle ?? Math.atan2(p.vy, p.vx);
      const spinSp = p.spinSpeed ?? 0;
      // 궤도 center + 반경 계산 (circular motion model)
      const absSp = Math.max(Math.abs(spinSp), 0.0001);
      const sign = spinSp < 0 ? -1 : 1;
      const R_circle = spd / absSp;
      // 현재 position의 궤도 각: spinAng - sign·π/2 (velocity 수직 반대)
      const thetaPos = spinAng - sign * Math.PI / 2;
      const centerX = p.x - R_circle * Math.cos(thetaPos);
      const centerY = p.y - R_circle * Math.sin(thetaPos);
      // ── Trail: 과거 position (궤도 원 따라 뒤로 돌림) ──
      {
        const TRAIL_SEGS = 20;
        let prevTX = p.x, prevTY = p.y;
        for (let k = 1; k <= TRAIL_SEGS; k++) {
          const s = k / TRAIL_SEGS;
          const pastTheta = thetaPos - k * spinSp;
          const tx = centerX + R_circle * Math.cos(pastTheta);
          const ty = centerY + R_circle * Math.sin(pastTheta);
          const env = Math.sin((1 - s) * Math.PI * 0.95 + 0.05);
          const colT = 0.18 + s * 0.62;
          // outer glow (ADD)
          glow.lineStyle(R * 0.85 * env, lerpFireColor(colT), 0.52 * env);
          glow.moveTo(prevTX, prevTY); glow.lineTo(tx, ty);
          // mid
          g.lineStyle(R * 0.42 * env, lerpFireColor(Math.max(0.05, colT - 0.1)), 0.80 * env);
          g.moveTo(prevTX, prevTY); g.lineTo(tx, ty);
          // front core
          if (s < 0.42) {
            g.lineStyle(R * 0.17 * env, lerpFireColor(0.0), 0.92 * env);
            g.moveTo(prevTX, prevTY); g.lineTo(tx, ty);
          }
          prevTX = tx; prevTY = ty;
        }
        g.lineStyle(0);
      }
      // ── 12방 mini flame spike (simpler — 2-layer triangles) ──
      const spikeN = 12;
      const halfBase = Math.PI / spikeN;
      const baseSR = R * 0.72;
      for (let k = 0; k < spikeN; k++) {
        const a = (k / spikeN) * Math.PI * 2 + t * 0.07;
        const flicker = 0.78 + (Math.sin(t * 0.32 + k * 1.3) * 0.5 + 0.5) * 0.44;
        const tipR = R * (1.22 * flicker);
        const ca = Math.cos(a), sa = Math.sin(a);
        const aL = a - halfBase * 0.90, aR = a + halfBase * 0.90;
        g.beginFill(lerpFireColor(0.72), 0.92);
        g.drawPolygon([
          p.x + ca * tipR,               p.y + sa * tipR,
          p.x + Math.cos(aL) * baseSR,    p.y + Math.sin(aL) * baseSR,
          p.x + Math.cos(aR) * baseSR,    p.y + Math.sin(aR) * baseSR,
        ]);
        g.endFill();
        const aL2 = a - halfBase * 0.62, aR2 = a + halfBase * 0.62;
        g.beginFill(lerpFireColor(0.38), 0.94);
        g.drawPolygon([
          p.x + ca * tipR * 0.78,             p.y + sa * tipR * 0.78,
          p.x + Math.cos(aL2) * baseSR * 1.01, p.y + Math.sin(aL2) * baseSR * 1.01,
          p.x + Math.cos(aR2) * baseSR * 1.01, p.y + Math.sin(aR2) * baseSR * 1.01,
        ]);
        g.endFill();
      }
      // ── 궤도 BACK ──
      const TILT = 0.52;
      const ORB_A = R * 0.90;
      const ORB_B = R * 0.44;
      const rotA = t * 0.095;
      const rotB = -t * 0.115 + Math.PI * 0.55;
      strokeOrbitHalf(g, p.x, p.y, ORB_A, ORB_B,  TILT, rotA, true, lerpFireColor(0.65), 1.0, 0.48);
      strokeOrbitHalf(g, p.x, p.y, ORB_A, ORB_B, -TILT, rotB, true, lerpFireColor(0.65), 1.0, 0.48);
      // 코어 bloom
      glow.beginFill(lerpFireColor(0.0), 0.72);
      glow.drawCircle(p.x, p.y, R * 0.95);
      glow.endFill();
      glow.beginFill(lerpFireColor(0.0), 1.0);
      glow.drawCircle(p.x, p.y, R * 0.50);
      glow.endFill();
      // 코어 5겹 (compact — full A보다 1단 적음)
      const corePulse = 0.93 + Math.sin(t * 0.22) * 0.07;
      g.beginFill(lerpFireColor(0.78), 0.94); g.drawCircle(p.x, p.y, R * 0.55);               g.endFill();
      g.beginFill(lerpFireColor(0.50), 0.94); g.drawCircle(p.x, p.y, R * 0.40 * corePulse);   g.endFill();
      g.beginFill(lerpFireColor(0.25), 0.96); g.drawCircle(p.x, p.y, R * 0.26 * corePulse);   g.endFill();
      g.beginFill(lerpFireColor(0.0),  1.0);  g.drawCircle(p.x, p.y, R * 0.13 * corePulse);   g.endFill();
      // 궤도 FRONT (no motion blur — compact)
      strokeOrbitHalf(g, p.x, p.y, ORB_A, ORB_B,  TILT, rotA, false, lerpFireColor(0.12), 1.6, 0.90);
      strokeOrbitHalf(g, p.x, p.y, ORB_A, ORB_B, -TILT, rotB, false, lerpFireColor(0.12), 1.6, 0.90);
      // 전자 1개
      const eCos = Math.cos(TILT), eSin = Math.sin(TILT);
      const eAng = rotA;
      const eBack = Math.sin(eAng) < 0;
      const eEx = Math.cos(eAng) * ORB_A;
      const eEy = Math.sin(eAng) * ORB_B;
      const eX = p.x + eEx * eCos - eEy * eSin;
      const eY = p.y + eEx * eSin + eEy * eCos;
      const eDep = eBack ? 0.45 : 1.0;
      const eSz = (eBack ? 2.0 : 2.8) * eDep;
      glow.beginFill(lerpFireColor(0.0), 0.55 * eDep);
      glow.drawCircle(eX, eY, eSz * 2.0);
      glow.endFill();
      g.beginFill(lerpFireColor(0.0), 0.95 * eDep);
      g.drawCircle(eX, eY, eSz);
      g.endFill();
      g.beginFill(lerpFireColor(0.1), eDep);
      g.drawCircle(eX, eY, eSz * 0.5);
      g.endFill();
      break;
    }
    case 'earth_orbital_meteor': {
      // Orbital Meteor — mini Planet Earth, 자전·대기·위경도 + 궤도 선회/직진.
      //    꼬리 없음. 구체·지구본 느낌.
      const R = r;
      const TILT = 0.40;
      const cosT = Math.cos(TILT), sinT = Math.sin(TILT);
      // 자전 위상 (시간 진행)
      const rotPhase = t * 0.035;

      // ── 대기 외곽 링 3단 (amber rim, stroked only) ──
      for (let ri = 0; ri < 3; ri++) {
        const rad = R * (1.12 + ri * 0.13);
        const al = (0.42 - ri * 0.12) * (0.9 + Math.sin(t * 0.04 + ri) * 0.1);
        g.lineStyle(1.8 - ri * 0.5, lerpEarthColor(0.08), al);
        g.drawCircle(p.x, p.y, rad);
      }
      g.lineStyle(0);

      // ── 코어 bloom (warm rim glow, ADD) ──
      glow.beginFill(lerpEarthColor(0.0), 0.55);
      glow.drawCircle(p.x, p.y, R * 1.10);
      glow.endFill();
      glow.beginFill(lerpEarthColor(0.0), 0.85);
      glow.drawCircle(p.x, p.y, R * 0.65);
      glow.endFill();

      // ── 구체 본체 (shading 4-layer: dark → mid → lit → rim) ──
      g.beginFill(lerpEarthColor(0.95), 0.97); g.drawCircle(p.x, p.y, R);                                    g.endFill();
      g.beginFill(lerpEarthColor(0.72), 0.94); g.drawCircle(p.x - R * 0.10, p.y - R * 0.12, R * 0.90);       g.endFill();
      g.beginFill(lerpEarthColor(0.48), 0.88); g.drawCircle(p.x - R * 0.22, p.y - R * 0.26, R * 0.68);       g.endFill();
      g.beginFill(lerpEarthColor(0.25), 0.62); g.drawCircle(p.x - R * 0.32, p.y - R * 0.36, R * 0.42);       g.endFill();
      g.beginFill(lerpEarthColor(0.10), 0.35); g.drawCircle(p.x - R * 0.38, p.y - R * 0.42, R * 0.22);       g.endFill();

      // ── 위경도선 (기울어진 grid — TILT 반영) ──
      // 위도선 5개 (수평 타원, 정면 투영)
      for (let li = 0; li < 5; li++) {
        const latFrac = (li - 2) / 2.4;
        const latY = latFrac * R * 0.86;
        const latA = R * Math.sqrt(Math.max(0, 1 - latFrac * latFrac)) * 0.94;
        const latB = latA * 0.20;
        const cx = latY * -sinT + p.x;
        const cy = latY * cosT + p.y;
        g.lineStyle(0.9, lerpEarthColor(0.0), 0.40);
        strokeTiltedEllipseAt(g, cx, cy, latA, latB, TILT);
      }
      // 경도선 6개 — rotPhase에 따른 visibleScale (뒤쪽 hide)
      for (let lo = 0; lo < 6; lo++) {
        const lonPhase = rotPhase + (lo / 6) * Math.PI * 2;
        const visibleScale = Math.cos(lonPhase);
        if (visibleScale < 0) continue;
        const lonA = R * 0.94 * Math.abs(visibleScale);
        const lonB = R * 0.94;
        g.lineStyle(0.9, lerpEarthColor(0.0), 0.30 + visibleScale * 0.18);
        strokeTiltedEllipseAt(g, p.x, p.y, lonA, lonB, TILT + Math.PI / 2);
      }
      g.lineStyle(0);

      // ── 극지 하이라이트 (작은 amber dot 상단) ──
      g.beginFill(lerpEarthColor(0.05), 0.88);
      g.drawCircle(p.x + sinT * R * 0.88, p.y - cosT * R * 0.88, 1.8);
      g.endFill();
      g.beginFill(lerpEarthColor(0.28), 0.85);
      g.drawCircle(p.x - sinT * R * 0.88, p.y + cosT * R * 0.88, 1.6);
      g.endFill();
      break;
    }
    case 'earth_tectonic_wall': {
      // Tectonic Wall — 이동 방향 수직으로 긴 crystal prism (벽).
      //    spinAngle = 이동 방향. 벽은 perpendicular으로 확장.
      const ang = p.spinAngle ?? Math.atan2(p.vy, p.vx);
      const cosA = Math.cos(ang), sinA = Math.sin(ang);
      const perpX = -sinA, perpY = cosA;
      const wallLen  = r * 4.2;   // 벽 길이 (이동 수직 방향)
      const wallThick = r * 1.15; // 벽 두께 (이동 방향)

      // 벽 4 모서리 (이동 방향이 X, 수직 방향이 Y로 생각)
      // 앞쪽 전면 edge + 뒤쪽 후면 edge
      const frontX = p.x + cosA * wallThick * 0.7;
      const frontY = p.y + sinA * wallThick * 0.7;
      const backX  = p.x - cosA * wallThick * 0.5;
      const backY  = p.y - sinA * wallThick * 0.5;
      // 벽 8각 실루엣 (crystal prism — 양 끝 뾰족)
      const halfLen = wallLen * 0.5;
      const tipOut = wallThick * 0.15;
      const pts = [
        frontX + perpX * (halfLen - tipOut),        frontY + perpY * (halfLen - tipOut),        // 전면-상
        frontX + perpX * (halfLen - tipOut*0.3) + cosA * tipOut,
                                                    frontY + perpY * (halfLen - tipOut*0.3) + sinA * tipOut,
        frontX + perpX * (-halfLen + tipOut*0.3) + cosA * tipOut,
                                                    frontY + perpY * (-halfLen + tipOut*0.3) + sinA * tipOut,
        frontX + perpX * (-halfLen + tipOut),       frontY + perpY * (-halfLen + tipOut),       // 전면-하
        backX  + perpX * (-halfLen),                backY  + perpY * (-halfLen),                // 후면-하
        backX  + perpX * (halfLen),                 backY  + perpY * (halfLen),                 // 후면-상
      ];
      // 외곽 deep shadow
      g.beginFill(lerpEarthColor(0.92), 0.96);
      g.drawPolygon(pts);
      g.endFill();
      // 전면 lit facet (얼굴면, 이동 방향 front)
      g.beginFill(lerpEarthColor(0.55), 0.92);
      g.drawPolygon([
        frontX + perpX * halfLen,         frontY + perpY * halfLen,
        frontX + perpX * -halfLen,        frontY + perpY * -halfLen,
        backX + perpX * -halfLen,         backY + perpY * -halfLen,
        backX + perpX * halfLen,          backY + perpY * halfLen,
      ]);
      g.endFill();
      // 앞 tip edge highlight (이동 방향 rim)
      g.lineStyle(1.6, lerpEarthColor(0.10), 0.92);
      g.moveTo(frontX + perpX * halfLen,  frontY + perpY * halfLen);
      g.lineTo(frontX + perpX * -halfLen, frontY + perpY * -halfLen);
      g.lineStyle(0);
      // 결정 상단/하단 edge highlight
      g.lineStyle(1.0, lerpEarthColor(0.18), 0.72);
      g.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
      g.lineTo(pts[0], pts[1]);
      g.lineStyle(0);
      // 중심 균열 crack (세로)
      g.lineStyle(1.2, lerpEarthColor(0.85), 0.80);
      g.moveTo(p.x - perpX * halfLen * 0.78, p.y - perpY * halfLen * 0.78);
      g.lineTo(p.x + perpX * halfLen * 0.78, p.y + perpY * halfLen * 0.78);
      g.lineStyle(0);
      // glow bloom (앞 방향 front rim)
      glow.beginFill(lerpEarthColor(0.0), 0.45);
      glow.drawPolygon([
        frontX + perpX * (halfLen + 4),    frontY + perpY * (halfLen + 4),
        frontX + perpX * (-halfLen - 4),   frontY + perpY * (-halfLen - 4),
        frontX + cosA * 8 + perpX * (-halfLen - 4), frontY + sinA * 8 + perpY * (-halfLen - 4),
        frontX + cosA * 8 + perpX * (halfLen + 4),  frontY + sinA * 8 + perpY * (halfLen + 4),
      ]);
      glow.endFill();
      break;
    }
    case 'light_halo': {
      // Halo Ring moving photon — gold diamond plate + 진행 방향 꼬리 없음.
      //    delay 끝난 뒤 vx/vy로 바깥 확장. 이동하면서 crisp plate 유지.
      drawGoldPlate(g, p.x, p.y, r * 0.70, 1.0);
      // 중심 inner ring (빛 느낌 보강)
      g.lineStyle(1.4, lerpLightColor(0.32), 0.85);
      g.drawCircle(p.x, p.y, r * 0.85);
      g.lineStyle(0);
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
