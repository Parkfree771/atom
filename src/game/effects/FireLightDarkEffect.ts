import * as PIXI from 'pixi.js';
import { CANVAS_W, CANVAS_H } from '../types';
import { swapPop } from './utils';

/**
 * 불+빛+암흑 3단계 — 빅뱅 (Big Bang)
 *
 * Phase 3 중 유일하게 개발서에 컨셉 명시된 조합 — "우주 탄생".
 * 슬롯에 불·빛·암흑이 모두 있으면 다른 2단계 조합을 덮어쓰며 최우선 발동.
 *
 * 6페이즈 사이클 (184f / ~3.07초):
 *   1. CONVERGE (50f) — 모든 적 stunFrames + 특이점 lerp, GLSL 중력 렌즈 (uStrength 0 → -1)
 *   2. SILENCE  (8f)  — 정적, 코어 부풀어오름
 *   3. FLASH    (6f)  — 금색 섬광 4f, 코어 폭발적 팽창 (r=20→120)
 *   4. EXPLODE  (40f) — uStrength 음→양 반전 (수렴→확장), 광역 200뎀, 3겹 충격파 링, 600셀
 *   5. EXPAND   (50f) — 은하 잔해 입자 500개 외측 확장 (보라→금→마그마)
 *   6. LINGER   (30f) — 페이드 → 자동 stop
 *
 * 좌표계 (DarkUltimate/WaterUltimate와 완전 동일, 개발서 규칙 4/7):
 *   - GLSL Filter → worldContainer(=groundLayer) — 캐릭터/몬스터 안 가려짐
 *   - Graphics    → overlayLayer (stage 직속, 스크린 좌표)
 *   - apply 오버라이드로 uTexSize 매 프레임 주입
 *
 * 디자인 원칙:
 *   - 흰색 남발 금지 — 보라/금/마그마 3대 주조, 순백은 FLASH 코어 2f만
 *   - 수렴기 입자는 트레일 없음 (수렴 느낌 방해)
 *   - 폭발 셀은 WaterUltimate 패턴 (3종 혼합 + 색 보간)
 *   - 충격파 링은 대해일 drawWaveBand 패턴 (사인파 폴리곤 3겹)
 */

// ── GLSL 시공간 왜곡 셰이더 — 수렴↔확장 양방향 ──
const BIGBANG_FRAG = [
  'varying vec2 vTextureCoord;',
  'uniform sampler2D uSampler;',
  '',
  'uniform vec2 uCenter;',
  'uniform float uRadius;',
  'uniform float uStrength;', // -1.0 ~ +1.0 (음수 = 수렴, 양수 = 확장)
  'uniform float uTime;',
  'uniform vec2 uTexSize;',
  '',
  'void main(void) {',
  '  vec2 pixCoord = vTextureCoord * uTexSize;',
  '  vec2 delta = pixCoord - uCenter;',
  '  float dist = length(delta);',
  '',
  '  if (dist > uRadius * 1.2) {',
  '    gl_FragColor = texture2D(uSampler, vTextureCoord);',
  '    return;',
  '  }',
  '',
  '  vec2 dir = normalize(delta + vec2(0.0001));',
  '  float t = clamp(dist / uRadius, 0.0, 1.0);',
  '  float falloff = exp(-(t * t) * 2.5);',
  '',
  '  // 수렴 or 확장 (부호로 결정)',
  '  float pull = uStrength * falloff * 140.0;',
  '',
  '  // 시공간 소용돌이 (회전 성분)',
  '  vec2 perp = vec2(-dir.y, dir.x);',
  '  float swirl = sin(dist * 0.05 - uTime * 2.2) * abs(uStrength) * 10.0 * falloff;',
  '',
  '  vec2 distorted = pixCoord - dir * pull + perp * swirl;',
  '  vec4 color = texture2D(uSampler, distorted / uTexSize);',
  '',
  '  // 중심 부근 색조 fringe (수렴기 보라, 확장기 금빛 마그마)',
  '  float centerZone = exp(-(t * t) * 5.0);',
  '  if (uStrength < 0.0) {',
  '    color.rgb += vec3(0.32, 0.10, 0.58) * centerZone * (-uStrength) * 0.9;',
  '  } else {',
  '    color.rgb += vec3(0.72, 0.48, 0.18) * centerZone * uStrength * 0.75;',
  '  }',
  '',
  '  // 확장기 파도 띠 부근 충격파 색조',
  '  float wavePos = dist - uRadius * 0.7;',
  '  float waveBand = exp(-(wavePos * wavePos) / (45.0 * 45.0));',
  '  if (uStrength > 0.0) {',
  '    color.rgb += vec3(0.62, 0.32, 0.12) * waveBand * uStrength * 0.55;',
  '  }',
  '',
  '  gl_FragColor = color;',
  '}',
].join('\n');

// ── 페이즈 상수 ──
const PHASE_CONVERGE = 0;
const PHASE_SILENCE = 1;
const PHASE_FLASH = 2;
const PHASE_EXPLODE = 3;
const PHASE_EXPAND = 4;
const PHASE_LINGER = 5;
const PHASE_COOLDOWN = 6; // 사이클 간 쉼 (시각·GLSL 모두 비활성)

const P_CONVERGE = 50;
const P_SILENCE = 8;
const P_FLASH = 6;
const P_EXPLODE = 40;
const P_EXPAND = 50;
const P_LINGER = 30;
const P_COOLDOWN = 120; // 2초 쉬고 다음 사이클

const MAX_RADIUS = 360; // 화면 절반 (CANVAS 720 기준) — 화면 끝 과도 수렴 방지

// ── 입자 타입 ──
interface ConvergeParticle {
  angle: number;
  radius: number;
  inwardSpeed: number;
  angularSpeed: number;
  size: number;
  color: number;
}

interface BurstCell {
  x: number; y: number;
  prevX: number; prevY: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
  type: number; // 0=보라, 1=금, 2=마그마
  tStart: number;
  tEnd: number;
}

interface ExpansionParticle {
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
  tStart: number;
  tEnd: number;
}

export class FireLightDarkEffect {
  private container: PIXI.Container;
  private gfx: PIXI.Graphics;
  private glowGfx: PIXI.Graphics;
  private worldContainer: PIXI.Container;
  private filter: PIXI.Filter | null = null;

  // ── 색상 팔레트 ──
  // 암흑 (수렴)
  private readonly COL_ABYSS    = 0x0a0015;
  private readonly COL_DEEP     = 0x1a0530;
  private readonly COL_V900     = 0x4c1d95; // violet-900
  private readonly COL_V700     = 0x6d28d9; // violet-700
  private readonly COL_V500     = 0x8b5cf6; // violet-500
  private readonly COL_V400     = 0xa78bfa; // violet-400
  // 빛 (폭발 — 순금만, 순백 X)
  private readonly COL_Y300     = 0xfde047; // yellow-300
  private readonly COL_Y400     = 0xfacc15; // yellow-400
  private readonly COL_Y500     = 0xeab308; // yellow-500
  private readonly COL_Y600     = 0xca8a04; // yellow-600
  // 불 (확장 — 마그마 톤)
  private readonly COL_O400     = 0xfb923c; // orange-400
  private readonly COL_O500     = 0xf97316; // orange-500
  private readonly COL_O600     = 0xea580c; // orange-600
  private readonly COL_R600     = 0xdc2626; // red-600
  private readonly COL_R700     = 0xb91c1c; // red-700
  private readonly COL_R900     = 0x7f1d1d; // red-900
  // 섬광 특수 (FLASH 페이즈만)
  private readonly COL_FLASH_BG = 0xfefce8; // yellow-50
  private readonly COL_PURE_W   = 0xffffff; // 코어 2f만

  // 색 보간 (보라 → 금 → 마그마, 8스톱)
  private readonly COLOR_STOPS: Array<{ t: number; r: number; g: number; b: number }> = [
    { t: 0.00, r: 167, g: 139, b: 250 }, // violet-400
    { t: 0.14, r: 139, g:  92, b: 246 }, // violet-500
    { t: 0.28, r: 109, g:  40, b: 217 }, // violet-700
    { t: 0.42, r: 253, g: 224, b:  71 }, // yellow-300
    { t: 0.56, r: 234, g: 179, b:   8 }, // yellow-500
    { t: 0.70, r: 249, g: 115, b:  22 }, // orange-500
    { t: 0.84, r: 185, g:  28, b:  28 }, // red-700
    { t: 1.00, r: 127, g:  29, b:  29 }, // red-900
  ];

  active = false;
  private posX = 0;
  private posY = 0;
  private screenX = 0;
  private screenY = 0;
  private time = 0;
  private phase = PHASE_CONVERGE;
  private phaseTimer = 0;

  // GLSL uniform 상태
  private uStrength = 0;
  private uRadius = 0;

  // 게임 로직 플래그
  explosionFiredThisFrame = false;

  // 입자 풀
  private convergeParticles: ConvergeParticle[] = [];
  private burstCells: BurstCell[] = [];
  private expansionParticles: ExpansionParticle[] = [];

  // 코어 반경 (페이즈별 다름)
  private coreRadius = 3;

  constructor(screenLayer: PIXI.Container, worldContainer: PIXI.Container) {
    this.worldContainer = worldContainer;
    this.container = new PIXI.Container();
    screenLayer.addChild(this.container);
    // 글로우 (ADD) 먼저
    this.glowGfx = new PIXI.Graphics();
    this.glowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.glowGfx);
    // NORMAL 그 위
    this.gfx = new PIXI.Graphics();
    this.container.addChild(this.gfx);
  }

  /** 특이점 위치 갱신 — 엔진이 매 프레임 호출 (캐릭터 추적으로 비대칭 해결) */
  setPosition(x: number, y: number) {
    this.posX = x;
    this.posY = y;
  }

  start(x: number, y: number) {
    this.active = true;
    this.posX = x;
    this.posY = y;
    this.phase = PHASE_CONVERGE;
    this.phaseTimer = 0;
    this.time = 0;
    this.uStrength = 0;
    this.uRadius = 0;
    this.coreRadius = 3;
    this.convergeParticles = [];
    this.burstCells = [];
    this.expansionParticles = [];
    this.explosionFiredThisFrame = false;

    if (!this.filter) {
      this.filter = new PIXI.Filter(undefined, BIGBANG_FRAG, {
        uCenter: [0, 0],
        uRadius: 0,
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

    this.worldContainer.filterArea = new PIXI.Rectangle(0, 0, CANVAS_W, CANVAS_H);
    const existing = this.worldContainer.filters || [];
    if (!existing.includes(this.filter)) {
      this.worldContainer.filters = [...existing, this.filter];
    }
  }

  update(dt: number, cameraX: number, cameraY: number) {
    if (!this.active || !this.filter) return;
    this.time += dt;
    this.phaseTimer += dt;
    this.explosionFiredThisFrame = false;

    // ★ 스크린 좌표 (GLSL과 Graphics 모두 이 값 사용)
    this.screenX = this.posX - cameraX;
    this.screenY = this.posY - cameraY;

    // ── 페이즈 머신 ──
    switch (this.phase) {
      case PHASE_CONVERGE: {
        const t = this.phaseTimer / P_CONVERGE;
        // GLSL 중력 렌즈: uStrength 0 → -1, uRadius 0 → MAX_RADIUS
        this.uStrength = -t;
        this.uRadius = MAX_RADIUS * t;
        this.coreRadius = 3 + t * 5; // 3 → 8
        // 수렴 입자 spawn (매 프레임 2~3개)
        if (this.convergeParticles.length < 100 && this.phaseTimer % 2 < 1) {
          this.spawnConvergeParticles(3);
        }
        if (this.phaseTimer >= P_CONVERGE) {
          this.phase = PHASE_SILENCE;
          this.phaseTimer = 0;
          this.uStrength = -1.0;
          this.uRadius = MAX_RADIUS;
        }
        break;
      }
      case PHASE_SILENCE: {
        // 정적: 코어 부풀어오름 r=8→20
        const t = this.phaseTimer / P_SILENCE;
        this.coreRadius = 8 + t * 12;
        this.uStrength = -1.0;
        this.uRadius = MAX_RADIUS;
        if (this.phaseTimer >= P_SILENCE) {
          this.phase = PHASE_FLASH;
          this.phaseTimer = 0;
        }
        break;
      }
      case PHASE_FLASH: {
        // 섬광: 코어 r=20→120 폭발적 팽창, uStrength 0 으로 복귀
        const t = this.phaseTimer / P_FLASH;
        this.coreRadius = 20 + t * 100;
        this.uStrength = -1.0 + t; // -1 → 0
        this.uRadius = MAX_RADIUS * (1 - t);
        if (this.phaseTimer >= P_FLASH) {
          this.phase = PHASE_EXPLODE;
          this.phaseTimer = 0;
          this.uStrength = 0;
          this.uRadius = 0;
          this.explosionFiredThisFrame = true; // 엔진이 이 프레임에 광역 데미지 처리
          this.spawnBurstCells();
        }
        break;
      }
      case PHASE_EXPLODE: {
        // 폭발: uStrength 0 → +1 (확장 반전), uRadius 0 → MAX_RADIUS
        const t = this.phaseTimer / P_EXPLODE;
        this.uStrength = t;
        this.uRadius = MAX_RADIUS * t;
        this.coreRadius = 20 * (1 - t); // 20 → 0
        if (this.phaseTimer >= P_EXPLODE) {
          this.phase = PHASE_EXPAND;
          this.phaseTimer = 0;
          this.uStrength = 1.0;
          this.uRadius = MAX_RADIUS;
          this.spawnExpansionParticles();
        }
        break;
      }
      case PHASE_EXPAND: {
        // 팽창: uStrength 1 → 0.3
        const t = this.phaseTimer / P_EXPAND;
        this.uStrength = 1.0 - t * 0.7;
        this.uRadius = MAX_RADIUS;
        this.coreRadius = 0;
        if (this.phaseTimer >= P_EXPAND) {
          this.phase = PHASE_LINGER;
          this.phaseTimer = 0;
        }
        break;
      }
      case PHASE_LINGER: {
        // 잔류: uStrength 0.3 → 0
        const t = this.phaseTimer / P_LINGER;
        this.uStrength = 0.3 * (1 - t);
        this.uRadius = MAX_RADIUS * (1 - t * 0.5);
        if (this.phaseTimer >= P_LINGER) {
          this.phase = PHASE_COOLDOWN;
          this.phaseTimer = 0;
          this.uStrength = 0;
          this.uRadius = 0;
        }
        break;
      }
      case PHASE_COOLDOWN: {
        // 쉼 — GLSL 완전 비활성, 시각 없음. 사이클 간 간격 확보.
        this.uStrength = 0;
        this.uRadius = 0;
        if (this.phaseTimer >= P_COOLDOWN) {
          this.stop();
          return;
        }
        break;
      }
    }

    // ── GLSL uniform 갱신 ──
    this.filter.uniforms.uCenter = [this.screenX, this.screenY];
    this.filter.uniforms.uRadius = this.uRadius;
    this.filter.uniforms.uStrength = this.uStrength;
    this.filter.uniforms.uTime = this.time * 0.016;

    // ── 입자 update ──
    this.updateConvergeParticles(dt);
    this.updateBurstCells(dt);
    this.updateExpansionParticles(dt);

    this.draw();
  }

  // ── 수렴 입자 spawn (사방에서 중심으로 빨림) ──
  private spawnConvergeParticles(count: number) {
    const colors = [
      // 보라 30%
      this.COL_V400, this.COL_V500, this.COL_V700,
      // 금 40%
      this.COL_Y300, this.COL_Y400, this.COL_Y500, this.COL_Y400,
      // 마그마 30%
      this.COL_O400, this.COL_O500, this.COL_R600,
    ];
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const spawnR = MAX_RADIUS * (0.85 + Math.random() * 0.15); // 380 ~ 400
      this.convergeParticles.push({
        angle,
        radius: spawnR,
        inwardSpeed: 0.5 + Math.random() * 0.8,
        angularSpeed: (Math.random() - 0.5) * 0.02,
        size: 1.5 + Math.random() * 2.2,
        color: colors[(Math.random() * colors.length) | 0],
      });
    }
  }

  private updateConvergeParticles(dt: number) {
    for (let i = this.convergeParticles.length - 1; i >= 0; i--) {
      const p = this.convergeParticles[i];
      // 진행도에 따라 가속 (수렴)
      p.inwardSpeed += 0.08 * dt;
      p.radius -= p.inwardSpeed * dt;
      p.angle += p.angularSpeed * dt;
      if (p.radius < 8) {
        swapPop(this.convergeParticles, i);
      }
    }
  }

  // ── 폭발 셀 spawn (600개, 사인파 곡선 위에서 사방 분출) ──
  private spawnBurstCells() {
    const N = 600;
    const baseR = 40; // 폭발 시작은 코어 근처
    for (let i = 0; i < N; i++) {
      const angle = (i / N) * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
      const r = baseR + Math.random() * 30;
      const sx = this.screenX + Math.cos(angle) * r;
      const sy = this.screenY + Math.sin(angle) * r;
      const speed = 6 + Math.random() * 10;

      const rType = Math.random();
      let type: number, size: number, life: number, tStart: number, tEnd: number;
      if (rType < 0.25) {
        // 보라 코어
        type = 0;
        size = 1.8 + Math.random() * 2.2;
        life = 28 + Math.random() * 22;
        tStart = 0.00;
        tEnd = 0.38;
      } else if (rType < 0.70) {
        // 금 메인
        type = 1;
        size = 1.6 + Math.random() * 2.6;
        life = 24 + Math.random() * 24;
        tStart = 0.18;
        tEnd = 0.65;
      } else {
        // 마그마 잔해
        type = 2;
        size = 1.5 + Math.random() * 2.3;
        life = 30 + Math.random() * 28;
        tStart = 0.55;
        tEnd = 1.00;
      }

      this.burstCells.push({
        x: sx, y: sy,
        prevX: sx, prevY: sy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life, maxLife: life,
        size, type,
        tStart, tEnd,
      });
    }
  }

  private updateBurstCells(dt: number) {
    for (let i = this.burstCells.length - 1; i >= 0; i--) {
      const c = this.burstCells[i];
      c.prevX = c.x;
      c.prevY = c.y;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.vx *= 0.93;
      c.vy *= 0.93;
      c.life -= dt;
      if (c.life <= 0) {
        swapPop(this.burstCells, i);
      }
    }
  }

  // ── 팽창 입자 spawn (500개, 외측으로 느리게) ──
  private spawnExpansionParticles() {
    const N = 500;
    for (let i = 0; i < N; i++) {
      const angle = Math.random() * Math.PI * 2;
      const r = 50 + Math.random() * 100;
      const sx = this.screenX + Math.cos(angle) * r;
      const sy = this.screenY + Math.sin(angle) * r;
      const speed = 1.5 + Math.random() * 2.5;
      const life = 40 + Math.random() * 50;
      const rType = Math.random();
      let tStart: number, tEnd: number;
      if (rType < 0.25) { tStart = 0.00; tEnd = 0.30; }
      else if (rType < 0.70) { tStart = 0.25; tEnd = 0.65; }
      else { tStart = 0.55; tEnd = 1.00; }

      this.expansionParticles.push({
        x: sx, y: sy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life, maxLife: life,
        size: 1.0 + Math.random() * 1.8,
        tStart, tEnd,
      });
    }
  }

  private updateExpansionParticles(dt: number) {
    for (let i = this.expansionParticles.length - 1; i >= 0; i--) {
      const p = this.expansionParticles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.96;
      p.vy *= 0.96;
      p.life -= dt;
      if (p.life <= 0) {
        swapPop(this.expansionParticles, i);
      }
    }
  }

  // ── 색 보간 (보라 → 금 → 마그마) ──
  private lerpBigBangColor(t: number): number {
    const stops = this.COLOR_STOPS;
    const c = Math.max(0, Math.min(1, t));
    for (let i = 0; i < stops.length - 1; i++) {
      if (c <= stops[i + 1].t) {
        const f = (c - stops[i].t) / (stops[i + 1].t - stops[i].t);
        const r = Math.round(stops[i].r + (stops[i + 1].r - stops[i].r) * f);
        const g = Math.round(stops[i].g + (stops[i + 1].g - stops[i].g) * f);
        const b = Math.round(stops[i].b + (stops[i + 1].b - stops[i].b) * f);
        return (r << 16) | (g << 8) | b;
      }
    }
    const last = stops[stops.length - 1];
    return (last.r << 16) | (last.g << 8) | last.b;
  }

  // ── 그리기 ──
  private draw() {
    this.gfx.clear();
    this.glowGfx.clear();

    // COOLDOWN 페이즈는 완전 쉼 — 아무 것도 안 그림
    if (this.phase === PHASE_COOLDOWN) return;

    // 1. 수렴 입자 (CONVERGE + SILENCE 동안)
    if (this.phase === PHASE_CONVERGE || this.phase === PHASE_SILENCE) {
      this.drawConvergeParticles();
    }

    // 2. 코어 (전 페이즈, 페이즈별 크기/색 다름)
    this.drawCore();

    // 3. FLASH 페이즈 — 금색 풀스크린 섬광 + 코어 순백 중심
    if (this.phase === PHASE_FLASH) {
      this.drawFlash();
    }

    // 4. 충격파 사인파 폴리곤 링 (EXPLODE 첫 25f)
    if (this.phase === PHASE_EXPLODE && this.phaseTimer < 25) {
      const fade = 1 - this.phaseTimer / 25;
      this.drawShockwaveRings(this.phaseTimer, fade);
    }

    // 5. 폭발 셀 (EXPLODE + EXPAND)
    if (this.burstCells.length > 0) {
      this.drawBurstCells();
    }

    // 6. 팽창 입자 (EXPAND + LINGER)
    if (this.expansionParticles.length > 0) {
      this.drawExpansionParticles();
    }
  }

  private drawConvergeParticles() {
    for (const p of this.convergeParticles) {
      const x = this.screenX + Math.cos(p.angle) * p.radius;
      const y = this.screenY + Math.sin(p.angle) * p.radius;
      // 중심에 가까울수록 강조
      const proximity = 1 - p.radius / MAX_RADIUS;
      const alpha = 0.35 + proximity * 0.55;
      const sz = p.size * (0.8 + proximity * 0.4);

      // 작은 ADD 글로우 (수렴 느낌 강화)
      this.glowGfx.beginFill(p.color, alpha * 0.35);
      this.glowGfx.drawCircle(x, y, sz * 1.8);
      this.glowGfx.endFill();

      // NORMAL 코어
      this.gfx.beginFill(p.color, alpha);
      this.gfx.drawCircle(x, y, sz);
      this.gfx.endFill();
    }
  }

  private drawCore() {
    const r = this.coreRadius;
    if (r < 0.5) return;
    const cx = this.screenX;
    const cy = this.screenY;

    // CONVERGE / SILENCE — 짙은 보라 응축
    if (this.phase === PHASE_CONVERGE || this.phase === PHASE_SILENCE) {
      this.gfx.beginFill(this.COL_ABYSS, 0.85);
      this.gfx.drawCircle(cx, cy, r);
      this.gfx.endFill();
      this.gfx.beginFill(this.COL_DEEP, 0.6);
      this.gfx.drawCircle(cx, cy, r * 0.7);
      this.gfx.endFill();
      this.gfx.beginFill(this.COL_V700, 0.7);
      this.gfx.drawCircle(cx, cy, r * 0.45);
      this.gfx.endFill();
      this.gfx.beginFill(this.COL_V500, 0.8);
      this.gfx.drawCircle(cx, cy, r * 0.25);
      this.gfx.endFill();

      // 글로우 (맥동)
      const pulse = 1 + Math.sin(this.time * 0.18) * 0.18;
      this.glowGfx.beginFill(this.COL_V700, 0.35);
      this.glowGfx.drawCircle(cx, cy, r * 1.8 * pulse);
      this.glowGfx.endFill();
      this.glowGfx.beginFill(this.COL_V500, 0.25);
      this.glowGfx.drawCircle(cx, cy, r * 2.6 * pulse);
      this.glowGfx.endFill();
    }
    // FLASH — 폭발적 팽창 코어 (보라 → 금 그라데이션)
    else if (this.phase === PHASE_FLASH) {
      this.gfx.beginFill(this.COL_V700, 0.7);
      this.gfx.drawCircle(cx, cy, r);
      this.gfx.endFill();
      this.gfx.beginFill(this.COL_Y600, 0.8);
      this.gfx.drawCircle(cx, cy, r * 0.75);
      this.gfx.endFill();
      this.gfx.beginFill(this.COL_Y400, 0.9);
      this.gfx.drawCircle(cx, cy, r * 0.50);
      this.gfx.endFill();
      this.gfx.beginFill(this.COL_Y300, 1.0);
      this.gfx.drawCircle(cx, cy, r * 0.28);
      this.gfx.endFill();

      // 순백 코어 — 첫 2프레임만
      if (this.phaseTimer < 2) {
        this.gfx.beginFill(this.COL_PURE_W, 1.0);
        this.gfx.drawCircle(cx, cy, r * 0.12);
        this.gfx.endFill();
      }

      // 큰 ADD 글로우
      this.glowGfx.beginFill(this.COL_Y400, 0.55);
      this.glowGfx.drawCircle(cx, cy, r * 1.6);
      this.glowGfx.endFill();
      this.glowGfx.beginFill(this.COL_Y500, 0.35);
      this.glowGfx.drawCircle(cx, cy, r * 2.2);
      this.glowGfx.endFill();
    }
    // EXPLODE 초반 — 작은 코어 페이드
    else if (this.phase === PHASE_EXPLODE) {
      this.gfx.beginFill(this.COL_Y500, 0.7);
      this.gfx.drawCircle(cx, cy, r);
      this.gfx.endFill();
      this.gfx.beginFill(this.COL_O500, 0.5);
      this.gfx.drawCircle(cx, cy, r * 0.6);
      this.gfx.endFill();
    }
  }

  private drawFlash() {
    // 풀스크린 금색 섬광 (FLASH 페이즈 4f만)
    if (this.phaseTimer >= 4) return;
    const flashAlpha = (1 - this.phaseTimer / 4) * 0.55;
    this.gfx.beginFill(this.COL_FLASH_BG, flashAlpha);
    this.gfx.drawRect(0, 0, CANVAS_W, CANVAS_H);
    this.gfx.endFill();
  }

  // ── 3겹 충격파 사인파 폴리곤 링 (대해일 drawWaveBand 패턴 차용) ──
  private drawShockwaveRings(timer: number, fade: number) {
    // 각 링의 반경 (0 → 400 선형 확장)
    const t = timer / 25;
    const r1 = 50 + t * 350; // 링 1 (가장 바깥, 보라)
    const r2 = r1 - 45;       // 링 2 (중간, 금)
    const r3 = r2 - 40;       // 링 3 (가장 안, 마그마)

    if (r1 > 0) this.drawSinewaveRing(r1, this.COL_V900, this.COL_V700, this.COL_V500, fade, 0.10);
    if (r2 > 0) this.drawSinewaveRing(r2, this.COL_Y600, this.COL_Y500, this.COL_Y300, fade, 0.13);
    if (r3 > 0) this.drawSinewaveRing(r3, this.COL_R700, this.COL_O500, this.COL_O400, fade, 0.17);
  }

  private drawSinewaveRing(
    radius: number,
    deepCol: number,
    midCol: number,
    lightCol: number,
    fade: number,
    phaseOffset: number,
  ) {
    const SEGS = 64;
    const t = this.time;

    // 외곽 사인파 (파도 정상)
    const outerR = (a: number) =>
      radius
      + Math.sin(a * 5 + t * 0.10 + phaseOffset) * 11
      + Math.sin(a * 9 + t * 0.07 + phaseOffset) * 5
      + Math.sin(a * 14 + t * 0.13 + phaseOffset) * 2.5;

    // 내곽 사인파 (파도 저점, 15px 안쪽)
    const innerR = (a: number) =>
      radius - 15
      + Math.sin(a * 5 + t * 0.10 + phaseOffset + 0.6) * 8
      + Math.sin(a * 9 + t * 0.07 + phaseOffset + 0.4) * 3.5;

    // ── 채움 (외곽→내곽 폴리곤) ──
    this.gfx.beginFill(midCol, 0.42 * fade);
    for (let i = 0; i <= SEGS; i++) {
      const a = (i / SEGS) * Math.PI * 2;
      const rr = outerR(a);
      const x = this.screenX + Math.cos(a) * rr;
      const y = this.screenY + Math.sin(a) * rr;
      if (i === 0) this.gfx.moveTo(x, y);
      else this.gfx.lineTo(x, y);
    }
    for (let i = SEGS; i >= 0; i--) {
      const a = (i / SEGS) * Math.PI * 2;
      const rr = innerR(a);
      const x = this.screenX + Math.cos(a) * rr;
      const y = this.screenY + Math.sin(a) * rr;
      this.gfx.lineTo(x, y);
    }
    this.gfx.endFill();

    // ── 외곽 라인 (파봉 강조) ──
    const drawWavyLine = (gfx: PIXI.Graphics, rFn: (a: number) => number, width: number, color: number, alpha: number) => {
      gfx.lineStyle(width, color, alpha);
      for (let i = 0; i <= SEGS; i++) {
        const a = (i / SEGS) * Math.PI * 2;
        const rr = rFn(a);
        const x = this.screenX + Math.cos(a) * rr;
        const y = this.screenY + Math.sin(a) * rr;
        if (i === 0) gfx.moveTo(x, y);
        else gfx.lineTo(x, y);
      }
      gfx.lineStyle(0);
    };

    drawWavyLine(this.glowGfx, outerR, 14, midCol, 0.28 * fade);
    drawWavyLine(this.glowGfx, outerR, 8, lightCol, 0.32 * fade);
    drawWavyLine(this.gfx, outerR, 3, lightCol, 0.85 * fade);
    drawWavyLine(this.gfx, outerR, 1.5, lightCol, 0.95 * fade);
    drawWavyLine(this.gfx, innerR, 1.0, deepCol, 0.55 * fade);
  }

  private drawBurstCells() {
    for (const c of this.burstCells) {
      const lifeFrac = c.life / c.maxLife;
      const ct = c.tStart + (1 - lifeFrac) * (c.tEnd - c.tStart);
      const color = this.lerpBigBangColor(ct);
      const alpha = lifeFrac * 0.92;
      const sz = c.size * (0.6 + lifeFrac * 0.4);

      // 금 코어 셀만 작은 ADD 글로우 (흰끼 방지)
      if (c.type === 1) {
        this.glowGfx.beginFill(color, alpha * 0.22);
        this.glowGfx.drawCircle(c.x, c.y, sz * 1.3);
        this.glowGfx.endFill();
      }

      // 트레일
      this.gfx.lineStyle(sz * 0.5, color, alpha * 0.5);
      this.gfx.moveTo(c.prevX, c.prevY);
      this.gfx.lineTo(c.x, c.y);
      this.gfx.lineStyle(0);

      // 코어
      this.gfx.beginFill(color, alpha);
      this.gfx.drawCircle(c.x, c.y, sz);
      this.gfx.endFill();
    }
  }

  private drawExpansionParticles() {
    for (const p of this.expansionParticles) {
      const lifeFrac = p.life / p.maxLife;
      const ct = p.tStart + (1 - lifeFrac) * (p.tEnd - p.tStart);
      const color = this.lerpBigBangColor(ct);
      const alpha = lifeFrac * 0.75;
      const sz = p.size * (0.7 + lifeFrac * 0.3);

      this.gfx.beginFill(color, alpha);
      this.gfx.drawCircle(p.x, p.y, sz);
      this.gfx.endFill();
    }
  }

  // ── 외부 통신 (engine이 사용) ──

  /** CONVERGE + SILENCE + FLASH 동안 true — 적 스턴 + 수렴 lerp 적용 */
  shouldFreezeEnemies(): boolean {
    return this.active && (
      this.phase === PHASE_CONVERGE ||
      this.phase === PHASE_SILENCE ||
      this.phase === PHASE_FLASH
    );
  }

  /** 현재 수렴 lerp factor (CONVERGE 동안 0.06 → 0.18, 약간 약화) */
  convergeLerp(): number {
    if (!this.active) return 0;
    if (this.phase === PHASE_CONVERGE) {
      const t = this.phaseTimer / P_CONVERGE;
      return 0.06 + t * 0.12;
    }
    if (this.phase === PHASE_SILENCE || this.phase === PHASE_FLASH) {
      return 0.28; // 확실히 모음
    }
    return 0;
  }

  /** 특이점 월드 좌표 */
  convergeCenterWorld(): { x: number; y: number } {
    return { x: this.posX, y: this.posY };
  }

  /** 폭발 반경 (엔진 데미지 판정용) */
  explosionRadius(): number {
    return MAX_RADIUS;
  }

  /** CONVERGE 페이즈인가 (엔진 DoT 틱용) */
  isConverging(): boolean {
    return this.active && this.phase === PHASE_CONVERGE;
  }

  stop() {
    this.active = false;
    this.convergeParticles = [];
    this.burstCells = [];
    this.expansionParticles = [];
    this.gfx.clear();
    this.glowGfx.clear();

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
