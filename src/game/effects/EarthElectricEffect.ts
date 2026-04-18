import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 흙+전기 2단계 — 테슬라 늪 (Tesla Mire)
 *
 * 컨셉: 흙 1단계(EarthEffect) 베이스 + 영역 내 모든 적에게 캐릭터에서
 *        자동 테슬라 아크가 은은하게 연결되어 감전된다.
 *        흙 베이스는 단순/가벼움. 전기 아크가 메인 임팩트.
 *
 * 3단계 물+흙+전기(감전 퀵샌드)와의 차이:
 *   - 베이스: 흙 1단계(단순) — 그라데이션, 심연, 5팔 나선, 파문, 입자
 *   - 3단계는 퀵샌드 베이스 (흡입 리플/삼킴 펄스/광택 추가)
 *
 * 검증된 컴포넌트 조합:
 *   - 베이스 필드 / 중심 심연 / 모래 나선 / 모래 파문 / 입자 → EarthEffect 차용
 *   - 테슬라 아크 → ElectricEffect의 makePath + 4패스 (얇은 버전, 좌표 기반)
 *
 * 좌표계: EarthEffect와 동일 — 컨테이너 = 캐릭터 위치, 로컬 좌표.
 *         테슬라 아크는 (0,0) 원점(=캐릭터)에서 적 로컬 좌표(적 - 캐릭터)로 그림.
 *
 * 풀 재사용 방어: engine이 매 프레임 영역 내 적 좌표(인덱스 X)만 전달.
 */

// ── 모래 파문 (중심 → 바깥) ──
interface SandRipple {
  progress: number;
  seed: number;
}

// ── 유사 입자 ──
interface SandGrain {
  angle: number;
  radius: number;
  inwardSpeed: number;
  angularSpeed: number;
  size: number;
  spawnRadius: number;
}

export class EarthElectricEffect {
  private container: PIXI.Container;
  private glowGfx: PIXI.Graphics;
  private fieldGfx: PIXI.Graphics;
  private grainGfx: PIXI.Graphics;
  /** 테슬라 아크 외곽 글로우 (ADD, 가장 위) */
  private arcGlowGfx: PIXI.Graphics;
  /** 테슬라 아크 코어/심선 (NORMAL, 가장 위) */
  private arcCoreGfx: PIXI.Graphics;

  active = false;
  radius = 0;
  private time = 0;
  private spiralRotation = 0;

  // 모래 파문
  private ripples: SandRipple[] = [];
  private rippleSpawnTimer = 0;
  private readonly RIPPLE_SPAWN_INTERVAL = 45;

  // 유사 입자
  private grains: SandGrain[] = [];
  private grainSpawnTimer = 0;

  /** 테슬라 타겟 — engine이 매 프레임 영역 내 모든 적의 캐릭터 기준 로컬 좌표 전달 */
  private teslaTargets: Array<{ lx: number; ly: number }> = [];

  // ── 모래 색 (흙 1단계와 동일) ──
  private readonly COL_ABYSS  = 0x1a0f02;
  private readonly COL_PIT    = 0x2d1a04;
  private readonly COL_EDGE   = 0x5c3d08;
  private readonly COL_DARK   = 0x78520a;
  private readonly COL_MAIN   = 0xa16207;
  private readonly COL_MID    = 0xb8860b;
  private readonly COL_SAND   = 0xd4a53c;
  private readonly COL_LIGHT  = 0xe8c882;

  // ── 전기 호 색 (노란) ──
  private readonly COL_ARC_OUTER = 0xeab308;
  private readonly COL_ARC_MID   = 0xfde047;
  private readonly COL_ARC_INNER = 0xfef9c3;
  private readonly COL_ARC_CORE  = 0xffffff;

  constructor(parent: PIXI.Container) {
    this.container = new PIXI.Container();
    parent.addChild(this.container);

    // 글로우 (가장 아래, ADD)
    this.glowGfx = new PIXI.Graphics();
    this.glowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.glowGfx);

    // 모래 필드
    this.fieldGfx = new PIXI.Graphics();
    this.container.addChild(this.fieldGfx);

    // 모래 입자 (ADD)
    this.grainGfx = new PIXI.Graphics();
    this.grainGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.grainGfx);

    // ★ 가장 위: 테슬라 아크 글로우 + 코어
    this.arcGlowGfx = new PIXI.Graphics();
    this.arcGlowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.arcGlowGfx);

    this.arcCoreGfx = new PIXI.Graphics();
    this.container.addChild(this.arcCoreGfx);
  }

  start(x: number, y: number, radius: number) {
    this.active = true;
    this.radius = radius;
    this.time = 0;
    this.spiralRotation = 0;
    this.ripples = [];
    this.grains = [];
    this.teslaTargets = [];
    this.rippleSpawnTimer = 0;
    this.grainSpawnTimer = 0;
    this.container.position.set(x, y);
    this.container.visible = true;
  }

  setPosition(x: number, y: number) {
    this.container.position.set(x, y);
  }

  /** engine이 매 프레임 호출 — 영역 내 적의 캐릭터 기준 로컬 좌표 전달 */
  setTeslaTargets(targets: Array<{ lx: number; ly: number }>) {
    this.teslaTargets = targets;
  }

  update(dt: number) {
    if (!this.active) return;
    this.time += dt;

    // 흙 1단계와 같은 회전 속도
    this.spiralRotation -= 0.008 * dt;

    // ── 모래 파문 (중심→바깥) ──
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

    // ── 유사 입자 ──
    this.grainSpawnTimer += dt;
    if (this.grainSpawnTimer >= 2 && this.grains.length < 60) {
      this.grainSpawnTimer = 0;
      this.spawnGrains();
    }
    const R = this.radius;
    for (let i = this.grains.length - 1; i >= 0; i--) {
      const g = this.grains[i];
      g.radius -= g.inwardSpeed * dt;
      g.angle += g.angularSpeed * dt;
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
    this.arcGlowGfx.clear();
    this.arcCoreGfx.clear();

    this.drawFieldGradient();
    this.drawCenterAbyss();
    this.drawQuicksandSpirals();
    this.drawSandRipples();
    this.drawSandGrains();
    this.drawTeslaArcs();
  }

  // ── 1. 베이스 필드 (흙 1단계와 동일) ──
  private drawFieldGradient() {
    const R = this.radius;
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

    const breathe = 1 + Math.sin(this.time * 0.03) * 0.015;
    this.fieldGfx.lineStyle(2, this.COL_DARK, 0.35);
    this.fieldGfx.drawCircle(0, 0, R * breathe);
    this.fieldGfx.lineStyle(1, this.COL_MAIN, 0.15);
    this.fieldGfx.drawCircle(0, 0, R * breathe * 0.96);
  }

  // ── 2. 중심 심연 (흙 1단계와 동일) ──
  private drawCenterAbyss() {
    const R = this.radius;
    const pulse = 1 + Math.sin(this.time * 0.05) * 0.12;

    this.fieldGfx.beginFill(this.COL_PIT, 0.18 * pulse);
    this.fieldGfx.drawCircle(0, 0, R * 0.18);
    this.fieldGfx.endFill();

    this.fieldGfx.beginFill(this.COL_PIT, 0.25 * pulse);
    this.fieldGfx.drawCircle(0, 0, R * 0.11);
    this.fieldGfx.endFill();

    this.fieldGfx.beginFill(this.COL_ABYSS, 0.3 * pulse);
    this.fieldGfx.drawCircle(0, 0, R * 0.05);
    this.fieldGfx.endFill();

    const ringPulse = 1 + Math.sin(this.time * 0.07) * 0.08;
    this.fieldGfx.lineStyle(1.5, this.COL_DARK, 0.2 * ringPulse);
    this.fieldGfx.drawCircle(0, 0, R * 0.19 * ringPulse);
    this.fieldGfx.lineStyle(0);
  }

  // ── 3. 유사 나선 (흙 1단계와 동일, 5팔) ──
  private drawQuicksandSpirals() {
    const R = this.radius;
    const arms = 5;
    const maxTheta = Math.PI * 4;
    const segments = 80;
    const timePhase = this.time * 0.04;

    for (let arm = 0; arm < arms; arm++) {
      const armOffset = (arm / arms) * Math.PI * 2;

      for (let i = 0; i < segments; i++) {
        const t1 = i / segments;
        const t2 = (i + 1) / segments;

        const r1 = R * 0.92 * (1 - t1);
        const r2 = R * 0.92 * (1 - t2);
        if (r1 < R * 0.06) continue;

        const theta1 = t1 * maxTheta;
        const theta2 = t2 * maxTheta;
        const angle1 = theta1 + armOffset + this.spiralRotation;
        const angle2 = theta2 + armOffset + this.spiralRotation;

        const noise1 = Math.sin(theta1 * 3 + timePhase + arm * 2.1) * r1 * 0.04;
        const noise2 = Math.sin(theta2 * 3 + timePhase + arm * 2.1) * r2 * 0.04;

        const x1 = Math.cos(angle1) * (r1 + noise1);
        const y1 = Math.sin(angle1) * (r1 + noise1);
        const x2 = Math.cos(angle2) * (r2 + noise2);
        const y2 = Math.sin(angle2) * (r2 + noise2);

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

  // ── 4. 모래 파문 (흙 1단계와 동일) ──
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

  // ── 5. 유사 입자 (흙 1단계와 동일) ──
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

  private drawSandGrains() {
    this.grainGfx.lineStyle(0);
    for (const g of this.grains) {
      const x = Math.cos(g.angle) * g.radius;
      const y = Math.sin(g.angle) * g.radius;
      const progress = 1 - g.radius / g.spawnRadius;
      const alpha = (1 - progress * 0.7) * 0.55;
      const sz = g.size * (1 - progress * 0.4);

      this.grainGfx.beginFill(this.COL_SAND, alpha);
      this.grainGfx.drawCircle(x, y, sz);
      this.grainGfx.endFill();

      this.grainGfx.beginFill(this.COL_MAIN, alpha * 0.25);
      this.grainGfx.drawCircle(x, y, sz * 2.5);
      this.grainGfx.endFill();
    }
  }

  // ───────────────────────────────────────────────────────────
  //  ★ 6. 테슬라 아크 — 캐릭터에서 영역 내 모든 적에게 자동 연결
  // ───────────────────────────────────────────────────────────

  private drawTeslaArcs() {
    if (this.teslaTargets.length === 0) return;

    // 은은한 sin 호흡 (0.55 ~ 0.75)
    const breathe = 0.65 + Math.sin(this.time * 0.10) * 0.10;

    for (const target of this.teslaTargets) {
      const dx = target.lx;
      const dy = target.ly;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 5) continue;

      // 지그재그 path 생성 (1단계 전기 패턴, 짧고 얇음)
      const segs = 6;
      const jitterAmp = dist * 0.10;
      const perpX = -dy / dist;
      const perpY = dx / dist;

      const pts: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }];
      for (let i = 1; i < segs; i++) {
        const t = i / segs;
        const j = (Math.random() - 0.5) * jitterAmp;
        pts.push({
          x: dx * t + perpX * j,
          y: dy * t + perpY * j,
        });
      }
      pts.push({ x: dx, y: dy });

      // 4패스 (1단계 전기보다 얇음, alpha 낮음 — 은은하게)
      this.arcGlowGfx.lineStyle(4.0, this.COL_ARC_OUTER, 0.32 * breathe);
      this.arcGlowGfx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) this.arcGlowGfx.lineTo(pts[i].x, pts[i].y);

      this.arcGlowGfx.lineStyle(2.5, this.COL_ARC_MID, 0.45 * breathe);
      this.arcGlowGfx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) this.arcGlowGfx.lineTo(pts[i].x, pts[i].y);

      this.arcCoreGfx.lineStyle(1.2, this.COL_ARC_INNER, 0.70 * breathe);
      this.arcCoreGfx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) this.arcCoreGfx.lineTo(pts[i].x, pts[i].y);

      this.arcCoreGfx.lineStyle(0.5, this.COL_ARC_CORE, 0.85 * breathe);
      this.arcCoreGfx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) this.arcCoreGfx.lineTo(pts[i].x, pts[i].y);

      // 적 위치에 작은 백열 스파크 코어
      this.arcCoreGfx.beginFill(this.COL_ARC_INNER, 0.6 * breathe);
      this.arcCoreGfx.drawCircle(dx, dy, 2.0);
      this.arcCoreGfx.endFill();
    }
    this.arcGlowGfx.lineStyle(0);
    this.arcCoreGfx.lineStyle(0);
  }

  stop() {
    this.active = false;
    this.container.visible = false;
    this.ripples = [];
    this.grains = [];
    this.teslaTargets = [];
    this.glowGfx.clear();
    this.fieldGfx.clear();
    this.grainGfx.clear();
    this.arcGlowGfx.clear();
    this.arcCoreGfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
