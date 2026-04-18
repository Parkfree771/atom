import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 흙 속성 1단계 — 모래지옥 장판
 *
 * 캐릭터 주변에 유사(流砂) 필드가 깔린다.
 * 바닥 자체가 살아서 안쪽으로 빨려드는 느낌.
 *
 * 시각 구성:
 *   1. 베이스 필드 — 바깥 진한 갈색 → 안쪽 밝은 모래색 그라데이션
 *   2. 중심 심연 — 어두운 구덩이, 맥동하며 삼키는 느낌
 *   3. 유사 나선 — 두꺼운 모래 줄기가 안쪽으로 회전하며 빨려듦
 *   4. 모래 파문 — 중심에서 바깥으로 펄스
 *   5. 유사 입자 — 모래 알갱이가 나선을 따라 중심으로 빨려 들어감
 *
 * 구현: PIXI.Graphics only (파티클 이미터 미사용)
 */

// ── 모래 파문 ──
interface SandRipple {
  /** 0→1 진행도 (0=중심, 1=최대 반경) */
  progress: number;
  /** 고유 시드 */
  seed: number;
}

// ── 유사 입자 (나선 따라 빨려드는 모래 알갱이) ──
interface SandGrain {
  /** 현재 각도 (라디안) */
  angle: number;
  /** 중심으로부터 거리 */
  radius: number;
  /** 안쪽으로 빨려드는 속도 (px/frame) */
  inwardSpeed: number;
  /** 회전 속도 (rad/frame) */
  angularSpeed: number;
  /** 크기 */
  size: number;
  /** 생성 시 반경 (알파 계산용) */
  spawnRadius: number;
}

export class EarthEffect {
  private container: PIXI.Container;
  private glowGfx: PIXI.Graphics;
  private fieldGfx: PIXI.Graphics;
  private grainGfx: PIXI.Graphics;

  active = false;
  private radius = 0;
  private time = 0;

  // 나선 회전 각도 — 지속 감소하면 안쪽으로 빨려드는 느낌
  private spiralRotation = 0;

  // 모래 파문
  private ripples: SandRipple[] = [];
  private rippleSpawnTimer = 0;
  private readonly RIPPLE_SPAWN_INTERVAL = 45;

  // 유사 입자 (나선 따라 빨려드는 모래 알갱이)
  private grains: SandGrain[] = [];
  private grainSpawnTimer = 0;

  // ── 색상 팔레트 ──
  private readonly COL_ABYSS  = 0x1a0f02; // 심연 중심 — 거의 검정
  private readonly COL_PIT    = 0x2d1a04; // 구덩이 — 매우 어두운 갈색
  private readonly COL_EDGE   = 0x5c3d08; // 필드 가장자리
  private readonly COL_DARK   = 0x78520a; // 바깥쪽 진한 갈색
  private readonly COL_MAIN   = 0xa16207; // 메인 앰버
  private readonly COL_MID    = 0xb8860b; // 중간 골드
  private readonly COL_SAND   = 0xd4a53c; // 모래색
  private readonly COL_LIGHT  = 0xe8c882; // 밝은 모래

  constructor(parent: PIXI.Container) {
    this.container = new PIXI.Container();
    parent.addChild(this.container);

    // 글로우 레이어 (최하단 — ADD 블렌드)
    this.glowGfx = new PIXI.Graphics();
    this.glowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.glowGfx);

    // 필드 레이어 (중간 — 그라데이션 + 심연 + 나선 + 파문)
    this.fieldGfx = new PIXI.Graphics();
    this.container.addChild(this.fieldGfx);

    // 유사 입자 레이어 (최상단 — ADD 블렌드)
    this.grainGfx = new PIXI.Graphics();
    this.grainGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.grainGfx);
  }

  start(x: number, y: number, radius: number) {
    this.active = true;
    this.radius = radius;
    this.time = 0;
    this.spiralRotation = 0;
    this.ripples = [];
    this.rippleSpawnTimer = 0;
    this.grains = [];
    this.grainSpawnTimer = 0;
    this.container.position.set(x, y);
    this.container.visible = true;
  }

  setPosition(x: number, y: number) {
    this.container.position.set(x, y);
  }

  update(dt: number) {
    if (!this.active) return;

    this.time += dt;

    // 나선 회전 — 시계방향(감소)으로 흡입 느낌
    this.spiralRotation -= 0.008 * dt;

    // ── 모래 파문 ──
    this.rippleSpawnTimer += dt;
    if (this.rippleSpawnTimer >= this.RIPPLE_SPAWN_INTERVAL) {
      this.rippleSpawnTimer = 0;
      this.ripples.push({ progress: 0, seed: Math.random() * 1000 });
    }
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      this.ripples[i].progress += 0.01 * dt;
      if (this.ripples[i].progress > 1.0) {
        swapPop(this.ripples, i);
      }
    }

    // ── 유사 입자 생성 ──
    this.grainSpawnTimer += dt;
    if (this.grainSpawnTimer >= 2 && this.grains.length < 60) {
      this.grainSpawnTimer = 0;
      this.spawnGrains();
    }

    // ── 유사 입자 업데이트 — 나선 따라 안쪽으로 빨려듦 ──
    const R = this.radius;
    for (let i = this.grains.length - 1; i >= 0; i--) {
      const g = this.grains[i];
      g.radius -= g.inwardSpeed * dt;
      g.angle += g.angularSpeed * dt;
      // 중심 도달 → 삼켜짐
      if (g.radius < R * 0.04) {
        swapPop(this.grains, i);
      }
    }

    this.draw();
  }

  // ═══════════════════════════════════════════════════════════
  //  렌더링
  // ═══════════════════════════════════════════════════════════

  private draw() {
    this.glowGfx.clear();
    this.fieldGfx.clear();
    this.grainGfx.clear();

    this.drawFieldGradient();
    this.drawCenterAbyss();
    this.drawQuicksandSpirals();
    this.drawSandRipples();
    this.drawSandGrains();
  }

  // ───────────────────────────────────────
  //  1. 베이스 필드 — 동심원 그라데이션
  // ───────────────────────────────────────
  private drawFieldGradient() {
    const R = this.radius;

    // 그라데이션: 바깥 진한 갈색 → 안쪽 밝은 모래
    const layers: Array<{ rFrac: number; color: number; alpha: number }> = [
      { rFrac: 1.00, color: this.COL_EDGE,  alpha: 0.14 },
      { rFrac: 0.90, color: this.COL_DARK,  alpha: 0.12 },
      { rFrac: 0.78, color: this.COL_MAIN,  alpha: 0.11 },
      { rFrac: 0.62, color: this.COL_MID,   alpha: 0.10 },
      { rFrac: 0.45, color: this.COL_SAND,  alpha: 0.09 },
      { rFrac: 0.28, color: this.COL_LIGHT, alpha: 0.08 },
    ];
    for (const l of layers) {
      this.fieldGfx.beginFill(l.color, l.alpha);
      this.fieldGfx.drawCircle(0, 0, R * l.rFrac);
      this.fieldGfx.endFill();
    }

    // 경계 테두리 — 미세 숨쉬기
    const breathe = 1 + Math.sin(this.time * 0.03) * 0.015;
    this.fieldGfx.lineStyle(2, this.COL_DARK, 0.35);
    this.fieldGfx.drawCircle(0, 0, R * breathe);
    this.fieldGfx.lineStyle(1, this.COL_MAIN, 0.15);
    this.fieldGfx.drawCircle(0, 0, R * breathe * 0.96);
  }

  // ───────────────────────────────────────
  //  2. 중심 심연 — 어두운 구덩이
  //     맥동하면서 모든 것을 삼키는 느낌
  // ───────────────────────────────────────
  private drawCenterAbyss() {
    const R = this.radius;
    const pulse = 1 + Math.sin(this.time * 0.05) * 0.12;

    // 외곽 어둠 (넓은 범위, 연하게)
    this.fieldGfx.beginFill(this.COL_PIT, 0.18 * pulse);
    this.fieldGfx.drawCircle(0, 0, R * 0.18);
    this.fieldGfx.endFill();

    // 중간 구덩이
    this.fieldGfx.beginFill(this.COL_PIT, 0.25 * pulse);
    this.fieldGfx.drawCircle(0, 0, R * 0.11);
    this.fieldGfx.endFill();

    // 심연 코어 — 거의 검정
    this.fieldGfx.beginFill(this.COL_ABYSS, 0.3 * pulse);
    this.fieldGfx.drawCircle(0, 0, R * 0.05);
    this.fieldGfx.endFill();

    // 심연 테두리 링 (빨려드는 경계선)
    const ringPulse = 1 + Math.sin(this.time * 0.07) * 0.08;
    this.fieldGfx.lineStyle(1.5, this.COL_DARK, 0.2 * ringPulse);
    this.fieldGfx.drawCircle(0, 0, R * 0.19 * ringPulse);
    this.fieldGfx.lineStyle(0);
  }

  // ───────────────────────────────────────
  //  3. 유사 나선 — 두꺼운 모래 줄기가 안으로 회전
  //     아르키메데스 나선 5줄기
  // ───────────────────────────────────────
  private drawQuicksandSpirals() {
    const R = this.radius;
    const arms = 5;
    const maxTheta = Math.PI * 4; // 2 바퀴
    const segments = 80;
    const timePhase = this.time * 0.04;

    for (let arm = 0; arm < arms; arm++) {
      const armOffset = (arm / arms) * Math.PI * 2;

      for (let i = 0; i < segments; i++) {
        const t1 = i / segments;
        const t2 = (i + 1) / segments;

        // 바깥(t=0)에서 안쪽(t=1)으로
        const r1 = R * 0.92 * (1 - t1);
        const r2 = R * 0.92 * (1 - t2);
        // 중심 심연 근처에서 끊기
        if (r1 < R * 0.06) continue;

        const theta1 = t1 * maxTheta;
        const theta2 = t2 * maxTheta;
        const angle1 = theta1 + armOffset + this.spiralRotation;
        const angle2 = theta2 + armOffset + this.spiralRotation;

        // 불규칙 노이즈
        const noise1 = Math.sin(theta1 * 3 + timePhase + arm * 2.1) * r1 * 0.04;
        const noise2 = Math.sin(theta2 * 3 + timePhase + arm * 2.1) * r2 * 0.04;

        const x1 = Math.cos(angle1) * (r1 + noise1);
        const y1 = Math.sin(angle1) * (r1 + noise1);
        const x2 = Math.cos(angle2) * (r2 + noise2);
        const y2 = Math.sin(angle2) * (r2 + noise2);

        // 바깥 → 굵고 진하게 | 안쪽 → 가늘고 연하게
        const thickness = 1.2 + (1 - t1) * 3.0;
        const alpha = 0.08 + (1 - t1) * 0.22;
        const color = t1 < 0.35 ? this.COL_MAIN : t1 < 0.7 ? this.COL_SAND : this.COL_LIGHT;

        this.fieldGfx.lineStyle(thickness, color, alpha);
        this.fieldGfx.moveTo(x1, y1);
        this.fieldGfx.lineTo(x2, y2);
      }
    }
    this.fieldGfx.lineStyle(0);
  }

  // ───────────────────────────────────────
  //  4. 모래 파문 — 중심에서 바깥으로 펄스
  // ───────────────────────────────────────
  private drawSandRipples() {
    const R = this.radius;

    for (const ripple of this.ripples) {
      const p = ripple.progress;
      const currentR = R * p * 0.85;
      if (currentR < 5) continue;

      const fadeIn = Math.min(1, p / 0.1);
      const fadeOut = p > 0.5 ? 1 - (p - 0.5) / 0.5 : 1;
      const lifeAlpha = fadeIn * fadeOut;
      if (lifeAlpha < 0.01) continue;

      const waveAmp = currentR * 0.05;
      const segments = 50;
      const step = (Math.PI * 2) / segments;
      const baseThickness = 1.2 + currentR * 0.012;

      // 메인 패스
      this.fieldGfx.lineStyle(baseThickness, this.COL_MAIN, lifeAlpha * 0.25);
      for (let j = 0; j <= segments; j++) {
        const angle = j * step;
        const noise = Math.sin(angle * 7 + ripple.seed + this.time * 0.05) * waveAmp;
        const r = currentR + noise;
        const x = Math.cos(angle) * r;
        const y = Math.sin(angle) * r;
        if (j === 0) this.fieldGfx.moveTo(x, y);
        else this.fieldGfx.lineTo(x, y);
      }
    }
    this.fieldGfx.lineStyle(0);
  }

  // ───────────────────────────────────────
  //  5. 유사 입자 — 모래 알갱이가 나선을 따라
  //     바깥에서 중심으로 빨려 들어감
  // ───────────────────────────────────────

  /** 바깥 가장자리에서 모래 알갱이 생성 */
  private spawnGrains() {
    const R = this.radius;
    const count = 3;
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const spawnR = R * (0.75 + Math.random() * 0.2);
      this.grains.push({
        angle,
        radius: spawnR,
        inwardSpeed: 0.12 + Math.random() * 0.18,
        angularSpeed: 0.012 + Math.random() * 0.008,
        size: 1.0 + Math.random() * 1.2,
        spawnRadius: spawnR,
      });
    }
  }

  /** 유사 입자 렌더링 — 나선 경로 위의 모래 알갱이 */
  private drawSandGrains() {
    this.grainGfx.lineStyle(0);
    for (const g of this.grains) {
      const x = Math.cos(g.angle) * g.radius;
      const y = Math.sin(g.angle) * g.radius;

      // 바깥→안쪽 진행도 (0=갓 생성, 1=중심 도달 직전)
      const progress = 1 - g.radius / g.spawnRadius;

      // 바깥에서는 선명, 중심에 가까울수록 흐려짐 (삼켜지는 느낌)
      const alpha = (1 - progress * 0.7) * 0.55;
      // 안쪽으로 갈수록 살짝 작아짐
      const sz = g.size * (1 - progress * 0.4);

      // 코어
      this.grainGfx.beginFill(this.COL_SAND, alpha);
      this.grainGfx.drawCircle(x, y, sz);
      this.grainGfx.endFill();

      // 은은한 글로우 (모래 알갱이 뒤의 잔상)
      this.grainGfx.beginFill(this.COL_MAIN, alpha * 0.25);
      this.grainGfx.drawCircle(x, y, sz * 2.5);
      this.grainGfx.endFill();
    }
  }

  // ═══════════════════════════════════════════════════════════

  stop() {
    this.active = false;
    this.container.visible = false;
    this.ripples = [];
    this.grains = [];
    this.glowGfx.clear();
    this.fieldGfx.clear();
    this.grainGfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
