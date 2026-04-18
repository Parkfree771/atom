import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 물+불+전기 3단계 — 증기폭뢰 (Steam Thunderbolt)
 *
 * 과열 증기 압력이 임계점에 도달하면 전기 방전과 함께 폭발.
 * 물+불=증기, 전기=방전. 세 부모(스팀폭발/감전파도/체인봄버)의 집대성.
 *
 * 4페이즈 사이클 (~185f / 3.1초):
 *   1. PRESSURE  (80f) — 증기 소용돌이 수렴 (cool→hot), 전기 스파크 증가, 열 틱뎀
 *   2. CRITICAL  (10f) — 전 증기 중심 압축, 전기 크래클 극대화
 *   3. RELEASE   (35f) — 대폭발 + 4겹 충격파 + 전기 체인 + 넉백
 *   4. COOLDOWN  (60f) — 쉼
 *
 * 캐릭터를 따라다님. GLSL 없음.
 */

// ── 페이즈 ──
const PHASE_PRESSURE = 0;
const PHASE_CRITICAL = 1;
const PHASE_RELEASE = 2;
const PHASE_COOLDOWN = 3;

const P_PRESSURE = 130;
const P_CRITICAL = 42;
const P_RELEASE = 40;
const P_COOLDOWN = 60;

// ── 증기 ──
const STEAM_MAX = 200;
const STEAM_SPAWN_RADIUS = 300;

// ── 스파크 ──
const SPARK_MAX = 55;

// ── 데미지 ──
const HEAT_RANGE = 140;
const HEAT_DAMAGE = 5;
const HEAT_TICK = 12;
const BURST_RADIUS = 280;
const BURST_DAMAGE = 85;
const BURST_KNOCKBACK = 30;
const CHAIN_DAMAGE = 20;
const CHAIN_HOP_RANGE = 200;
const CHAIN_MAX_HOPS = 12;

// ── 폭발 셀 ──
const BURST_CELL_COUNT = 250;
const POOL_SIZE = 300;
const CIRCLE_TEX_R = 8;

// ── 충격파 ──
const SHOCK_MAX_R = 320;

// ── 색상: 증기 그래디언트 (베이지 배경 대비, 물 파랑→불 주황→고온 빨강) ──
const STEAM_STOPS: Array<{ t: number; r: number; g: number; b: number }> = [
  { t: 0.00, r: 37, g: 99, b: 235 },    // blue-600 (물 — 차가운 증기)
  { t: 0.15, r: 59, g: 130, b: 246 },   // blue-500
  { t: 0.30, r: 96, g: 165, b: 250 },   // blue-400
  { t: 0.45, r: 249, g: 115, b: 22 },   // orange-500 (불 — 가열)
  { t: 0.60, r: 239, g: 68, b: 68 },    // red-500 (고온)
  { t: 0.75, r: 220, g: 38, b: 38 },    // red-600
  { t: 0.88, r: 249, g: 115, b: 22 },   // orange-500
  { t: 1.00, r: 251, g: 146, b: 60 },   // orange-400 (최고온)
];

function lerpSteamColor(t: number): number {
  const ct = Math.max(0, Math.min(1, t));
  let i = 0;
  while (i < STEAM_STOPS.length - 2 && STEAM_STOPS[i + 1].t < ct) i++;
  const a = STEAM_STOPS[i], b = STEAM_STOPS[i + 1];
  const lt = (ct - a.t) / (b.t - a.t + 0.0001);
  const r = Math.round(a.r + (b.r - a.r) * lt);
  const g = Math.round(a.g + (b.g - a.g) * lt);
  const bl = Math.round(a.b + (b.b - a.b) * lt);
  return (r << 16) | (g << 8) | bl;
}

// 폭발 셀 색 (불 빨강 → 전기 보라/시안 → 물 파랑, 베이지 대비 강한 색)
const BURST_STOPS: Array<{ t: number; r: number; g: number; b: number }> = [
  { t: 0.00, r: 239, g: 68, b: 68 },    // red-500 (불 코어)
  { t: 0.12, r: 249, g: 115, b: 22 },   // orange-500
  { t: 0.24, r: 251, g: 146, b: 60 },   // orange-400
  { t: 0.36, r: 167, g: 139, b: 250 },  // violet-400 (전기)
  { t: 0.48, r: 139, g: 92, b: 246 },   // violet-500
  { t: 0.60, r: 34, g: 211, b: 238 },   // cyan-400 (전기)
  { t: 0.72, r: 253, g: 224, b: 71 },   // yellow-300 (전기 밝은)
  { t: 0.84, r: 59, g: 130, b: 246 },   // blue-500 (물)
  { t: 1.00, r: 37, g: 99, b: 235 },    // blue-600 (물)
];

function lerpBurstColor(t: number): number {
  const ct = Math.max(0, Math.min(1, t));
  let i = 0;
  while (i < BURST_STOPS.length - 2 && BURST_STOPS[i + 1].t < ct) i++;
  const a = BURST_STOPS[i], b = BURST_STOPS[i + 1];
  const lt = (ct - a.t) / (b.t - a.t + 0.0001);
  const r = Math.round(a.r + (b.r - a.r) * lt);
  const g = Math.round(a.g + (b.g - a.g) * lt);
  const bl = Math.round(a.b + (b.b - a.b) * lt);
  return (r << 16) | (g << 8) | bl;
}

// 전기 스파크/체인 색 (시안+보라, 베이지 대비 선명)
const COL_SPARK_OUTER = 0x8b5cf6;  // violet-500
const COL_SPARK_MID = 0x22d3ee;    // cyan-400
const COL_SPARK_CORE = 0x67e8f9;   // cyan-300
// 체인 색 (물+불+전기 혼합톤, 베이지 대비 선명)
const COL_CHAIN_OUTER = 0x6d28d9;  // violet-700 (물+전기 혼합 = 깊은 보라)
const COL_CHAIN_MID = 0xdb2777;    // pink-600 (불+전기 혼합 = 마젠타)
const COL_CHAIN_INNER = 0x0ea5e9;  // sky-500 (물+전기 혼합 = 밝은 스카이)
const COL_CHAIN_CORE = 0xfbbf24;   // amber-400 (불+물 혼합 = 밝은 앰버)
// 충격파 색
const COL_SHOCK1 = 0xc2410c;  // orange-700
const COL_SHOCK2 = 0xfb923c;  // orange-400
const COL_SHOCK3 = 0xfde047;  // gold

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
interface SteamParticle {
  angle: number;
  radius: number;
  inwardSpeed: number;
  angularSpeed: number;
  size: number;
  jitter: number; // 개별 흔들림
}

interface Spark {
  x: number; y: number;    // 중심 기준 상대
  angle: number;           // 스파크 방향
  length: number;
  life: number;
  maxLife: number;
}

interface BurstCell {
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
  tStart: number; tEnd: number;
}

interface ChainLink {
  fromX: number; fromY: number;  // 월드 좌표
  toX: number; toY: number;      // 월드 좌표
  life: number; maxLife: number;
}

export class WaterFireElectricEffect {
  private container: PIXI.Container;
  private gfx: PIXI.Graphics;
  private glowGfx: PIXI.Graphics;

  private burstCoreSprites: PIXI.Sprite[] = [];
  private burstGlowSprites: PIXI.Sprite[] = [];

  active = false;
  private posX = 0;
  private posY = 0;
  private screenX = 0;
  private screenY = 0;
  private time = 0;
  private phase = PHASE_COOLDOWN;
  private phaseTimer = 0;

  // 증기
  private steamParticles: SteamParticle[] = [];
  // 전기 스파크
  private sparks: Spark[] = [];
  // 폭발 셀
  private burstCells: BurstCell[] = [];
  // 충격파
  private shockwaveR = 0;
  private shockwaveAlpha = 0;
  // 체인 링크 (프리즘 패턴)
  private chainLinks: ChainLink[] = [];

  // 압력 (0→1)
  private pressure = 0;

  // 엔진 통신
  releaseFiredThisFrame = false;
  private _isPressuring = false;

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
      this.burstGlowSprites.push(glow);

      const core = new PIXI.Sprite(tex);
      core.anchor.set(0.5);
      core.visible = false;
      this.container.addChild(core);
      this.burstCoreSprites.push(core);
    }
  }

  setPosition(x: number, y: number) {
    this.posX = x;
    this.posY = y;
  }

  start(x: number, y: number) {
    this.active = true;
    this.posX = x;
    this.posY = y;
    this.time = 0;
    this.phase = PHASE_PRESSURE;
    this.phaseTimer = 0;
    this.steamParticles = [];
    this.sparks = [];
    this.burstCells = [];
    this.chainLinks = [];
    this.shockwaveR = 0;
    this.shockwaveAlpha = 0;
    this.pressure = 0;
    this.releaseFiredThisFrame = false;
    this._isPressuring = false;
  }

  /** 엔진에서 전기 체인 전달 */
  /** 지그재그 번개 경로 (프리즘 캐스케이드 동일 패턴, 스크린 좌표) */
  private makeZigzagPath(x0: number, y0: number, x1: number, y1: number): Array<{ x: number; y: number }> {
    const dx = x1 - x0, dy = y1 - y0;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 2) return [{ x: x0, y: y0 }, { x: x1, y: y1 }];
    const segs = Math.max(6, Math.floor(dist / 14));
    const jitter = dist * 0.16;
    const perpX = -dy / dist, perpY = dx / dist;
    const pts: Array<{ x: number; y: number }> = [{ x: x0, y: y0 }];
    for (let i = 1; i < segs; i++) {
      const t = i / segs;
      const j = (Math.random() - 0.5) * jitter;
      pts.push({ x: x0 + dx * t + perpX * j, y: y0 + dy * t + perpY * j });
    }
    pts.push({ x: x1, y: y1 });
    return pts;
  }

  /** 엔진에서 체인 라인 추가 (월드 좌표 그대로 저장, draw에서 변환) */
  addChainArc(worldPoints: { x: number; y: number }[]) {
    if (worldPoints.length < 2) return;
    for (let i = 0; i < worldPoints.length - 1; i++) {
      const p0 = worldPoints[i], p1 = worldPoints[i + 1];
      this.chainLinks.push({
        fromX: p0.x, fromY: p0.y,
        toX: p1.x, toY: p1.y,
        life: 22, maxLife: 22,
      });
    }
  }

  update(dt: number, cameraX: number, cameraY: number) {
    if (!this.active) return;
    this.time += dt;
    this.phaseTimer += dt;
    this.releaseFiredThisFrame = false;
    this.screenX = this.posX - cameraX;
    this.screenY = this.posY - cameraY;

    switch (this.phase) {
      case PHASE_PRESSURE: {
        const t = this.phaseTimer / P_PRESSURE;
        this.pressure = t;
        this._isPressuring = true;

        // 증기 입자 스폰 (처음부터 많이)
        if (this.steamParticles.length < STEAM_MAX) {
          const rate = 2 + Math.floor(t * 2);
          for (let i = 0; i < rate; i++) this.spawnSteamParticle();
        }

        // 전기 스파크 (처음부터 활발, 점점 강해짐)
        if (this.sparks.length < SPARK_MAX * (0.3 + t * 0.7)) {
          const sparkRate = 0.4 + t * 0.6;
          if (Math.random() < sparkRate) this.spawnSpark();
          if (t > 0.5 && Math.random() < 0.3) this.spawnSpark();
        }

        if (this.phaseTimer >= P_PRESSURE) {
          this.phase = PHASE_CRITICAL;
          this.phaseTimer = 0;
        }
        break;
      }
      case PHASE_CRITICAL: {
        const t = this.phaseTimer / P_CRITICAL;
        this.pressure = 1;
        this._isPressuring = true;

        // 모든 증기 중심으로 천천히 압축 (급격하지 않게)
        const compress = 0.96 - t * 0.04; // 0.96→0.92 점진적
        for (const sp of this.steamParticles) {
          sp.radius *= compress;
          sp.angularSpeed *= 1.02;
        }

        // 전기 스파크 폭주
        if (this.sparks.length < SPARK_MAX * 2) {
          for (let i = 0; i < 4; i++) this.spawnSpark();
        }

        if (this.phaseTimer >= P_CRITICAL) {
          this.phase = PHASE_RELEASE;
          this.phaseTimer = 0;
          this.releaseFiredThisFrame = true;
          this._isPressuring = false;
          this.spawnBurstCells();
          this.shockwaveR = 15;
          this.shockwaveAlpha = 1;
          this.steamParticles = [];
          this.sparks = [];
        }
        break;
      }
      case PHASE_RELEASE: {
        const t = this.phaseTimer / P_RELEASE;
        this.pressure = Math.max(0, 1 - t);
        // 충격파 확장 (70% radius in first 20%)
        const shockT = t < 0.2 ? t / 0.2 * 0.7 : 0.7 + (t - 0.2) / 0.8 * 0.3;
        this.shockwaveR = 15 + (SHOCK_MAX_R - 15) * shockT;
        this.shockwaveAlpha = (1 - t) * (1 - t);

        if (this.phaseTimer >= P_RELEASE) {
          this.phase = PHASE_COOLDOWN;
          this.phaseTimer = 0;
        }
        break;
      }
      case PHASE_COOLDOWN: {
        this.pressure = 0;
        this._isPressuring = false;
        if (this.phaseTimer >= P_COOLDOWN) {
          this.stop();
          return;
        }
        break;
      }
    }

    // 증기 업데이트
    for (let i = this.steamParticles.length - 1; i >= 0; i--) {
      const sp = this.steamParticles[i];
      sp.inwardSpeed += 0.025 * dt;
      sp.radius -= sp.inwardSpeed * dt;
      const accel = 1 + (1 - sp.radius / STEAM_SPAWN_RADIUS) * 2.5;
      sp.angle += sp.angularSpeed * accel * dt;
      if (sp.radius < 6) swapPop(this.steamParticles, i);
    }
    // 스파크 업데이트
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      this.sparks[i].life += dt;
      if (this.sparks[i].life >= this.sparks[i].maxLife) swapPop(this.sparks, i);
    }
    // 폭발 셀 업데이트
    for (let i = this.burstCells.length - 1; i >= 0; i--) {
      const c = this.burstCells[i];
      c.life += dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.vx *= 0.96;
      c.vy *= 0.96;
      if (c.life >= c.maxLife) swapPop(this.burstCells, i);
    }
    // 체인 아크 업데이트
    for (let i = this.chainLinks.length - 1; i >= 0; i--) {
      this.chainLinks[i].life -= dt;
      if (this.chainLinks[i].life <= 0) swapPop(this.chainLinks, i);
    }

    this.draw();
  }

  private spawnSteamParticle() {
    const angle = Math.random() * Math.PI * 2;
    this.steamParticles.push({
      angle,
      radius: STEAM_SPAWN_RADIUS * (0.8 + Math.random() * 0.2),
      inwardSpeed: 0.25 + Math.random() * 0.45,
      angularSpeed: (0.02 + Math.random() * 0.03) * (Math.random() < 0.5 ? 1 : -1),
      size: 2.8 + Math.random() * 3.5,
      jitter: Math.random() * Math.PI * 2,
    });
  }

  private spawnSpark() {
    const cloudR = STEAM_SPAWN_RADIUS * (0.3 + (1 - this.pressure) * 0.5);
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * cloudR;
    this.sparks.push({
      x: Math.cos(angle) * dist,
      y: Math.sin(angle) * dist,
      angle: Math.random() * Math.PI * 2,
      length: 14 + Math.random() * 28,
      life: 0,
      maxLife: 4 + Math.random() * 5,
    });
  }

  private spawnBurstCells() {
    for (let i = 0; i < BURST_CELL_COUNT; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 6 + Math.random() * 16;
      const r = Math.random();
      let tStart: number, tEnd: number;
      if (r < 0.35) { tStart = 0; tEnd = 0.3; }           // 증기 핫코어
      else if (r < 0.55) { tStart = 0.4; tEnd = 0.65; }   // 전기 금
      else { tStart = 0.7; tEnd = 1.0; }                    // 증기 냉각
      this.burstCells.push({
        x: (Math.random() - 0.5) * 12,
        y: (Math.random() - 0.5) * 12,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        maxLife: 20 + Math.random() * 28,
        size: 3.5 + Math.random() * 5.0,
        tStart, tEnd,
      });
    }
  }

  // ── 그리기 ──
  private draw() {
    this.gfx.clear();
    this.glowGfx.clear();
    this.gfx.lineStyle(0);
    this.glowGfx.lineStyle(0);

    const sx = this.screenX;
    const sy = this.screenY;
    const isCooldown = this.phase === PHASE_COOLDOWN
      && this.burstCells.length === 0 && this.chainLinks.length === 0;
    if (isCooldown) {
      this.hideAllSprites();
      return;
    }

    // ── 1. 증기 소용돌이 (PRESSURE ~ CRITICAL) ──
    for (const sp of this.steamParticles) {
      const px = sx + Math.cos(sp.angle) * sp.radius;
      const py = sy + Math.sin(sp.angle) * sp.radius;
      // 색상: 거리 기반 + 압력 기반 보간
      const distT = 1 - sp.radius / STEAM_SPAWN_RADIUS;
      const heatT = Math.min(1, distT * 0.6 + this.pressure * 0.4);
      const color = lerpSteamColor(heatT);
      // 중심 가까울수록 강조
      const alpha = 0.3 + distT * 0.55;
      const sz = sp.size * (0.8 + distT * 0.4);
      // 약간의 흔들림
      const jx = Math.sin(this.time * 0.05 + sp.jitter) * 2;
      const jy = Math.cos(this.time * 0.07 + sp.jitter) * 2;

      // ADD 글로우 (증기 미스트 느낌)
      this.glowGfx.beginFill(color, alpha * 0.25);
      this.glowGfx.drawCircle(px + jx, py + jy, sz * 2.0);
      this.glowGfx.endFill();
      // NORMAL 코어
      this.gfx.beginFill(color, alpha);
      this.gfx.drawCircle(px + jx, py + jy, sz);
      this.gfx.endFill();
    }

    // ── 2. 전기 스파크 (증기 사이에서 튀김) ──
    for (const sp of this.sparks) {
      const fadeT = sp.life / sp.maxLife;
      const alpha = fadeT < 0.3 ? fadeT / 0.3 : (1 - fadeT) / 0.7;
      if (alpha < 0.05) continue;

      const spx = sx + sp.x;
      const spy = sy + sp.y;
      const ex = spx + Math.cos(sp.angle) * sp.length;
      const ey = spy + Math.sin(sp.angle) * sp.length;
      // 중간 꺾임점
      const mx = (spx + ex) / 2 + (Math.random() - 0.5) * sp.length * 0.4;
      const my = (spy + ey) / 2 + (Math.random() - 0.5) * sp.length * 0.4;

      // ADD 글로우 (넓고 선명)
      this.glowGfx.lineStyle(7, COL_SPARK_OUTER, alpha * 0.5);
      this.glowGfx.moveTo(spx, spy);
      this.glowGfx.lineTo(mx, my);
      this.glowGfx.lineTo(ex, ey);
      // 중간
      this.gfx.lineStyle(3, COL_SPARK_MID, alpha * 0.7);
      this.gfx.moveTo(spx, spy);
      this.gfx.lineTo(mx, my);
      this.gfx.lineTo(ex, ey);
      // 코어
      this.gfx.lineStyle(1.5, COL_SPARK_CORE, alpha * 0.9);
      this.gfx.moveTo(spx, spy);
      this.gfx.lineTo(mx, my);
      this.gfx.lineTo(ex, ey);
    }
    this.gfx.lineStyle(0);
    this.glowGfx.lineStyle(0);

    // ── 3. CRITICAL 코어 (압축 + 전기 폭주, 3색) ──
    if (this.phase === PHASE_CRITICAL) {
      const t = this.phaseTimer / P_CRITICAL;
      const coreR = 12 + t * 14;
      const coreAlpha = 0.5 + t * 0.4;
      // 전기 보라 외곽
      this.glowGfx.beginFill(COL_SPARK_OUTER, coreAlpha * 0.35);
      this.glowGfx.drawCircle(sx, sy, coreR * 2.5);
      this.glowGfx.endFill();
      // 불 주황 중간
      this.glowGfx.beginFill(0xf97316, coreAlpha * 0.3);
      this.glowGfx.drawCircle(sx, sy, coreR * 1.6);
      this.glowGfx.endFill();
      // 전기 시안 코어
      this.gfx.beginFill(COL_SPARK_MID, coreAlpha * 0.7);
      this.gfx.drawCircle(sx, sy, coreR);
      this.gfx.endFill();
    }

    // ── 4. 충격파 (4겹, FireElectric 참조) ──
    if (this.shockwaveAlpha > 0.01) {
      const r = this.shockwaveR;
      const a = this.shockwaveAlpha;
      this.gfx.lineStyle(14, COL_SHOCK1, a * 0.35);
      this.gfx.drawCircle(sx, sy, r);
      this.gfx.lineStyle(8, COL_SHOCK2, a * 0.5);
      this.gfx.drawCircle(sx, sy, r * 0.92);
      this.gfx.lineStyle(4, COL_SHOCK3, a * 0.65);
      this.gfx.drawCircle(sx, sy, r * 0.84);
      this.gfx.lineStyle(2, COL_SPARK_CORE, a * 0.8);
      this.gfx.drawCircle(sx, sy, r * 0.76);
      this.gfx.lineStyle(0);
    }

    // ── 5. 폭발 셀 — Sprite 풀 ──
    const cellCount = this.burstCells.length;
    for (let i = 0; i < POOL_SIZE; i++) {
      if (i >= cellCount) {
        this.burstGlowSprites[i].visible = false;
        this.burstCoreSprites[i].visible = false;
        continue;
      }
      const c = this.burstCells[i];
      const lt = c.life / c.maxLife;
      const alpha = lt < 0.08 ? lt / 0.08 : (1 - lt) * (1 - lt);
      if (alpha < 0.01) {
        this.burstGlowSprites[i].visible = false;
        this.burstCoreSprites[i].visible = false;
        continue;
      }

      const t = c.tStart + (c.tEnd - c.tStart) * lt;
      const color = lerpBurstColor(t);
      const cx = sx + c.x;
      const cy = sy + c.y;

      const glow = this.burstGlowSprites[i];
      glow.visible = true;
      glow.position.set(cx, cy);
      glow.scale.set((c.size * 2.0) / CIRCLE_TEX_R);
      glow.tint = color;
      glow.alpha = alpha * 0.3;

      const core = this.burstCoreSprites[i];
      core.visible = true;
      core.position.set(cx, cy);
      core.scale.set((c.size * (1 - lt * 0.3)) / CIRCLE_TEX_R);
      core.tint = color;
      core.alpha = alpha * 0.9;
    }

    // ── 6. 전기 체인 (매 프레임 월드→스크린 변환 + 지그재그 재생성 = 깨작거림) ──
    const camX = this.posX - this.screenX;
    const camY = this.posY - this.screenY;

    for (const c of this.chainLinks) {
      const lifeT = c.life / c.maxLife;
      const flicker = 0.7 + Math.random() * 0.3;
      const a = lifeT * flicker;
      if (a < 0.02) continue;

      // 매 프레임 월드→스크린 변환 (카메라 이동 대응)
      const sx0 = c.fromX - camX, sy0 = c.fromY - camY;
      const sx1 = c.toX - camX, sy1 = c.toY - camY;
      // 매 프레임 지그재그 재생성 (깨작거림)
      const pts = this.makeZigzagPath(sx0, sy0, sx1, sy1);
      if (pts.length < 2) continue;

      const drawPath = (gfx: PIXI.Graphics, w: number, color: number, alpha: number) => {
        gfx.lineStyle(w, color, alpha);
        gfx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) gfx.lineTo(pts[i].x, pts[i].y);
        gfx.lineStyle(0);
      };

      // 4패스: 물(파랑) → 불(주황) → 전기(시안) → 전기(코어)
      drawPath(this.glowGfx, 16, COL_CHAIN_OUTER, a * 0.28);
      drawPath(this.glowGfx, 10, COL_CHAIN_MID, a * 0.4);
      drawPath(this.gfx, 4.5, COL_CHAIN_INNER, a * 0.85);
      drawPath(this.gfx, 1.8, COL_CHAIN_CORE, a * 0.95);

      // 양 끝 임팩트 글로우
      this.glowGfx.beginFill(COL_CHAIN_INNER, a * 0.35);
      this.glowGfx.drawCircle(sx1, sy1, 8);
      this.glowGfx.endFill();
      this.glowGfx.beginFill(COL_CHAIN_MID, a * 0.2);
      this.glowGfx.drawCircle(sx0, sy0, 6);
      this.glowGfx.endFill();
    }
  }

  private hideAllSprites() {
    for (let i = 0; i < POOL_SIZE; i++) {
      this.burstGlowSprites[i].visible = false;
      this.burstCoreSprites[i].visible = false;
    }
  }

  // ── 엔진 쿼리 ──
  isPressuring(): boolean { return this.active && this._isPressuring; }
  heatRange(): number { return HEAT_RANGE; }
  burstRadius(): number { return BURST_RADIUS; }

  // ── 정리 ──
  stop() {
    this.active = false;
    this.steamParticles = [];
    this.sparks = [];
    this.burstCells = [];
    this.chainLinks = [];
    this._isPressuring = false;
    this.hideAllSprites();
    this.gfx.clear();
    this.glowGfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
