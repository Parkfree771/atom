import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 흙+불+전기 3단계 — 화산뇌 (Volcanic Thunder)
 *
 * 유성우(흙+암흑)와 동일 구조: 45° 대각선 낙하 연속 운석.
 * 색상만 흙+불(갈색+적/주황)로 교체, 착탄 시 전기 체인이 주변 적으로 확산.
 *
 * 운석 라이프사이클:
 *   FALLING (22f) — 우상단에서 대각선 낙하, 3겹 트레일, 크기 증가
 *   IMPACT (10f)  — 폭발 파티클 + 4겹 충격파 + 전기 체인 트리거
 *
 * GLSL 없음. 캐릭터 따라다님.
 */

// ── 스폰 ──
const SPAWN_INTERVAL = 6;       // 더 빈번 (9→6)
const SPAWN_RADIUS_MIN = 40;
const SPAWN_RADIUS_MAX = 280;   // 훨씬 넓은 범위 (150→280)
const FALL_FRAMES = 22;
const IMPACT_FRAMES = 12;
const START_OFFSET = 130;       // 더 먼 곳에서 낙하

// ── 운석 크기 ──
const METEOR_SIZE_MIN = 6;
const METEOR_SIZE_MAX = 13;     // 더 큰 운석 (10→13)
const METEOR_STRETCH = 1.6;

// ── 착탄 ──
const IMPACT_RADIUS = 65;      // 더 넓은 착탄 범위 (55→65)
const BURST_COUNT = 36;         // 더 많은 폭발 파티클 (28→36)

// ── 트레일 ──
const TRAIL_SEGS = 6;
const TRAIL_MAX_LEN = 95;

// ── 체인 ──
const CHAIN_LIFE = 22;

// ── 색상: 흙+불 (암흑 대신 불) ──
// 운석 톤 (4 바리에이션)
const TONES = [
  { outer: 0x78520a, inner: 0xef4444 },  // brown + red-500
  { outer: 0x5c3d08, inner: 0xf97316 },  // brown + orange-500
  { outer: 0xa16207, inner: 0xdc2626 },  // amber + red-600
  { outer: 0x3a1a0a, inner: 0xea580c },  // dark brown + orange-600
];
// 흙
const COL_EARTH1 = 0x78520a;
const COL_EARTH2 = 0xa16207;
const COL_EARTH3 = 0xd4a53c;
// 불
const COL_FIRE1 = 0xef4444;  // red-500
const COL_FIRE2 = 0xf97316;  // orange-500
const COL_FIRE3 = 0xf59e0b;  // amber-500
const COL_FIRE4 = 0xfbbf24;  // amber-400
// 전기
const COL_ELEC1 = 0x8b5cf6;  // violet-500
const COL_ELEC2 = 0x22d3ee;  // cyan-400
const COL_ELEC3 = 0x67e8f9;  // cyan-300
// 충격파
const COL_SHOCK_OUTER = 0xea580c;  // orange-600
const COL_SHOCK_MID = 0xf97316;    // orange-500
const COL_SHOCK_INNER = 0x22d3ee;  // cyan-400
const COL_SHOCK_CORE = 0xfbbf24;   // amber-400
// 체인
const COL_CHAIN1 = 0xf97316;  // orange-500 (불+흙)
const COL_CHAIN2 = 0xdb2777;  // pink-600 (불+전기)
const COL_CHAIN3 = 0x0ea5e9;  // sky-500 (전기)
const COL_CHAIN4 = 0xfbbf24;  // amber-400 (코어)

// ── 타입 ──
interface Meteor {
  targetX: number; targetY: number; // 착탄 월드 좌표
  startOX: number; startOY: number; // 시작 오프셋
  timer: number;
  phase: number; // 0=FALLING, 1=IMPACT
  size: number;
  toneIdx: number;
  // 착탄 파티클
  burstParticles: BurstP[];
  shockProgress: number;
  impactFired: boolean;
}

interface BurstP {
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
  color: number;
}

interface ChainLink {
  fromX: number; fromY: number; // 월드
  toX: number; toY: number;
  life: number; maxLife: number;
}

export class EarthFireElectricEffect {
  private container: PIXI.Container;
  private gfx: PIXI.Graphics;
  private glowGfx: PIXI.Graphics;

  active = false;
  private posX = 0;
  private posY = 0;
  private screenX = 0;
  private screenY = 0;
  private time = 0;
  private spawnTimer = 0;

  private meteors: Meteor[] = [];
  private chainLinks: ChainLink[] = [];

  // 엔진 통신: 이번 프레임 착탄 위치들
  private _impacts: { x: number; y: number }[] = [];

  constructor(screenLayer: PIXI.Container) {
    this.container = new PIXI.Container();
    screenLayer.addChild(this.container);

    this.glowGfx = new PIXI.Graphics();
    this.glowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.glowGfx);

    this.gfx = new PIXI.Graphics();
    this.container.addChild(this.gfx);
  }

  setPosition(x: number, y: number) { this.posX = x; this.posY = y; }

  start(x: number, y: number) {
    this.active = true;
    this.posX = x; this.posY = y;
    this.time = 0;
    this.spawnTimer = 0;
    this.meteors = [];
    this.chainLinks = [];
    this._impacts = [];
  }

  /** 엔진에서 체인 라인 추가 (월드 좌표) */
  addChainLine(x0: number, y0: number, x1: number, y1: number) {
    this.chainLinks.push({
      fromX: x0, fromY: y0, toX: x1, toY: y1,
      life: CHAIN_LIFE, maxLife: CHAIN_LIFE,
    });
  }

  /** 이번 프레임 착탄 좌표 (엔진 읽기용) */
  impactsThisFrame(): { x: number; y: number }[] { return this._impacts; }
  impactRadius(): number { return IMPACT_RADIUS; }

  update(dt: number, cameraX: number, cameraY: number) {
    if (!this.active) return;
    this.time += dt;
    this.screenX = this.posX - cameraX;
    this.screenY = this.posY - cameraY;
    this._impacts = [];

    // 운석 스폰
    this.spawnTimer += dt;
    if (this.spawnTimer >= SPAWN_INTERVAL) {
      this.spawnTimer = 0;
      this.spawnMeteor();
    }

    // 운석 업데이트
    for (let i = this.meteors.length - 1; i >= 0; i--) {
      const m = this.meteors[i];
      m.timer += dt;

      if (m.phase === 0) {
        // FALLING
        if (m.timer >= FALL_FRAMES) {
          m.phase = 1;
          m.timer = 0;
          m.impactFired = true;
          this._impacts.push({ x: m.targetX, y: m.targetY });
          this.spawnBurst(m);
        }
      } else {
        // IMPACT
        m.shockProgress = m.timer / IMPACT_FRAMES;
        // 파티클 업데이트
        for (let j = m.burstParticles.length - 1; j >= 0; j--) {
          const p = m.burstParticles[j];
          p.life += dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.vx *= 0.92;
          p.vy *= 0.92;
          if (p.life >= p.maxLife) swapPop(m.burstParticles, j);
        }
        if (m.timer >= IMPACT_FRAMES && m.burstParticles.length === 0) {
          swapPop(this.meteors, i);
        }
      }
    }

    // 체인 업데이트
    for (let i = this.chainLinks.length - 1; i >= 0; i--) {
      this.chainLinks[i].life -= dt;
      if (this.chainLinks[i].life <= 0) swapPop(this.chainLinks, i);
    }

    this.draw();
  }

  private spawnMeteor() {
    const angle = Math.random() * Math.PI * 2;
    const dist = SPAWN_RADIUS_MIN + Math.random() * (SPAWN_RADIUS_MAX - SPAWN_RADIUS_MIN);
    this.meteors.push({
      targetX: this.posX + Math.cos(angle) * dist,
      targetY: this.posY + Math.sin(angle) * dist,
      startOX: START_OFFSET * (0.85 + Math.random() * 0.3),
      startOY: -START_OFFSET * (0.85 + Math.random() * 0.3),
      timer: 0,
      phase: 0,
      size: METEOR_SIZE_MIN + Math.random() * (METEOR_SIZE_MAX - METEOR_SIZE_MIN),
      toneIdx: Math.floor(Math.random() * TONES.length),
      burstParticles: [],
      shockProgress: 0,
      impactFired: false,
    });
  }

  private spawnBurst(m: Meteor) {
    const earthColors = [COL_EARTH1, COL_EARTH2, COL_EARTH3];
    const fireColors = [COL_FIRE1, COL_FIRE2, COL_FIRE3, COL_FIRE4];
    const elecColors = [COL_ELEC1, COL_ELEC2, COL_ELEC3];
    for (let i = 0; i < BURST_COUNT; i++) {
      const a = Math.random() * Math.PI * 2;
      const spd = 4 + Math.random() * 7;
      const r = Math.random();
      let color: number;
      if (r < 0.35) color = earthColors[Math.floor(Math.random() * earthColors.length)];
      else if (r < 0.70) color = fireColors[Math.floor(Math.random() * fireColors.length)];
      else color = elecColors[Math.floor(Math.random() * elecColors.length)];

      m.burstParticles.push({
        x: 0, y: 0,
        vx: Math.cos(a) * spd,
        vy: Math.sin(a) * spd,
        life: 0,
        maxLife: 18 + Math.random() * 22,
        size: 1.8 + Math.random() * 2.8,
        color,
      });
    }
  }

  // ── 지그재그 경로 ──
  private makeZigzag(x0: number, y0: number, x1: number, y1: number): Array<{ x: number; y: number }> {
    const dx = x1 - x0, dy = y1 - y0;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 2) return [{ x: x0, y: y0 }, { x: x1, y: y1 }];
    const segs = Math.max(5, Math.floor(dist / 14));
    const jitter = dist * 0.16;
    const px = -dy / dist, py = dx / dist;
    const pts: Array<{ x: number; y: number }> = [{ x: x0, y: y0 }];
    for (let i = 1; i < segs; i++) {
      const t = i / segs;
      const j = (Math.random() - 0.5) * jitter;
      pts.push({ x: x0 + dx * t + px * j, y: y0 + dy * t + py * j });
    }
    pts.push({ x: x1, y: y1 });
    return pts;
  }

  // ── 그리기 ──
  private draw() {
    this.gfx.clear();
    this.glowGfx.clear();
    this.gfx.lineStyle(0);
    this.glowGfx.lineStyle(0);

    const camX = this.posX - this.screenX;
    const camY = this.posY - this.screenY;

    for (const m of this.meteors) {
      const tone = TONES[m.toneIdx];
      const tsx = m.targetX - camX;
      const tsy = m.targetY - camY;

      if (m.phase === 0) {
        // ── FALLING: 트레일 + 운석 본체 ──
        const t = m.timer / FALL_FRAMES;
        const easeT = t * t; // ease-in
        const ox = m.startOX * (1 - easeT);
        const oy = m.startOY * (1 - easeT);
        const mx = tsx + ox;
        const my = tsy + oy;
        const sz = m.size * (0.5 + easeT * 0.5);

        // 트레일 (6세그먼트, 시작→현재)
        for (let si = 0; si < TRAIL_SEGS; si++) {
          const st = si / TRAIL_SEGS;
          const nt = (si + 1) / TRAIL_SEGS;
          const sx0 = tsx + m.startOX * (1 - st * easeT);
          const sy0 = tsy + m.startOY * (1 - st * easeT);
          const sx1 = tsx + m.startOX * (1 - nt * easeT);
          const sy1 = tsy + m.startOY * (1 - nt * easeT);
          const segAlpha = ((si + 1) / TRAIL_SEGS);

          // 불 글로우 (외곽)
          this.glowGfx.lineStyle(5, tone.inner, segAlpha * 0.45);
          this.glowGfx.moveTo(sx0, sy0);
          this.glowGfx.lineTo(sx1, sy1);
          // 흙 중간
          this.gfx.lineStyle(3, tone.outer, segAlpha * 0.75);
          this.gfx.moveTo(sx0, sy0);
          this.gfx.lineTo(sx1, sy1);
          // 밝은 코어
          this.gfx.lineStyle(1.4, COL_FIRE4, segAlpha * 0.9);
          this.gfx.moveTo(sx0, sy0);
          this.gfx.lineTo(sx1, sy1);
        }
        this.gfx.lineStyle(0);
        this.glowGfx.lineStyle(0);

        // 운석 본체 (3겹 원 — 심플, 폴리곤 금지 원칙)
        // 외곽
        this.gfx.beginFill(tone.outer, 0.9);
        this.gfx.drawCircle(mx, my, sz);
        this.gfx.endFill();
        // 내부 (불색)
        this.gfx.beginFill(tone.inner, 0.9);
        this.gfx.drawCircle(mx, my, sz * 0.65);
        this.gfx.endFill();
        // 코어 (밝은)
        this.gfx.beginFill(COL_FIRE4, 0.85);
        this.gfx.drawCircle(mx, my, sz * 0.3);
        this.gfx.endFill();
        // 글로우 (2겹, 더 화려)
        this.glowGfx.beginFill(tone.inner, 0.2);
        this.glowGfx.drawCircle(mx, my, sz * 2.8);
        this.glowGfx.endFill();
        this.glowGfx.beginFill(COL_FIRE4, 0.3);
        this.glowGfx.drawCircle(mx, my, sz * 1.6);
        this.glowGfx.endFill();
      } else {
        // ── IMPACT: 충격파 + 파티클 ──
        const sp = m.shockProgress;
        if (sp < 1) {
          const shockR = IMPACT_RADIUS * (0.4 + sp * 0.6);
          const fade = (1 - sp) * (1 - sp);
          // 4겹 충격파 (불+전기 색, 두껍게)
          this.gfx.lineStyle(8, COL_SHOCK_OUTER, fade * 0.65);
          this.gfx.drawCircle(tsx, tsy, shockR);
          this.gfx.lineStyle(5, COL_SHOCK_MID, fade * 0.7);
          this.gfx.drawCircle(tsx, tsy, shockR * 0.85);
          this.gfx.lineStyle(3, COL_SHOCK_INNER, fade * 0.6);
          this.gfx.drawCircle(tsx, tsy, shockR * 0.7);
          this.gfx.lineStyle(1.8, COL_SHOCK_CORE, fade * 0.8);
          this.gfx.drawCircle(tsx, tsy, shockR * 0.55);
          // ADD 글로우 링
          this.glowGfx.lineStyle(10, COL_SHOCK_MID, fade * 0.2);
          this.glowGfx.drawCircle(tsx, tsy, shockR);
          this.gfx.lineStyle(0);
        }

        // 파티클
        for (const p of m.burstParticles) {
          const lt = p.life / p.maxLife;
          const alpha = lt < 0.1 ? lt / 0.1 : (1 - lt);
          if (alpha < 0.02) continue;
          const px = tsx + p.x;
          const py = tsy + p.y;
          this.glowGfx.beginFill(p.color, alpha * 0.3);
          this.glowGfx.drawCircle(px, py, p.size * 1.8);
          this.glowGfx.endFill();
          this.gfx.beginFill(p.color, alpha * 0.85);
          this.gfx.drawCircle(px, py, p.size);
          this.gfx.endFill();
        }
      }
    }

    // ── 전기 체인 (깨작거리는 지그재그, 매 프레임 재생성) ──
    for (const c of this.chainLinks) {
      const lifeT = c.life / c.maxLife;
      const flicker = 0.7 + Math.random() * 0.3;
      const a = lifeT * flicker;
      if (a < 0.02) continue;

      const sx0 = c.fromX - camX, sy0 = c.fromY - camY;
      const sx1 = c.toX - camX, sy1 = c.toY - camY;
      const pts = this.makeZigzag(sx0, sy0, sx1, sy1);
      if (pts.length < 2) continue;

      const drawPath = (gfx: PIXI.Graphics, w: number, color: number, alpha: number) => {
        gfx.lineStyle(w, color, alpha);
        gfx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) gfx.lineTo(pts[i].x, pts[i].y);
        gfx.lineStyle(0);
      };

      // 4패스: 불+흙 → 불+전기 → 전기 → 코어
      drawPath(this.glowGfx, 14, COL_CHAIN1, a * 0.25);
      drawPath(this.glowGfx, 9, COL_CHAIN2, a * 0.38);
      drawPath(this.gfx, 4, COL_CHAIN3, a * 0.82);
      drawPath(this.gfx, 1.6, COL_CHAIN4, a * 0.95);

      // 착탄점 글로우
      this.glowGfx.beginFill(COL_CHAIN3, a * 0.35);
      this.glowGfx.drawCircle(sx1, sy1, 7);
      this.glowGfx.endFill();
    }
  }

  stop() {
    this.active = false;
    this.meteors = [];
    this.chainLinks = [];
    this._impacts = [];
    this.gfx.clear();
    this.glowGfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
