import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 물+빛 2단계 — 프리즘 차징 빔 v4
 *
 * 빛 1단계와 동일한 구조 (광점 차징 → 캐릭터 중심에서 일자 빔 발사) + 무지개 컬러.
 * 빛 1단계와의 차이점:
 *   1. 광점이 알록달록한 무지개 7색
 *   2. 광점이 직선이 아닌 나선으로 빨려옴 (회전 + 짧은 꼬리)
 *   3. 발사 시 빔 길이가 0 → 1800px로 빠르게 늘어남 (즉발 X)
 *   4. 빔이 6겹 무지개 (1단계 5겹 백/금 → 6겹 무지개)
 *   5. 빔이 1단계보다 25% 굵음
 *   6. 차징 시작 시 발사 방향 잠금 (사이클 동안 고정)
 *
 * 사이클 (총 140f ≈ 2.33초, 빛 1단계와 동일):
 *   A. 차징 (CHARGING, 90f)
 *   B. 발사 (BEAM,    50f)
 *
 * 좌표계: 장판형 (컨테이너 = 캐릭터 위치).
 */

// ───────────────────────────────────────────────────────────────
//  타입
// ───────────────────────────────────────────────────────────────

const enum PrismPhase {
  CHARGING = 0,
  BEAM = 1,
}

interface ChargeParticle {
  x: number; y: number;
  /** 직전 프레임 위치 — 꼬리 그리기용 */
  prevX: number; prevY: number;
  /** 반경 방향 속도 */
  speed: number;
  /** 접선 회전 강도 (시계/반시계, 부호 포함) */
  spinBias: number;
  size: number;
  colorIdx: number;
}

// ───────────────────────────────────────────────────────────────
//  무지개 7색
// ───────────────────────────────────────────────────────────────

const RAINBOW: number[] = [
  0xef4444, // 빨강
  0xf97316, // 주황
  0xfacc15, // 노랑
  0x22c55e, // 초록
  0x3b82f6, // 파랑
  0x6366f1, // 남색
  0xa855f7, // 보라
];

// ───────────────────────────────────────────────────────────────
//  메인 클래스
// ───────────────────────────────────────────────────────────────

export class WaterLightEffect {
  private container: PIXI.Container;
  /** ADD 블렌드 — 광점 글로우/꼬리, 빔 외곽 글로우, 임팩트 */
  private glowGfx: PIXI.Graphics;
  /** 빔 본체 (NORMAL, lineStyle) */
  private beamGfx: PIXI.Graphics;
  /** 광점 코어, 빔 심선, 백색 플래시 */
  private coreGfx: PIXI.Graphics;

  active = false;

  // 페이즈
  private phase: PrismPhase = PrismPhase.CHARGING;
  private phaseTimer = 0;
  private readonly CHARGE_DURATION = 90;
  private readonly BEAM_DURATION = 50;

  // 빔 사양
  private readonly BEAM_RANGE = 1800;
  /** 빔이 0 → 풀 길이로 늘어나는 시간 */
  private readonly BEAM_GROW_FRAMES = 8;
  static readonly BEAM_RANGE_PUBLIC = 1800;

  private time = 0;

  // 방향 잠금
  private pendingAngle = 0;
  private lockedAngle = 0;

  // 엔진이 읽는 공개 상태
  beamFiredThisFrame = false;
  beamDirection = 0;

  private chargeParticles: ChargeParticle[] = [];
  /** 발사 임팩트 코어 글로우 (발사 직후 강한 백광) */
  private impactCorePulse = 0;

  constructor(parent: PIXI.Container) {
    this.container = new PIXI.Container();
    parent.addChild(this.container);

    this.glowGfx = new PIXI.Graphics();
    this.glowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.glowGfx);

    this.beamGfx = new PIXI.Graphics();
    this.container.addChild(this.beamGfx);

    this.coreGfx = new PIXI.Graphics();
    this.container.addChild(this.coreGfx);
  }

  start(x: number, y: number) {
    this.active = true;
    this.time = 0;
    this.container.position.set(x, y);
    this.container.visible = true;
    this.beamFiredThisFrame = false;
    this.startNewCycle();
  }

  setPosition(x: number, y: number) {
    this.container.position.set(x, y);
  }

  setDirection(angle: number) {
    this.pendingAngle = angle;
  }

  private startNewCycle() {
    this.phase = PrismPhase.CHARGING;
    this.phaseTimer = 0;
    this.chargeParticles = [];
    this.lockedAngle = this.pendingAngle;
    this.impactCorePulse = 0;
  }

  // ═══════════════════════════════════════════════════════════
  //  업데이트
  // ═══════════════════════════════════════════════════════════

  update(dt: number) {
    if (!this.active) return;
    this.time += dt;
    this.beamFiredThisFrame = false;
    this.phaseTimer += dt;

    if (this.phase === PrismPhase.CHARGING) {
      this.updateCharging(dt);
      if (this.phaseTimer >= this.CHARGE_DURATION) {
        this.phase = PrismPhase.BEAM;
        this.phaseTimer = 0;
        this.beamFiredThisFrame = true;
        this.beamDirection = this.lockedAngle;
        this.chargeParticles = [];
        this.impactCorePulse = 1;
      }
    } else {
      // BEAM
      if (this.impactCorePulse > 0) {
        this.impactCorePulse -= dt * 0.08;
        if (this.impactCorePulse < 0) this.impactCorePulse = 0;
      }
      if (this.phaseTimer >= this.BEAM_DURATION) {
        this.startNewCycle();
      }
    }

    this.draw();
  }

  // ───────────────────────────────────────────────────────────
  //  차징 — 광점이 나선으로 빨려옴
  // ───────────────────────────────────────────────────────────

  private updateCharging(dt: number) {
    const progress = this.phaseTimer / this.CHARGE_DURATION;

    // 광점 생성 (진행될수록 빈번)
    const spawnRate = 1.5 + progress * 4.5;
    if (this.chargeParticles.length < 60 &&
        Math.floor(this.time) % Math.max(1, Math.floor(4 - spawnRate * 0.6)) === 0) {
      const count = 1 + Math.floor(progress * 2);
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 75 + Math.random() * 70;
        const sign = Math.random() < 0.5 ? -1 : 1;
        this.chargeParticles.push({
          x: Math.cos(angle) * dist,
          y: Math.sin(angle) * dist,
          prevX: Math.cos(angle) * dist,
          prevY: Math.sin(angle) * dist,
          speed: 0.7 + Math.random() * 0.5 + progress * 1.6,
          spinBias: sign * (0.7 + Math.random() * 0.6),
          // 입자 크기 키움 (1.7~3.3)
          size: 1.7 + Math.random() * 1.6,
          colorIdx: Math.floor(Math.random() * 7),
        });
      }
    }

    // 광점 이동 — 나선 (반경 방향 + 접선 방향, 가까울수록 회전 빨라짐)
    for (let i = this.chargeParticles.length - 1; i >= 0; i--) {
      const p = this.chargeParticles[i];
      // 직전 위치 저장 (꼬리용)
      p.prevX = p.x;
      p.prevY = p.y;

      const d = Math.sqrt(p.x * p.x + p.y * p.y);
      if (d < 3) {
        swapPop(this.chargeParticles, i);
        continue;
      }
      // 반경 방향 (중심으로)
      const nx = -p.x / d;
      const ny = -p.y / d;
      // 접선 방향 (회전)
      const tx = -ny * p.spinBias;
      const ty = nx * p.spinBias;
      // 가까울수록 회전 + 반경 가속
      const closeBoost = 1 + Math.max(0, (140 - d) / 100);
      const radSpeed = p.speed * closeBoost;
      const tanSpeed = 0.4 + (140 - d) / 80;

      p.x += (nx * radSpeed + tx * tanSpeed) * dt;
      p.y += (ny * radSpeed + ty * tanSpeed) * dt;
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  드로우
  // ═══════════════════════════════════════════════════════════

  private draw() {
    this.glowGfx.clear();
    this.beamGfx.clear();
    this.coreGfx.clear();

    if (this.phase === PrismPhase.CHARGING) {
      this.drawCharging();
    } else {
      this.drawBeam();
    }
  }

  // ───────────────────────────────────────────────────────────
  //  드로우: 차징 (광점 + 꼬리 + 코어)
  // ───────────────────────────────────────────────────────────

  private drawCharging() {
    const progress = this.phaseTimer / this.CHARGE_DURATION;

    // 광점 + 꼬리
    for (const p of this.chargeParticles) {
      const d = Math.sqrt(p.x * p.x + p.y * p.y);
      const closeFrac = Math.min(1, (140 - d) / 130);
      const alpha = 0.6 + closeFrac * 0.35;
      const color = RAINBOW[p.colorIdx];

      // 꼬리 (이전 위치 → 현재 위치)
      this.glowGfx.lineStyle(p.size * 1.6, color, alpha * 0.55);
      this.glowGfx.moveTo(p.prevX, p.prevY);
      this.glowGfx.lineTo(p.x, p.y);
      this.glowGfx.lineStyle(0);

      // 큰 글로우
      this.glowGfx.beginFill(color, alpha * 0.45);
      this.glowGfx.drawCircle(p.x, p.y, p.size * 3.0);
      this.glowGfx.endFill();

      // 코어
      this.coreGfx.beginFill(color, alpha);
      this.coreGfx.drawCircle(p.x, p.y, p.size);
      this.coreGfx.endFill();
    }

    // 중심 코어 (차징 진행에 따라 점점 밝아짐)
    if (progress > 0.15) {
      const intensity = (progress - 0.15) / 0.85;
      // 무지개 글로우 둘레 (회전)
      const ringPoints = 14;
      for (let i = 0; i < ringPoints; i++) {
        const a = (i / ringPoints) * Math.PI * 2 + this.time * 0.04;
        const gx = Math.cos(a) * (10 + intensity * 6);
        const gy = Math.sin(a) * (10 + intensity * 6);
        const color = RAINBOW[i % 7];
        this.glowGfx.beginFill(color, 0.18 * intensity);
        this.glowGfx.drawCircle(gx, gy, 4 + intensity * 3);
        this.glowGfx.endFill();
      }
      // 백색 코어
      this.glowGfx.beginFill(0xffffff, 0.20 * intensity * intensity);
      this.glowGfx.drawCircle(0, 0, 11 * intensity);
      this.glowGfx.endFill();

      // 막바지 펄스 (발사 임박)
      if (progress > 0.82) {
        const pulseInt = (progress - 0.82) / 0.18;
        const pulse = 0.7 + Math.sin(this.time * 0.55) * 0.3;
        this.coreGfx.beginFill(0xffffff, pulseInt * 0.45 * pulse);
        this.coreGfx.drawCircle(0, 0, 6 + pulseInt * 4);
        this.coreGfx.endFill();
      }
    }
  }

  // ───────────────────────────────────────────────────────────
  //  드로우: 발사 (6겹 무지개 빔, 길이 애니메이션)
  // ───────────────────────────────────────────────────────────

  private drawBeam() {
    const fadeProg = this.phaseTimer / this.BEAM_DURATION;
    const alpha = 1 - fadeProg * 0.7; // 페이드 약하게 (덜 투명)
    const fade = 1 - fadeProg * 0.35;
    const angle = this.beamDirection;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const perpX = -sinA;
    const perpY = cosA;

    // 빔 길이 애니메이션 (0 → 풀 길이, 8f 동안)
    const growT = Math.min(1, this.phaseTimer / this.BEAM_GROW_FRAMES);
    const easedGrow = 1 - Math.pow(1 - growT, 3);
    const currentRange = this.BEAM_RANGE * easedGrow;

    const endX = cosA * currentRange;
    const endY = sinA * currentRange;

    // 발사 직후 5f 두께 130% → 정상
    const impactBulge = this.phaseTimer < 5
      ? 1 + (1 - this.phaseTimer / 5) * 0.3
      : 1;
    const bulge = fade * impactBulge;

    // ──────────────────────────────────────────────────
    //  무지개 빔 — 빔 길이 따라 6 segment로 색이 변함
    //  캐릭터 → 끝: 빨강 → 주황 → 노랑 → 초록 → 파랑 → 보라
    //  각 segment가 자기 구간에서 진하게 보임 (NORMAL alpha 0.95)
    // ──────────────────────────────────────────────────

    // 1) 외곽 백색 후광 (ADD, 살짝, 빔이 빛나는 느낌만)
    this.glowGfx.lineStyle(28 * bulge, 0xffffff, alpha * 0.22);
    this.glowGfx.moveTo(0, 0);
    this.glowGfx.lineTo(endX, endY);
    this.glowGfx.lineStyle(0);

    // 2) 6 segment 본체 (NORMAL, 진하게)
    const RAINBOW_BEAM = [0xef4444, 0xf97316, 0xfacc15, 0x22c55e, 0x3b82f6, 0xa855f7];
    const segments = RAINBOW_BEAM.length;
    const segLen = currentRange / segments;
    const overlap = 2; // segment 끊김 방지
    const beamWidth = 11 * impactBulge;
    for (let i = 0; i < segments; i++) {
      const startAlong = Math.max(0, i * segLen - overlap);
      const endAlong = Math.min(currentRange, (i + 1) * segLen + overlap);
      const sx = cosA * startAlong;
      const sy = sinA * startAlong;
      const ex = cosA * endAlong;
      const ey = sinA * endAlong;
      this.beamGfx.lineStyle(beamWidth, RAINBOW_BEAM[i], alpha * 0.95);
      this.beamGfx.moveTo(sx, sy);
      this.beamGfx.lineTo(ex, ey);
    }
    this.beamGfx.lineStyle(0);

    // 3) 심선 백 (가운데 진한 코어, 빔 길이 전체)
    this.coreGfx.lineStyle(2.5 * impactBulge, 0xffffff, alpha * 0.92);
    this.coreGfx.moveTo(0, 0);
    this.coreGfx.lineTo(endX, endY);
    this.coreGfx.lineStyle(0);

    // ── 빔 길이 따라 흐르는 스파클 (디테일) ──
    const sparkCount = 6;
    for (let i = 0; i < sparkCount; i++) {
      const phase = (this.phaseTimer * 0.06 + i / sparkCount) % 1;
      const along = phase * currentRange;
      if (along > currentRange - 5) continue;
      const sx = cosA * along;
      const sy = sinA * along;
      const fadeS = phase < 0.1 ? phase / 0.1 : (phase > 0.9 ? (1 - phase) / 0.1 : 1);
      const a = alpha * fadeS;
      this.glowGfx.beginFill(0xffffff, a * 0.7);
      this.glowGfx.drawCircle(sx, sy, 4);
      this.glowGfx.endFill();
      this.coreGfx.beginFill(0xffffff, a);
      this.coreGfx.drawCircle(sx, sy, 1.6);
      this.coreGfx.endFill();
    }

    // ── 발사 임팩트 — 캐릭터 위치 강한 백색 플래시 ──
    if (this.impactCorePulse > 0) {
      const f = this.impactCorePulse;
      // 큰 백색 글로우
      this.glowGfx.beginFill(0xffffff, f * 0.7);
      this.glowGfx.drawCircle(0, 0, 30 * f);
      this.glowGfx.endFill();
      // 중간 글로우
      this.glowGfx.beginFill(0xffffff, f * 0.45);
      this.glowGfx.drawCircle(0, 0, 50 * f);
      this.glowGfx.endFill();
      // 코어
      this.coreGfx.beginFill(0xffffff, f);
      this.coreGfx.drawCircle(0, 0, 12 * f);
      this.coreGfx.endFill();
      // 무지개 충격파 링 (캐릭터 주변, 조금 큼)
      const ringR = 16 + (1 - f) * 30;
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        const gx = Math.cos(a) * ringR;
        const gy = Math.sin(a) * ringR;
        this.glowGfx.beginFill(RAINBOW[i], f * 0.55);
        this.glowGfx.drawCircle(gx, gy, 5 * f);
        this.glowGfx.endFill();
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  정리
  // ═══════════════════════════════════════════════════════════

  stop() {
    this.active = false;
    this.container.visible = false;
    this.chargeParticles = [];
    this.impactCorePulse = 0;
    this.glowGfx.clear();
    this.beamGfx.clear();
    this.coreGfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
