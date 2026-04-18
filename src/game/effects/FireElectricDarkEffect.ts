import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 불+전기+암흑 3단계 — 연쇄 폭뢰 (Chain Detonation)
 *
 * 핵분열 연쇄반응: 1→3→9→27... 다분기 동시 폭발.
 * 암흑이 적을 "마킹" → 화염 폭발 → 전기가 3갈래로 동시 전이 → 각각 마킹 → 폭발 → ...
 * 적이 많을수록 연쇄가 넓게 퍼지며 화면 전체를 뒤덮는다.
 *
 * GLSL 없음. 화면 어둡게 없음.
 * 순수 비주얼 담당 — 엔진이 타이밍/데미지/분기 로직 관리.
 */

// ── Sprite 풀 ──
const POOL_SIZE = 600;
const CIRCLE_TEX_R = 8;

// ── 폭발 상수 ──
const CELLS_PER_EXPLOSION = 70;
const SHOCKWAVE_MAX_R = 130;

// ── 색상 팔레트 ──
// 불
const COL_R500 = 0xef4444;
const COL_R400 = 0xf87171;
const COL_R300 = 0xfca5a5;
const COL_O500 = 0xf97316;
const COL_O400 = 0xfb923c;
const COL_A500 = 0xf59e0b;
const COL_A400 = 0xfbbf24;
// 전기
const COL_C400 = 0x22d3ee;
const COL_C300 = 0x67e8f9;
const COL_Y300 = 0xfde047;
const COL_Y200 = 0xfef08a;
// 암흑
const COL_V700 = 0x6d28d9;
const COL_V600 = 0x7c3aed;
const COL_V500 = 0x8b5cf6;
const COL_V400 = 0xa78bfa;
const COL_V300 = 0xc4b5fd;
const COL_I950 = 0x1e1b4b;
const COL_I900 = 0x312e81;

// 원 텍스처 싱글턴
let _circTex: PIXI.Texture | null = null;
function getCircleTexture(): PIXI.Texture {
  if (_circTex) return _circTex;
  const s = CIRCLE_TEX_R * 2;
  const c = document.createElement('canvas');
  c.width = s; c.height = s;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createRadialGradient(CIRCLE_TEX_R, CIRCLE_TEX_R, 0, CIRCLE_TEX_R, CIRCLE_TEX_R, CIRCLE_TEX_R);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.7, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, s, s);
  _circTex = PIXI.Texture.from(c);
  return _circTex;
}

// ── 타입 ──
interface DarkMark {
  x: number; y: number;
  life: number;
  maxLife: number;
  orbitOffset: number; // 궤도 입자 시작 각도
}

interface BurstCell {
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
  color: number;
}

interface ShockRing {
  x: number; y: number;
  r: number;
  life: number;
  maxLife: number;
}

interface ElectricArc {
  x0: number; y0: number;
  x1: number; y1: number;
  life: number;
  maxLife: number;
  seed: number;
}

export class FireElectricDarkEffect {
  private container: PIXI.Container;
  private gfx: PIXI.Graphics;
  private glowGfx: PIXI.Graphics;

  private cellCoreSprites: PIXI.Sprite[] = [];
  private cellGlowSprites: PIXI.Sprite[] = [];

  active = false;
  private camX = 0;
  private camY = 0;
  private time = 0;

  private marks: DarkMark[] = [];
  private burstCells: BurstCell[] = [];
  private shockRings: ShockRing[] = [];
  private arcs: ElectricArc[] = [];

  constructor(screenLayer: PIXI.Container) {
    this.container = new PIXI.Container();
    screenLayer.addChild(this.container);

    this.glowGfx = new PIXI.Graphics();
    this.glowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.glowGfx);

    this.gfx = new PIXI.Graphics();
    this.container.addChild(this.gfx);

    const tex = getCircleTexture();
    for (let i = 0; i < POOL_SIZE; i++) {
      const glow = new PIXI.Sprite(tex);
      glow.anchor.set(0.5);
      glow.blendMode = PIXI.BLEND_MODES.ADD;
      glow.visible = false;
      this.container.addChild(glow);
      this.cellGlowSprites.push(glow);

      const core = new PIXI.Sprite(tex);
      core.anchor.set(0.5);
      core.visible = false;
      this.container.addChild(core);
      this.cellCoreSprites.push(core);
    }
  }

  start() {
    this.active = true;
    this.time = 0;
    this.marks = [];
    this.burstCells = [];
    this.shockRings = [];
    this.arcs = [];
  }

  // ── 엔진 비주얼 커맨드 ──

  addMark(wx: number, wy: number, duration: number) {
    this.marks.push({
      x: wx, y: wy,
      life: 0, maxLife: duration,
      orbitOffset: Math.random() * Math.PI * 2,
    });
  }

  addExplosion(wx: number, wy: number) {
    const fireColors = [COL_R500, COL_R400, COL_R300, COL_O500, COL_O400, COL_A500, COL_A400];
    for (let i = 0; i < CELLS_PER_EXPLOSION; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 5 + Math.random() * 14;
      const sz = 2.8 + Math.random() * 4.5;
      this.burstCells.push({
        x: wx + Math.cos(angle) * (2 + Math.random() * 8),
        y: wy + Math.sin(angle) * (2 + Math.random() * 8),
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        maxLife: 20 + Math.random() * 25,
        size: sz,
        color: fireColors[Math.floor(Math.random() * fireColors.length)],
      });
    }
    this.shockRings.push({ x: wx, y: wy, r: 10, life: 0, maxLife: 22 });
  }

  addArc(x0: number, y0: number, x1: number, y1: number) {
    this.arcs.push({
      x0, y0, x1, y1,
      life: 0, maxLife: 16,
      seed: Math.random() * 1000,
    });
  }

  update(dt: number, cameraX: number, cameraY: number) {
    if (!this.active) return;
    this.time += dt;
    this.camX = cameraX;
    this.camY = cameraY;

    for (let i = this.marks.length - 1; i >= 0; i--) {
      this.marks[i].life += dt;
      if (this.marks[i].life >= this.marks[i].maxLife) swapPop(this.marks, i);
    }
    for (let i = this.burstCells.length - 1; i >= 0; i--) {
      const c = this.burstCells[i];
      c.life += dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.vx *= 0.93;
      c.vy *= 0.93;
      if (c.life >= c.maxLife) swapPop(this.burstCells, i);
    }
    for (let i = this.shockRings.length - 1; i >= 0; i--) {
      const s = this.shockRings[i];
      s.life += dt;
      s.r = 10 + (SHOCKWAVE_MAX_R - 10) * (s.life / s.maxLife);
      if (s.life >= s.maxLife) swapPop(this.shockRings, i);
    }
    for (let i = this.arcs.length - 1; i >= 0; i--) {
      this.arcs[i].life += dt;
      if (this.arcs[i].life >= this.arcs[i].maxLife) swapPop(this.arcs, i);
    }

    this.draw();
  }

  private draw() {
    this.gfx.clear();
    this.glowGfx.clear();
    this.gfx.lineStyle(0);
    this.glowGfx.lineStyle(0);

    const cx = this.camX;
    const cy = this.camY;

    // ── 1. 암흑 마크 — 크고 분명한 보라 수축 링 + 궤도 입자 + 코어 ──
    for (const m of this.marks) {
      const sx = m.x - cx;
      const sy = m.y - cy;
      const t = m.life / m.maxLife; // 0→1
      const intensity = Math.min(1, t / 0.2); // 빠르게 최대 밝기

      // 암흑 코어 (짙은 보라 원) — 항상 보임
      this.gfx.beginFill(COL_I950, intensity * 0.85);
      this.gfx.drawCircle(sx, sy, 16);
      this.gfx.endFill();
      this.gfx.beginFill(COL_I900, intensity * 0.6);
      this.gfx.drawCircle(sx, sy, 22);
      this.gfx.endFill();

      // ADD 보라 글로우 (넓은)
      this.glowGfx.beginFill(COL_V600, intensity * 0.4);
      this.glowGfx.drawCircle(sx, sy, 38);
      this.glowGfx.endFill();
      this.glowGfx.beginFill(COL_V400, intensity * 0.2);
      this.glowGfx.drawCircle(sx, sy, 55);
      this.glowGfx.endFill();

      // 수축 링 4겹 (큰 → 작은, 두꺼운 선)
      for (let ri = 0; ri < 4; ri++) {
        const phase = ri * 0.22;
        const ringT = (t * 1.5 + phase) % 1;
        const ringR = 55 * (1 - ringT) + 8;
        const ringAlpha = intensity * (1 - ringT) * 0.65;
        if (ringAlpha < 0.02) continue;

        this.gfx.lineStyle(2.5 - ri * 0.3, COL_V500, ringAlpha);
        this.gfx.drawCircle(sx, sy, ringR);
      }

      // 궤도 입자 (6개, 암흑 보라)
      const orbitR = 30 * (1 - t * 0.4);
      const orbitSpeed = 0.08 + t * 0.12; // 점점 빨라짐
      for (let oi = 0; oi < 6; oi++) {
        const oa = m.orbitOffset + oi * (Math.PI / 3) + this.time * orbitSpeed;
        const ox = sx + Math.cos(oa) * orbitR;
        const oy = sy + Math.sin(oa) * orbitR;
        this.gfx.lineStyle(0);
        this.gfx.beginFill(COL_V400, intensity * 0.8);
        this.gfx.drawCircle(ox, oy, 2.5);
        this.gfx.endFill();
        this.glowGfx.beginFill(COL_V500, intensity * 0.3);
        this.glowGfx.drawCircle(ox, oy, 5);
        this.glowGfx.endFill();
      }

      // 분열 직전 — 붉은 플래시 (마지막 25%)
      if (t > 0.75) {
        const flashT = (t - 0.75) / 0.25;
        const flashR = 20 + flashT * 25;
        this.glowGfx.beginFill(COL_R500, flashT * 0.5);
        this.glowGfx.drawCircle(sx, sy, flashR);
        this.glowGfx.endFill();
        // 전기 스파크 (분열 에너지)
        this.glowGfx.beginFill(COL_C400, flashT * 0.3);
        this.glowGfx.drawCircle(sx, sy, flashR * 1.3);
        this.glowGfx.endFill();
      }
    }

    // ── 2. 충격파 링 — 이중 (불+전기) ──
    for (const s of this.shockRings) {
      const sx = s.x - cx;
      const sy = s.y - cy;
      const t = s.life / s.maxLife;
      const alpha = (1 - t) * (1 - t);

      // 불 링 (외곽, 두꺼운)
      this.gfx.lineStyle(4, COL_O500, alpha * 0.8);
      this.gfx.drawCircle(sx, sy, s.r);
      // 전기 링 (내곽)
      this.gfx.lineStyle(2.5, COL_C400, alpha * 0.6);
      this.gfx.drawCircle(sx, sy, s.r * 0.8);
      // ADD 글로우 (넓은 불빛)
      this.glowGfx.lineStyle(10, COL_R500, alpha * 0.25);
      this.glowGfx.drawCircle(sx, sy, s.r);
      // 폭발 중심 플래시
      if (t < 0.3) {
        const flashAlpha = (1 - t / 0.3) * 0.6;
        this.glowGfx.lineStyle(0);
        this.glowGfx.beginFill(COL_A400, flashAlpha);
        this.glowGfx.drawCircle(sx, sy, 18 * (1 - t));
        this.glowGfx.endFill();
      }
    }
    this.gfx.lineStyle(0);
    this.glowGfx.lineStyle(0);

    // ── 3. 폭발 셀 — Sprite 풀 ──
    const cellCount = this.burstCells.length;
    for (let i = 0; i < POOL_SIZE; i++) {
      if (i >= cellCount) {
        this.cellGlowSprites[i].visible = false;
        this.cellCoreSprites[i].visible = false;
        continue;
      }
      const c = this.burstCells[i];
      const lt = c.life / c.maxLife;
      const alpha = lt < 0.1 ? lt / 0.1 : (1 - lt) * (1 - lt);
      if (alpha < 0.01) {
        this.cellGlowSprites[i].visible = false;
        this.cellCoreSprites[i].visible = false;
        continue;
      }

      const sx = c.x - cx;
      const sy = c.y - cy;

      const glow = this.cellGlowSprites[i];
      glow.visible = true;
      glow.position.set(sx, sy);
      glow.scale.set((c.size * 2.2) / CIRCLE_TEX_R);
      glow.tint = c.color;
      glow.alpha = alpha * 0.35;

      const core = this.cellCoreSprites[i];
      core.visible = true;
      core.position.set(sx, sy);
      core.scale.set((c.size * (1 - lt * 0.3)) / CIRCLE_TEX_R);
      core.tint = c.color;
      core.alpha = alpha * 0.9;
    }

    // ── 4. 전기 아크 — 두꺼운 지그재그 ──
    for (const arc of this.arcs) {
      const fadeT = arc.life / arc.maxLife;
      const alpha = (1 - fadeT) * (1 - fadeT);
      if (alpha < 0.02) continue;

      const sx0 = arc.x0 - cx;
      const sy0 = arc.y0 - cy;
      const sx1 = arc.x1 - cx;
      const sy1 = arc.y1 - cy;

      const dx = sx1 - sx0;
      const dy = sy1 - sy0;
      const s = arc.seed + arc.life * 13;
      const jit = 25;
      const segs = 5;
      const pts: { x: number; y: number }[] = [{ x: sx0, y: sy0 }];
      for (let si = 1; si < segs; si++) {
        const frac = si / segs;
        pts.push({
          x: sx0 + dx * frac + Math.sin(s * (si * 1.7)) * jit,
          y: sy0 + dy * frac + Math.cos(s * (si * 2.3)) * jit,
        });
      }
      pts.push({ x: sx1, y: sy1 });

      // ADD 글로우 (넓고 밝은)
      this.glowGfx.lineStyle(8, COL_C400, alpha * 0.5);
      this.glowGfx.moveTo(pts[0].x, pts[0].y);
      for (let pi = 1; pi < pts.length; pi++) this.glowGfx.lineTo(pts[pi].x, pts[pi].y);

      // 코어 (밝은 선)
      this.gfx.lineStyle(3, COL_C300, alpha * 0.9);
      this.gfx.moveTo(pts[0].x, pts[0].y);
      for (let pi = 1; pi < pts.length; pi++) this.gfx.lineTo(pts[pi].x, pts[pi].y);

      // 양 끝 노드 글로우
      this.glowGfx.lineStyle(0);
      this.glowGfx.beginFill(COL_Y300, alpha * 0.5);
      this.glowGfx.drawCircle(sx0, sy0, 8);
      this.glowGfx.endFill();
      this.glowGfx.beginFill(COL_Y200, alpha * 0.4);
      this.glowGfx.drawCircle(sx1, sy1, 10);
      this.glowGfx.endFill();
    }
  }

  stop() {
    this.active = false;
    this.marks = [];
    this.burstCells = [];
    this.shockRings = [];
    this.arcs = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      this.cellGlowSprites[i].visible = false;
      this.cellCoreSprites[i].visible = false;
    }
    this.gfx.clear();
    this.glowGfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
