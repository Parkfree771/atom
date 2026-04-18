import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 물+흙+불 3단계 — 원소 유성우 (Elemental Meteor Storm)
 *
 * 화산뇌(흙+불+전기) 동일 구조: 45° 대각선 연속 운석.
 * 불 유성 → 마그마 장판 (지속 뎀), 물 유성 → 파동 넉백.
 * 흙은 공통 베이스.
 *
 * 운석 3종 (순환: 불→흙→물→불→...):
 *   FIRE  — 갈색+빨강, 폭발 + 마그마 장판 (DoT)
 *   EARTH — 갈색+앰버, 폭발 + 정지 장판 (스턴)
 *   WATER — 갈색+파랑, 폭발 + 소용돌이 장판 (흡인)
 *
 * 장판은 적당 간격으로 (운석 3발 중 1발만 장판)
 */

// ── 스폰 ──
const SPAWN_INTERVAL = 6;
const SPAWN_RADIUS_MIN = 40;
const SPAWN_RADIUS_MAX = 280;
const FALL_FRAMES = 22;
const IMPACT_FRAMES = 12;
const START_OFFSET = 130;

// ── 운석 크기 ──
const METEOR_SIZE_MIN = 6;
const METEOR_SIZE_MAX = 13;

// ── 착탄 ──
const IMPACT_RADIUS = 60;
const BURST_COUNT = 32;

// ── 장판 공통 ──
const PUDDLE_RADIUS = 45;
const PUDDLE_LIFE = 150;
const PUDDLE_MAX = 5; // 동시 최대 장판 수 (종류 합산)

// ── 파동 (물 유성 착탄 이펙트) ──
const WAVE_MAX_R = 90;
const WAVE_LIFE = 16;

// ── 불 유성 색 ──
const FIRE_TONES = [
  { outer: 0x78520a, inner: 0xef4444 },
  { outer: 0x5c3d08, inner: 0xf97316 },
  { outer: 0xa16207, inner: 0xdc2626 },
  { outer: 0x3a1a0a, inner: 0xea580c },
];
const COL_MAGMA1 = 0xb91c1c;  // red-700 (장판 외곽)
const COL_MAGMA2 = 0xef4444;  // red-500
const COL_MAGMA3 = 0xf97316;  // orange-500
const COL_MAGMA4 = 0xfbbf24;  // amber-400

// ── 흙 유성 색 ──
const EARTH_TONES = [
  { outer: 0x5c3d08, inner: 0xa16207 },
  { outer: 0x78520a, inner: 0xd4a53c },
  { outer: 0x3a1a0a, inner: 0xb8860b },
  { outer: 0x2d1a04, inner: 0x78520a },
];
const COL_STUN1 = 0x78520a;   // amber-700 (장판 외곽)
const COL_STUN2 = 0xa16207;   // amber
const COL_STUN3 = 0xd4a53c;   // sand
const COL_STUN4 = 0xe8c882;   // light sand

// ── 물 유성 색 ──
const WATER_TONES = [
  { outer: 0x78520a, inner: 0x2563eb },
  { outer: 0x5c3d08, inner: 0x3b82f6 },
  { outer: 0xa16207, inner: 0x1d4ed8 },
  { outer: 0x3a1a0a, inner: 0x1e40af },
];
const COL_VORTEX1 = 0x1e40af;  // blue-800 (장판 외곽)
const COL_VORTEX2 = 0x2563eb;  // blue-600
const COL_VORTEX3 = 0x3b82f6;  // blue-500
const COL_VORTEX4 = 0x60a5fa;  // blue-400

// 파동 (물 착탄 이펙트)
const COL_WAVE1 = 0x1d4ed8;
const COL_WAVE2 = 0x3b82f6;
const COL_WAVE3 = 0x60a5fa;
const COL_WAVE4 = 0x93c5fd;

// ── 공통 흙 색 ──
const COL_EARTH1 = 0x78520a;
const COL_EARTH2 = 0xa16207;
const COL_EARTH3 = 0xd4a53c;

// ── 타입 ──
const TYPE_FIRE = 0;
const TYPE_EARTH = 1;
const TYPE_WATER = 2;

interface Meteor {
  targetX: number; targetY: number;
  startOX: number; startOY: number;
  timer: number;
  phase: number; // 0=FALLING, 1=IMPACT
  size: number;
  toneIdx: number;
  meteorType: number; // TYPE_FIRE or TYPE_WATER
  burstParticles: BurstP[];
  shockProgress: number;
  impactFired: boolean;
}

interface BurstP {
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number; color: number;
}

interface Puddle {
  x: number; y: number; // 월드
  life: number;
  maxLife: number;
  type: number; // TYPE_FIRE=마그마, TYPE_EARTH=정지, TYPE_WATER=소용돌이
}

interface WaveRing {
  x: number; y: number;
  r: number;
  life: number;
}

export class WaterEarthFireEffect {
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
  private puddles: Puddle[] = [];
  private waveRings: WaveRing[] = [];
  private spawnCycle = 0; // 0=불, 1=흙, 2=물 순환

  // 엔진 통신
  private _impacts: { x: number; y: number; type: number }[] = [];

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
    this.time = 0; this.spawnTimer = 0; this.spawnCycle = 0;
    this.meteors = []; this.puddles = []; this.waveRings = [];
    this._impacts = [];
  }

  // 엔진 쿼리
  impactsThisFrame(): { x: number; y: number; type: number }[] { return this._impacts; }
  impactRadius(): number { return IMPACT_RADIUS; }
  /** 활성 장판 (타입별 — 엔진 DoT/스턴/흡인용) */
  activePuddles(): { x: number; y: number; radius: number; type: number }[] {
    return this.puddles.map(p => ({ x: p.x, y: p.y, radius: PUDDLE_RADIUS, type: p.type }));
  }
  waveKnockbackRadius(): number { return WAVE_MAX_R; }

  update(dt: number, cameraX: number, cameraY: number) {
    if (!this.active) return;
    this.time += dt;
    this.screenX = this.posX - cameraX;
    this.screenY = this.posY - cameraY;
    this._impacts = [];

    // 스폰
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
        if (m.timer >= FALL_FRAMES) {
          m.phase = 1; m.timer = 0; m.impactFired = true;
          this.spawnBurst(m);
          this._impacts.push({ x: m.targetX, y: m.targetY, type: m.meteorType });
          // 장판 생성 (동시 최대 제한)
          if (this.puddles.length < PUDDLE_MAX) {
            this.puddles.push({
              x: m.targetX, y: m.targetY,
              life: 0, maxLife: PUDDLE_LIFE,
              type: m.meteorType,
            });
          }
          // 물 유성은 추가 파동 링
          if (m.meteorType === TYPE_WATER) {
            this.waveRings.push({ x: m.targetX, y: m.targetY, r: 10, life: 0 });
          }
        }
      } else {
        m.shockProgress = m.timer / IMPACT_FRAMES;
        for (let j = m.burstParticles.length - 1; j >= 0; j--) {
          const p = m.burstParticles[j];
          p.life += dt; p.x += p.vx * dt; p.y += p.vy * dt;
          p.vx *= 0.92; p.vy *= 0.92;
          if (p.life >= p.maxLife) swapPop(m.burstParticles, j);
        }
        if (m.timer >= IMPACT_FRAMES && m.burstParticles.length === 0) {
          swapPop(this.meteors, i);
        }
      }
    }

    // 장판 업데이트
    for (let i = this.puddles.length - 1; i >= 0; i--) {
      this.puddles[i].life += dt;
      if (this.puddles[i].life >= this.puddles[i].maxLife) swapPop(this.puddles, i);
    }

    // 파동 링 업데이트
    for (let i = this.waveRings.length - 1; i >= 0; i--) {
      const w = this.waveRings[i];
      w.life += dt;
      w.r = 10 + (WAVE_MAX_R - 10) * (w.life / WAVE_LIFE);
      if (w.life >= WAVE_LIFE) swapPop(this.waveRings, i);
    }

    this.draw();
  }

  private spawnMeteor() {
    const angle = Math.random() * Math.PI * 2;
    const dist = SPAWN_RADIUS_MIN + Math.random() * (SPAWN_RADIUS_MAX - SPAWN_RADIUS_MIN);
    const mType = this.spawnCycle;
    this.spawnCycle = (this.spawnCycle + 1) % 3;
    this.meteors.push({
      targetX: this.posX + Math.cos(angle) * dist,
      targetY: this.posY + Math.sin(angle) * dist,
      startOX: START_OFFSET * (0.85 + Math.random() * 0.3),
      startOY: -START_OFFSET * (0.85 + Math.random() * 0.3),
      timer: 0, phase: 0,
      size: METEOR_SIZE_MIN + Math.random() * (METEOR_SIZE_MAX - METEOR_SIZE_MIN),
      toneIdx: Math.floor(Math.random() * 4),
      meteorType: mType,
      burstParticles: [],
      shockProgress: 0, impactFired: false,
    });
  }

  private spawnBurst(m: Meteor) {
    const mainColors = m.meteorType === TYPE_FIRE
      ? [COL_MAGMA2, COL_MAGMA3, COL_MAGMA4]
      : m.meteorType === TYPE_EARTH
      ? [COL_STUN2, COL_STUN3, COL_STUN4]
      : [COL_VORTEX2, COL_VORTEX3, COL_VORTEX4];
    const earthColors = [COL_EARTH1, COL_EARTH2, COL_EARTH3];

    for (let i = 0; i < BURST_COUNT; i++) {
      const a = Math.random() * Math.PI * 2;
      const spd = 4 + Math.random() * 7;
      const r = Math.random();
      const color = r < 0.6
        ? mainColors[Math.floor(Math.random() * mainColors.length)]
        : earthColors[Math.floor(Math.random() * earthColors.length)];
      m.burstParticles.push({
        x: 0, y: 0,
        vx: Math.cos(a) * spd, vy: Math.sin(a) * spd,
        life: 0, maxLife: 18 + Math.random() * 22,
        size: 1.8 + Math.random() * 2.8, color,
      });
    }
  }

  private draw() {
    this.gfx.clear();
    this.glowGfx.clear();
    this.gfx.lineStyle(0);
    this.glowGfx.lineStyle(0);

    const camX = this.posX - this.screenX;
    const camY = this.posY - this.screenY;

    // ── 1. 장판 3종 ──
    for (const p of this.puddles) {
      const psx = p.x - camX, psy = p.y - camY;
      const lt = p.life / p.maxLife;
      const alpha = lt < 0.1 ? lt / 0.1 : (lt > 0.75 ? (1 - lt) / 0.25 : 1);
      const pulse = 0.85 + Math.sin(this.time * 0.06 + p.x * 0.01) * 0.15;
      const r = PUDDLE_RADIUS * pulse;

      if (p.type === TYPE_FIRE) {
        // 마그마 장판 (DoT)
        this.gfx.beginFill(COL_MAGMA1, alpha * 0.5);
        this.gfx.drawCircle(psx, psy, r);
        this.gfx.endFill();
        this.gfx.beginFill(COL_MAGMA2, alpha * 0.4);
        this.gfx.drawCircle(psx, psy, r * 0.7);
        this.gfx.endFill();
        this.gfx.beginFill(COL_MAGMA3, alpha * 0.35);
        this.gfx.drawCircle(psx, psy, r * 0.4);
        this.gfx.endFill();
        this.glowGfx.beginFill(COL_MAGMA3, alpha * 0.15);
        this.glowGfx.drawCircle(psx, psy, r * 1.3);
        this.glowGfx.endFill();
      } else if (p.type === TYPE_EARTH) {
        // 정지 장판 (스턴) — 모래색, 균열 느낌
        this.gfx.beginFill(COL_STUN1, alpha * 0.45);
        this.gfx.drawCircle(psx, psy, r);
        this.gfx.endFill();
        this.gfx.beginFill(COL_STUN2, alpha * 0.35);
        this.gfx.drawCircle(psx, psy, r * 0.65);
        this.gfx.endFill();
        this.gfx.beginFill(COL_STUN3, alpha * 0.3);
        this.gfx.drawCircle(psx, psy, r * 0.35);
        this.gfx.endFill();
        // 정지 표시: 얇은 십자
        const crossR = r * 0.8;
        this.gfx.lineStyle(1.5, COL_STUN4, alpha * 0.4);
        this.gfx.moveTo(psx - crossR, psy); this.gfx.lineTo(psx + crossR, psy);
        this.gfx.moveTo(psx, psy - crossR); this.gfx.lineTo(psx, psy + crossR);
        this.gfx.lineStyle(0);
      } else {
        // 소용돌이 장판 (흡인) — 파란색, 회전 링
        this.gfx.beginFill(COL_VORTEX1, alpha * 0.4);
        this.gfx.drawCircle(psx, psy, r);
        this.gfx.endFill();
        this.gfx.beginFill(COL_VORTEX2, alpha * 0.35);
        this.gfx.drawCircle(psx, psy, r * 0.6);
        this.gfx.endFill();
        // 회전 링 (소용돌이 느낌)
        const ringAngle = this.time * 0.04 + p.x * 0.1;
        for (let ri = 0; ri < 2; ri++) {
          const rr = r * (0.5 + ri * 0.3);
          this.gfx.lineStyle(1.2, COL_VORTEX3, alpha * 0.4);
          this.gfx.arc(psx, psy, rr, ringAngle + ri * 1.5, ringAngle + ri * 1.5 + Math.PI * 1.2);
          this.gfx.lineStyle(0);
        }
        this.glowGfx.beginFill(COL_VORTEX3, alpha * 0.12);
        this.glowGfx.drawCircle(psx, psy, r * 1.2);
        this.glowGfx.endFill();
      }
    }

    // ── 2. 운석 ──
    for (const m of this.meteors) {
      const tones = m.meteorType === TYPE_FIRE ? FIRE_TONES
        : m.meteorType === TYPE_EARTH ? EARTH_TONES : WATER_TONES;
      const tone = tones[m.toneIdx];
      const tsx = m.targetX - camX, tsy = m.targetY - camY;
      const coreColor = m.meteorType === TYPE_FIRE ? COL_MAGMA4
        : m.meteorType === TYPE_EARTH ? COL_STUN4 : COL_WAVE4;

      if (m.phase === 0) {
        const t = m.timer / FALL_FRAMES;
        const easeT = t * t;
        const ox = m.startOX * (1 - easeT);
        const oy = m.startOY * (1 - easeT);
        const mx = tsx + ox, my = tsy + oy;
        const sz = m.size * (0.5 + easeT * 0.5);

        // 트레일
        for (let si = 0; si < 6; si++) {
          const st = si / 6, nt = (si + 1) / 6;
          const sx0 = tsx + m.startOX * (1 - st * easeT);
          const sy0 = tsy + m.startOY * (1 - st * easeT);
          const sx1 = tsx + m.startOX * (1 - nt * easeT);
          const sy1 = tsy + m.startOY * (1 - nt * easeT);
          const segA = (si + 1) / 6;

          this.glowGfx.lineStyle(5, tone.inner, segA * 0.45);
          this.glowGfx.moveTo(sx0, sy0); this.glowGfx.lineTo(sx1, sy1);
          this.gfx.lineStyle(3, tone.outer, segA * 0.75);
          this.gfx.moveTo(sx0, sy0); this.gfx.lineTo(sx1, sy1);
          this.gfx.lineStyle(1.4, coreColor, segA * 0.9);
          this.gfx.moveTo(sx0, sy0); this.gfx.lineTo(sx1, sy1);
        }
        this.gfx.lineStyle(0); this.glowGfx.lineStyle(0);

        // 본체
        this.gfx.beginFill(tone.outer, 0.9);
        this.gfx.drawCircle(mx, my, sz);
        this.gfx.endFill();
        this.gfx.beginFill(tone.inner, 0.9);
        this.gfx.drawCircle(mx, my, sz * 0.65);
        this.gfx.endFill();
        this.gfx.beginFill(coreColor, 0.85);
        this.gfx.drawCircle(mx, my, sz * 0.3);
        this.gfx.endFill();
        this.glowGfx.beginFill(tone.inner, 0.2);
        this.glowGfx.drawCircle(mx, my, sz * 2.8);
        this.glowGfx.endFill();
        this.glowGfx.beginFill(coreColor, 0.3);
        this.glowGfx.drawCircle(mx, my, sz * 1.6);
        this.glowGfx.endFill();
      } else {
        // 충격파 (불=주황, 물=파랑)
        const sp = m.shockProgress;
        if (sp < 1) {
          const shockR = IMPACT_RADIUS * (0.4 + sp * 0.6);
          const fade = (1 - sp) * (1 - sp);
          const shockOuter = m.meteorType === TYPE_FIRE ? COL_MAGMA1
            : m.meteorType === TYPE_EARTH ? COL_STUN1 : COL_WAVE1;
          const shockInner = m.meteorType === TYPE_FIRE ? COL_MAGMA3
            : m.meteorType === TYPE_EARTH ? COL_STUN3 : COL_WAVE3;
          this.gfx.lineStyle(8, shockOuter, fade * 0.65);
          this.gfx.drawCircle(tsx, tsy, shockR);
          this.gfx.lineStyle(4, shockInner, fade * 0.7);
          this.gfx.drawCircle(tsx, tsy, shockR * 0.8);
          this.glowGfx.lineStyle(10, tone.inner, fade * 0.2);
          this.glowGfx.drawCircle(tsx, tsy, shockR);
          this.gfx.lineStyle(0); this.glowGfx.lineStyle(0);
        }

        // 파티클
        for (const bp of m.burstParticles) {
          const lt = bp.life / bp.maxLife;
          const alpha = lt < 0.1 ? lt / 0.1 : (1 - lt);
          if (alpha < 0.02) continue;
          const px = tsx + bp.x, py = tsy + bp.y;
          this.glowGfx.beginFill(bp.color, alpha * 0.3);
          this.glowGfx.drawCircle(px, py, bp.size * 1.8);
          this.glowGfx.endFill();
          this.gfx.beginFill(bp.color, alpha * 0.85);
          this.gfx.drawCircle(px, py, bp.size);
          this.gfx.endFill();
        }
      }
    }

    // ── 3. 물 파동 링 ──
    for (const w of this.waveRings) {
      const sx = w.x - camX, sy = w.y - camY;
      const lt = w.life / WAVE_LIFE;
      const fade = (1 - lt) * (1 - lt);
      // 3겹 파동
      this.gfx.lineStyle(5, COL_WAVE1, fade * 0.6);
      this.gfx.drawCircle(sx, sy, w.r);
      this.gfx.lineStyle(3, COL_WAVE2, fade * 0.7);
      this.gfx.drawCircle(sx, sy, w.r * 0.88);
      this.gfx.lineStyle(1.5, COL_WAVE4, fade * 0.5);
      this.gfx.drawCircle(sx, sy, w.r * 0.76);
      this.glowGfx.lineStyle(8, COL_WAVE3, fade * 0.15);
      this.glowGfx.drawCircle(sx, sy, w.r);
      this.gfx.lineStyle(0); this.glowGfx.lineStyle(0);
    }
  }

  stop() {
    this.active = false;
    this.meteors = []; this.puddles = []; this.waveRings = [];
    this._impacts = [];
    this.gfx.clear(); this.glowGfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
