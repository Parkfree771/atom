import * as PIXI from 'pixi.js';
import { CANVAS_W, CANVAS_H } from '../types';
import { swapPop } from './utils';

/**
 * 물+빛+암흑 3단계 — 개기일식 (Total Eclipse)
 *
 * 태양(빛)을 달(암흑)이 가리고, 중력 교란으로 조석 파동(물)이 사방으로 퍼진다.
 * 완전히 가린 순간 — 코로나가 폭발하듯 솟아오르며 광역 데미지.
 *
 * 5페이즈 사이클 (총 ~217f / 3.6초):
 *   1. COVERING     (45f) — 달 디스크가 태양을 서서히 가림, GLSL 디밍 증가, 조석 입자 수렴
 *   2. TOTALITY     (12f) — 완전한 어둠, 코로나만 빛남, 다이아몬드 링 효과, 적 스턴
 *   3. CORONA_BURST  (35f) — 코로나 폭발 + 조석 파동 충격파, 광역 데미지 + 넉백
 *   4. AFTERGLOW    (25f) — 디밍 해제, 셀 페이드
 *   5. COOLDOWN     (100f) — 시각·GLSL 비활성, 사이클 간 쉼
 *
 * 좌표계 (빅뱅/라그나로크와 동일, 개발서 규칙 4/7):
 *   - GLSL Filter → worldContainer(=groundLayer) — 캐릭터/몬스터 안 가려짐
 *   - Graphics    → overlayLayer (stage 직속, 스크린 좌표)
 *   - apply 오버라이드로 uTexSize 매 프레임 주입
 *
 * 디자인 원칙:
 *   - 흰색 남발 금지 — 금(빛)/보라(암흑)/청(물) 3대 주조
 *   - 순백은 다이아몬드 링 2f만
 *   - 코로나 = 솔라 폭주 코로나 스킬 (반대회전 셀)
 *   - 조석 파동 = 대해일 사인파 폴리곤 스킬
 *   - 디밍 = 라그나로크 GLSL 스크린 디밍 스킬
 */

// ── GLSL 일식 셰이더 — 스크린 디밍 + 코로나 후광 ──
const ECLIPSE_FRAG = [
  'varying vec2 vTextureCoord;',
  'uniform sampler2D uSampler;',
  '',
  'uniform vec2 uCenter;',
  'uniform float uDim;',      // 0.0 ~ 0.75 (스크린 디밍 강도)
  'uniform float uCoronaT;',  // 0.0 ~ 1.0 (코로나 후광 강도)
  'uniform float uTime;',
  'uniform vec2 uTexSize;',
  '',
  'void main(void) {',
  '  vec2 pixCoord = vTextureCoord * uTexSize;',
  '  vec4 color = texture2D(uSampler, vTextureCoord);',
  '',
  '  vec2 delta = pixCoord - uCenter;',
  '  float dist = length(delta);',
  '',
  '  // 1. 스크린 디밍 제거 (uDim 무시)',
  '',
  '  // 2. 코로나 후광 (일식 중심 주변 금빛 글로우)',
  '  if (uCoronaT > 0.01) {',
  '    float diskR = 42.0;',
  '    float coronaDist = dist - diskR;',
  '',
  '    // 넓은 금빛 코로나 (가우시안)',
  '    float outerG = exp(-(coronaDist * coronaDist) / 1200.0)',
  '                   * step(0.0, coronaDist);',
  '    vec3 gold = vec3(0.99, 0.88, 0.34) * outerG * uCoronaT * 0.50;',
  '',
  '    // 좁은 보라-금 프린지 (디스크 경계)',
  '    float innerG = exp(-(coronaDist * coronaDist) / 280.0)',
  '                   * step(-5.0, coronaDist);',
  '    vec3 fringe = vec3(0.68, 0.45, 0.90) * innerG * uCoronaT * 0.30;',
  '',
  '    // 코로나 줄기 (각도 변동 — 비대칭 광선)',
  '    float angle = atan(delta.y, delta.x);',
  '    float ray = pow(max(0.0, sin(angle * 8.0 + uTime * 0.5)), 3.0);',
  '    float rayFall = exp(-(coronaDist * coronaDist) / 2200.0)',
  '                    * step(0.0, coronaDist);',
  '    vec3 rayGlow = vec3(0.99, 0.93, 0.52) * ray * rayFall * uCoronaT * 0.22;',
  '',
  '    color.rgb += gold + fringe + rayGlow;',
  '  }',
  '',
  '  gl_FragColor = color;',
  '}',
].join('\n');

// ── 페이즈 상수 ──
const PHASE_COVERING = 0;
const PHASE_TOTALITY = 1;
const PHASE_CORONA_BURST = 2;
const PHASE_AFTERGLOW = 3;
const PHASE_COOLDOWN = 4;

const P_COVERING = 45;
const P_TOTALITY = 12;
const P_CORONA_BURST = 50;
const P_AFTERGLOW = 25;
const P_COOLDOWN = 100;

// ── 일식 치수 ──
const SUN_RADIUS = 36;       // 태양 디스크 반경
const DISK_RADIUS = 42;      // 달 디스크 반경 (태양보다 약간 큼 — 완전 가림)
const MOON_START_OX = 32;    // 달 시작 오프셋 X (우측에서 접근)
const MOON_START_OY = -28;   // 달 시작 오프셋 Y (위에서 접근)

// ── 코로나 링 ──
const CORONA_RING_COUNT = 3;
const CORONA_RINGS = [
  { r: DISK_RADIUS + 10, count: 10, speed: 0.022 },  // 안쪽, 빠르게
  { r: DISK_RADIUS + 22, count: 14, speed: -0.014 },  // 중간, 역회전
  { r: DISK_RADIUS + 38, count: 12, speed: 0.008 },   // 외곽, 느리게
];

// ── 조석 충격파 ──
const TIDAL_WAVE_MAX_R = 380;
const TIDAL_WAVE_BAND = 22; // 파도 띠 두께
const TIDAL_WAVE_SEGS = 72;

// ── 데미지 ──
const BURST_DAMAGE = 120;
const BURST_RADIUS = 300;
const BURST_KNOCKBACK = 55;
const CONVERGE_RANGE = 320;
const CONVERGE_LERP_MIN = 0.015;
const CONVERGE_LERP_MAX = 0.06;
const CONVERGE_DOT = 5;
const CONVERGE_DOT_INTERVAL = 20;

// ── 색상 팔레트 ──
// 빛 (태양/코로나)
const COL_Y200 = 0xfef08a;  // yellow-200 (빛 메인)
const COL_Y300 = 0xfde047;  // yellow-300
const COL_Y500 = 0xeab308;  // yellow-500
const COL_A500 = 0xf59e0b;  // amber-500
const COL_A600 = 0xd97706;  // amber-600
// 암흑 (달)
const COL_DK_CORE = 0x0a0015;  // 검정보라
const COL_DK_MID = 0x1a0530;   // 짙은 보라
const COL_DK_OUTER = 0x2d0a4e; // 보라
const COL_V400 = 0xa78bfa;     // violet-400
const COL_V500 = 0x8b5cf6;     // violet-500
const COL_V700 = 0x6d28d9;     // violet-700
// 물 (조석)
const COL_B900 = 0x1e3a8a; // blue-900
const COL_B600 = 0x2563eb; // blue-600
const COL_B500 = 0x3b82f6; // blue-500
const COL_B400 = 0x60a5fa; // blue-400
const COL_S400 = 0x38bdf8; // sky-400
const COL_S500 = 0x0ea5e9; // sky-500
// 다이아몬드 링 (2f만)
const COL_DIAMOND = 0xfefce8; // yellow-50 (순백 회피, 따뜻한 백)

// 폭발 셀 색 보간 (금 → 보라 → 청, 10스톱)
const COLOR_STOPS: Array<{ t: number; r: number; g: number; b: number }> = [
  { t: 0.00, r: 253, g: 224, b: 71 },   // yellow-300 (코로나 금)
  { t: 0.12, r: 234, g: 179, b: 8 },     // yellow-500
  { t: 0.24, r: 245, g: 158, b: 11 },    // amber-500
  { t: 0.36, r: 167, g: 139, b: 250 },   // violet-400
  { t: 0.48, r: 139, g: 92, b: 246 },    // violet-500
  { t: 0.60, r: 109, g: 40, b: 217 },    // violet-700
  { t: 0.72, r: 96, g: 165, b: 250 },    // blue-400
  { t: 0.82, r: 59, g: 130, b: 246 },    // blue-500
  { t: 0.92, r: 37, g: 99, b: 235 },     // blue-600
  { t: 1.00, r: 30, g: 58, b: 138 },     // blue-900
];

function lerpEclipseColor(t: number): number {
  const ct = Math.max(0, Math.min(1, t));
  let i = 0;
  while (i < COLOR_STOPS.length - 2 && COLOR_STOPS[i + 1].t < ct) i++;
  const a = COLOR_STOPS[i], b = COLOR_STOPS[i + 1];
  const lt = (ct - a.t) / (b.t - a.t + 0.0001);
  const r = Math.round(a.r + (b.r - a.r) * lt);
  const g = Math.round(a.g + (b.g - a.g) * lt);
  const bl = Math.round(a.b + (b.b - a.b) * lt);
  return (r << 16) | (g << 8) | bl;
}

// ── 입자 타입 ──
interface CoronaCell {
  ringIdx: number;
  angleOffset: number;
  size: number;
  color: number;
  pulse: number; // 개별 호흡 오프셋
}

interface TidalParticle {
  angle: number;
  radius: number;
  inwardSpeed: number;
  angularSpeed: number;
  size: number;
  color: number;
  life: number;
  maxLife: number;
}

interface BurstCell {
  x: number; y: number;
  prevX: number; prevY: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
  type: number; // 0=코로나(금), 1=그림자(보라), 2=조석(청)
  tStart: number;
  tEnd: number;
}

// ── Sprite 풀 상수 ──
const BURST_POOL_SIZE = 700;
const CIRCLE_TEX_R = 8; // 원 텍스처 반경 (px)

/** Canvas 기반 화이트 원 텍스처 (1회 생성, 전 인스턴스 공유) */
let _sharedCircleTex: PIXI.Texture | null = null;
function getCircleTexture(): PIXI.Texture {
  if (_sharedCircleTex) return _sharedCircleTex;
  const size = CIRCLE_TEX_R * 2;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  // 부드러운 원 (가장자리 안티앨리어싱)
  const grad = ctx.createRadialGradient(CIRCLE_TEX_R, CIRCLE_TEX_R, 0, CIRCLE_TEX_R, CIRCLE_TEX_R, CIRCLE_TEX_R);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.7, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  _sharedCircleTex = PIXI.Texture.from(canvas);
  return _sharedCircleTex;
}

export class WaterLightDarkEffect {
  private container: PIXI.Container;
  private gfx: PIXI.Graphics;
  private glowGfx: PIXI.Graphics;
  private worldContainer: PIXI.Container;
  private filter: PIXI.Filter | null = null;

  // ── Sprite 풀 (폭발 셀용, GPU 배칭) ──
  private burstCoreSprites: PIXI.Sprite[] = [];
  private burstGlowSprites: PIXI.Sprite[] = [];

  active = false;
  private posX = 0;
  private posY = 0;
  private screenX = 0;
  private screenY = 0;
  private time = 0;
  private phase = PHASE_COOLDOWN;
  private phaseTimer = 0;

  // GLSL uniform 상태
  private uDim = 0;
  private uCoronaT = 0;

  // 달 오프셋 (COVERING 동안 슬라이드)
  private moonOffsetX = MOON_START_OX;
  private moonOffsetY = MOON_START_OY;

  // 코로나 셀
  private coronaCells: CoronaCell[] = [];

  // 조석 수렴 입자
  private tidalParticles: TidalParticle[] = [];

  // 폭발 셀
  private burstCells: BurstCell[] = [];

  // 조석 충격파 반경
  private tidalWaveR = 0;
  private tidalWaveAlpha = 0;

  // 다이아몬드 링 (식 직전/직후 빛 한 점)
  private diamondAngle = 0;
  private diamondAlpha = 0;

  // 엔진 통신 플래그
  burstFiredThisFrame = false;
  private _shouldFreeze = false;
  private _convergeLerp = 0;
  private _isConverging = false;

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

    // ── 폭발 Sprite 풀 (GPU 배칭 최적화) ──
    const tex = getCircleTexture();
    for (let i = 0; i < BURST_POOL_SIZE; i++) {
      // ADD 글로우 스프라이트
      const glow = new PIXI.Sprite(tex);
      glow.anchor.set(0.5);
      glow.blendMode = PIXI.BLEND_MODES.ADD;
      glow.visible = false;
      this.container.addChild(glow);
      this.burstGlowSprites.push(glow);
      // NORMAL 코어 스프라이트
      const core = new PIXI.Sprite(tex);
      core.anchor.set(0.5);
      core.visible = false;
      this.container.addChild(core);
      this.burstCoreSprites.push(core);
    }

    this.initCoronaCells();
  }

  /** 코로나 셀 초기화 (3링 × 각 셀수) */
  private initCoronaCells() {
    const coronaColors = [COL_Y300, COL_Y500, COL_A500, COL_A600, COL_V400];
    this.coronaCells = [];
    for (let ri = 0; ri < CORONA_RING_COUNT; ri++) {
      const ring = CORONA_RINGS[ri];
      for (let ci = 0; ci < ring.count; ci++) {
        this.coronaCells.push({
          ringIdx: ri,
          angleOffset: (ci / ring.count) * Math.PI * 2 + Math.random() * 0.3,
          size: 1.8 + Math.random() * 1.6,
          color: coronaColors[Math.floor(Math.random() * coronaColors.length)],
          pulse: Math.random() * Math.PI * 2,
        });
      }
    }
  }

  setPosition(x: number, y: number) {
    this.posX = x;
    this.posY = y;
  }

  start(x: number, y: number) {
    this.active = true;
    this.posX = x;
    this.posY = y;
    this.phase = PHASE_COVERING;
    this.phaseTimer = 0;
    this.time = 0;
    this.uDim = 0;
    this.uCoronaT = 0;
    this.moonOffsetX = MOON_START_OX;
    this.moonOffsetY = MOON_START_OY;
    this.tidalParticles = [];
    this.burstCells = [];
    this.tidalWaveR = 0;
    this.tidalWaveAlpha = 0;
    this.diamondAlpha = 0;
    this.burstFiredThisFrame = false;
    this._shouldFreeze = false;
    this._convergeLerp = 0;
    this._isConverging = false;

    // 달 접근 각도 (랜덤화, 매 사이클 다른 방향)
    const a = Math.random() * Math.PI * 2;
    const dist = 38;
    this.moonOffsetX = Math.cos(a) * dist;
    this.moonOffsetY = Math.sin(a) * dist;
    this.diamondAngle = a + Math.PI; // 달 반대편에 다이아몬드

    if (!this.filter) {
      this.filter = new PIXI.Filter(undefined, ECLIPSE_FRAG, {
        uCenter: [0, 0],
        uDim: 0,
        uCoronaT: 0,
        uTime: 0,
        uTexSize: [CANVAS_W, CANVAS_H],
      });
      this.filter.padding = 0;
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
    this.burstFiredThisFrame = false;

    this.screenX = this.posX - cameraX;
    this.screenY = this.posY - cameraY;

    // ── 페이즈 머신 ──
    switch (this.phase) {
      case PHASE_COVERING: {
        const t = this.phaseTimer / P_COVERING;
        // 달 슬라이드 (시작 위치 → 중심 정렬)
        const easeT = t * t * (3 - 2 * t); // smoothstep
        this.moonOffsetX = MOON_START_OX * (1 - easeT) * (this.moonOffsetX > 0 ? 1 : -1);
        this.moonOffsetY = MOON_START_OY * (1 - easeT) * (this.moonOffsetY > 0 ? 1 : -1);
        // 오프셋이 시작값→0으로 수렴
        const initA = this.diamondAngle + Math.PI;
        const dist0 = 38;
        this.moonOffsetX = Math.cos(initA) * dist0 * (1 - easeT);
        this.moonOffsetY = Math.sin(initA) * dist0 * (1 - easeT);

        this.uDim = 0;
        // 코로나 서서히 드러남 (식이 진행될수록)
        this.uCoronaT = Math.max(0, (t - 0.3) / 0.7) * 0.5;

        // 조석 수렴 입자 spawn
        this._isConverging = true;
        this._shouldFreeze = t > 0.6; // 후반부터 스턴
        this._convergeLerp = CONVERGE_LERP_MIN + t * (CONVERGE_LERP_MAX - CONVERGE_LERP_MIN);
        if (this.tidalParticles.length < 80) {
          const spawnRate = 1 + Math.floor(t * 3);
          this.spawnTidalParticles(spawnRate);
        }

        // 다이아몬드 링 (마지막 4f)
        this.diamondAlpha = t > 0.91 ? (t - 0.91) / 0.09 : 0;

        if (this.phaseTimer >= P_COVERING) {
          this.phase = PHASE_TOTALITY;
          this.phaseTimer = 0;
          this.moonOffsetX = 0;
          this.moonOffsetY = 0;
          this.uDim = 0;
          this._shouldFreeze = true;
        }
        break;
      }
      case PHASE_TOTALITY: {
        const t = this.phaseTimer / P_TOTALITY;
        this.uDim = 0;
        this.uCoronaT = 0.5 + t * 0.5; // 0.5 → 1.0 (코로나 최고조)
        this._shouldFreeze = true;
        this._isConverging = false;
        this._convergeLerp = 0;

        // 다이아몬드 링 (처음 3f는 사라짐)
        this.diamondAlpha = Math.max(0, 1 - t * 3);

        if (this.phaseTimer >= P_TOTALITY) {
          this.phase = PHASE_CORONA_BURST;
          this.phaseTimer = 0;
          this.burstFiredThisFrame = true;
          this.spawnBurstCells();
          this.tidalWaveR = DISK_RADIUS;
          this.tidalWaveAlpha = 1.0;
          this.diamondAlpha = 0;
        }
        break;
      }
      case PHASE_CORONA_BURST: {
        const t = this.phaseTimer / P_CORONA_BURST;
        this.uDim = 0;
        // 코로나 소멸
        this.uCoronaT = (1 - t) * 0.7;
        this._shouldFreeze = false;
        this._isConverging = false;

        // 조석 충격파 확장
        this.tidalWaveR = DISK_RADIUS + (TIDAL_WAVE_MAX_R - DISK_RADIUS) * t;
        this.tidalWaveAlpha = (1 - t) * (1 - t); // 제곱 감쇠

        if (this.phaseTimer >= P_CORONA_BURST) {
          this.phase = PHASE_AFTERGLOW;
          this.phaseTimer = 0;
        }
        break;
      }
      case PHASE_AFTERGLOW: {
        const t = this.phaseTimer / P_AFTERGLOW;
        this.uDim = 0;
        this.uCoronaT = 0;
        this.tidalWaveAlpha = 0;
        this._shouldFreeze = false;

        if (this.phaseTimer >= P_AFTERGLOW) {
          this.phase = PHASE_COOLDOWN;
          this.phaseTimer = 0;
        }
        break;
      }
      case PHASE_COOLDOWN: {
        this.uDim = 0;
        this.uCoronaT = 0;
        this._shouldFreeze = false;
        if (this.phaseTimer >= P_COOLDOWN) {
          this.stop();
          return;
        }
        break;
      }
    }

    // ── GLSL uniform 갱신 ──
    this.filter.uniforms.uCenter = [this.screenX, this.screenY];
    this.filter.uniforms.uDim = this.uDim;
    this.filter.uniforms.uCoronaT = this.uCoronaT;
    this.filter.uniforms.uTime = this.time * 0.016;

    // ── 입자 update ──
    this.updateTidalParticles(dt);
    this.updateBurstCells(dt);

    this.draw();
  }

  // ── 조석 수렴 입자 ──
  private spawnTidalParticles(count: number) {
    const colors = [COL_B400, COL_B500, COL_B600, COL_S400, COL_S500];
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = CONVERGE_RANGE * (0.82 + Math.random() * 0.18);
      this.tidalParticles.push({
        angle,
        radius,
        inwardSpeed: 1.2 + Math.random() * 1.8,
        angularSpeed: (0.02 + Math.random() * 0.03) * (Math.random() < 0.5 ? 1 : -1),
        size: 1.2 + Math.random() * 1.6,
        color: colors[Math.floor(Math.random() * colors.length)],
        life: 0,
        maxLife: 50 + Math.random() * 40,
      });
    }
  }

  private updateTidalParticles(dt: number) {
    for (let i = this.tidalParticles.length - 1; i >= 0; i--) {
      const p = this.tidalParticles[i];
      p.life += dt;
      // 나선 흡입 (반경 감소 + 회전 가속)
      p.radius -= p.inwardSpeed * dt;
      const accel = 1 + (1 - p.radius / CONVERGE_RANGE) * 2; // 안쪽일수록 빠른 회전
      p.angle += p.angularSpeed * accel * dt;
      // 소멸: 중심 도달 or 수명 초과
      if (p.radius < 8 || p.life >= p.maxLife) {
        swapPop(this.tidalParticles, i);
      }
    }
  }

  // ── 폭발 셀 ──
  private spawnBurstCells() {
    const CELL_COUNT = 700;
    for (let i = 0; i < CELL_COUNT; i++) {
      const r = Math.random();
      let type: number, tStart: number, tEnd: number, size: number, lifeMin: number, lifeMax: number;

      if (r < 0.30) {
        // 코로나 플레어 (금)
        type = 0; tStart = 0.00; tEnd = 0.28;
        size = 3.5 + Math.random() * 4.5;
        lifeMin = 30; lifeMax = 55;
      } else if (r < 0.60) {
        // 그림자 잔해 (보라)
        type = 1; tStart = 0.32; tEnd = 0.64;
        size = 3.0 + Math.random() * 4.0;
        lifeMin = 35; lifeMax = 60;
      } else {
        // 조석 거품 (청)
        type = 2; tStart = 0.65; tEnd = 1.00;
        size = 2.8 + Math.random() * 4.2;
        lifeMin = 32; lifeMax = 58;
      }

      // 코로나 링 위치에서 외측 폭발 발사 — 강한 넉백감
      const angle = Math.random() * Math.PI * 2;
      const spawnR = DISK_RADIUS + Math.random() * 20;
      const speed = 14 + Math.random() * 18;

      this.burstCells.push({
        x: Math.cos(angle) * spawnR,
        y: Math.sin(angle) * spawnR,
        prevX: Math.cos(angle) * spawnR,
        prevY: Math.sin(angle) * spawnR,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        maxLife: lifeMin + Math.random() * (lifeMax - lifeMin),
        size,
        type,
        tStart,
        tEnd,
      });
    }
  }

  private updateBurstCells(dt: number) {
    for (let i = this.burstCells.length - 1; i >= 0; i--) {
      const c = this.burstCells[i];
      c.prevX = c.x;
      c.prevY = c.y;
      c.life += dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      // 드래그 (낮을수록 멀리 퍼짐)
      c.vx *= 0.97;
      c.vy *= 0.97;
      if (c.life >= c.maxLife) {
        swapPop(this.burstCells, i);
      }
    }
  }

  // ── 그리기 ──
  private draw() {
    this.gfx.clear();
    this.glowGfx.clear();

    const sx = this.screenX;
    const sy = this.screenY;
    const isCooldown = this.phase === PHASE_COOLDOWN;
    const isAfterglow = this.phase === PHASE_AFTERGLOW;
    const afterT = isAfterglow ? this.phaseTimer / P_AFTERGLOW : 0;
    const afterAlpha = isAfterglow ? 1 - afterT : 1;

    if (isCooldown) return;

    // ── 1. 태양 디스크 (COVERING 동안만 — 달에 가려지면서 사라짐) ──
    if (this.phase === PHASE_COVERING) {
      const coverT = this.phaseTimer / P_COVERING;
      const sunAlpha = Math.max(0, 1 - coverT * 1.3);
      if (sunAlpha > 0) {
        // ADD 글로우 (넓은 빛)
        this.glowGfx.beginFill(COL_Y500, sunAlpha * 0.25);
        this.glowGfx.drawCircle(sx, sy, SUN_RADIUS * 1.6);
        this.glowGfx.endFill();
        this.glowGfx.beginFill(COL_Y300, sunAlpha * 0.35);
        this.glowGfx.drawCircle(sx, sy, SUN_RADIUS * 1.2);
        this.glowGfx.endFill();
        // NORMAL 본체 (3겹)
        this.gfx.beginFill(COL_A500, sunAlpha * 0.9);
        this.gfx.drawCircle(sx, sy, SUN_RADIUS);
        this.gfx.endFill();
        this.gfx.beginFill(COL_Y300, sunAlpha * 0.95);
        this.gfx.drawCircle(sx, sy, SUN_RADIUS * 0.72);
        this.gfx.endFill();
        this.gfx.beginFill(COL_Y200, sunAlpha);
        this.gfx.drawCircle(sx, sy, SUN_RADIUS * 0.42);
        this.gfx.endFill();
      }
    }

    // ── 2. 달 디스크 (COVERING ~ CORONA_BURST) ──
    if (this.phase <= PHASE_CORONA_BURST) {
      let diskAlpha = 1;
      let diskR = DISK_RADIUS;

      if (this.phase === PHASE_COVERING) {
        const t = this.phaseTimer / P_COVERING;
        diskR = DISK_RADIUS * Math.min(1, t * 1.5); // 빠르게 풀사이즈
        diskAlpha = Math.min(1, t * 2);
      } else if (this.phase === PHASE_CORONA_BURST) {
        const t = this.phaseTimer / P_CORONA_BURST;
        diskAlpha = Math.max(0, 1 - t * 1.8); // 빠르게 사라짐
      }

      const mx = sx + this.moonOffsetX;
      const my = sy + this.moonOffsetY;

      if (diskAlpha > 0.01) {
        // 달 본체 (3겹, NORMAL)
        this.gfx.beginFill(COL_DK_OUTER, diskAlpha * 0.7);
        this.gfx.drawCircle(mx, my, diskR);
        this.gfx.endFill();
        this.gfx.beginFill(COL_DK_MID, diskAlpha * 0.85);
        this.gfx.drawCircle(mx, my, diskR * 0.78);
        this.gfx.endFill();
        this.gfx.beginFill(COL_DK_CORE, diskAlpha * 0.95);
        this.gfx.drawCircle(mx, my, diskR * 0.55);
        this.gfx.endFill();
      }
    }

    // ── 3. 코로나 셀 (TOTALITY ~ CORONA_BURST 초반) ──
    const coronaVisible = this.uCoronaT > 0.05;
    if (coronaVisible) {
      const coronaAlpha = this.uCoronaT;
      for (const cell of this.coronaCells) {
        const ring = CORONA_RINGS[cell.ringIdx];
        const angle = cell.angleOffset + this.time * ring.speed;
        const pulseMul = 1 + Math.sin(this.time * 0.06 + cell.pulse) * 0.08;
        const r = ring.r * pulseMul;
        const cx = sx + Math.cos(angle) * r;
        const cy = sy + Math.sin(angle) * r;
        const s = cell.size * pulseMul;
        // ADD 글로우
        this.glowGfx.beginFill(cell.color, coronaAlpha * 0.35);
        this.glowGfx.drawCircle(cx, cy, s * 2.0);
        this.glowGfx.endFill();
        // NORMAL 코어
        this.gfx.beginFill(cell.color, coronaAlpha * 0.9);
        this.gfx.drawCircle(cx, cy, s);
        this.gfx.endFill();
      }
    }

    // ── 4. 다이아몬드 링 효과 (식 직전 빛 한 점) ──
    if (this.diamondAlpha > 0.01) {
      const dr = DISK_RADIUS + 3;
      const dx = sx + Math.cos(this.diamondAngle) * dr;
      const dy = sy + Math.sin(this.diamondAngle) * dr;
      // ADD 글로우 (넓은 빛)
      this.glowGfx.beginFill(COL_Y200, this.diamondAlpha * 0.6);
      this.glowGfx.drawCircle(dx, dy, 14);
      this.glowGfx.endFill();
      this.glowGfx.beginFill(COL_DIAMOND, this.diamondAlpha * 0.4);
      this.glowGfx.drawCircle(dx, dy, 8);
      this.glowGfx.endFill();
      // NORMAL 심선
      this.gfx.beginFill(COL_Y200, this.diamondAlpha);
      this.gfx.drawCircle(dx, dy, 3);
      this.gfx.endFill();
    }

    // ── 5. 조석 수렴 입자 (COVERING) ──
    for (const p of this.tidalParticles) {
      const px = sx + Math.cos(p.angle) * p.radius;
      const py = sy + Math.sin(p.angle) * p.radius;
      const lifeT = p.life / p.maxLife;
      const alpha = lifeT < 0.1 ? lifeT / 0.1 : (lifeT > 0.85 ? (1 - lifeT) / 0.15 : 1);
      // ADD 글로우
      this.glowGfx.beginFill(p.color, alpha * 0.3);
      this.glowGfx.drawCircle(px, py, p.size * 2.2);
      this.glowGfx.endFill();
      // NORMAL 코어
      this.gfx.beginFill(p.color, alpha * 0.85);
      this.gfx.drawCircle(px, py, p.size);
      this.gfx.endFill();
    }

    // ── 6. 조석 충격파 링 (CORONA_BURST) ──
    if (this.tidalWaveAlpha > 0.01 && this.tidalWaveR > DISK_RADIUS + 5) {
      this.drawTidalWave(sx, sy);
    }

    // ── 7. 폭발 셀 — Sprite 풀 (GPU 배칭, drawCircle 제거) ──
    const cellCount = this.burstCells.length;
    for (let i = 0; i < BURST_POOL_SIZE; i++) {
      if (i >= cellCount) {
        // 미사용 스프라이트 숨김
        this.burstGlowSprites[i].visible = false;
        this.burstCoreSprites[i].visible = false;
        continue;
      }
      const c = this.burstCells[i];
      const lt = c.life / c.maxLife;
      const alpha = lt < 0.08 ? lt / 0.08 : (1 - lt) * (1 - lt);
      const cellAlpha = alpha * afterAlpha;
      if (cellAlpha < 0.01) {
        this.burstGlowSprites[i].visible = false;
        this.burstCoreSprites[i].visible = false;
        continue;
      }

      const t = c.tStart + (c.tEnd - c.tStart) * lt;
      const color = lerpEclipseColor(t);
      const cx = sx + c.x;
      const cy = sy + c.y;

      // ADD 글로우 스프라이트
      const glow = this.burstGlowSprites[i];
      glow.visible = true;
      glow.position.set(cx, cy);
      glow.scale.set((c.size * 2.2) / CIRCLE_TEX_R);
      glow.tint = color;
      glow.alpha = cellAlpha * 0.3;

      // NORMAL 코어 스프라이트
      const core = this.burstCoreSprites[i];
      core.visible = true;
      core.position.set(cx, cy);
      core.scale.set((c.size * (1 - lt * 0.25)) / CIRCLE_TEX_R);
      core.tint = color;
      core.alpha = cellAlpha * 0.95;
    }
  }

  /** 조석 충격파 — 사인파 폴리곤 3겹 (대해일 패턴) */
  private drawTidalWave(sx: number, sy: number) {
    const r = this.tidalWaveR;
    const alpha = this.tidalWaveAlpha;
    const t = this.time;
    const SEGS = TIDAL_WAVE_SEGS;
    const step = (Math.PI * 2) / SEGS;

    const wavyR = (angle: number, baseR: number): number => {
      return baseR
        + Math.sin(angle * 5 + t * 0.10) * 7
        + Math.sin(angle * 9 + t * 0.07) * 3.5
        + Math.sin(angle * 14 + t * 0.13) * 1.8;
    };

    // 3겹 라인 (외→내)
    const layers = [
      { rOff: 0, color: COL_B900, a: alpha * 0.7, w: 3.5 },
      { rOff: -5, color: COL_B600, a: alpha * 0.8, w: 2.5 },
      { rOff: -10, color: COL_B400, a: alpha * 0.6, w: 1.8 },
    ];

    for (const layer of layers) {
      this.gfx.lineStyle(layer.w, layer.color, layer.a);
      for (let i = 0; i <= SEGS; i++) {
        const angle = i * step;
        const wr = wavyR(angle, r + layer.rOff);
        const px = sx + Math.cos(angle) * wr;
        const py = sy + Math.sin(angle) * wr;
        if (i === 0) this.gfx.moveTo(px, py);
        else this.gfx.lineTo(px, py);
      }
    }

    // ADD 글로우 (외곽)
    this.glowGfx.lineStyle(8, COL_B600, alpha * 0.2);
    for (let i = 0; i <= SEGS; i++) {
      const angle = i * step;
      const wr = wavyR(angle, r);
      const px = sx + Math.cos(angle) * wr;
      const py = sy + Math.sin(angle) * wr;
      if (i === 0) this.glowGfx.moveTo(px, py);
      else this.glowGfx.lineTo(px, py);
    }
  }

  // ── 엔진 쿼리 ──
  shouldFreezeEnemies(): boolean { return this.active && this._shouldFreeze; }
  isConverging(): boolean { return this.active && this._isConverging; }
  convergeLerp(): number { return this._convergeLerp; }
  convergeCenter(): { x: number; y: number } { return { x: this.posX, y: this.posY }; }
  convergeRange(): number { return CONVERGE_RANGE; }
  burstRadius(): number { return BURST_RADIUS; }

  // ── 정리 ──
  stop() {
    this.active = false;
    this.tidalParticles = [];
    this.burstCells = [];
    this._shouldFreeze = false;
    this._isConverging = false;
    this.uDim = 0;
    this.uCoronaT = 0;

    // 스프라이트 풀 전부 숨김
    for (let i = 0; i < BURST_POOL_SIZE; i++) {
      this.burstGlowSprites[i].visible = false;
      this.burstCoreSprites[i].visible = false;
    }

    if (this.filter && this.worldContainer.filters) {
      this.worldContainer.filters = this.worldContainer.filters.filter(
        (f: PIXI.Filter) => f !== this.filter
      );
    }
    this.filter?.uniforms && (this.filter.uniforms.uDim = 0);
    this.filter?.uniforms && (this.filter.uniforms.uCoronaT = 0);

    this.gfx.clear();
    this.glowGfx.clear();
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
