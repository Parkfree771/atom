import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 흙+빛+암흑 3단계 — 천지섬광 (Earth Flash)
 *
 * 캐릭터 시전 위치에 고정. 캐릭터는 자유 이동.
 *
 * 4페이즈:
 *   1. SPREAD (35f)   — 흙 입자 쫙 퍼짐 + 광자 수렴 시작
 *   2. CONVERGE (50f)  — 블랙홀 등장, 흙+몬스터 빨아들임, 광자 급격히 수렴
 *   3. FLASH (30f)     — 섬광 폭발! 거대 피해 + 넉백 + 셀 비산
 *   4. COOLDOWN (80f)  — 쉼 → 다음 사이클 (새 캐릭터 위치)
 *
 * 좌표계: overlayLayer (스크린 좌표). 앵커(시전 위치)는 월드 좌표 고정.
 */

// ── 페이즈 ──
const PHASE_SPREAD = 0;
const PHASE_CONVERGE = 1;
const PHASE_FLASH = 2;
const PHASE_COOLDOWN = 3;

const P_SPREAD = 100;
const P_CONVERGE = 85;
const P_FLASH = 30;
const P_COOLDOWN = 80;

// ── 상수 ──
const EARTH_COUNT = 150;
const SPREAD_RADIUS = 420;
const PHOTON_MAX = 130;
const PHOTON_CONVERGE_Y = -200; // 빛 수렴점 — 훨씬 위 (천장)
const BLACKHOLE_MAX_R = 34;

// ── 데미지 (엔진 참조) ──
const CONVERGE_RANGE = 400;
const FLASH_RADIUS = 350;
const FLASH_DAMAGE = 90;
const FLASH_KNOCKBACK = 35;

// ── Sprite 풀 (섬광 셀) ──
const POOL_SIZE = 350;
const FLASH_CELL_COUNT = 250;
const CIRCLE_TEX_R = 8;

// ── 색상 ──
// 흙
const COL_EARTH1 = 0xa16207; // amber-700
const COL_EARTH2 = 0x78520a; // stone
const COL_EARTH3 = 0xd4a53c; // sand
const COL_EARTH4 = 0xb8860b; // goldenrod
const COL_EARTH5 = 0x57534e; // stone-600
// 빛
const COL_L100 = 0xfef9c3;   // yellow-100 (cream)
const COL_L200 = 0xfef08a;   // yellow-200
const COL_L300 = 0xfde047;   // yellow-300
const COL_L500 = 0xeab308;   // yellow-500
const COL_A500 = 0xf59e0b;   // amber-500
// 암흑
const COL_I950 = 0x1e1b4b;   // indigo-950
const COL_V700 = 0x6d28d9;   // violet-700
const COL_V500 = 0x8b5cf6;   // violet-500
const COL_V400 = 0xa78bfa;   // violet-400

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
interface EarthParticle {
  x: number; y: number;       // 앵커 기준 상대 좌표
  vx: number; vy: number;
  outAngle: number;           // 퍼진 각도 (복귀용)
  outDist: number;            // 퍼진 거리 (복귀용)
  size: number;
  color: number;
}

interface Photon {
  x: number; y: number;       // 앵커 기준 상대 좌표
  targetX: number; targetY: number;
  speed: number;
  size: number;
  life: number;
  maxLife: number;
  color: number;
}

interface FlashCell {
  x: number; y: number;       // 앵커 기준
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
  color: number;
}

export class EarthLightDarkEffect {
  private container: PIXI.Container;
  private gfx: PIXI.Graphics;
  private glowGfx: PIXI.Graphics;

  // Sprite 풀 (섬광 셀)
  private flashCoreSprites: PIXI.Sprite[] = [];
  private flashGlowSprites: PIXI.Sprite[] = [];

  active = false;
  // 앵커 (시전 위치, 월드 좌표) — 캐릭터 따라다니지 않음
  anchorX = 0;
  anchorY = 0;
  private screenX = 0;
  private screenY = 0;
  private time = 0;
  private phase = PHASE_COOLDOWN;
  private phaseTimer = 0;

  // 흙 입자
  private earthParticles: EarthParticle[] = [];
  // 광자
  private photons: Photon[] = [];
  // 섬광 셀
  private flashCells: FlashCell[] = [];
  // 충격파
  private shockwaveR = 0;
  private shockwaveAlpha = 0;

  // 블랙홀 반경
  private blackholeR = 0;
  // 빛 수렴 강도 (0→1)
  private lightIntensity = 0;

  // 엔진 통신
  flashFiredThisFrame = false;
  private _isConverging = false;
  private _convergeLerp = 0;

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
      this.flashGlowSprites.push(glow);

      const core = new PIXI.Sprite(tex);
      core.anchor.set(0.5);
      core.visible = false;
      this.container.addChild(core);
      this.flashCoreSprites.push(core);
    }
  }

  start(x: number, y: number) {
    this.active = true;
    this.anchorX = x;
    this.anchorY = y;
    this.time = 0;
    this.phase = PHASE_SPREAD;
    this.phaseTimer = 0;
    this.earthParticles = [];
    this.photons = [];
    this.flashCells = [];
    this.shockwaveR = 0;
    this.shockwaveAlpha = 0;
    this.blackholeR = 0;
    this.lightIntensity = 0;
    this.flashFiredThisFrame = false;
    this._isConverging = false;
    this._convergeLerp = 0;

    this.spawnEarthParticles();
  }

  // ── 흙 입자 스폰 (퍼지는 방향으로) ──
  private spawnEarthParticles() {
    const colors = [COL_EARTH1, COL_EARTH2, COL_EARTH3, COL_EARTH4, COL_EARTH5];
    for (let i = 0; i < EARTH_COUNT; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = SPREAD_RADIUS * (0.5 + Math.random() * 0.5);
      const speed = 2 + Math.random() * 3.5;
      this.earthParticles.push({
        x: 0, y: 0,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        outAngle: angle,
        outDist: dist,
        size: 1.8 + Math.random() * 2.5,
        color: colors[Math.floor(Math.random() * colors.length)],
      });
    }
  }

  // ── 수렴 입자 스폰 (빛+암흑+흙 3색 혼합, 빅뱅 패턴) ──
  private spawnPhoton() {
    const colors = [
      // 빛 40%
      COL_L300, COL_L500, COL_A500, COL_L300,
      // 암흑 30%
      COL_V500, COL_V700, COL_V400,
      // 흙 30%
      COL_EARTH1, COL_EARTH3, COL_EARTH4,
    ];
    const spawnAngle = Math.random() * Math.PI * 2;
    const spawnR = 160 + Math.random() * 200;
    this.photons.push({
      x: Math.cos(spawnAngle) * spawnR,
      y: Math.sin(spawnAngle) * spawnR + PHOTON_CONVERGE_Y,
      targetX: 0,
      targetY: PHOTON_CONVERGE_Y,
      speed: 1.2 + Math.random() * 2.0,
      size: 1.6 + Math.random() * 2.2,
      life: 0,
      maxLife: 50 + Math.random() * 40,
      color: colors[Math.floor(Math.random() * colors.length)],
    });
  }

  // ── 섬광 셀 스폰 ──
  private spawnFlashCells() {
    const lightColors = [COL_L100, COL_L200, COL_L300, COL_L500, COL_A500];
    const darkColors = [COL_V700, COL_V500, COL_I950];
    const earthColors = [COL_EARTH1, COL_EARTH3, COL_EARTH4];

    for (let i = 0; i < FLASH_CELL_COUNT; i++) {
      const r = Math.random();
      let color: number;
      if (r < 0.45) color = lightColors[Math.floor(Math.random() * lightColors.length)];
      else if (r < 0.72) color = darkColors[Math.floor(Math.random() * darkColors.length)];
      else color = earthColors[Math.floor(Math.random() * earthColors.length)];

      const angle = Math.random() * Math.PI * 2;
      const speed = 8 + Math.random() * 18;
      this.flashCells.push({
        x: (Math.random() - 0.5) * 10,
        y: (Math.random() - 0.5) * 10,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        maxLife: 22 + Math.random() * 30,
        size: 3 + Math.random() * 5,
        color,
      });
    }
  }

  update(dt: number, cameraX: number, cameraY: number) {
    if (!this.active) return;
    this.time += dt;
    this.phaseTimer += dt;
    this.flashFiredThisFrame = false;
    this.screenX = this.anchorX - cameraX;
    this.screenY = this.anchorY - cameraY;

    switch (this.phase) {
      case PHASE_SPREAD: {
        const t = this.phaseTimer / P_SPREAD;
        this._isConverging = false;
        this._convergeLerp = 0;

        // 흙 입자 퍼짐 (느린 감속 — 멀리 퍼짐)
        for (const ep of this.earthParticles) {
          ep.x += ep.vx * dt;
          ep.y += ep.vy * dt;
          ep.vx *= 0.985;
          ep.vy *= 0.985;
        }

        // 광자 강하게 스폰 (처음부터 과하게)
        this.lightIntensity = 0.15 + t * 0.45;
        const photonRate = 0.5 + t * 0.5;
        if (this.photons.length < PHOTON_MAX * 0.7) {
          const spawnCount = Math.random() < photonRate ? (Math.random() < 0.3 ? 2 : 1) : 0;
          for (let si = 0; si < spawnCount; si++) this.spawnPhoton();
        }

        if (this.phaseTimer >= P_SPREAD) {
          this.phase = PHASE_CONVERGE;
          this.phaseTimer = 0;
        }
        break;
      }
      case PHASE_CONVERGE: {
        const t = this.phaseTimer / P_CONVERGE;
        this._isConverging = true;
        this._convergeLerp = 0.012 + t * 0.04;

        // 블랙홀 서서히 성장
        this.blackholeR = BLACKHOLE_MAX_R * Math.min(1, t * 1.2);

        // 흙 입자 → 블랙홀 중심으로 확실히 흡입 (나선)
        for (const ep of this.earthParticles) {
          const dx = -ep.x;
          const dy = -ep.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          // 중심 방향 lerp (점점 강해짐, 확실히 중심으로 감)
          const lerpPull = 0.015 + t * t * 0.06;
          ep.x += dx * lerpPull;
          ep.y += dy * lerpPull;
          // 나선 회전 (접선 방향)
          const perpX = -dy / dist;
          const perpY = dx / dist;
          const spin = 0.8 + t * 1.2;
          ep.x += perpX * spin * dt;
          ep.y += perpY * spin * dt;
        }

        // 광자 과하게 수렴 — 점점 폭발적으로 모임
        this.lightIntensity = 0.5 + t * 0.5;
        const photonRate2 = 0.6 + t * 0.4;
        if (this.photons.length < PHOTON_MAX) {
          const spawnN = Math.random() < photonRate2 ? (Math.random() < 0.4 + t * 0.3 ? 3 : 2) : 1;
          for (let si = 0; si < spawnN; si++) this.spawnPhoton();
        }

        if (this.phaseTimer >= P_CONVERGE) {
          this.phase = PHASE_FLASH;
          this.phaseTimer = 0;
          this.flashFiredThisFrame = true;
          this.spawnFlashCells();
          this.shockwaveR = 15;
          this.shockwaveAlpha = 1.0;
          this.earthParticles = [];
          this.photons = [];
          this._isConverging = false;
        }
        break;
      }
      case PHASE_FLASH: {
        const t = this.phaseTimer / P_FLASH;
        this.blackholeR = BLACKHOLE_MAX_R * Math.max(0, 1 - t * 2);
        this.lightIntensity = Math.max(0, 1 - t);

        // 충격파 확장
        this.shockwaveR = 15 + (FLASH_RADIUS + 40) * t;
        this.shockwaveAlpha = (1 - t) * (1 - t);

        if (this.phaseTimer >= P_FLASH) {
          this.phase = PHASE_COOLDOWN;
          this.phaseTimer = 0;
        }
        break;
      }
      case PHASE_COOLDOWN: {
        this.blackholeR = 0;
        this.lightIntensity = 0;
        this._isConverging = false;
        if (this.phaseTimer >= P_COOLDOWN) {
          this.stop();
          return;
        }
        break;
      }
    }

    // 광자 업데이트
    for (let i = this.photons.length - 1; i >= 0; i--) {
      const p = this.photons[i];
      p.life += dt;
      const dx = p.targetX - p.x;
      const dy = p.targetY - p.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const accel = 1 + this.lightIntensity * 3; // 강도 높을수록 빠르게 수렴
      p.x += (dx / dist) * p.speed * accel * dt;
      p.y += (dy / dist) * p.speed * accel * dt;
      if (dist < 5 || p.life >= p.maxLife) swapPop(this.photons, i);
    }

    // 섬광 셀 업데이트
    for (let i = this.flashCells.length - 1; i >= 0; i--) {
      const c = this.flashCells[i];
      c.life += dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.vx *= 0.96;
      c.vy *= 0.96;
      if (c.life >= c.maxLife) swapPop(this.flashCells, i);
    }

    this.draw();
  }

  // ── 그리기 ──
  private draw() {
    this.gfx.clear();
    this.glowGfx.clear();
    this.gfx.lineStyle(0);
    this.glowGfx.lineStyle(0);

    const sx = this.screenX;
    const sy = this.screenY;
    const isCooldown = this.phase === PHASE_COOLDOWN && this.flashCells.length === 0;
    if (isCooldown) {
      this.hideAllSprites();
      return;
    }

    // ── 1. 블랙홀 (CONVERGE ~ FLASH 초반) ──
    if (this.blackholeR > 1) {
      const bR = this.blackholeR;
      // 외곽 보라 글로우
      this.glowGfx.beginFill(COL_V500, 0.3);
      this.glowGfx.drawCircle(sx, sy, bR * 2.5);
      this.glowGfx.endFill();
      this.glowGfx.beginFill(COL_V700, 0.25);
      this.glowGfx.drawCircle(sx, sy, bR * 1.8);
      this.glowGfx.endFill();
      // 코어
      this.gfx.beginFill(COL_I950, 0.95);
      this.gfx.drawCircle(sx, sy, bR);
      this.gfx.endFill();
      this.gfx.beginFill(0x000008, 0.9);
      this.gfx.drawCircle(sx, sy, bR * 0.6);
      this.gfx.endFill();

      // 강착 링 (회전)
      for (let ri = 0; ri < 3; ri++) {
        const ringR = bR * (1.3 + ri * 0.4);
        const ringAlpha = 0.4 - ri * 0.1;
        const ringAngle = this.time * (0.05 - ri * 0.015);
        this.gfx.lineStyle(1.5, COL_V400, ringAlpha);
        this.gfx.drawCircle(sx, sy, ringR);
      }
      this.gfx.lineStyle(0);
    }

    // ── 2. 흙 입자 ──
    for (const ep of this.earthParticles) {
      const px = sx + ep.x;
      const py = sy + ep.y;
      this.gfx.beginFill(ep.color, 0.85);
      this.gfx.drawCircle(px, py, ep.size);
      this.gfx.endFill();
      // 블랙홀 근접 시 스트레치 효과 (ADD)
      const dist = Math.sqrt(ep.x * ep.x + ep.y * ep.y);
      if (dist < 60 && this.blackholeR > 5) {
        this.glowGfx.beginFill(COL_V500, 0.15);
        this.glowGfx.drawCircle(px, py, ep.size * 2);
        this.glowGfx.endFill();
      }
    }

    // ── 3. 빛 수렴 (광자 + 수렴점 글로우) ──
    const convX = sx;
    const convY = sy + PHOTON_CONVERGE_Y;

    // 수렴점 — 글로우 원 없음, 입자 밀도 자체로만 표현
    // (광자가 모이면서 자연스럽게 밝아짐)

    // 수렴 입자 (빅뱅 패턴: 중심 가까울수록 강조)
    for (const p of this.photons) {
      const px = sx + p.x;
      const py = sy + p.y;
      // 수렴점까지 거리
      const dx = p.x - p.targetX;
      const dy = p.y - p.targetY;
      const distToCenter = Math.sqrt(dx * dx + dy * dy);
      const maxDist = 360;
      const proximity = 1 - Math.min(1, distToCenter / maxDist);
      const alpha = 0.4 + proximity * 0.5;
      const sz = p.size * (0.8 + proximity * 0.5);

      // ADD 글로우 (작게)
      this.glowGfx.beginFill(p.color, alpha * 0.3);
      this.glowGfx.drawCircle(px, py, sz * 1.8);
      this.glowGfx.endFill();
      // NORMAL 코어
      this.gfx.beginFill(p.color, alpha);
      this.gfx.drawCircle(px, py, sz);
      this.gfx.endFill();
    }

    // ── 4. 섬광 — 수렴점(천장)에서 블랙홀로 3색 빔 내리침 ──
    if (this.phase === PHASE_FLASH && this.phaseTimer < 14) {
      const flashT = this.phaseTimer / 14;
      const flashAlpha = (1 - flashT) * 0.85;
      const beamTop = convY - 30;

      // 외곽: 암흑 빔 (가장 넓은, 보라)
      this.gfx.lineStyle(22, COL_V700, flashAlpha * 0.7);
      this.gfx.moveTo(convX, beamTop);
      this.gfx.lineTo(sx, sy);
      // 중간: 흙 빔 (앰버)
      this.gfx.lineStyle(12, COL_EARTH1, flashAlpha * 0.8);
      this.gfx.moveTo(convX, beamTop);
      this.gfx.lineTo(sx, sy);
      // 코어: 빛 빔 (노랑, 가장 밝은)
      this.gfx.lineStyle(5, COL_L300, flashAlpha * 0.9);
      this.gfx.moveTo(convX, beamTop);
      this.gfx.lineTo(sx, sy);
      this.gfx.lineStyle(0);

      // ADD 글로우 (보라+금 혼합)
      this.glowGfx.lineStyle(30, COL_V500, flashAlpha * 0.25);
      this.glowGfx.moveTo(convX, beamTop);
      this.glowGfx.lineTo(sx, sy);
      this.glowGfx.lineStyle(10, COL_L500, flashAlpha * 0.3);
      this.glowGfx.moveTo(convX, beamTop);
      this.glowGfx.lineTo(sx, sy);
      this.glowGfx.lineStyle(0);
    }

    // ── 5. 충격파 ──
    if (this.shockwaveAlpha > 0.01) {
      // 빛 링 (외곽)
      this.gfx.lineStyle(4, COL_L500, this.shockwaveAlpha * 0.7);
      this.gfx.drawCircle(sx, sy, this.shockwaveR);
      // 암흑 링 (내곽)
      this.gfx.lineStyle(2.5, COL_V500, this.shockwaveAlpha * 0.5);
      this.gfx.drawCircle(sx, sy, this.shockwaveR * 0.85);
      // ADD
      this.glowGfx.lineStyle(10, COL_L300, this.shockwaveAlpha * 0.2);
      this.glowGfx.drawCircle(sx, sy, this.shockwaveR);
      this.gfx.lineStyle(0);
      this.glowGfx.lineStyle(0);
    }

    // ── 6. 섬광 셀 — Sprite 풀 ──
    const cellCount = this.flashCells.length;
    for (let i = 0; i < POOL_SIZE; i++) {
      if (i >= cellCount) {
        this.flashGlowSprites[i].visible = false;
        this.flashCoreSprites[i].visible = false;
        continue;
      }
      const c = this.flashCells[i];
      const lt = c.life / c.maxLife;
      const alpha = lt < 0.08 ? lt / 0.08 : (1 - lt) * (1 - lt);
      if (alpha < 0.01) {
        this.flashGlowSprites[i].visible = false;
        this.flashCoreSprites[i].visible = false;
        continue;
      }

      const cx = sx + c.x;
      const cy = sy + c.y;

      const glow = this.flashGlowSprites[i];
      glow.visible = true;
      glow.position.set(cx, cy);
      glow.scale.set((c.size * 2.2) / CIRCLE_TEX_R);
      glow.tint = c.color;
      glow.alpha = alpha * 0.35;

      const core = this.flashCoreSprites[i];
      core.visible = true;
      core.position.set(cx, cy);
      core.scale.set((c.size * (1 - lt * 0.3)) / CIRCLE_TEX_R);
      core.tint = c.color;
      core.alpha = alpha * 0.9;
    }
  }

  private hideAllSprites() {
    for (let i = 0; i < POOL_SIZE; i++) {
      this.flashGlowSprites[i].visible = false;
      this.flashCoreSprites[i].visible = false;
    }
  }

  // ── 엔진 쿼리 ──
  isConverging(): boolean { return this.active && this._isConverging; }
  convergeLerp(): number { return this._convergeLerp; }
  convergeRange(): number { return CONVERGE_RANGE; }
  anchor(): { x: number; y: number } { return { x: this.anchorX, y: this.anchorY }; }
  flashRadius(): number { return FLASH_RADIUS; }

  // ── 정리 ──
  stop() {
    this.active = false;
    this.earthParticles = [];
    this.photons = [];
    this.flashCells = [];
    this._isConverging = false;
    this.blackholeR = 0;
    this.lightIntensity = 0;
    this.hideAllSprites();
    this.gfx.clear();
    this.glowGfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
