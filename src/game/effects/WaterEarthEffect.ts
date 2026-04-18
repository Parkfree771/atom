import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 물+흙 2단계 — 퀵샌드 (Quicksand)
 *
 * 물 머금은 모래가 발을 삼킨다.
 * 흙 1단계 베이스 (나선+입자) + 젖은 표면 + 안쪽 흡입 리플 + 삼킴 맥동.
 * 마른 모래가 아닌 "살아있는 액체 모래".
 *
 * 컨테이너는 플레이어 위치.
 */

// ── 흡입 리플 (바깥→중심) ──
interface InwardRipple {
  progress: number; // 1→0 (바깥에서 안쪽으로)
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

export class WaterEarthEffect {
  private container: PIXI.Container;
  private glowGfx: PIXI.Graphics;
  private fieldGfx: PIXI.Graphics;
  private grainGfx: PIXI.Graphics;
  private sheenGfx: PIXI.Graphics;

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

  // ── 색상: 젖은 모래 (촉촉하고 어두운 사막 톤) ──
  private readonly COL_ABYSS     = 0x0d0802;  // 심연 — 거의 검정 (물에 잠긴)
  private readonly COL_DEEP      = 0x1a0f02;  // 깊은 심연
  private readonly COL_PIT       = 0x2a1a06;  // 젖은 구덩이
  private readonly COL_WET_DARK  = 0x4a3420;  // 젖은 어두운 모래
  private readonly COL_WET_MID   = 0x6b5234;  // 젖은 중간 모래
  private readonly COL_WET_SAND  = 0x8b7348;  // 젖은 모래
  private readonly COL_DRY_EDGE  = 0xa08850;  // 바깥 가장자리 (약간 마른)
  private readonly COL_SHEEN     = 0xd4b87a;  // 광택 하이라이트
  private readonly COL_SHEEN_HOT = 0xe8d4a0;  // 강한 광택
  private readonly COL_SPIRAL    = 0x7a6340;  // 나선 색
  private readonly COL_GRAIN     = 0x9e8960;  // 입자 색
  private readonly COL_RIPPLE    = 0x6b5838;  // 리플 색

  constructor(parent: PIXI.Container) {
    this.container = new PIXI.Container();
    parent.addChild(this.container);

    this.glowGfx = new PIXI.Graphics();
    this.glowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.glowGfx);

    this.fieldGfx = new PIXI.Graphics();
    this.container.addChild(this.fieldGfx);

    this.sheenGfx = new PIXI.Graphics();
    this.sheenGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.sheenGfx);

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
    this.grains = [];
    this.sheens = [];
    this.gulps = [];
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

  update(dt: number) {
    if (!this.active) return;
    this.time += dt;

    // 나선 회전 (흙 1단계보다 느리고 유동적)
    this.spiralRotation -= 0.006 * dt;

    // ── 흡입 리플 (바깥→중심) ──
    this.rippleSpawnTimer += dt;
    if (this.rippleSpawnTimer >= 35) {
      this.rippleSpawnTimer = 0;
      this.ripples.push({ progress: 1.0, seed: Math.random() * 1000 });
    }
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      this.ripples[i].progress -= 0.008 * dt; // 안쪽으로 수축
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
      s.radius -= 0.05 * dt; // 천천히 안쪽으로
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

    this.drawFieldGradient();
    this.drawCenterAbyss();
    this.drawSpirals();
    this.drawInwardRipples();
    this.drawGulps();
    this.drawWetSheens();
    this.drawGrains();
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

    // 경계 — 젖은 테두리
    const breathe = 1 + Math.sin(this.time * 0.025) * 0.01;
    this.fieldGfx.lineStyle(2.5, this.COL_WET_DARK, 0.3);
    this.fieldGfx.drawCircle(0, 0, R * breathe);
    this.fieldGfx.lineStyle(1, this.COL_WET_SAND, 0.12);
    this.fieldGfx.drawCircle(0, 0, R * breathe * 0.97);
    this.fieldGfx.lineStyle(0);
  }

  // ── 2. 중심 심연 — 더 깊고 액체처럼 ──
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

    // 심연 테두리 — 맥동
    const ringPulse = 1 + Math.sin(this.time * 0.06) * 0.1;
    this.fieldGfx.lineStyle(1.5, this.COL_WET_DARK, 0.2 * ringPulse);
    this.fieldGfx.drawCircle(0, 0, R * 0.24 * ringPulse);
    this.fieldGfx.lineStyle(0);
  }

  // ── 3. 나선 — 유동적인 젖은 모래 줄기 ──
  private drawSpirals() {
    const R = this.radius;
    const arms = 5;
    const maxTheta = Math.PI * 4.5; // 흙 1단계(4)보다 더 감김
    const segments = 90;
    const timePhase = this.time * 0.03;

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

        // 유동적 노이즈 (흙 1단계보다 큰 진폭 → 액체 느낌)
        const noise1 = Math.sin(theta1 * 2.5 + timePhase + arm * 1.7) * r1 * 0.06;
        const noise2 = Math.sin(theta2 * 2.5 + timePhase + arm * 1.7) * r2 * 0.06;

        const x1 = Math.cos(angle1) * (r1 + noise1);
        const y1 = Math.sin(angle1) * (r1 + noise1);
        const x2 = Math.cos(angle2) * (r2 + noise2);
        const y2 = Math.sin(angle2) * (r2 + noise2);

        const thickness = 1.5 + (1 - t1) * 3.5;
        const alpha = 0.07 + (1 - t1) * 0.18;

        // 안쪽으로 갈수록 어두워짐
        const color = t1 < 0.3 ? this.COL_WET_SAND
                    : t1 < 0.6 ? this.COL_SPIRAL
                    : this.COL_WET_DARK;

        this.fieldGfx.lineStyle(thickness, color, alpha);
        this.fieldGfx.moveTo(x1, y1);
        this.fieldGfx.lineTo(x2, y2);
      }
    }
    this.fieldGfx.lineStyle(0);
  }

  // ── 4. 흡입 리플 — 바깥에서 중심으로 수축하는 동심원 ──
  private drawInwardRipples() {
    const R = this.radius;

    for (const ripple of this.ripples) {
      const p = ripple.progress; // 1→0
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

  // ── 5. 삼킴 펄스 — 꿀꺽 꺼졌다 올라오는 맥동 ──
  private drawGulps() {
    for (const g of this.gulps) {
      const lifeRatio = g.life / g.maxLife;
      // 전반: 꺼짐 (어두워짐) → 후반: 복원
      const sinkPhase = lifeRatio > 0.5
        ? (1 - lifeRatio) / 0.5  // 0→1 (꺼지는 중)
        : lifeRatio / 0.5;       // 1→0 (복원 중)

      const sinkSize = 12 + sinkPhase * 15;
      const sinkAlpha = sinkPhase * 0.25;

      // 어두운 웅덩이
      this.fieldGfx.beginFill(this.COL_DEEP, sinkAlpha);
      this.fieldGfx.drawCircle(g.x, g.y, sinkSize);
      this.fieldGfx.endFill();

      // 가장자리 링
      this.fieldGfx.lineStyle(1, this.COL_WET_DARK, sinkAlpha * 0.6);
      this.fieldGfx.drawCircle(g.x, g.y, sinkSize * 1.3);
      this.fieldGfx.lineStyle(0);

      // 복원 시 약한 광택 (물기 반짝)
      if (lifeRatio < 0.3) {
        const flashA = (0.3 - lifeRatio) / 0.3;
        this.sheenGfx.beginFill(this.COL_SHEEN, flashA * 0.15);
        this.sheenGfx.drawCircle(g.x, g.y, sinkSize * 0.6);
        this.sheenGfx.endFill();
      }
    }
  }

  // ── 6. 젖은 광택 — 표면에서 흘러다니는 하이라이트 ──
  private drawWetSheens() {
    this.sheenGfx.lineStyle(0);
    for (const s of this.sheens) {
      const x = Math.cos(s.angle) * s.radius;
      const y = Math.sin(s.angle) * s.radius;
      const lt = s.life / s.maxLife;
      const alpha = lt < 0.3 ? lt / 0.3 : lt > 0.7 ? (1 - lt) / 0.3 : 1;

      // 넓은 은은한 광택
      this.sheenGfx.beginFill(this.COL_SHEEN, alpha * 0.08);
      this.sheenGfx.drawCircle(x, y, s.size * 2);
      this.sheenGfx.endFill();

      // 밝은 핵
      this.sheenGfx.beginFill(this.COL_SHEEN_HOT, alpha * 0.12);
      this.sheenGfx.drawCircle(x, y, s.size * 0.7);
      this.sheenGfx.endFill();
    }
  }

  // ── 7. 유사 입자 — 나선 따라 빨려드는 모래 알갱이 ──
  private spawnGrains() {
    const R = this.radius;
    for (let i = 0; i < 3; i++) {
      const angle = Math.random() * Math.PI * 2;
      const spawnR = R * (0.7 + Math.random() * 0.25);
      this.grains.push({
        angle, radius: spawnR,
        inwardSpeed: 0.1 + Math.random() * 0.15,
        angularSpeed: 0.01 + Math.random() * 0.008,
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

      this.grainGfx.beginFill(this.COL_SPIRAL, alpha * 0.2);
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
    this.glowGfx.clear();
    this.fieldGfx.clear();
    this.sheenGfx.clear();
    this.grainGfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
