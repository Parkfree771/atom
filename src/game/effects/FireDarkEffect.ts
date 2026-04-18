import * as PIXI from 'pixi.js';
import { CANVAS_W, CANVAS_H } from '../types';
import { swapPop } from './utils';

/**
 * 불+암흑 2단계 — 항성 붕괴 (Stellar Collapse)
 *
 * 컨셉: 별 하나가 자체 중력으로 응축되어 초신성처럼 폭발하고,
 *        그 자리에 블랙홀이 남아 1초 가까이 적을 빨아들이며 태운다.
 *        폭발이 끝점이 아니라 중간점.
 *
 * 5페이즈 사이클 (총 115프레임 ≈ 1.92초):
 *   1. 형성 (FORMING,    15f) — 응축 셀 흡입 + GLSL 페이드인 (별의 씨앗)
 *   2. 블랙홀 (BLACKHOLE,60f) — GLSL 풀 강도, 강착원반 입자, 강한 흡인 + DoT (적 모음)
 *   3. 임계 (CRITICAL,    6f) — 강착원반 정적, 폭발 직전 압축
 *   4. 폭발 (BURST,      22f) — 충격파 + 사방 화염 셀 분출, 광역 데미지 (블랙홀이 터짐)
 *   5. 소멸 (DISSIPATING,12f) — 폭발 셀 페이드 → 자동 stop()
 *
 * 좌표계 (메일스트롬과 완전 동일, 개발서 규칙 4):
 *   - GLSL Filter → worldContainer (스크린 공간 후처리)
 *   - Graphics → overlayLayer (stage 직속, 스크린 좌표)
 *   - update(dt, cameraX, cameraY) 매 프레임 카메라 받음 → screenX/Y 계산
 *   - apply 오버라이드로 uTexSize에 실제 렌더 텍스처 크기 주입
 *
 * 위치 거동:
 *   - 시작 시점에 캐릭터 위치 → 즉시 잠금 (블랙홀은 그 자리에 형성)
 *   - 사이클 끝(소멸 종료)에 자동 stop() → engine 분기에서 다음 프레임 새 캐릭터 위치로 다시 start
 */

// ───────────────────────────────────────────────────────────────
//  GLSL 셰이더 — 적색 중력 렌즈 (DarkEffect 셰이더 적색 변형)
// ───────────────────────────────────────────────────────────────

const STELLAR_FRAG = [
  'varying vec2 vTextureCoord;',
  'uniform sampler2D uSampler;',
  '',
  'uniform vec2 uCenter;',
  'uniform float uRadius;',
  'uniform float uStrength;', // 0~1, 페이즈에 따라 변화
  'uniform float uTime;',
  'uniform vec2 uTexSize;',
  '',
  'void main(void) {',
  '  vec2 pixCoord = vTextureCoord * uTexSize;',
  '  vec2 delta = pixCoord - uCenter;',
  '  float dist = length(delta);',
  '',
  '  // uStrength == 0이면 (응축/임계/폭발) 패스스루 — 셀들만 보이게',
  '  if (uStrength <= 0.001 || dist > uRadius * 0.95) {',
  '    gl_FragColor = texture2D(uSampler, vTextureCoord);',
  '    return;',
  '  }',
  '',
  '  float r = uRadius * 0.95;',
  '  float t = clamp(dist / r, 0.0, 1.0);',
  '',
  '  // 중심 압축 (블랙홀 흡입 원리, DarkEffect와 동일)',
  '  float warp = pow(max(t, 0.02), 0.40 + uStrength * 0.45);',
  '  vec2 dir = normalize(delta + vec2(0.0001));',
  '  vec2 warpedCoord = uCenter + dir * r * warp;',
  '  vec2 warpedUV = warpedCoord / uTexSize;',
  '  vec4 color = texture2D(uSampler, warpedUV);',
  '',
  '  // 중심 어두움 (블랙홀)',
  '  float darkness = smoothstep(0.0, 0.45, t);',
  '  color.rgb *= mix(1.0, darkness, uStrength);',
  '',
  '  // 사건의 지평선 링 — 적색/오렌지 (보라 ring → 적색)',
  '  float ringDist = (t - 0.78) * 7.5;',
  '  float ring = exp(-(ringDist * ringDist));',
  '  // 정적 코로나 플레어 패턴 (회전 X — 메일스트롬과 차별), 살짝 깜빡임',
  '  float corona = sin(atan(delta.y, delta.x) * 6.0 + uTime * 0.3) * 0.5 + 0.5;',
  '  vec3 coronaColor = vec3(0.95, 0.32, 0.08); // 진주홍/오렌지',
  '  color.rgb += coronaColor * ring * 0.62 * (0.45 + corona * 0.55) * uStrength;',
  '',
  '  // 안쪽 적색 글로우 (별의 표면 잔열)',
  '  float innerGlow = exp(-pow((t - 0.30) * 4.5, 2.0));',
  '  vec3 innerColor = vec3(0.55, 0.10, 0.04);',
  '  color.rgb += innerColor * innerGlow * 0.40 * uStrength;',
  '',
  '  // 중심 void (사건의 지평선 안쪽)',
  '  float voidMask = smoothstep(0.0, 0.16, t);',
  '  color.rgb *= mix(1.0, voidMask, uStrength);',
  '',
  '  gl_FragColor = color;',
  '}',
].join('\n');

// ───────────────────────────────────────────────────────────────
//  타입 정의
// ───────────────────────────────────────────────────────────────

const enum StellarPhase {
  FORMING = 0,
  BLACKHOLE = 1,
  CRITICAL = 2,
  BURST = 3,
  DISSIPATING = 4,
}

/** 응축 셀: 사방에서 중심으로 직선 흡입되는 적색 별 물질 */
interface CondenseParticle {
  x: number;
  y: number;
  radialSpeed: number;
  size: number;
  seed: number;
}

/** 폭발 셀: 사방 360도로 분출되는 백열/화염/검은 잔해 */
interface BurstParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  /** 0=백열 코어, 1=화염 본체, 2=검은 잔해 */
  type: 0 | 1 | 2;
}

/** 충격파: 1차/2차 두 발 */
interface Shockwave {
  progress: number;
  delay: number;
  scale: number;
}

/** 블랙홀 강착원반 입자: 사방→중심으로 회전+흡입 */
interface AccretionParticle {
  angle: number;
  radius: number;
  radialSpeed: number;
  angularSpeed: number;
  size: number;
  spawnRadius: number;
}

// ───────────────────────────────────────────────────────────────
//  색상 보간 — 별의 임종 그라데이션
// ───────────────────────────────────────────────────────────────

interface ColorStop { t: number; r: number; g: number; b: number; }

const STELLAR_STOPS: ColorStop[] = [
  { t: 0.00, r: 0xff, g: 0xff, b: 0xff }, // pure white
  { t: 0.05, r: 0xff, g: 0xf7, b: 0xed }, // warm white
  { t: 0.12, r: 0xfd, g: 0xe0, b: 0x47 }, // 황금
  { t: 0.22, r: 0xfb, g: 0x92, b: 0x3c }, // orange-400
  { t: 0.36, r: 0xea, g: 0x58, b: 0x0c }, // orange-600
  { t: 0.52, r: 0xc2, g: 0x41, b: 0x0c }, // orange-700 진주홍
  { t: 0.68, r: 0x7c, g: 0x2d, b: 0x12 }, // orange-900 적갈색
  { t: 0.82, r: 0x44, g: 0x18, b: 0x1a }, // 검적색
  { t: 0.92, r: 0x1a, g: 0x08, b: 0x08 }, // 진검정 (적색 끼)
  { t: 1.00, r: 0x0a, g: 0x02, b: 0x02 }, // 거의 검정
];

const STELLAR_CONDENSE_STOPS: ColorStop[] = [
  { t: 0.00, r: 0x44, g: 0x18, b: 0x1a }, // 검적색 차가움
  { t: 0.30, r: 0x99, g: 0x1b, b: 0x1b }, // red-800
  { t: 0.55, r: 0xdc, g: 0x26, b: 0x26 }, // red-600
  { t: 0.78, r: 0xea, g: 0x58, b: 0x0c }, // orange-600
  { t: 1.00, r: 0xff, g: 0xf7, b: 0xed }, // warm white 백열
];

function lerpStops(stops: ColorStop[], t: number): number {
  const tt = t < 0 ? 0 : t > 1 ? 1 : t;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (tt >= a.t && tt <= b.t) {
      const u = (tt - a.t) / (b.t - a.t);
      const r = Math.round(a.r + (b.r - a.r) * u);
      const g = Math.round(a.g + (b.g - a.g) * u);
      const bl = Math.round(a.b + (b.b - a.b) * u);
      return (r << 16) | (g << 8) | bl;
    }
  }
  const last = stops[stops.length - 1];
  return (last.r << 16) | (last.g << 8) | last.b;
}

const lerpStellarColor = (t: number) => lerpStops(STELLAR_STOPS, t);
const lerpStellarCondenseColor = (t: number) => lerpStops(STELLAR_CONDENSE_STOPS, t);

// ───────────────────────────────────────────────────────────────
//  메인 클래스
// ───────────────────────────────────────────────────────────────

export class FireDarkEffect {
  private container: PIXI.Container;
  private worldContainer: PIXI.Container;
  /** ADD 블렌드 글로우 (충격파, 코어 글로우, 백열 셀 글로우) */
  private glowGfx: PIXI.Graphics;
  /** 일반 블렌드 (응축 셀, 폭발 셀 본체, 강착원반) */
  private cellGfx: PIXI.Graphics;
  /** 코어/임계점 (위에 그림) */
  private coreGfx: PIXI.Graphics;
  /** GLSL 중력 렌즈 셰이더 */
  private filter: PIXI.Filter | null = null;

  active = false;
  /** 폭발 발동 순간 (엔진이 데미지 처리에 사용) */
  burstFiredThisFrame = false;
  burstRadius = 260;
  blackholeRadius = 150;

  // 월드/스크린 좌표
  private posX = 0;
  private posY = 0;
  private screenX = 0;
  private screenY = 0;

  // 페이즈 상태
  private phase: StellarPhase = StellarPhase.FORMING;
  private phaseTimer = 0;
  private time = 0;

  // 페이즈 길이 (프레임)
  private readonly FORMING_DURATION = 15;
  private readonly BLACKHOLE_DURATION = 60;
  private readonly CRITICAL_DURATION = 6;
  private readonly BURST_DURATION = 22;
  private readonly DISSIPATE_DURATION = 12;

  // 응축 셀
  private condenseParticles: CondenseParticle[] = [];
  private readonly CONDENSE_MAX = 70;
  private condenseSpawnAcc = 0;

  // 폭발 셀
  private burstParticles: BurstParticle[] = [];

  // 충격파
  private shockwaves: Shockwave[] = [];

  // 강착원반 입자 (블랙홀 페이즈)
  private accretionParticles: AccretionParticle[] = [];
  private readonly ACCRETION_MAX = 60;
  private accretionSpawnAcc = 0;

  // 위치 잠금 (폭발/블랙홀/소멸 단계에서 컨테이너 고정)
  private locked = false;

  // GLSL uStrength 현재값 (페이즈에 따라 변화)
  private uStrength = 0;

  constructor(screenLayer: PIXI.Container, worldContainer: PIXI.Container) {
    this.worldContainer = worldContainer;
    this.container = new PIXI.Container();
    screenLayer.addChild(this.container);

    // 글로우 (아래, ADD)
    this.glowGfx = new PIXI.Graphics();
    this.glowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.glowGfx);

    // 셀 본체 (중간, NORMAL)
    this.cellGfx = new PIXI.Graphics();
    this.container.addChild(this.cellGfx);

    // 코어 (위, NORMAL)
    this.coreGfx = new PIXI.Graphics();
    this.container.addChild(this.coreGfx);
  }

  start(x: number, y: number) {
    this.active = true;
    this.posX = x;
    this.posY = y;
    this.time = 0;
    this.phase = StellarPhase.FORMING;
    this.phaseTimer = 0;
    this.condenseParticles = [];
    this.burstParticles = [];
    this.shockwaves = [];
    this.accretionParticles = [];
    this.condenseSpawnAcc = 0;
    this.accretionSpawnAcc = 0;
    // 처음부터 잠금: 블랙홀은 시작 위치에 형성됨, 캐릭터를 따라가지 않음
    this.locked = true;
    this.burstFiredThisFrame = false;
    this.uStrength = 0;
    this.container.visible = true;

    if (!this.filter) {
      this.filter = new PIXI.Filter(undefined, STELLAR_FRAG, {
        uCenter: [0, 0],
        uRadius: this.blackholeRadius,
        uStrength: 0,
        uTime: 0,
        uTexSize: [CANVAS_W, CANVAS_H],
      });
      this.filter.padding = 0;

      // ★ apply 오버라이드 (개발서 규칙 4)
      const f = this.filter;
      f.apply = function (filterManager: any, input: any, output: any, clearMode: any) {
        if (input && input.width > 0) {
          f.uniforms.uTexSize = [input.width, input.height];
        }
        filterManager.applyFilter(f, input, output, clearMode);
      };
    }
    this.filter.uniforms.uRadius = this.blackholeRadius;
    this.filter.uniforms.uStrength = 0;

    this.worldContainer.filterArea = new PIXI.Rectangle(0, 0, CANVAS_W, CANVAS_H);

    const existing = this.worldContainer.filters || [];
    if (!existing.includes(this.filter)) {
      this.worldContainer.filters = [...existing, this.filter];
    }
  }

  setPosition(x: number, y: number) {
    if (this.locked) return; // 폭발/블랙홀/소멸 동안 잠금
    this.posX = x;
    this.posY = y;
  }

  /** 폭발 중심 좌표 (월드) — 엔진 흡인/데미지 판정용 */
  get centerX(): number { return this.posX; }
  get centerY(): number { return this.posY; }

  /** 블랙홀 페이즈 활성 여부 — 엔진이 흡인/DoT 처리에 사용 */
  get blackholeActive(): boolean {
    return this.phase === StellarPhase.BLACKHOLE;
  }

  // ═══════════════════════════════════════════════════════════
  //  업데이트 (페이즈 상태머신)
  // ═══════════════════════════════════════════════════════════

  update(dt: number, cameraX: number, cameraY: number) {
    if (!this.active || !this.filter) return;
    this.time += dt;
    this.phaseTimer += dt;
    this.burstFiredThisFrame = false;

    // ★ 스크린 좌표 — 컨테이너 위치 + 셰이더 uCenter 모두 이 값
    this.screenX = this.posX - cameraX;
    this.screenY = this.posY - cameraY;
    this.container.position.set(this.screenX, this.screenY);

    this.filter.uniforms.uCenter = [this.screenX, this.screenY];
    this.filter.uniforms.uTime = this.time * 0.016;

    switch (this.phase) {
      case StellarPhase.FORMING:
        this.updateForming(dt);
        if (this.phaseTimer >= this.FORMING_DURATION) {
          this.phase = StellarPhase.BLACKHOLE;
          this.phaseTimer = 0;
          this.condenseParticles = []; // 응축 셀 모두 한 점으로 → 사라짐
        }
        break;

      case StellarPhase.BLACKHOLE:
        this.updateBlackhole(dt); // 강착원반 spawn + 회전 흡입
        if (this.phaseTimer >= this.BLACKHOLE_DURATION) {
          this.phase = StellarPhase.CRITICAL;
          this.phaseTimer = 0;
        }
        break;

      case StellarPhase.CRITICAL:
        // 강착원반은 spawn 정지하지만 기존 입자는 계속 빨려듦
        this.updateBlackhole(dt);
        if (this.phaseTimer >= this.CRITICAL_DURATION) {
          this.phase = StellarPhase.BURST;
          this.phaseTimer = 0;
          this.burstFiredThisFrame = true; // 엔진에 폭발 알림
          this.spawnBurst();
          this.spawnShockwaves();
          this.accretionParticles = []; // 폭발에 휩쓸림
        }
        break;

      case StellarPhase.BURST:
        this.updateBurst(dt);
        if (this.phaseTimer >= this.BURST_DURATION) {
          this.phase = StellarPhase.DISSIPATING;
          this.phaseTimer = 0;
        }
        break;

      case StellarPhase.DISSIPATING:
        this.updateBurst(dt); // 폭발 셀만 페이드
        if (this.phaseTimer >= this.DISSIPATE_DURATION) {
          // 사이클 종료: 자동 stop. engine이 다음 프레임에 새 위치로 다시 start.
          this.stop();
          return;
        }
        break;
    }

    // ── uStrength 페이즈별 ──
    this.updateUStrength();
    this.filter.uniforms.uStrength = this.uStrength;

    this.draw();
  }

  /** 페이즈에 따라 uStrength 변화 */
  private updateUStrength() {
    switch (this.phase) {
      case StellarPhase.FORMING: {
        // 0 → 0.5 (별의 씨앗이 형성되며 GLSL 페이드인)
        const t = this.phaseTimer / this.FORMING_DURATION;
        this.uStrength = t * 0.5;
        break;
      }
      case StellarPhase.BLACKHOLE: {
        // 0.5 → 1.0 (첫 6f 페이드인) → 1.0 → 0.8 (나머지 유지)
        if (this.phaseTimer < 6) {
          this.uStrength = 0.5 + (this.phaseTimer / 6) * 0.5;
        } else {
          const after = (this.phaseTimer - 6) / (this.BLACKHOLE_DURATION - 6);
          this.uStrength = 1.0 - after * 0.2;
        }
        break;
      }
      case StellarPhase.CRITICAL: {
        // 0.8 → 0.5 (블랙홀 압축감)
        const t = this.phaseTimer / this.CRITICAL_DURATION;
        this.uStrength = 0.8 - t * 0.3;
        break;
      }
      case StellarPhase.BURST: {
        // 0.5 → 0 (블랙홀이 폭발과 함께 사라짐)
        const t = this.phaseTimer / this.BURST_DURATION;
        this.uStrength = 0.5 * (1 - t);
        break;
      }
      case StellarPhase.DISSIPATING:
        this.uStrength = 0;
        break;
    }
  }

  // ───────────────────────────────────────────────────────────
  //  Phase 1 — 형성 (응축 셀 직선 흡입 + GLSL 페이드인)
  // ───────────────────────────────────────────────────────────

  private updateForming(dt: number) {
    // 짧은 페이즈(15f)라 spawn은 즉시 빠르게
    this.condenseSpawnAcc += dt * 4.5;
    while (this.condenseSpawnAcc >= 1 && this.condenseParticles.length < this.CONDENSE_MAX) {
      this.condenseSpawnAcc -= 1;
      this.spawnCondenseParticle();
    }

    for (let i = this.condenseParticles.length - 1; i >= 0; i--) {
      const p = this.condenseParticles[i];
      const d = Math.sqrt(p.x * p.x + p.y * p.y);

      if (d < 8) {
        swapPop(this.condenseParticles, i);
        continue;
      }

      // 직선 흡입 (회전 없음 — 메일스트롬과의 차별점)
      const nx = -p.x / d;
      const ny = -p.y / d;

      // 짧은 페이즈라 흡입 가속을 크게
      const closeBoost = 1 + Math.max(0, (130 - d) / 80);
      p.radialSpeed += 0.18 * closeBoost * dt;

      p.x += nx * p.radialSpeed * dt;
      p.y += ny * p.radialSpeed * dt;
    }
  }

  private spawnCondenseParticle() {
    const angle = Math.random() * Math.PI * 2;
    // 블랙홀 반경(150) 안쪽 분포
    const dist = 75 + Math.random() * 55;
    this.condenseParticles.push({
      x: Math.cos(angle) * dist,
      y: Math.sin(angle) * dist,
      radialSpeed: 1.4 + Math.random() * 0.8,
      size: 1.5 + Math.random() * 2.0,
      seed: Math.random(),
    });
  }

  // ───────────────────────────────────────────────────────────
  //  Phase 3 — 폭발 셀 / 충격파 생성
  // ───────────────────────────────────────────────────────────

  private spawnBurst() {
    const total = 130;
    for (let i = 0; i < total; i++) {
      const angle = (i / total) * Math.PI * 2 + (Math.random() - 0.5) * 0.20;
      const speed = 5 + Math.random() * 7;

      const r = Math.random();
      let type: 0 | 1 | 2;
      let size: number;
      let maxLife: number;
      if (r < 0.12) {
        type = 0;
        size = 3 + Math.random() * 4;
        maxLife = 25 + Math.random() * 12;
      } else if (r < 0.77) {
        type = 1;
        size = 2 + Math.random() * 3;
        maxLife = 32 + Math.random() * 16;
      } else {
        type = 2;
        size = 1.5 + Math.random() * 2.5;
        maxLife = 38 + Math.random() * 12;
      }

      const startDist = 6 + Math.random() * 6;
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

  private spawnShockwaves() {
    this.shockwaves = [
      { progress: 0, delay: 0, scale: 1.0 },
      { progress: 0, delay: 5, scale: 0.78 },
    ];
  }

  // ───────────────────────────────────────────────────────────
  //  Phase 3/4/5 — 폭발 셀 + 충격파 업데이트
  // ───────────────────────────────────────────────────────────

  private updateBurst(dt: number) {
    for (let i = this.burstParticles.length - 1; i >= 0; i--) {
      const p = this.burstParticles[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        swapPop(this.burstParticles, i);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const drag = p.type === 2 ? 0.92 : 0.94;
      p.vx *= drag;
      p.vy *= drag;
    }

    for (const sw of this.shockwaves) {
      if (sw.delay > 0) {
        sw.delay -= dt;
        continue;
      }
      sw.progress += dt / 30;
    }
  }

  // ───────────────────────────────────────────────────────────
  //  Phase 4 — 블랙홀 강착원반 입자
  // ───────────────────────────────────────────────────────────

  private updateBlackhole(dt: number) {
    // 소멸 페이즈 동안에는 새로 spawn 안 함 (페이드 아웃)
    if (this.phase === StellarPhase.BLACKHOLE) {
      this.accretionSpawnAcc += dt * 1.4;
      while (this.accretionSpawnAcc >= 1 && this.accretionParticles.length < this.ACCRETION_MAX) {
        this.accretionSpawnAcc -= 1;
        this.spawnAccretionParticle();
      }
    }

    // 강착원반 입자 업데이트 (회전 + 흡입, 메일스트롬보다 느림)
    const R = this.blackholeRadius;
    for (let i = this.accretionParticles.length - 1; i >= 0; i--) {
      const p = this.accretionParticles[i];
      p.radius -= p.radialSpeed * dt;
      p.angle += p.angularSpeed * dt;
      p.radialSpeed += 0.018 * dt; // 가속
      p.angularSpeed += 0.0006 * dt; // 안쪽일수록 회전 빠름
      if (p.radius < R * 0.07) {
        swapPop(this.accretionParticles, i);
      }
    }
  }

  private spawnAccretionParticle() {
    const R = this.blackholeRadius;
    const angle = Math.random() * Math.PI * 2;
    const radius = R * (0.70 + Math.random() * 0.30);
    this.accretionParticles.push({
      angle,
      radius,
      radialSpeed: 0.35 + Math.random() * 0.30,
      angularSpeed: 0.005 + Math.random() * 0.007,
      size: 1.8 + Math.random() * 2.2,
      spawnRadius: radius,
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  렌더링
  // ═══════════════════════════════════════════════════════════

  private draw() {
    this.glowGfx.clear();
    this.cellGfx.clear();
    this.coreGfx.clear();

    switch (this.phase) {
      case StellarPhase.FORMING:
        this.drawForming();
        break;
      case StellarPhase.BLACKHOLE:
        this.drawAccretion();
        this.drawBlackholeCore();
        break;
      case StellarPhase.CRITICAL:
        // 블랙홀 압축 — 강착원반은 빨려들고 코어가 점점 부풀어 오름
        this.drawAccretion();
        this.drawBlackholeCore();
        this.drawCritical();
        break;
      case StellarPhase.BURST:
        // 폭발 셀 + 충격파 (블랙홀이 폭발)
        this.drawBurst();
        this.drawShockwaves();
        // 블랙홀 코어가 폭발과 함께 페이드
        this.drawCollapsingCore();
        break;
      case StellarPhase.DISSIPATING:
        this.drawBurst();
        this.drawShockwaves();
        break;
    }
  }

  // ───────────────────────────────────────────────────────────
  //  형성 드로우 — 응축 셀이 사방→중심 흡입, 검은 코어 페이드인
  // ───────────────────────────────────────────────────────────

  private drawForming() {
    const progress = this.phaseTimer / this.FORMING_DURATION;

    this.cellGfx.lineStyle(0);
    for (const p of this.condenseParticles) {
      const d = Math.sqrt(p.x * p.x + p.y * p.y);
      const tempT = 1 - Math.min(1, Math.max(0, (d - 8) / 130));
      const color = lerpStellarCondenseColor(tempT);
      const alpha = 0.65 + p.seed * 0.25;
      this.cellGfx.beginFill(color, alpha);
      this.cellGfx.drawCircle(p.x, p.y, p.size);
      this.cellGfx.endFill();

      if (tempT > 0.50) {
        const glowAlpha = (tempT - 0.50) / 0.50 * 0.45;
        this.glowGfx.beginFill(color, glowAlpha);
        this.glowGfx.drawCircle(p.x, p.y, p.size * 2.6);
        this.glowGfx.endFill();
      }
    }

    // 검은 블랙홀 코어 페이드인 (블랙홀이 형성되는 중)
    const R = this.blackholeRadius;
    const coreFade = progress;

    this.glowGfx.beginFill(0x44181a, coreFade * 0.45);
    this.glowGfx.drawCircle(0, 0, R * 0.32);
    this.glowGfx.endFill();

    this.glowGfx.beginFill(0x7c2d12, coreFade * 0.40);
    this.glowGfx.drawCircle(0, 0, R * 0.22);
    this.glowGfx.endFill();

    this.coreGfx.beginFill(0x1a0808, coreFade * 0.85);
    this.coreGfx.drawCircle(0, 0, R * 0.13);
    this.coreGfx.endFill();

    this.coreGfx.beginFill(0x0a0202, coreFade * 0.92);
    this.coreGfx.drawCircle(0, 0, R * 0.09);
    this.coreGfx.endFill();
  }

  // ───────────────────────────────────────────────────────────
  //  임계 드로우
  // ───────────────────────────────────────────────────────────

  // 임계 — 블랙홀이 폭발 직전 압축. 검은 코어 가장자리에 백열 라인이 부풀음
  private drawCritical() {
    const tFrac = this.phaseTimer / this.CRITICAL_DURATION;
    // 진행될수록 백열이 점점 강해짐
    const heatT = tFrac;
    const baseR = 14 + heatT * 6;

    // 블랙홀 코어 가장자리에 백열 헤일로 (점점 부풀음)
    this.glowGfx.beginFill(0xc2410c, 0.45 * heatT);
    this.glowGfx.drawCircle(0, 0, baseR * 2.4);
    this.glowGfx.endFill();

    this.glowGfx.beginFill(0xfb923c, 0.60 * heatT);
    this.glowGfx.drawCircle(0, 0, baseR * 1.6);
    this.glowGfx.endFill();

    this.glowGfx.beginFill(0xfde047, 0.70 * heatT);
    this.glowGfx.drawCircle(0, 0, baseR * 1.05);
    this.glowGfx.endFill();

    // 백열 림 (사건의 지평선 가장자리가 가열됨)
    this.coreGfx.lineStyle(2.2 * heatT, 0xfff7ed, 0.85 * heatT);
    this.coreGfx.drawCircle(0, 0, baseR * 0.85);
    this.coreGfx.lineStyle(0);
  }

  // 폭발 직후 블랙홀 코어가 함께 페이드 아웃 (블랙홀이 터짐)
  private drawCollapsingCore() {
    const tFrac = this.phaseTimer / this.BURST_DURATION;
    const fade = 1 - tFrac;
    if (fade <= 0) return;

    const R = this.blackholeRadius;

    // 검은 코어 페이드 (사건의 지평선 안쪽)
    this.coreGfx.beginFill(0x0a0202, fade * 0.85);
    this.coreGfx.drawCircle(0, 0, R * 0.10);
    this.coreGfx.endFill();

    this.coreGfx.beginFill(0x1a0808, fade * 0.65);
    this.coreGfx.drawCircle(0, 0, R * 0.15);
    this.coreGfx.endFill();
  }

  // ───────────────────────────────────────────────────────────
  //  폭발/잔류 드로우 — 셀
  // ───────────────────────────────────────────────────────────

  private drawBurst() {
    this.cellGfx.lineStyle(0);

    for (const p of this.burstParticles) {
      const lifeFrac = p.life / p.maxLife;
      const sizePhase = lifeFrac < 0.25
        ? 1 + lifeFrac * 1.0
        : 1.25 - (lifeFrac - 0.25) * 0.5;
      const r = p.size * sizePhase;

      let color: number;
      let alpha: number;
      let glowColor: number;
      let glowAlpha: number;
      let glowMul: number;

      if (p.type === 0) {
        color = lerpStellarColor(lifeFrac * 0.40);
        alpha = (1 - lifeFrac * 0.50) * 0.95;
        glowColor = lerpStellarColor(Math.max(0, lifeFrac * 0.30));
        glowAlpha = (1 - lifeFrac) * 0.60;
        glowMul = 2.8;
      } else if (p.type === 1) {
        color = lerpStellarColor(0.18 + lifeFrac * 0.55);
        alpha = (1 - lifeFrac * 0.40) * 0.78;
        glowColor = lerpStellarColor(0.15 + lifeFrac * 0.40);
        glowAlpha = (1 - lifeFrac) * 0.32;
        glowMul = 2.2;
      } else {
        color = lerpStellarColor(0.50 + lifeFrac * 0.50);
        alpha = (1 - lifeFrac * 0.30) * 0.70;
        glowColor = lerpStellarColor(0.45 + lifeFrac * 0.40);
        glowAlpha = (1 - lifeFrac) * 0.18;
        glowMul = 1.8;
      }

      this.glowGfx.beginFill(glowColor, glowAlpha);
      this.glowGfx.drawCircle(p.x, p.y, r * glowMul);
      this.glowGfx.endFill();

      this.cellGfx.beginFill(color, alpha);
      this.cellGfx.drawCircle(p.x, p.y, r);
      this.cellGfx.endFill();

      if (p.type === 0 && lifeFrac < 0.4) {
        const sparkA = (1 - lifeFrac / 0.4) * 0.75;
        this.coreGfx.beginFill(0xffffff, sparkA);
        this.coreGfx.drawCircle(p.x, p.y, r * 0.4);
        this.coreGfx.endFill();
      }
    }
  }

  // ───────────────────────────────────────────────────────────
  //  폭발 드로우 — 충격파
  // ───────────────────────────────────────────────────────────

  private drawShockwaves() {
    for (const sw of this.shockwaves) {
      if (sw.delay > 0) continue;
      if (sw.progress >= 1) continue;

      const p = sw.progress;
      const radiusFrac = p < 0.17
        ? (p / 0.17) * 0.7
        : 0.7 + ((p - 0.17) / 0.83) * 0.3;
      const r = radiusFrac * this.burstRadius * sw.scale;

      const fade = (1 - p) * (1 - p);

      this.glowGfx.lineStyle(28 * (1 - p * 0.4), 0xc2410c, fade * 0.32);
      this.glowGfx.drawCircle(0, 0, r);

      this.glowGfx.lineStyle(18 * (1 - p * 0.3), 0xfb923c, fade * 0.50);
      this.glowGfx.drawCircle(0, 0, r);

      this.glowGfx.lineStyle(10 * (1 - p * 0.25), 0xfde047, fade * 0.62);
      this.glowGfx.drawCircle(0, 0, r);

      this.glowGfx.lineStyle(6 * (1 - p * 0.2), 0xfff7ed, fade * 0.78);
      this.glowGfx.drawCircle(0, 0, r);

      const coreLine = sw.scale > 0.9 ? 3 : 1.6;
      this.glowGfx.lineStyle(coreLine, 0xffffff, fade * 0.85);
      this.glowGfx.drawCircle(0, 0, r);
    }
    this.glowGfx.lineStyle(0);
  }

  // ───────────────────────────────────────────────────────────
  //  블랙홀 드로우 — 강착원반 입자 (느린 회전 흡입)
  // ───────────────────────────────────────────────────────────

  private drawAccretion() {
    // BLACKHOLE/CRITICAL 페이즈에서만 호출됨 (BURST 시점에 강착원반 입자 모두 소멸)
    const phaseAlpha = 1;

    this.cellGfx.lineStyle(0);
    for (const p of this.accretionParticles) {
      const x = Math.cos(p.angle) * p.radius;
      const y = Math.sin(p.angle) * p.radius;
      const progress = 1 - p.radius / p.spawnRadius;

      // 색: 바깥(어두운 적색) → 안쪽(백열) — 강착원반 가열
      const color = lerpStellarColor(0.55 - progress * 0.50);
      const glowColor = lerpStellarColor(0.45 - progress * 0.35);

      const alpha = (1 - progress * 0.35) * 0.85 * phaseAlpha;
      const sz = p.size * (1 - progress * 0.3);

      // 글로우
      this.glowGfx.beginFill(glowColor, alpha * 0.45);
      this.glowGfx.drawCircle(x, y, sz * 2.4);
      this.glowGfx.endFill();

      // 본체
      this.cellGfx.beginFill(color, alpha);
      this.cellGfx.drawCircle(x, y, sz);
      this.cellGfx.endFill();
    }
  }

  // ───────────────────────────────────────────────────────────
  //  블랙홀 드로우 — 검은 코어 (사건의 지평선 안쪽)
  // ───────────────────────────────────────────────────────────

  private drawBlackholeCore() {
    const R = this.blackholeRadius;

    // 페이즈 알파 — BLACKHOLE 첫 6f 페이드인, 그 후 풀, CRITICAL은 풀 유지
    let coreAlpha = 1;
    if (this.phase === StellarPhase.BLACKHOLE && this.phaseTimer < 6) {
      coreAlpha = this.phaseTimer / 6;
    }
    if (coreAlpha <= 0) return;

    // 외곽 적색 글로우 (별의 잔열)
    this.glowGfx.beginFill(0x44181a, coreAlpha * 0.55);
    this.glowGfx.drawCircle(0, 0, R * 0.32);
    this.glowGfx.endFill();

    this.glowGfx.beginFill(0x7c2d12, coreAlpha * 0.50);
    this.glowGfx.drawCircle(0, 0, R * 0.22);
    this.glowGfx.endFill();

    // 검은 코어 (위)
    this.coreGfx.beginFill(0x1a0808, coreAlpha * 0.92);
    this.coreGfx.drawCircle(0, 0, R * 0.15);
    this.coreGfx.endFill();

    this.coreGfx.beginFill(0x0a0202, coreAlpha * 0.96);
    this.coreGfx.drawCircle(0, 0, R * 0.10);
    this.coreGfx.endFill();

    // 사건의 지평선 적색 라인
    this.coreGfx.lineStyle(1.4, 0xc2410c, coreAlpha * 0.60);
    this.coreGfx.drawCircle(0, 0, R * 0.155);
    this.coreGfx.lineStyle(0);
  }

  // ═══════════════════════════════════════════════════════════
  //  정리
  // ═══════════════════════════════════════════════════════════

  stop() {
    this.active = false;
    this.container.visible = false;
    this.condenseParticles = [];
    this.burstParticles = [];
    this.shockwaves = [];
    this.accretionParticles = [];
    this.locked = false;
    this.uStrength = 0;
    this.glowGfx.clear();
    this.cellGfx.clear();
    this.coreGfx.clear();

    if (this.filter && this.worldContainer.filters) {
      this.worldContainer.filters = this.worldContainer.filters.filter(f => f !== this.filter);
      if (this.worldContainer.filters.length === 0) {
        this.worldContainer.filters = null;
        this.worldContainer.filterArea = null as any;
      }
    }
  }

  destroy() {
    this.stop();
    if (this.filter) {
      this.filter.destroy();
      this.filter = null;
    }
    this.container.destroy({ children: true });
  }
}
