import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 빛+암흑 2단계 — 초신성 (Supernova)
 *
 * 컨셉: 빛 원과 흑 원이 캐릭터 좌우에 따로 생성 → 서로 향해 천천히 접근 →
 *        충돌하며 격렬한 스파크 → 합체 → SUPERNOVA EXPLOSION (역대급 폭발)
 *        + 광역 데미지/넉백 + 사방으로 16발 빔 발사.
 *
 *        다른 모든 이펙트와 완전 새로운 거동: 캐릭터 1점 기준 X, 두 원이 만나는 충돌형.
 *        흑 vs 백 본질적 색 대비. GLSL 미사용 (사용자 명시 — 중력 X).
 *
 * 5페이즈 사이클 (총 190프레임 ≈ 3.16초):
 *   1. 생성 (SPAWN,    5f)  — 두 원 캐릭터 좌우 등장 (사이즈 0 → 풀)
 *   2. 접근 (APPROACH, 60f) — 두 원이 캐릭터 중심으로 천천히 이동, 각자 회전 입자
 *   3. 충돌 (COLLISION,30f) — 두 원 거리 가까울수록 격렬한 스파크 + 진동 + 미니 빔
 *   4. 폭발 (SUPERNOVA,60f) — 충격파 4겹 + 사방 빔 16발 + 폭발 셀 120개
 *   5. 잔해 (LINGER,   35f) — 페이드 → 사이클 재시작
 *
 * 검증된 컴포넌트:
 *   - 두 원 회전 입자 → DarkEffect 강착원반 패턴 (작게)
 *   - 충격파 4겹 → WaterFireEffect.drawShockwaves 패턴
 *   - 폭발 셀 → WaterFireEffect.spawnBurst 패턴 (더 많이)
 *   - 사방 빔 16발 → EarthLightEffect.drawSingleBeam 패턴 + 16발 angle 배열
 *
 * 좌표계: 빛 1단계와 동일 — 컨테이너 = 캐릭터 위치, 모든 좌표 로컬.
 *         차징 동안 캐릭터 추적, 폭발 시점에 잠금.
 */

// ── 두 원 (빛 원 / 흑 원) ──
interface Orb {
  /** 컨테이너 로컬 좌표 (중심) */
  x: number;
  y: number;
  /** 사이즈 (0 → fullSize) */
  size: number;
  /** 알파 (0 → 1) */
  alpha: number;
  /** 0=빛, 1=흑 */
  type: 0 | 1;
  /** 회전 입자 (DarkEffect 강착원반 패턴, 작게) */
  particles: OrbParticle[];
  /** 진동 오프셋 (충돌 단계) */
  shakeX: number;
  shakeY: number;
}

interface OrbParticle {
  angle: number;
  radius: number;
  angularSpeed: number;
  size: number;
}

// ── 충돌 스파크 (두 원 사이) ──
interface CollisionSpark {
  x: number; y: number;
  vx: number; vy: number;
  life: number;
  maxLife: number;
  /** 0=빛(백/금), 1=암흑(보라) */
  type: 0 | 1;
  size: number;
}

// ── 폭발 셀 ──
interface BurstParticle {
  x: number; y: number;
  vx: number; vy: number;
  life: number;
  maxLife: number;
  size: number;
  /** 0=백열, 1=황금, 2=검은 잔해 */
  type: 0 | 1 | 2;
}

// ── 충격파 ──
interface Shockwave {
  progress: number;
  delay: number;
}

const enum SupernovaPhase {
  SPAWN = 0,
  APPROACH = 1,
  COLLISION = 2,
  SUPERNOVA = 3,
  LINGER = 4,
}

export class LightDarkEffect {
  private container: PIXI.Container;
  /** ADD 블렌드 (글로우, 충격파, 폭발 셀 글로우, 충돌 스파크 글로우) */
  private glowGfx: PIXI.Graphics;
  /** NORMAL (두 원 본체, 폭발 셀 본체, 충돌 스파크 본체) */
  private cellGfx: PIXI.Graphics;
  /** NORMAL (빔 라인 — 가장 위) */
  private beamGfx: PIXI.Graphics;

  active = false;
  private posX = 0;
  private posY = 0;

  // 페이즈
  private phase: SupernovaPhase = SupernovaPhase.SPAWN;
  private phaseTimer = 0;
  private readonly SPAWN_DURATION = 5;
  private readonly APPROACH_DURATION = 100; // 더 천천히 (60 → 100)
  private readonly COLLISION_DURATION = 50; // 더 격렬한 충돌 시간 (30 → 50)
  private readonly SUPERNOVA_DURATION = 70; // 폭발도 살짝 더 길게 (60 → 70)
  private readonly LINGER_DURATION = 40;

  // 폭발 발동 (엔진 통신)
  supernovaFiredThisFrame = false;
  readonly burstRadius = 350;

  // 사방 빔 16발 (22.5° 간격, 360° 전체)
  static readonly BEAM_ANGLES: number[] = (() => {
    const arr: number[] = [];
    const N = 16;
    for (let i = 0; i < N; i++) {
      arr.push((i / N) * Math.PI * 2);
    }
    return arr;
  })();
  readonly beamRange = 1500;

  // 두 원
  private orbs: Orb[] = [];
  private readonly ORB_FULL_SIZE = 24;
  private readonly ORB_START_DIST = 80;

  // 충돌 스파크
  private collisionSparks: CollisionSpark[] = [];

  // 폭발
  private burstParticles: BurstParticle[] = [];
  private shockwaves: Shockwave[] = [];

  // 위치 잠금 (폭발/잔해 동안)
  private locked = false;

  // ── 색 ──
  // 빛
  private readonly COL_LIGHT_CORE   = 0xfef9c3; // cream / yellow-100 (백 대신, 일반 사용)
  private readonly COL_LIGHT_GLOW   = 0xfde047; // yellow-300
  private readonly COL_LIGHT_DEEP   = 0xeab308; // yellow-500
  // 암흑
  private readonly COL_DARK_CORE    = 0x0a0015; // 거의 검정
  private readonly COL_DARK_GLOW    = 0x1a0530; // 짙은 보라
  private readonly COL_DARK_LIGHT   = 0x44168b; // 진보라
  // 폭발 충격파/셀 (초신성 그라데이션)
  private readonly COL_BURST_WHITE  = 0xfffef5; // 백열 (가장 강력한 폭발이라 임팩트 1점 백 OK)
  private readonly COL_BURST_GOLD   = 0xfde047;
  private readonly COL_BURST_ORANGE = 0xea580c;
  private readonly COL_BURST_DARK   = 0x44181a; // 검적 잔해

  constructor(parent: PIXI.Container) {
    this.container = new PIXI.Container();
    parent.addChild(this.container);

    // 글로우 (가장 아래, ADD)
    this.glowGfx = new PIXI.Graphics();
    this.glowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.glowGfx);

    // 본체 (NORMAL)
    this.cellGfx = new PIXI.Graphics();
    this.container.addChild(this.cellGfx);

    // 빔 (위)
    this.beamGfx = new PIXI.Graphics();
    this.container.addChild(this.beamGfx);
  }

  start(x: number, y: number) {
    this.active = true;
    this.posX = x;
    this.posY = y;
    this.phase = SupernovaPhase.SPAWN;
    this.phaseTimer = 0;
    this.locked = false;
    this.supernovaFiredThisFrame = false;
    this.collisionSparks = [];
    this.burstParticles = [];
    this.shockwaves = [];
    this.spawnOrbs();
    this.container.position.set(x, y);
    this.container.visible = true;
  }

  setPosition(x: number, y: number) {
    if (this.locked) return;
    this.posX = x;
    this.posY = y;
    this.container.position.set(x, y);
  }

  /** 폭발 중심 좌표 (월드) */
  get centerX(): number { return this.posX; }
  get centerY(): number { return this.posY; }

  // ═══════════════════════════════════════════════════════════
  //  업데이트
  // ═══════════════════════════════════════════════════════════

  update(dt: number) {
    if (!this.active) return;
    this.phaseTimer += dt;
    this.supernovaFiredThisFrame = false;

    switch (this.phase) {
      case SupernovaPhase.SPAWN:
        this.updateSpawn(dt);
        if (this.phaseTimer >= this.SPAWN_DURATION) {
          this.phase = SupernovaPhase.APPROACH;
          this.phaseTimer = 0;
        }
        break;

      case SupernovaPhase.APPROACH:
        this.updateApproach(dt);
        if (this.phaseTimer >= this.APPROACH_DURATION) {
          this.phase = SupernovaPhase.COLLISION;
          this.phaseTimer = 0;
        }
        break;

      case SupernovaPhase.COLLISION:
        this.updateCollision(dt);
        if (this.phaseTimer >= this.COLLISION_DURATION) {
          this.phase = SupernovaPhase.SUPERNOVA;
          this.phaseTimer = 0;
          // 폭발 발동
          this.locked = true;
          this.supernovaFiredThisFrame = true;
          this.spawnSupernova();
          this.orbs = [];
          this.collisionSparks = [];
        }
        break;

      case SupernovaPhase.SUPERNOVA:
        this.updateSupernova(dt);
        if (this.phaseTimer >= this.SUPERNOVA_DURATION) {
          this.phase = SupernovaPhase.LINGER;
          this.phaseTimer = 0;
        }
        break;

      case SupernovaPhase.LINGER:
        this.updateSupernova(dt); // 페이드만
        if (this.phaseTimer >= this.LINGER_DURATION) {
          // 사이클 재시작
          this.phase = SupernovaPhase.SPAWN;
          this.phaseTimer = 0;
          this.locked = false;
          this.burstParticles = [];
          this.shockwaves = [];
          this.spawnOrbs();
        }
        break;
    }

    this.draw();
  }

  // ═══════════════════════════════════════════════════════════
  //  Phase 1 — 생성
  // ═══════════════════════════════════════════════════════════

  private spawnOrbs() {
    this.orbs = [
      // 빛 원 (우측)
      {
        x: this.ORB_START_DIST,
        y: 0,
        size: 0,
        alpha: 0,
        type: 0,
        particles: this.makeOrbParticles(0),
        shakeX: 0,
        shakeY: 0,
      },
      // 흑 원 (좌측)
      {
        x: -this.ORB_START_DIST,
        y: 0,
        size: 0,
        alpha: 0,
        type: 1,
        particles: this.makeOrbParticles(1),
        shakeX: 0,
        shakeY: 0,
      },
    ];
  }

  private makeOrbParticles(type: 0 | 1): OrbParticle[] {
    const count = 7;
    const particles: OrbParticle[] = [];
    for (let i = 0; i < count; i++) {
      particles.push({
        angle: (i / count) * Math.PI * 2 + Math.random() * 0.4,
        radius: this.ORB_FULL_SIZE * (0.85 + Math.random() * 0.45),
        angularSpeed: (0.04 + Math.random() * 0.025) * (type === 0 ? 1 : -1),
        size: 1.0 + Math.random() * 0.8,
      });
    }
    return particles;
  }

  private updateSpawn(dt: number) {
    const t = this.phaseTimer / this.SPAWN_DURATION;
    // ease-out cubic
    const ease = 1 - Math.pow(1 - t, 3);
    for (const orb of this.orbs) {
      orb.size = this.ORB_FULL_SIZE * ease;
      orb.alpha = ease;
    }
    // 회전 입자도 회전
    this.updateOrbParticles(dt);
  }

  // ═══════════════════════════════════════════════════════════
  //  Phase 2 — 접근
  // ═══════════════════════════════════════════════════════════

  private updateApproach(dt: number) {
    // 두 원이 캐릭터 중심으로 천천히 이동
    // 60f 동안 80px → 22px 이동 (충돌 시작 거리)
    const t = this.phaseTimer / this.APPROACH_DURATION;
    const ease = 1 - Math.pow(1 - t, 1.6); // 약간 가속
    const COLLISION_DIST = 22;
    const dist = this.ORB_START_DIST - (this.ORB_START_DIST - COLLISION_DIST) * ease;
    // 빛 원: 우측 → 가까이, 흑 원: 좌측 → 가까이
    this.orbs[0].x = dist;
    this.orbs[1].x = -dist;
    // 사이즈/알파 풀 유지
    for (const orb of this.orbs) {
      orb.size = this.ORB_FULL_SIZE;
      orb.alpha = 1;
    }
    this.updateOrbParticles(dt);
  }

  // ═══════════════════════════════════════════════════════════
  //  Phase 3 — 충돌
  // ═══════════════════════════════════════════════════════════

  private updateCollision(dt: number) {
    // 두 원이 22px → 4px (거의 완전히 만남)
    const t = this.phaseTimer / this.COLLISION_DURATION;
    const dist = 22 - 18 * t;
    this.orbs[0].x = dist;
    this.orbs[1].x = -dist;

    // 진동 — 작게 (±0.6 → ±2.0, 사용자 피드백: 흔들림 너무 과함)
    const shakeAmp = 0.6 + t * 1.4;
    for (const orb of this.orbs) {
      orb.shakeX = (Math.random() - 0.5) * shakeAmp * 2;
      orb.shakeY = (Math.random() - 0.5) * shakeAmp * 2;
    }

    this.updateOrbParticles(dt);

    // 충돌 스파크 spawn — 더 격렬 (6 + t*14, 약 6 → 20개/f)
    const sparkRate = 6 + Math.floor(t * 14);
    for (let i = 0; i < sparkRate; i++) {
      this.spawnCollisionSpark();
    }

    // 충돌 스파크 업데이트
    for (let i = this.collisionSparks.length - 1; i >= 0; i--) {
      const s = this.collisionSparks[i];
      s.life += dt;
      if (s.life >= s.maxLife) {
        swapPop(this.collisionSparks, i);
        continue;
      }
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vx *= 0.92;
      s.vy *= 0.92;
    }
  }

  private spawnCollisionSpark() {
    // 두 원 사이 (캐릭터 중심 부근)에서 spawn, 사방으로 분출
    const angle = Math.random() * Math.PI * 2;
    // 속도 더 빠르게 (3~8)
    const speed = 3 + Math.random() * 5;
    const startDist = Math.random() * 8;
    const type: 0 | 1 = Math.random() < 0.5 ? 0 : 1;
    this.collisionSparks.push({
      x: Math.cos(angle) * startDist,
      y: Math.sin(angle) * startDist,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0,
      // 수명 더 길게 (18~32f)
      maxLife: 18 + Math.random() * 14,
      type,
      // 사이즈 더 큼 (1.5~3.3)
      size: 1.5 + Math.random() * 1.8,
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  Phase 4 — SUPERNOVA 폭발
  // ═══════════════════════════════════════════════════════════

  private spawnSupernova() {
    // 충격파 3발 (1차 즉발 + 2차 5f 후 + 3차 12f 후)
    this.shockwaves = [
      { progress: 0, delay: 0 },
      { progress: 0, delay: 5 },
      { progress: 0, delay: 12 },
    ];

    // 폭발 셀 200개 사방 분출 (이전 120 → 200)
    // 빛/어둠 양극이 부딪힌 결과 — 백열/황금/보라/검 모두 분출
    const total = 200;
    for (let i = 0; i < total; i++) {
      const angle = (i / total) * Math.PI * 2 + (Math.random() - 0.5) * 0.22;
      // 속도 더 빠르게 (5~12 → 6~15)
      const speed = 6 + Math.random() * 9;

      const r = Math.random();
      let type: 0 | 1 | 2;
      let size: number;
      let maxLife: number;
      if (r < 0.28) {
        type = 0; // 백열 (코어 임팩트)
        // 사이즈 더 큼 (1.5~3.5 → 1.8~4.5)
        size = 1.8 + Math.random() * 2.7;
        maxLife = 28 + Math.random() * 18;
      } else if (r < 0.78) {
        type = 1; // 황금 (메인)
        size = 1.6 + Math.random() * 2.4;
        maxLife = 32 + Math.random() * 22;
      } else {
        type = 2; // 검은 잔해/보라 (암흑 측)
        size = 1.5 + Math.random() * 2.2;
        maxLife = 42 + Math.random() * 22;
      }

      const startDist = 6 + Math.random() * 8;
      this.burstParticles.push({
        x: Math.cos(angle) * startDist,
        y: Math.sin(angle) * startDist,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        maxLife,
        size,
        type,
      });
    }
  }

  private updateSupernova(dt: number) {
    // 폭발 셀
    for (let i = this.burstParticles.length - 1; i >= 0; i--) {
      const p = this.burstParticles[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        swapPop(this.burstParticles, i);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const drag = p.type === 2 ? 0.93 : 0.94;
      p.vx *= drag;
      p.vy *= drag;
    }

    // 충격파
    for (const sw of this.shockwaves) {
      if (sw.delay > 0) {
        sw.delay -= dt;
        continue;
      }
      sw.progress += dt / 35;
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  공통 — 두 원 회전 입자 업데이트
  // ═══════════════════════════════════════════════════════════

  private updateOrbParticles(dt: number) {
    for (const orb of this.orbs) {
      for (const p of orb.particles) {
        p.angle += p.angularSpeed * dt;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  렌더링
  // ═══════════════════════════════════════════════════════════

  private draw() {
    this.glowGfx.clear();
    this.cellGfx.clear();
    this.beamGfx.clear();

    switch (this.phase) {
      case SupernovaPhase.SPAWN:
      case SupernovaPhase.APPROACH:
        this.drawOrbs();
        break;
      case SupernovaPhase.COLLISION:
        this.drawOrbs();
        this.drawCollisionSparks();
        this.drawMiniBeams();
        break;
      case SupernovaPhase.SUPERNOVA:
      case SupernovaPhase.LINGER:
        this.drawShockwaves();
        this.drawSupernovaBeams();
        this.drawBurstParticles();
        break;
    }
  }

  // ── 두 원 (NORMAL로 꽉 채워서 흰끼 방지 — ADD 글로우 매우 작게만) ──
  private drawOrbs() {
    for (const orb of this.orbs) {
      const ox = orb.x + orb.shakeX;
      const oy = orb.y + orb.shakeY;
      const a = orb.alpha;
      const r = orb.size;

      if (orb.type === 0) {
        // 빛 원 — NORMAL로 4겹 꽉 채움 (밖→안 점점 밝아짐)
        // 1. 가장 바깥 (어두운 황금/갈색)
        this.cellGfx.beginFill(0xb45309, a * 0.55); // amber-700
        this.cellGfx.drawCircle(ox, oy, r * 1.35);
        this.cellGfx.endFill();
        // 2. 외곽 (yellow-500)
        this.cellGfx.beginFill(this.COL_LIGHT_DEEP, a * 0.75);
        this.cellGfx.drawCircle(ox, oy, r * 1.05);
        this.cellGfx.endFill();
        // 3. 중간 (yellow-300)
        this.cellGfx.beginFill(this.COL_LIGHT_GLOW, a * 0.90);
        this.cellGfx.drawCircle(ox, oy, r * 0.78);
        this.cellGfx.endFill();
        // 4. 코어 (cream)
        this.cellGfx.beginFill(this.COL_LIGHT_CORE, a * 0.97);
        this.cellGfx.drawCircle(ox, oy, r * 0.45);
        this.cellGfx.endFill();
        // ADD 글로우는 매우 작게만 (살짝 빛남)
        this.glowGfx.beginFill(this.COL_LIGHT_GLOW, a * 0.18);
        this.glowGfx.drawCircle(ox, oy, r * 0.85);
        this.glowGfx.endFill();
      } else {
        // 흑 원 — NORMAL로 4겹 꽉 채움
        // 1. 가장 바깥 (보라)
        this.cellGfx.beginFill(this.COL_DARK_LIGHT, a * 0.55); // 진보라
        this.cellGfx.drawCircle(ox, oy, r * 1.35);
        this.cellGfx.endFill();
        // 2. 외곽 (짙은 보라)
        this.cellGfx.beginFill(this.COL_DARK_GLOW, a * 0.80);
        this.cellGfx.drawCircle(ox, oy, r * 1.05);
        this.cellGfx.endFill();
        // 3. 중간 (검정 보라)
        this.cellGfx.beginFill(0x05000a, a * 0.92);
        this.cellGfx.drawCircle(ox, oy, r * 0.78);
        this.cellGfx.endFill();
        // 4. 코어 (거의 검정)
        this.cellGfx.beginFill(this.COL_DARK_CORE, a * 0.97);
        this.cellGfx.drawCircle(ox, oy, r * 0.45);
        this.cellGfx.endFill();
        // ADD 글로우 매우 작게 (보라 빛)
        this.glowGfx.beginFill(this.COL_DARK_LIGHT, a * 0.20);
        this.glowGfx.drawCircle(ox, oy, r * 0.85);
        this.glowGfx.endFill();
      }

      // 회전 입자 (NORMAL only — ADD 누적 흰끼 방지)
      for (const p of orb.particles) {
        const px = ox + Math.cos(p.angle) * p.radius;
        const py = oy + Math.sin(p.angle) * p.radius;
        if (orb.type === 0) {
          // 빛 원 입자: 황금
          this.cellGfx.beginFill(this.COL_LIGHT_GLOW, a * 0.92);
          this.cellGfx.drawCircle(px, py, p.size);
          this.cellGfx.endFill();
          // 작은 NORMAL 후광
          this.cellGfx.beginFill(this.COL_LIGHT_DEEP, a * 0.45);
          this.cellGfx.drawCircle(px, py, p.size * 1.7);
          this.cellGfx.endFill();
        } else {
          // 흑 원 입자: 보라
          this.cellGfx.beginFill(this.COL_DARK_LIGHT, a * 0.92);
          this.cellGfx.drawCircle(px, py, p.size);
          this.cellGfx.endFill();
          this.cellGfx.beginFill(this.COL_DARK_GLOW, a * 0.45);
          this.cellGfx.drawCircle(px, py, p.size * 1.7);
          this.cellGfx.endFill();
        }
      }
    }
  }

  // ── 충돌 스파크 (백/검 교차) ──
  private drawCollisionSparks() {
    for (const s of this.collisionSparks) {
      const lifeFrac = s.life / s.maxLife;
      const alpha = (1 - lifeFrac) * 0.92;

      const color = s.type === 0 ? this.COL_LIGHT_CORE : this.COL_DARK_LIGHT;
      const glowColor = s.type === 0 ? this.COL_LIGHT_GLOW : this.COL_DARK_GLOW;

      this.glowGfx.beginFill(glowColor, alpha * 0.45);
      this.glowGfx.drawCircle(s.x, s.y, s.size * 2.0);
      this.glowGfx.endFill();

      this.cellGfx.beginFill(color, alpha);
      this.cellGfx.drawCircle(s.x, s.y, s.size);
      this.cellGfx.endFill();
    }
  }

  // ── 미니 빔 (충돌 단계, 두 원 사이 — 거의 매 프레임, 굵게) ──
  private drawMiniBeams() {
    if (this.orbs.length < 2) return;
    const orb1 = this.orbs[0]; // 빛
    const orb2 = this.orbs[1]; // 흑
    // 거의 매 프레임 (90% 확률)
    if (Math.random() > 0.9) return;

    const intensity = this.phaseTimer / this.COLLISION_DURATION;
    const x1 = orb1.x + orb1.shakeX;
    const y1 = orb1.y + orb1.shakeY;
    const x2 = orb2.x + orb2.shakeX;
    const y2 = orb2.y + orb2.shakeY;

    // 4겹 (양극 — 빛 위 / 어둠 아래 또는 교차)
    // 가장 굵음 — 보라/검정 (어둠)
    this.beamGfx.lineStyle(5.5, this.COL_DARK_LIGHT, 0.55 * intensity);
    this.beamGfx.moveTo(x1, y1);
    this.beamGfx.lineTo(x2, y2);

    // 황금
    this.beamGfx.lineStyle(3.5, this.COL_LIGHT_DEEP, 0.70 * intensity);
    this.beamGfx.moveTo(x1, y1);
    this.beamGfx.lineTo(x2, y2);

    // 코어 — 크림/백 (얇은 심선)
    this.beamGfx.lineStyle(1.5, this.COL_LIGHT_CORE, 0.92 * intensity);
    this.beamGfx.moveTo(x1, y1);
    this.beamGfx.lineTo(x2, y2);

    this.beamGfx.lineStyle(0);
  }

  // ── SUPERNOVA 충격파 (5겹 — 양극 보라 + 빛 황금 + 백) ──
  private drawShockwaves() {
    for (const sw of this.shockwaves) {
      if (sw.delay > 0) continue;
      if (sw.progress >= 1) continue;

      const p = sw.progress;
      // 빠르게 팽창 (15%까지 60%, 이후 천천히 100%)
      const radiusFrac = p < 0.15
        ? (p / 0.15) * 0.60
        : 0.60 + ((p - 0.15) / 0.85) * 0.40;
      const r = radiusFrac * this.burstRadius;

      const fade = (1 - p) * (1 - p);

      // 5겹 — 양극 (어둠 외곽 → 빛 내부)
      // 1) 가장 외곽 — 진보라 (어둠)
      this.glowGfx.lineStyle(36 * (1 - p * 0.4), this.COL_DARK_LIGHT, fade * 0.32);
      this.glowGfx.drawCircle(0, 0, r);

      // 2) 외곽 — 검적 (양극 충돌)
      this.glowGfx.lineStyle(26 * (1 - p * 0.35), this.COL_BURST_DARK, fade * 0.42);
      this.glowGfx.drawCircle(0, 0, r);

      // 3) 중간 — 오렌지 (열기)
      this.glowGfx.lineStyle(18 * (1 - p * 0.3), this.COL_BURST_ORANGE, fade * 0.55);
      this.glowGfx.drawCircle(0, 0, r);

      // 4) 내부 — 황금
      this.glowGfx.lineStyle(11 * (1 - p * 0.25), this.COL_BURST_GOLD, fade * 0.70);
      this.glowGfx.drawCircle(0, 0, r);

      // 5) 코어 — 백열 (역대급 폭발 임팩트)
      this.glowGfx.lineStyle(5 * (1 - p * 0.2), this.COL_BURST_WHITE, fade * 0.88);
      this.glowGfx.drawCircle(0, 0, r);
    }
    this.glowGfx.lineStyle(0);
  }

  // ── SUPERNOVA 사방 빔 16발 ──
  private drawSupernovaBeams() {
    if (this.phase !== SupernovaPhase.SUPERNOVA && this.phase !== SupernovaPhase.LINGER) return;

    const totalT = this.phase === SupernovaPhase.SUPERNOVA
      ? this.phaseTimer
      : this.SUPERNOVA_DURATION + this.phaseTimer;
    const totalDuration = this.SUPERNOVA_DURATION + this.LINGER_DURATION;
    const fadeProg = totalT / totalDuration;
    const alpha = 1 - fadeProg * 0.92;
    const fade = 1 - fadeProg * 0.4;

    // 빔 grow 애니메이션 (0 → 1, ease-out, 8f)
    const burstT = this.phase === SupernovaPhase.SUPERNOVA ? this.phaseTimer : this.SUPERNOVA_DURATION;
    const growT = Math.min(1, burstT / 8);
    const easedGrow = 1 - Math.pow(1 - growT, 3);

    // impactBulge (LightEffect 패턴 — 첫 5f 130%)
    const impactBulge = burstT < 5
      ? 1 + (1 - burstT / 5) * 0.3
      : 1;
    const bulge = fade * impactBulge;
    const range = this.beamRange * easedGrow;
    if (range < 5) return;

    // 16발 동시 발사 — 빛/어둠 교차 (8빛 + 8어둠)
    for (let i = 0; i < LightDarkEffect.BEAM_ANGLES.length; i++) {
      const angle = LightDarkEffect.BEAM_ANGLES[i];
      const isLight = (i % 2) === 0; // 짝수 = 빛, 홀수 = 어둠
      this.drawSingleBeam(angle, range, bulge, alpha, isLight);
    }
  }

  /** 빔 1발 5겹 (LightEffect.drawBeam 패턴, 빛/어둠 양극 색) */
  private drawSingleBeam(angle: number, range: number, bulge: number, alpha: number, isLight: boolean) {
    const endX = Math.cos(angle) * range;
    const endY = Math.sin(angle) * range;

    if (isLight) {
      // 빛 빔 — 백/황금
      // 1) 최외곽 — 황금 진
      this.beamGfx.lineStyle(40 * bulge, this.COL_LIGHT_DEEP, alpha * 0.15);
      this.beamGfx.moveTo(0, 0);
      this.beamGfx.lineTo(endX, endY);

      // 2) 외곽 — 황금
      this.beamGfx.lineStyle(26 * bulge, this.COL_LIGHT_GLOW, alpha * 0.30);
      this.beamGfx.moveTo(0, 0);
      this.beamGfx.lineTo(endX, endY);

      // 3) 중간 — 크림
      this.beamGfx.lineStyle(14 * bulge, this.COL_LIGHT_CORE, alpha * 0.55);
      this.beamGfx.moveTo(0, 0);
      this.beamGfx.lineTo(endX, endY);

      // 4) 내부 — 백열
      this.beamGfx.lineStyle(7 * bulge, this.COL_BURST_WHITE, alpha * 0.78);
      this.beamGfx.moveTo(0, 0);
      this.beamGfx.lineTo(endX, endY);

      // 5) 심선 — 백 (역대급 폭발 임팩트, 1점 OK)
      this.beamGfx.lineStyle(2.5 * bulge, 0xffffff, alpha * 0.92);
      this.beamGfx.moveTo(0, 0);
      this.beamGfx.lineTo(endX, endY);
    } else {
      // 어둠 빔 — 보라/검 (양극 표현)
      // 1) 최외곽 — 진보라
      this.beamGfx.lineStyle(40 * bulge, 0x2e1065, alpha * 0.18); // violet-950
      this.beamGfx.moveTo(0, 0);
      this.beamGfx.lineTo(endX, endY);

      // 2) 외곽 — 보라
      this.beamGfx.lineStyle(26 * bulge, this.COL_DARK_LIGHT, alpha * 0.35); // 0x44168b
      this.beamGfx.moveTo(0, 0);
      this.beamGfx.lineTo(endX, endY);

      // 3) 중간 — violet-500
      this.beamGfx.lineStyle(14 * bulge, 0x8b5cf6, alpha * 0.55);
      this.beamGfx.moveTo(0, 0);
      this.beamGfx.lineTo(endX, endY);

      // 4) 내부 — violet-300 (라이트)
      this.beamGfx.lineStyle(7 * bulge, 0xc4b5fd, alpha * 0.78);
      this.beamGfx.moveTo(0, 0);
      this.beamGfx.lineTo(endX, endY);

      // 5) 심선 — violet-200 (가장 밝지만 백 X)
      this.beamGfx.lineStyle(2.5 * bulge, 0xddd6fe, alpha * 0.92);
      this.beamGfx.moveTo(0, 0);
      this.beamGfx.lineTo(endX, endY);
    }

    this.beamGfx.lineStyle(0);
  }

  // ── SUPERNOVA 폭발 셀 (양극 — 빛 + 어둠 셀 모두) ──
  private drawBurstParticles() {
    for (const p of this.burstParticles) {
      const lifeFrac = p.life / p.maxLife;
      const sizePhase = lifeFrac < 0.20
        ? 1 + lifeFrac * 1.3
        : 1.26 - (lifeFrac - 0.20) * 0.5;
      const r = p.size * sizePhase;

      let color: number;
      let glowColor: number;
      let alpha: number;
      let glowAlpha: number;
      let glowMul: number;

      if (p.type === 0) {
        // 백열 (코어 임팩트)
        color = this.COL_BURST_WHITE;
        glowColor = this.COL_LIGHT_GLOW;
        alpha = (1 - lifeFrac * 0.50) * 0.96;
        // ADD 글로우 알파 작게 (흰끼 방지)
        glowAlpha = (1 - lifeFrac) * 0.32;
        glowMul = 2.0;
      } else if (p.type === 1) {
        // 황금 (메인 빛)
        color = this.COL_LIGHT_GLOW;
        glowColor = this.COL_LIGHT_DEEP;
        alpha = (1 - lifeFrac * 0.40) * 0.92;
        glowAlpha = (1 - lifeFrac) * 0.25;
        glowMul = 1.9;
      } else {
        // 어둠 잔해 (보라 — 더 명확하게)
        color = this.COL_DARK_LIGHT; // 0x44168b 진보라
        glowColor = 0x8b5cf6; // violet-500 글로우
        alpha = (1 - lifeFrac * 0.35) * 0.92;
        glowAlpha = (1 - lifeFrac) * 0.28;
        glowMul = 1.8;
      }

      // 글로우 (작게)
      this.glowGfx.beginFill(glowColor, glowAlpha);
      this.glowGfx.drawCircle(p.x, p.y, r * glowMul);
      this.glowGfx.endFill();

      // 본체
      this.cellGfx.beginFill(color, alpha);
      this.cellGfx.drawCircle(p.x, p.y, r);
      this.cellGfx.endFill();
    }
  }

  stop() {
    this.active = false;
    this.container.visible = false;
    this.orbs = [];
    this.collisionSparks = [];
    this.burstParticles = [];
    this.shockwaves = [];
    this.locked = false;
    this.glowGfx.clear();
    this.cellGfx.clear();
    this.beamGfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
