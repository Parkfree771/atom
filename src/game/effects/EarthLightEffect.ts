import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 흙+빛 2단계 — 풀구라이트 (Fulgurite)
 *
 * 빛 1단계와 동일한 구조 (광점 차징 → 캐릭터 중심에서 발사) + 흙 컨셉.
 * WaterLightEffect 패턴 100% 차용 (나선 흡수 + 꼬리) + 흙 색/개성:
 *   1. 무지개 7색 → 모래/갈색/황금 4톤 (거리 기반 + 랜덤)
 *   2. 멀리=어두운 갈색, 가까이=황금/크림 (열을 받아 가열되는 모래)
 *   3. 입자 크기 다양 (모래 알갱이 무게감)
 *   4. 발사 시 단일 빔이 아닌 다발 빔 7발 (메인 + 분산 ±15°/±30°/±45°)
 *
 * 사이클 (총 162f ≈ 2.7초):
 *   A. 차징 (FORMING, 90f) — 모래 입자가 사방에서 나선으로 빨려옴 (꼬리 포함)
 *   B. 발사 (BURST,   50f) — 다발 빔 7발 동시 발사 + 작은 모래 폭발
 *   C. 잔해 (LINGER,  22f) — 빔 페이드 → 사이클 재시작
 *
 * 빛 1단계와 핵심 차이:
 *   - 직선 → 나선 흡수
 *   - 단일 톤(황금) → 4톤 거리 기반 (모래/황금)
 *   - 입자 크기 균일 → 다양 (모래 알갱이 무게감)
 *   - 1발 빔 → 다발 빔 7발
 *
 * 좌표계: 빛 1단계와 동일 — 컨테이너 = 캐릭터 위치, 모든 좌표 로컬.
 */

// ── 차징 입자 (모래 알갱이) ──
interface ChargeParticle {
  x: number; y: number;
  /** 직전 프레임 위치 — 꼬리 그리기용 */
  prevX: number; prevY: number;
  /** 반경 방향 속도 */
  speed: number;
  /** 접선 회전 강도 (시계/반시계, 부호 포함) */
  spinBias: number;
  size: number;
  /** 0=어두운 갈색, 1=모래 메인, 2=황금, 3=크림 (거리 기반으로 동적 계산) */
  colorIdx: number;
}

// ── 발사 시 작은 모래 폭발 셀 ──
interface BurstParticle {
  x: number; y: number;
  vx: number; vy: number;
  life: number;
  maxLife: number;
  size: number;
  colorIdx: number;
}

const enum FulguritePhase {
  FORMING = 0,
  BURST = 1,
  LINGER = 2,
}

// ── 모래 톤 4단계 (거리 기반 — 멀리 = 어두움, 가까이 = 밝음) ──
const SAND_TONES: number[] = [
  0x78520a, // 0: 어두운 갈색 (가장 먼 거리)
  0xa16207, // 1: 모래 메인 갈색
  0xd4a53c, // 2: 황금 모래
  0xfde047, // 3: 빛에 가열된 황금 (가장 가까운 거리)
];

export class EarthLightEffect {
  private container: PIXI.Container;
  /** ADD 블렌드 — 글로우 (작게만 사용 — 흰끼 방지) */
  private glowGfx: PIXI.Graphics;
  /** NORMAL — 입자 코어, 빔 본체 */
  private coreGfx: PIXI.Graphics;
  /** NORMAL — 빔 라인 (위) */
  private beamGfx: PIXI.Graphics;

  active = false;
  private time = 0;

  // 페이즈
  private phase: FulguritePhase = FulguritePhase.FORMING;
  private phaseTimer = 0;
  private readonly CHARGE_DURATION = 90;
  private readonly BURST_DURATION = 50;
  private readonly LINGER_DURATION = 22;

  // 빔 발사 정보 (엔진과 통신)
  beamFiredThisFrame = false;
  beamMainAngle = 0;
  /** 분산 빔 각도 오프셋 (메인 기준) — 메인 + 6 분산 = 7발 */
  static readonly SPREAD_OFFSETS = [
    -Math.PI / 12, Math.PI / 12,   // ±15°
    -Math.PI / 6,  Math.PI / 6,    // ±30°
    -Math.PI / 4,  Math.PI / 4,    // ±45°
  ];

  /** 외부에서 갱신 */
  private pendingAngle = 0;

  // 차징 입자
  private chargeParticles: ChargeParticle[] = [];

  // 발사 시 작은 폭발 셀
  private burstParticles: BurstParticle[] = [];

  // 빔 사양
  private readonly BEAM_RANGE_MAIN = 1800;
  private readonly BEAM_RANGE_SPREAD = 1500;
  private readonly BEAM_GROW_FRAMES = 8;

  // 색 (가장 밝은 톤은 크림 — 백 X)
  private readonly COL_GOLD_BRIGHT = 0xfef08a;
  private readonly COL_CREAM       = 0xfef9c3;

  constructor(parent: PIXI.Container) {
    this.container = new PIXI.Container();
    parent.addChild(this.container);

    // 글로우 (가장 아래, ADD — 매우 작게)
    this.glowGfx = new PIXI.Graphics();
    this.glowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.glowGfx);

    // 입자 코어 (NORMAL)
    this.coreGfx = new PIXI.Graphics();
    this.container.addChild(this.coreGfx);

    // 빔 (위, NORMAL)
    this.beamGfx = new PIXI.Graphics();
    this.container.addChild(this.beamGfx);
  }

  start(x: number, y: number) {
    this.active = true;
    this.time = 0;
    this.phase = FulguritePhase.FORMING;
    this.phaseTimer = 0;
    this.chargeParticles = [];
    this.burstParticles = [];
    this.beamFiredThisFrame = false;
    this.container.position.set(x, y);
    this.container.visible = true;
  }

  setPosition(x: number, y: number) {
    // 차징 동안에만 캐릭터 추적, 발사 후에는 잠금 (그 자리 발사)
    if (this.phase === FulguritePhase.FORMING) {
      this.container.position.set(x, y);
    }
  }

  setDirection(angle: number) {
    this.pendingAngle = angle;
  }

  update(dt: number) {
    if (!this.active) return;
    this.time += dt;
    this.phaseTimer += dt;
    this.beamFiredThisFrame = false;

    switch (this.phase) {
      case FulguritePhase.FORMING:
        this.updateCharging(dt);
        if (this.phaseTimer >= this.CHARGE_DURATION) {
          this.phase = FulguritePhase.BURST;
          this.phaseTimer = 0;
          // 발사 알림 + 메인 각도 잠금
          this.beamFiredThisFrame = true;
          this.beamMainAngle = this.pendingAngle;
          // 차징 입자가 빛으로 폭발 (작은 모래 폭발)
          this.spawnBurstFromChargeParticles();
          this.chargeParticles = [];
        }
        break;

      case FulguritePhase.BURST:
        this.updateBurstParticles(dt);
        if (this.phaseTimer >= this.BURST_DURATION) {
          this.phase = FulguritePhase.LINGER;
          this.phaseTimer = 0;
        }
        break;

      case FulguritePhase.LINGER:
        this.updateBurstParticles(dt);
        if (this.phaseTimer >= this.LINGER_DURATION) {
          // 사이클 재시작 (FORMING으로)
          this.phase = FulguritePhase.FORMING;
          this.phaseTimer = 0;
          this.burstParticles = [];
        }
        break;
    }

    this.draw();
  }

  // ═══════════════════════════════════════════════════════════
  //  Phase 1 — 차징 (WaterLightEffect 나선 흡수 패턴 100% 차용)
  // ═══════════════════════════════════════════════════════════

  private updateCharging(dt: number) {
    const progress = this.phaseTimer / this.CHARGE_DURATION;

    // 광점 생성 (진행될수록 빈번)
    const spawnRate = 1.5 + progress * 4.5;
    if (this.chargeParticles.length < 55 &&
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
          // ★ 흙 개성 — 입자 크기 다양 (모래 알갱이 무게감, 1.5~3.6)
          size: 1.5 + Math.random() * 2.1,
          colorIdx: 0, // 거리 기반으로 매 프레임 동적 계산
        });
      }
    }

    // 광점 이동 — 나선 (반경 + 접선, 가까울수록 회전 빨라짐)
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
  //  Phase 1 → 2 전환: 차징 입자 → 작은 모래 폭발
  // ═══════════════════════════════════════════════════════════

  /** 차징 동안 모인 입자 위치 기준으로 작은 폭발 셀 생성 */
  private spawnBurstFromChargeParticles() {
    // 36개 사방 분출 (단순)
    const total = 36;
    for (let i = 0; i < total; i++) {
      const angle = (i / total) * Math.PI * 2 + (Math.random() - 0.5) * 0.30;
      const speed = 3 + Math.random() * 4.5;
      const startDist = 4 + Math.random() * 5;

      this.burstParticles.push({
        x: Math.cos(angle) * startDist,
        y: Math.sin(angle) * startDist,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        maxLife: 25 + Math.random() * 18,
        size: 1.4 + Math.random() * 1.8,
        // 황금 위주 (빛에 가열된 모래가 폭발)
        colorIdx: Math.random() < 0.55 ? 2 : (Math.random() < 0.7 ? 3 : 1),
      });
    }
  }

  private updateBurstParticles(dt: number) {
    for (let i = this.burstParticles.length - 1; i >= 0; i--) {
      const p = this.burstParticles[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        swapPop(this.burstParticles, i);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.94;
      p.vy *= 0.94;
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  렌더링
  // ═══════════════════════════════════════════════════════════

  private draw() {
    this.glowGfx.clear();
    this.coreGfx.clear();
    this.beamGfx.clear();

    if (this.phase === FulguritePhase.FORMING) {
      this.drawCharging();
    } else {
      // BURST or LINGER
      this.drawBeams();
      this.drawBurstParticles();
    }
  }

  // ── 차징 입자 (WaterLight 패턴 + 모래 색) ──
  private drawCharging() {
    for (const p of this.chargeParticles) {
      const d = Math.sqrt(p.x * p.x + p.y * p.y);
      // 거리 기반 색 (멀리 = 어두운 갈색, 가까이 = 황금)
      // d 범위 ~ 0~145 → t 0(가까이) ~ 1(멀리)
      const tDist = Math.min(1, d / 140);
      // 4톤 인덱스
      let colorIdx: number;
      if (tDist > 0.75) colorIdx = 0;        // 어두운 갈색
      else if (tDist > 0.50) colorIdx = 1;   // 모래 메인
      else if (tDist > 0.25) colorIdx = 2;   // 황금
      else colorIdx = 3;                     // 가열된 황금
      const color = SAND_TONES[colorIdx];

      // 알파: 가까울수록 진함
      const closeFrac = 1 - tDist;
      const alpha = 0.55 + closeFrac * 0.40;

      // 꼬리 (이전 위치 → 현재 위치) — 모래 trail
      this.coreGfx.lineStyle(p.size * 1.3, color, alpha * 0.50);
      this.coreGfx.moveTo(p.prevX, p.prevY);
      this.coreGfx.lineTo(p.x, p.y);
      this.coreGfx.lineStyle(0);

      // 작은 글로우 (ADD — 매우 작게, 흰끼 방지)
      // 단일 톤 누적 흰끼 방지 위해 사이즈/알파 모두 작게
      this.glowGfx.beginFill(color, alpha * 0.22);
      this.glowGfx.drawCircle(p.x, p.y, p.size * 1.6);
      this.glowGfx.endFill();

      // 코어 (NORMAL — 색이 정확)
      this.coreGfx.beginFill(color, alpha);
      this.coreGfx.drawCircle(p.x, p.y, p.size);
      this.coreGfx.endFill();
    }

    // 중심 코어 (차징 진행에 따라 점점 밝아짐) — 작게
    const progress = this.phaseTimer / this.CHARGE_DURATION;
    if (progress > 0.15) {
      const intensity = (progress - 0.15) / 0.85;

      // 작은 황금 글로우 (NORMAL — ADD 누적 X)
      this.coreGfx.beginFill(SAND_TONES[2], 0.35 * intensity);
      this.coreGfx.drawCircle(0, 0, 5 * intensity);
      this.coreGfx.endFill();

      // 작은 가열 황금 코어
      this.coreGfx.beginFill(SAND_TONES[3], 0.65 * intensity);
      this.coreGfx.drawCircle(0, 0, 2.5 * intensity);
      this.coreGfx.endFill();
    }
  }

  // ── 다발 빔 7발 ──
  private drawBeams() {
    if (this.phase !== FulguritePhase.BURST && this.phase !== FulguritePhase.LINGER) return;

    // BURST 동안 alpha 페이드, LINGER에서 더 빠르게
    const totalT = this.phase === FulguritePhase.BURST
      ? this.phaseTimer
      : this.BURST_DURATION + this.phaseTimer;
    const totalDuration = this.BURST_DURATION + this.LINGER_DURATION;
    const fadeProg = totalT / totalDuration;
    const alpha = 1 - fadeProg * 0.92;
    const fade = 1 - fadeProg * 0.4;

    // 빔 grow 애니메이션 (0 → 1, ease-out) — BURST 시작 시점부터
    const burstT = this.phase === FulguritePhase.BURST ? this.phaseTimer : this.BURST_DURATION;
    const growT = Math.min(1, burstT / this.BEAM_GROW_FRAMES);
    const easedGrow = 1 - Math.pow(1 - growT, 3);

    // impactBulge (LightEffect 패턴 — BURST 처음 5f 130% → 정상)
    const impactBulge = burstT < 5
      ? 1 + (1 - burstT / 5) * 0.3
      : 1;
    const bulge = fade * impactBulge;

    // 메인 빔
    this.drawSingleBeam(
      this.beamMainAngle,
      this.BEAM_RANGE_MAIN * easedGrow,
      bulge * 1.0,
      alpha,
      true,
    );

    // 분산 빔 6발
    for (const offset of EarthLightEffect.SPREAD_OFFSETS) {
      this.drawSingleBeam(
        this.beamMainAngle + offset,
        this.BEAM_RANGE_SPREAD * easedGrow,
        bulge * 1.0,
        alpha,
        false,
      );
    }
  }

  /** 빔 1발 5겹 (LightEffect.drawBeam 패턴, 모래/황금 색) */
  private drawSingleBeam(angle: number, range: number, bulge: number, alpha: number, isMain: boolean) {
    if (range < 5) return;
    const endX = Math.cos(angle) * range;
    const endY = Math.sin(angle) * range;

    // 두께: 메인은 LightEffect와 동일, 분산은 60%
    const sizeScale = isMain ? 1.0 : 0.60;

    // 1) 최외곽 — 모래 갈
    this.beamGfx.lineStyle(60 * sizeScale * bulge, SAND_TONES[1], alpha * 0.12);
    this.beamGfx.moveTo(0, 0);
    this.beamGfx.lineTo(endX, endY);

    // 2) 외곽 — 황금 진
    this.beamGfx.lineStyle(38 * sizeScale * bulge, 0xeab308, alpha * 0.28);
    this.beamGfx.moveTo(0, 0);
    this.beamGfx.lineTo(endX, endY);

    // 3) 중간 — 황금 라이트
    this.beamGfx.lineStyle(20 * sizeScale * bulge, SAND_TONES[3], alpha * 0.55);
    this.beamGfx.moveTo(0, 0);
    this.beamGfx.lineTo(endX, endY);

    // 4) 내부 — 황금 브라이트
    this.beamGfx.lineStyle(10 * sizeScale * bulge, this.COL_GOLD_BRIGHT, alpha * 0.78);
    this.beamGfx.moveTo(0, 0);
    this.beamGfx.lineTo(endX, endY);

    // 5) 심선 — 크림 (백 대신)
    this.beamGfx.lineStyle(4 * sizeScale * bulge, this.COL_CREAM, alpha * 0.92);
    this.beamGfx.moveTo(0, 0);
    this.beamGfx.lineTo(endX, endY);

    this.beamGfx.lineStyle(0);
  }

  // ── 작은 모래 폭발 ──
  private drawBurstParticles() {
    for (const p of this.burstParticles) {
      const lifeFrac = p.life / p.maxLife;
      const sizePhase = lifeFrac < 0.20
        ? 1 + lifeFrac * 1.3
        : 1.26 - (lifeFrac - 0.20) * 0.5;
      const r = p.size * sizePhase;

      const color = SAND_TONES[p.colorIdx];
      const alpha = (1 - lifeFrac * 0.45) * 0.90;

      // 본체 (NORMAL)
      this.coreGfx.beginFill(color, alpha);
      this.coreGfx.drawCircle(p.x, p.y, r);
      this.coreGfx.endFill();
    }
  }

  stop() {
    this.active = false;
    this.container.visible = false;
    this.chargeParticles = [];
    this.burstParticles = [];
    this.glowGfx.clear();
    this.coreGfx.clear();
    this.beamGfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
