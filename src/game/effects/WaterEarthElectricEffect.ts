import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 물+흙+전기 3단계 — 감전 퀵샌드 (Charged Quicksand)
 *
 * Phase 3 첫 조합. 퀵샌드(물+흙)의 풍부한 베이스(흡입 리플/삼킴 펄스/광택)를 그대로 두고
 * 영역 내 모든 적에게 캐릭터에서 자동 테슬라 아크가 연결되어 감전된다.
 *
 * 2단계 흙+전기(테슬라 늪)와의 차이:
 *   - 베이스: 흙 1단계(단순) → 퀵샌드(풍부 — 흡입 리플/삼킴 펄스/광택)
 *   - 즉 흙+전기 2단계는 단순한 흙 필드 + 테슬라
 *      물+흙+전기 3단계는 액체 모래 필드 + 테슬라 (더 함정스러움)
 *
 * 검증된 컴포넌트 조합:
 *   - 베이스 필드 / 중심 어두움 / 흡입 리플 / 삼킴 펄스 / 광택 / 입자 → WaterEarthEffect 차용
 *   - 모래 5팔 나선 → WaterEarthEffect.drawSpirals (회전 속도 절반)
 *   - 테슬라 아크 → ElectricEffect의 makePath + 4패스 (얇은 버전, 좌표 기반)
 *
 * 좌표계: WaterEarthEffect와 동일 — 컨테이너 = 캐릭터 위치, 로컬 좌표.
 *         테슬라 아크는 (0,0) 원점(=캐릭터)에서 적 로컬 좌표(적 - 캐릭터)로 그림.
 *
 * 풀 재사용 방어: engine이 매 프레임 영역 내 적 좌표(인덱스 X)만 전달 → 인덱스 추적 무관.
 */

// ── 흡입 리플 (바깥→중심) ──
interface InwardRipple {
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

// ── 젖은 광택 셀 ──
interface WetSheen {
  angle: number;
  radius: number;
  angularSpeed: number;
  size: number;
  life: number;
  maxLife: number;
}

// ── 삼킴 펄스 ──
interface GulpPulse {
  life: number;
  maxLife: number;
  x: number;
  y: number;
}

export class WaterEarthElectricEffect {
  private container: PIXI.Container;
  /** 베이스 글로우 (ADD) */
  private glowGfx: PIXI.Graphics;
  /** 베이스 필드 + 모래 도형 (NORMAL) */
  private fieldGfx: PIXI.Graphics;
  /** 모래 광택 (ADD) */
  private sheenGfx: PIXI.Graphics;
  /** 모래 입자 (ADD) */
  private grainGfx: PIXI.Graphics;
  /** 전기 호 외곽 글로우 (ADD, 가장 위) */
  private arcGlowGfx: PIXI.Graphics;
  /** 전기 호 코어/심선 (NORMAL, 가장 위) */
  private arcCoreGfx: PIXI.Graphics;

  active = false;
  radius = 0;
  private time = 0;
  private spiralRotation = 0;

  // 흡입 리플
  private ripples: InwardRipple[] = [];
  private rippleSpawnTimer = 0;

  // 유사 입자
  private grains: SandGrain[] = [];
  private grainSpawnTimer = 0;

  // 젖은 광택
  private sheens: WetSheen[] = [];
  private sheenSpawnTimer = 0;

  // 삼킴 펄스
  private gulps: GulpPulse[] = [];
  private gulpTimer = 0;

  /** 테슬라 타겟 — engine이 매 프레임 영역 내 적의 캐릭터 기준 로컬 좌표 전달 */
  private teslaTargets: Array<{ lx: number; ly: number }> = [];

  // ── 모래 색상 (퀵샌드와 동일) ──
  private readonly COL_ABYSS     = 0x0d0802;
  private readonly COL_DEEP      = 0x1a0f02;
  private readonly COL_PIT       = 0x2a1a06;
  private readonly COL_WET_DARK  = 0x4a3420;
  private readonly COL_WET_MID   = 0x6b5234;
  private readonly COL_WET_SAND  = 0x8b7348;
  private readonly COL_DRY_EDGE  = 0xa08850;
  private readonly COL_SHEEN     = 0xd4b87a;
  private readonly COL_SHEEN_HOT = 0xe8d4a0;
  private readonly COL_GRAIN     = 0x9e8960;
  private readonly COL_RIPPLE    = 0x6b5838;

  // ── 전기 호 색상 (노란 전기, 모래 갈색 위 강한 대비) ──
  private readonly COL_ARC_OUTER = 0xeab308; // yellow-500 진한 노랑
  private readonly COL_ARC_MID   = 0xfde047; // yellow-300 밝은 노랑
  private readonly COL_ARC_INNER = 0xfef9c3; // yellow-100 연한 크림
  private readonly COL_ARC_CORE  = 0xffffff; // 백열

  constructor(parent: PIXI.Container) {
    this.container = new PIXI.Container();
    parent.addChild(this.container);

    // 가장 아래: 모래 베이스 글로우
    this.glowGfx = new PIXI.Graphics();
    this.glowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.glowGfx);

    // 모래 필드
    this.fieldGfx = new PIXI.Graphics();
    this.container.addChild(this.fieldGfx);

    // 광택
    this.sheenGfx = new PIXI.Graphics();
    this.sheenGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.sheenGfx);

    // 입자
    this.grainGfx = new PIXI.Graphics();
    this.grainGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.grainGfx);

    // ★ 가장 위: 전기 호 글로우 + 코어 (모래를 가리고 강렬하게 보임)
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
    this.sheens = [];
    this.gulps = [];
    this.teslaTargets = [];
    this.rippleSpawnTimer = 0;
    this.grainSpawnTimer = 0;
    this.sheenSpawnTimer = 0;
    this.gulpTimer = 0;
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

    // 회전 (퀵샌드의 절반 — 천천히 묵직하게)
    this.spiralRotation -= 0.003 * dt;

    // ── 흡입 리플 ──
    this.rippleSpawnTimer += dt;
    if (this.rippleSpawnTimer >= 35) {
      this.rippleSpawnTimer = 0;
      this.ripples.push({ progress: 1.0, seed: Math.random() * 1000 });
    }
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      this.ripples[i].progress -= 0.004 * dt; // 퀵샌드 절반
      if (this.ripples[i].progress < 0.05) swapPop(this.ripples, i);
    }

    // ── 유사 입자 ──
    this.grainSpawnTimer += dt;
    if (this.grainSpawnTimer >= 2 && this.grains.length < 70) {
      this.grainSpawnTimer = 0;
      this.spawnGrains();
    }
    const R = this.radius;
    for (let i = this.grains.length - 1; i >= 0; i--) {
      const g = this.grains[i];
      g.radius -= g.inwardSpeed * dt;
      g.angle += g.angularSpeed * dt;
      if (g.radius < R * 0.04) swapPop(this.grains, i);
    }

    // ── 젖은 광택 셀 ──
    this.sheenSpawnTimer += dt;
    if (this.sheenSpawnTimer >= 6 && this.sheens.length < 20) {
      this.sheenSpawnTimer = 0;
      const angle = Math.random() * Math.PI * 2;
      const r = R * (0.15 + Math.random() * 0.7);
      this.sheens.push({
        angle, radius: r,
        angularSpeed: 0.003 + Math.random() * 0.004,
        size: 3 + Math.random() * 6,
        life: 30 + Math.random() * 40,
        maxLife: 30 + Math.random() * 40,
      });
    }
    for (let i = this.sheens.length - 1; i >= 0; i--) {
      const s = this.sheens[i];
      s.angle += s.angularSpeed * dt;
      s.radius -= 0.05 * dt;
      s.life -= dt;
      if (s.life <= 0 || s.radius < R * 0.05) swapPop(this.sheens, i);
    }

    // ── 삼킴 펄스 ──
    this.gulpTimer += dt;
    if (this.gulpTimer >= 80 + Math.random() * 40) {
      this.gulpTimer = 0;
      const gAngle = Math.random() * Math.PI * 2;
      const gR = R * (0.2 + Math.random() * 0.5);
      this.gulps.push({
        life: 25, maxLife: 25,
        x: Math.cos(gAngle) * gR,
        y: Math.sin(gAngle) * gR,
      });
    }
    for (let i = this.gulps.length - 1; i >= 0; i--) {
      this.gulps[i].life -= dt;
      if (this.gulps[i].life <= 0) swapPop(this.gulps, i);
    }

    this.draw();
  }

  // ═══════════════════════════════════════════════════════════
  //  렌더링
  // ═══════════════════════════════════════════════════════════

  private draw() {
    this.glowGfx.clear();
    this.fieldGfx.clear();
    this.sheenGfx.clear();
    this.grainGfx.clear();
    this.arcGlowGfx.clear();
    this.arcCoreGfx.clear();

    this.drawFieldGradient();
    this.drawCenterAbyss();
    this.drawSandSpirals();   // 모래 5팔 나선 (천천히 회전, 갈색)
    this.drawInwardRipples();
    this.drawGulps();
    this.drawWetSheens();
    this.drawGrains();
    this.drawTeslaArcs();     // ★ 핵심 — 영역 내 적에게 테슬라 아크 (가장 위)
  }

  // ── 1. 베이스 필드 — 젖은 모래 그라데이션 ──
  private drawFieldGradient() {
    const R = this.radius;

    const layers: Array<{ rFrac: number; color: number; alpha: number }> = [
      { rFrac: 1.00, color: this.COL_DRY_EDGE,  alpha: 0.16 },
      { rFrac: 0.92, color: this.COL_WET_SAND,   alpha: 0.14 },
      { rFrac: 0.78, color: this.COL_WET_MID,    alpha: 0.13 },
      { rFrac: 0.62, color: this.COL_WET_DARK,   alpha: 0.14 },
      { rFrac: 0.45, color: this.COL_PIT,         alpha: 0.15 },
      { rFrac: 0.28, color: this.COL_DEEP,        alpha: 0.16 },
    ];
    for (const l of layers) {
      this.fieldGfx.beginFill(l.color, l.alpha);
      this.fieldGfx.drawCircle(0, 0, R * l.rFrac);
      this.fieldGfx.endFill();
    }

    const breathe = 1 + Math.sin(this.time * 0.025) * 0.01;
    this.fieldGfx.lineStyle(2.5, this.COL_WET_DARK, 0.3);
    this.fieldGfx.drawCircle(0, 0, R * breathe);
    this.fieldGfx.lineStyle(1, this.COL_WET_SAND, 0.12);
    this.fieldGfx.drawCircle(0, 0, R * breathe * 0.97);
    this.fieldGfx.lineStyle(0);
  }

  // ── 2. 중심 심연 ──
  private drawCenterAbyss() {
    const R = this.radius;
    const pulse = 1 + Math.sin(this.time * 0.04) * 0.15;

    this.fieldGfx.beginFill(this.COL_PIT, 0.22 * pulse);
    this.fieldGfx.drawCircle(0, 0, R * 0.22);
    this.fieldGfx.endFill();

    this.fieldGfx.beginFill(this.COL_DEEP, 0.3 * pulse);
    this.fieldGfx.drawCircle(0, 0, R * 0.13);
    this.fieldGfx.endFill();

    this.fieldGfx.beginFill(this.COL_ABYSS, 0.4 * pulse);
    this.fieldGfx.drawCircle(0, 0, R * 0.06);
    this.fieldGfx.endFill();

    const ringPulse = 1 + Math.sin(this.time * 0.06) * 0.1;
    this.fieldGfx.lineStyle(1.5, this.COL_WET_DARK, 0.2 * ringPulse);
    this.fieldGfx.drawCircle(0, 0, R * 0.24 * ringPulse);
    this.fieldGfx.lineStyle(0);
  }

  // ───────────────────────────────────────────────────────────
  //  3. 모래 나선 — 5팔 회전 (퀵샌드와 동일한 갈색, 천천히)
  // ───────────────────────────────────────────────────────────

  private drawSandSpirals() {
    const R = this.radius;
    const arms = 5;
    const maxTheta = Math.PI * 4.5;
    const segments = 90;
    const timePhase = this.time * 0.015; // 퀵샌드 0.03 → 절반

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

        // 부드러운 흐름 노이즈
        const noise1 = Math.sin(theta1 * 2.5 + timePhase + arm * 1.7) * r1 * 0.06;
        const noise2 = Math.sin(theta2 * 2.5 + timePhase + arm * 1.7) * r2 * 0.06;

        const x1 = Math.cos(angle1) * (r1 + noise1);
        const y1 = Math.sin(angle1) * (r1 + noise1);
        const x2 = Math.cos(angle2) * (r2 + noise2);
        const y2 = Math.sin(angle2) * (r2 + noise2);

        const thickness = 1.5 + (1 - t1) * 3.5;
        const alpha = 0.07 + (1 - t1) * 0.18;

        // 갈색 (안쪽이 더 어두움)
        const color = t1 < 0.3 ? this.COL_WET_SAND
                    : t1 < 0.6 ? this.COL_GRAIN
                    : this.COL_WET_DARK;

        this.fieldGfx.lineStyle(thickness, color, alpha);
        this.fieldGfx.moveTo(x1, y1);
        this.fieldGfx.lineTo(x2, y2);
      }
    }
    this.fieldGfx.lineStyle(0);
  }

  // ───────────────────────────────────────────────────────────
  //  ★ 8. 테슬라 아크 — 캐릭터에서 영역 내 적에게 자동 연결, 은은한 치지직
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

      // 지그재그 path 생성 (1단계 전기 makePath 패턴, 짧고 얇음)
      const segs = 6;
      const jitterAmp = dist * 0.10;
      const perpX = -dy / dist;
      const perpY = dx / dist;

      const pts: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }]; // 캐릭터 (컨테이너 (0,0))
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
      // 1) 외곽 진노랑 (ADD 글로우)
      this.arcGlowGfx.lineStyle(4.0, this.COL_ARC_OUTER, 0.32 * breathe);
      this.arcGlowGfx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) this.arcGlowGfx.lineTo(pts[i].x, pts[i].y);

      // 2) 글로우 노랑 (ADD)
      this.arcGlowGfx.lineStyle(2.5, this.COL_ARC_MID, 0.45 * breathe);
      this.arcGlowGfx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) this.arcGlowGfx.lineTo(pts[i].x, pts[i].y);

      // 3) 코어 크림 (NORMAL)
      this.arcCoreGfx.lineStyle(1.2, this.COL_ARC_INNER, 0.70 * breathe);
      this.arcCoreGfx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) this.arcCoreGfx.lineTo(pts[i].x, pts[i].y);

      // 4) 심선 백열 (NORMAL)
      this.arcCoreGfx.lineStyle(0.5, this.COL_ARC_CORE, 0.85 * breathe);
      this.arcCoreGfx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) this.arcCoreGfx.lineTo(pts[i].x, pts[i].y);

      // 적 위치에 작은 스파크 코어 (감전 표시)
      this.arcCoreGfx.beginFill(this.COL_ARC_INNER, 0.6 * breathe);
      this.arcCoreGfx.drawCircle(dx, dy, 2.0);
      this.arcCoreGfx.endFill();
    }
    this.arcGlowGfx.lineStyle(0);
    this.arcCoreGfx.lineStyle(0);
  }

  // ── 4. 흡입 리플 ──
  private drawInwardRipples() {
    const R = this.radius;

    for (const ripple of this.ripples) {
      const p = ripple.progress;
      const currentR = R * p * 0.88;
      if (currentR < 5) continue;

      const fadeIn = p < 0.9 ? (1 - (p - 0.9) / 0.1) : 1;
      const fadeOut = p < 0.15 ? p / 0.15 : 1;
      const lifeAlpha = Math.min(fadeIn, fadeOut);
      if (lifeAlpha < 0.01) continue;

      const segments = 50;
      const step = (Math.PI * 2) / segments;
      const waveAmp = currentR * 0.04;

      this.fieldGfx.lineStyle(1.5, this.COL_RIPPLE, lifeAlpha * 0.25);
      for (let j = 0; j <= segments; j++) {
        const angle = j * step;
        const noise = Math.sin(angle * 6 + ripple.seed + this.time * 0.04) * waveAmp;
        const r = currentR + noise;
        const x = Math.cos(angle) * r;
        const y = Math.sin(angle) * r;
        if (j === 0) this.fieldGfx.moveTo(x, y);
        else this.fieldGfx.lineTo(x, y);
      }
    }
    this.fieldGfx.lineStyle(0);
  }

  // ── 5. 삼킴 펄스 ──
  private drawGulps() {
    for (const g of this.gulps) {
      const lifeRatio = g.life / g.maxLife;
      const sinkPhase = lifeRatio > 0.5
        ? (1 - lifeRatio) / 0.5
        : lifeRatio / 0.5;

      const sinkSize = 12 + sinkPhase * 15;
      const sinkAlpha = sinkPhase * 0.25;

      this.fieldGfx.beginFill(this.COL_DEEP, sinkAlpha);
      this.fieldGfx.drawCircle(g.x, g.y, sinkSize);
      this.fieldGfx.endFill();

      this.fieldGfx.lineStyle(1, this.COL_WET_DARK, sinkAlpha * 0.6);
      this.fieldGfx.drawCircle(g.x, g.y, sinkSize * 1.3);
      this.fieldGfx.lineStyle(0);

      if (lifeRatio < 0.3) {
        const flashA = (0.3 - lifeRatio) / 0.3;
        this.sheenGfx.beginFill(this.COL_SHEEN, flashA * 0.15);
        this.sheenGfx.drawCircle(g.x, g.y, sinkSize * 0.6);
        this.sheenGfx.endFill();
      }
    }
  }

  // ── 6. 젖은 광택 ──
  private drawWetSheens() {
    this.sheenGfx.lineStyle(0);
    for (const s of this.sheens) {
      const x = Math.cos(s.angle) * s.radius;
      const y = Math.sin(s.angle) * s.radius;
      const lt = s.life / s.maxLife;
      const alpha = lt < 0.3 ? lt / 0.3 : lt > 0.7 ? (1 - lt) / 0.3 : 1;

      this.sheenGfx.beginFill(this.COL_SHEEN, alpha * 0.08);
      this.sheenGfx.drawCircle(x, y, s.size * 2);
      this.sheenGfx.endFill();

      this.sheenGfx.beginFill(this.COL_SHEEN_HOT, alpha * 0.12);
      this.sheenGfx.drawCircle(x, y, s.size * 0.7);
      this.sheenGfx.endFill();
    }
  }

  // ── 7. 유사 입자 ──
  private spawnGrains() {
    const R = this.radius;
    for (let i = 0; i < 3; i++) {
      const angle = Math.random() * Math.PI * 2;
      const spawnR = R * (0.7 + Math.random() * 0.25);
      this.grains.push({
        angle, radius: spawnR,
        inwardSpeed: 0.05 + Math.random() * 0.07, // 퀵샌드 절반
        angularSpeed: 0.005 + Math.random() * 0.004, // 퀵샌드 절반
        size: 1.0 + Math.random() * 1.3,
        spawnRadius: spawnR,
      });
    }
  }

  private drawGrains() {
    this.grainGfx.lineStyle(0);
    for (const g of this.grains) {
      const x = Math.cos(g.angle) * g.radius;
      const y = Math.sin(g.angle) * g.radius;
      const progress = 1 - g.radius / g.spawnRadius;
      const alpha = (1 - progress * 0.7) * 0.45;
      const sz = g.size * (1 - progress * 0.4);

      this.grainGfx.beginFill(this.COL_GRAIN, alpha);
      this.grainGfx.drawCircle(x, y, sz);
      this.grainGfx.endFill();

      this.grainGfx.beginFill(this.COL_GRAIN, alpha * 0.2);
      this.grainGfx.drawCircle(x, y, sz * 2.5);
      this.grainGfx.endFill();
    }
  }

  stop() {
    this.active = false;
    this.container.visible = false;
    this.ripples = [];
    this.grains = [];
    this.sheens = [];
    this.gulps = [];
    this.teslaTargets = [];
    this.glowGfx.clear();
    this.fieldGfx.clear();
    this.sheenGfx.clear();
    this.grainGfx.clear();
    this.arcGlowGfx.clear();
    this.arcCoreGfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
