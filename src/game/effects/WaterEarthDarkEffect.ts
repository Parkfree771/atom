import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 물+흙+암흑 3단계 — 은하 소용돌이 (Galactic Vortex)
 *
 * 컨셉: 검정 우주 + 나선형 별을 GLSL로 직접 렌더링.
 *  - PIXI.Mesh + custom shader → quad에 procedural galaxy 그림
 *  - log spiral 곡선 위에 별 노이즈 빽빽, 외곽으로 갈수록 sparse
 *  - 별이 시간에 따라 회전 + 안쪽으로 흐름 (rFlow 시간 변환)
 *  - 코어 = 백열 가우시안 (도형 X — shader가 그림)
 *  - 적 흡인: engine.ts에서 중심 lerp + swirl, 코어 닿으면 즉사
 *
 * 사이클 (총 480f = 8초):
 *   SPAWN    (40f)  — uStrength 0→1 fade-in (mesh alpha)
 *   ACTIVE   (360f) — 정상 가동
 *   COLLAPSE (50f)  — uStrength 변동 + 별 inflow 가속 (셰이더 inflowMul uniform)
 *   REST     (30f)  — uStrength 0 (mesh 안 보임)
 *
 * 디자인 룰 (개발서 규칙 준수):
 *   - 도형 fill 코어/ring X — 셰이더가 모두 그림
 *   - 별 = procedural noise (PIXI Graphics 점 X)
 *   - 색 = 검정 베이스 + 흰/노랑 별
 *   - GLSL은 worldContainer attach가 아닌 mesh 자체 — 화면 다른 부분 안 가림
 */

// ── Vertex shader (표준 PIXI mesh) ──
const GALAXY_VERT = `
attribute vec2 aVertexPosition;
attribute vec2 aUvs;
uniform mat3 translationMatrix;
uniform mat3 projectionMatrix;
varying vec2 vUvs;
void main() {
  vUvs = aUvs;
  gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
}
`;

// ── Fragment shader (procedural galaxy) ──
const GALAXY_FRAG = `
precision mediump float;
varying vec2 vUvs;
uniform float uTime;
uniform float uStrength;
uniform float uInflowMul;

const float PI = 3.14159265359;
const float SPIRAL_B = 1.7;
const float ARMS = 2.0;
const float SPIRAL_A_NORM = 0.06;
// 사선 시점 (M51 처럼 살짝 기울어짐)
const float TILT_COS = 0.55;     // 평면이 시점 기준 ~57° 기울어짐 → y가 압축돼 보임
const float ORIENT = 0.35;       // 갤럭시 축 회전 (rad)

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// 별 layer — 셀 그리드에 별 spawn (3x3 이웃 검사)
float starLayer(vec2 uv, float density, float intensityBoost) {
  vec2 grid = uv * density;
  vec2 cell = floor(grid);
  float total = 0.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 nb = cell + vec2(float(dx), float(dy));
      float h = hash(nb);
      float threshold = 0.965 - intensityBoost * 0.13;
      if (h > threshold) {
        vec2 starOff = vec2(hash(nb + 7.3), hash(nb + 13.7));
        vec2 sp = nb + starOff;
        float d = length(grid - sp);
        float starSize = 0.18 + h * 0.30;
        float twinkle = 0.55 + 0.45 * sin(uTime * 3.5 + h * 17.0);
        total += smoothstep(starSize, 0.0, d) * twinkle;
      }
    }
  }
  return clamp(total, 0.0, 1.5);
}

void main(void) {
  // uv: 중심 기준 [-1, 1] (screen 평면)
  vec2 uvScreen = (vUvs - 0.5) * 2.0;
  // 갤럭시 plane 좌표로 변환 (orient 회전 → tilt unsquish)
  float oc = cos(ORIENT);
  float os = sin(ORIENT);
  vec2 uvR = vec2(uvScreen.x * oc + uvScreen.y * os, -uvScreen.x * os + uvScreen.y * oc);
  // tilt: 화면상 y가 압축된 ellipse → 평면에서 y는 / TILT_COS
  vec2 uv = vec2(uvR.x, uvR.y / TILT_COS);
  float r = length(uv);
  if (r > 1.02) discard;

  float theta = atan(uv.y, uv.x);

  // ── 회전 + inflow ──
  // 회전: 안쪽일수록 빠름 (케플러)
  float spinAngle = uTime * (0.20 + (1.0 - r) * 0.85);
  // inflow: r을 시간에 따라 키워 hash 입력 → 별이 안쪽으로 흘러가는 효과
  // (시각적으로 spiral 위 별이 코어로 빨려들어감)
  float rFlow = r * (1.0 + uTime * 0.05 * uInflowMul);

  // ── log spiral arm intensity ──
  float spiralAngle = SPIRAL_B * log(max(rFlow, SPIRAL_A_NORM) / SPIRAL_A_NORM);
  float armPhase = mod((theta + spinAngle - spiralAngle) * ARMS * 0.5 + PI * 0.5, PI) - PI * 0.5;
  float armWidth = 0.62 - r * 0.30;
  float armIntensity = exp(-armPhase * armPhase / (armWidth * armWidth));
  // 분홍 dust lane = arm 가장자리 (intensity 0.4~0.7 범위)
  float dustLane = smoothstep(0.35, 0.55, armIntensity) * (1.0 - smoothstep(0.55, 0.78, armIntensity));

  // ── 코어 (백열 가우시안) ──
  float core = exp(-r * r / 0.018);
  float coreEdge = exp(-r * r / 0.06) * 0.5;

  // ── 별 (arm 위 빽빽 + 배경 sparse) ──
  vec2 starUv = vec2(cos(theta + spinAngle), sin(theta + spinAngle)) * rFlow;
  float starsArm = starLayer(starUv, 26.0, armIntensity);
  float starsBg = starLayer(starUv * 1.6, 46.0, 0.0);
  float stars = starsArm + starsBg * 0.55;

  // ── 색 (검정 베이스 + 흰/노랑 별 + 분홍 dust) ──
  vec3 coreCol = vec3(1.00, 0.96, 0.78);   // 백열 노랑
  vec3 armCol  = vec3(0.96, 0.98, 1.00);   // 거의 흰
  vec3 outerCol = vec3(0.78, 0.86, 1.00);  // 외곽 흰푸름
  vec3 dustCol = vec3(0.92, 0.50, 0.62);   // 분홍 dust lane (HII region)
  vec3 starColor = mix(coreCol, armCol, smoothstep(0.05, 0.40, r));
  starColor = mix(starColor, outerCol, smoothstep(0.55, 1.00, r));

  vec3 col = vec3(0.0);  // 검정 우주
  col += core * coreCol * 1.45;                                              // 코어 백열
  col += coreEdge * coreCol * 0.80;                                          // 코어 부드러운 가장자리
  col += armIntensity * exp(-r * 0.4) * vec3(0.62, 0.72, 0.95) * 0.20;       // arm 희미한 푸른 안개
  col += dustLane * dustCol * 0.45 * smoothstep(0.10, 0.55, r);              // 분홍 dust lane (코어 밖)
  col += stars * starColor;                                                  // 별

  // 외곽 vignette (영역 가장자리 부드럽게)
  float vignette = 1.0 - smoothstep(0.90, 1.02, r);

  gl_FragColor = vec4(col, vignette * uStrength);
}
`;

// ── 페이즈 ──
const PH_SPAWN = 40;
const PH_ACTIVE = 360;
const PH_COLLAPSE = 50;
const PH_REST = 30;
const PHASE_LEN = [PH_SPAWN, PH_ACTIVE, PH_COLLAPSE, PH_REST];
const PHASE_SPAWN = 0;
const PHASE_ACTIVE = 1;
const PHASE_COLLAPSE = 2;
const PHASE_REST = 3;

// ── 차원 ──
const OUTER_RADIUS = 240;             // mesh quad 반경
const KILL_RADIUS = 22;
const PULL_RADIUS = 220;              // 강한 흡인 영역
const GRAVITY_RADIUS = 1000;          // 약한 중력 영역 (이 안 모든 적)
const PULL_LERP_BASE = 0.020;
const PULL_LERP_INNER = 0.090;
const SWIRL_RATE_BASE = 0.025;
const SWIRL_RATE_INNER = 0.095;
const GRAVITY_LERP_MAX = 0.012;       // 영역 경계 직전 약한 중력 max
const GRAVITY_SWIRL_MAX = 0.015;

// ── 설치 ──
const PLACE_RADIUS_MIN = 60;
const PLACE_RADIUS_MAX = 180;

// ── 색 (즉사 흡수 파티클용) ──
const COL_FLARE = 0xfffbeb;
const COL_AMBER_200 = 0xfde68a;
const COL_YELLOW_200 = 0xfef08a;
const COL_SKY_200 = 0xbae6fd;
const COL_SKY_100 = 0xe0f2fe;

interface AbsorbP {
  x: number; y: number;
  prevX: number; prevY: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
  color: number;
}

export class WaterEarthDarkEffect {
  private container: PIXI.Container;
  private gfx: PIXI.Graphics;       // 흡수 파티클 전용
  private mesh: PIXI.Mesh | null = null;
  private shader: PIXI.Shader | null = null;

  active = false;
  private posX = 0;
  private posY = 0;
  private centerX = 0;
  private centerY = 0;

  private time = 0;
  private phase = PHASE_SPAWN;
  private phaseTimer = 0;
  private uStrength = 0;
  private uInflowMul = 1.0;

  private absorbs: AbsorbP[] = [];

  constructor(screenLayer: PIXI.Container, _worldContainer: PIXI.Container) {
    this.container = new PIXI.Container();
    screenLayer.addChild(this.container);
    // mesh는 start() 시 생성
    this.gfx = new PIXI.Graphics();
    this.container.addChild(this.gfx);
  }

  setPosition(x: number, y: number) { this.posX = x; this.posY = y; }

  start(x: number, y: number) {
    this.active = true;
    this.posX = x; this.posY = y;
    this.time = 0;
    this.phase = PHASE_SPAWN;
    this.phaseTimer = 0;
    this.uStrength = 0;
    this.uInflowMul = 1.0;
    this.absorbs = [];

    if (!this.mesh) {
      // tilt + orient로 ellipse가 회전 → quad를 더 크게 (1.4×) 잡아야 잘림 X
      const R = Math.ceil(OUTER_RADIUS * 1.4);
      const geometry = new PIXI.Geometry()
        .addAttribute('aVertexPosition', [-R, -R,  R, -R,  R,  R,  -R,  R], 2)
        .addAttribute('aUvs', [0, 0,  1, 0,  1, 1,  0, 1], 2)
        .addIndex([0, 1, 2, 0, 2, 3]);
      this.shader = PIXI.Shader.from(GALAXY_VERT, GALAXY_FRAG, {
        uTime: 0,
        uStrength: 0,
        uInflowMul: 1.0,
      });
      this.mesh = new PIXI.Mesh(geometry, this.shader as PIXI.MeshMaterial);
      // mesh 먼저 그리고 그 위에 흡수 파티클
      this.container.removeChild(this.gfx);
      this.container.addChild(this.mesh);
      this.container.addChild(this.gfx);
    }
    this.placeGalaxy();
  }

  private placeGalaxy() {
    const a = Math.random() * Math.PI * 2;
    const r = PLACE_RADIUS_MIN + Math.random() * (PLACE_RADIUS_MAX - PLACE_RADIUS_MIN);
    this.centerX = this.posX + Math.cos(a) * r;
    this.centerY = this.posY + Math.sin(a) * r;
  }

  // ── 엔진 통신 ──
  isAbsorbing(): boolean {
    return this.active && (this.phase === PHASE_ACTIVE || this.phase === PHASE_SPAWN);
  }
  absorbStrength(): number {
    if (!this.isAbsorbing()) return 0;
    if (this.phase === PHASE_SPAWN) return this.phaseTimer / PH_SPAWN;
    return 1.0;
  }
  galaxyCenter(): { x: number; y: number } {
    return { x: this.centerX, y: this.centerY };
  }
  pullRadius(): number { return PULL_RADIUS; }
  killRadius(): number { return KILL_RADIUS; }
  gravityRadius(): number { return GRAVITY_RADIUS; }
  /** 거리에 따른 흡인 lerp — 영역 안 강함 + 영역 밖 약한 중력 */
  pullLerpAt(dist: number): number {
    if (dist >= GRAVITY_RADIUS) return 0;
    if (dist < PULL_RADIUS) {
      // 강한 흡인 (영역 안): 가까울수록 강함
      const t = 1 - dist / PULL_RADIUS;
      return PULL_LERP_BASE + t * t * (PULL_LERP_INNER - PULL_LERP_BASE);
    }
    // 영역 밖 약한 중력: PULL_RADIUS → GRAVITY_RADIUS 거리 비례
    const t = 1 - (dist - PULL_RADIUS) / (GRAVITY_RADIUS - PULL_RADIUS);
    return GRAVITY_LERP_MAX * t * t;
  }
  /** 거리에 따른 swirl 회전 — 영역 안 강한 회전 + 외곽 약한 swirl */
  swirlRateAt(dist: number): number {
    if (dist >= GRAVITY_RADIUS) return 0;
    if (dist < PULL_RADIUS) {
      const t = 1 - dist / PULL_RADIUS;
      return SWIRL_RATE_BASE + t * t * (SWIRL_RATE_INNER - SWIRL_RATE_BASE);
    }
    const t = 1 - (dist - PULL_RADIUS) / (GRAVITY_RADIUS - PULL_RADIUS);
    return GRAVITY_SWIRL_MAX * t * t;
  }
  spawnAbsorbBurst(wx: number, wy: number) {
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const spd = 0.4 + Math.random() * 1.2;
      const colors = [COL_FLARE, COL_AMBER_200, COL_YELLOW_200, COL_SKY_200, COL_SKY_100];
      this.absorbs.push({
        x: wx, y: wy, prevX: wx, prevY: wy,
        vx: Math.cos(a) * spd, vy: Math.sin(a) * spd,
        life: 0,
        maxLife: 18 + Math.random() * 14,
        size: 0.9 + Math.random() * 1.2,
        color: colors[Math.floor(Math.random() * colors.length)],
      });
    }
  }

  update(dt: number, cameraX: number, cameraY: number) {
    if (!this.active) return;
    this.time += dt;

    // 페이즈 전환
    this.phaseTimer += dt;
    const curLen = PHASE_LEN[this.phase];
    if (this.phaseTimer >= curLen) {
      this.phaseTimer -= curLen;
      this.phase = (this.phase + 1) % PHASE_LEN.length;
      if (this.phase === PHASE_SPAWN) {
        this.placeGalaxy();
        this.uStrength = 0;
        this.uInflowMul = 1.0;
      }
    }

    // uStrength + inflow per phase
    if (this.phase === PHASE_SPAWN) {
      this.uStrength = this.phaseTimer / PH_SPAWN;
      this.uInflowMul = 1.0;
    } else if (this.phase === PHASE_ACTIVE) {
      this.uStrength = 1.0;
      this.uInflowMul = 1.0;
    } else if (this.phase === PHASE_COLLAPSE) {
      const t = this.phaseTimer / PH_COLLAPSE;
      this.uStrength = 1 - t * 0.7;
      this.uInflowMul = 1 + t * 8;  // 별 빠르게 코어로 흘러감
    } else {
      this.uStrength = 0;
      this.uInflowMul = 1.0;
    }

    // mesh position + uniforms
    if (this.mesh && this.shader) {
      this.mesh.position.set(this.centerX - cameraX, this.centerY - cameraY);
      this.mesh.visible = this.uStrength > 0.001;
      this.shader.uniforms.uTime = this.time * 0.016;
      this.shader.uniforms.uStrength = this.uStrength;
      this.shader.uniforms.uInflowMul = this.uInflowMul;
    }

    // absorbs
    for (let i = this.absorbs.length - 1; i >= 0; i--) {
      const p = this.absorbs[i];
      p.life += dt;
      p.prevX = p.x; p.prevY = p.y;
      const dx = this.centerX - p.x;
      const dy = this.centerY - p.y;
      p.vx += dx * 0.04 * dt;
      p.vy += dy * 0.04 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.92;
      p.vy *= 0.92;
      if (p.life >= p.maxLife) swapPop(this.absorbs, i);
    }

    this.draw(cameraX, cameraY);
  }

  private draw(camX: number, camY: number) {
    this.gfx.clear();
    for (const p of this.absorbs) {
      const lt = p.life / p.maxLife;
      const a = lt < 0.15 ? lt / 0.15 : 1 - (lt - 0.15) / 0.85;
      if (a < 0.04) continue;
      const x = p.x - camX;
      const y = p.y - camY;
      const ppx = p.prevX - camX;
      const ppy = p.prevY - camY;
      this.gfx.lineStyle(p.size * 0.9, p.color, a * 0.7);
      this.gfx.moveTo(ppx, ppy);
      this.gfx.lineTo(x, y);
      this.gfx.lineStyle(0);
      this.gfx.beginFill(p.color, a);
      this.gfx.drawCircle(x, y, p.size);
      this.gfx.endFill();
    }
  }

  stop() {
    this.active = false;
    this.absorbs = [];
    this.phase = PHASE_SPAWN;
    this.phaseTimer = 0;
    this.uStrength = 0;
    this.uInflowMul = 1.0;
    this.gfx.clear();
    if (this.mesh) this.mesh.visible = false;
  }

  destroy() {
    this.stop();
    if (this.mesh) {
      this.mesh.destroy({ children: true });
      this.mesh = null;
    }
    if (this.shader) {
      this.shader = null;
    }
    this.container.destroy({ children: true });
  }
}
