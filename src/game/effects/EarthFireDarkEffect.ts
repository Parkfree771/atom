import * as PIXI from 'pixi.js';
import { CANVAS_W, CANVAS_H } from '../types';
import { swapPop } from './utils';

/**
 * 흙+불+암흑 3단계 — 심연균열 (Abyssal Rift)
 *
 * 개발서 규칙 준수:
 *   - 규칙 4: GLSL + Graphics 좌표 통일 (overlayLayer 스크린 좌표 + apply 오버라이드)
 *   - 규칙 6(1): 폴리곤 금지, 셀/파티클이 형태 구성
 *   - 규칙 6(2): 장식 금지
 *   - 규칙 7: GLSL Filter는 groundLayer에만
 *
 * 컨셉:
 *   - **설치형** — 콤보 활성 순간 플레이어 위치에 X자 바닥 균열이 설치됨. 플레이어 이동과 무관하게 그 자리 영구 고정.
 *   - 같은 크랙이 BURST_INTERVAL마다 주기적으로 폭발(flash + 3색 파티클 분출 + 광역 피해)
 *   - **크랙 시각 전부 GLSL이 담당** — 셀/도트/폴리곤 일절 없음. 셰이더가 픽셀 단위로 어둡게 렌더링하여 테이퍼 X 형태 표현
 *   - 내부 순검정 + 주변 빨려들어가는 왜곡(3D 흡입 착시)
 *   - **강한 테이퍼** — 중앙 최대 → 양 끝 0. 4 tip 모두 뾰족
 *
 * 버스트 파티클 + 엔진 explosion particles:
 *   - 이펙트 내부 파티클: 주 라인 수직 외측 분출 + 중앙 방사형
 *   - 엔진에서 spawnExplosionParticles 호출 (흙/불/암흑 × 중앙 + 4 tip 5포인트)
 */

// ── GLSL 셰이더 — 테이퍼 기반 왜곡 + 검정 내부 ──
// 단일 크랙 (설치형이라 1개만 필요)
const ABYSSAL_RIFT_FRAG = [
  'varying vec2 vTextureCoord;',
  'uniform sampler2D uSampler;',
  '',
  'uniform vec2 uCenter;',
  'uniform float uStrength;',
  'uniform float uFlashT;',
  'uniform float uHalfLen;',
  'uniform float uTime;',
  'uniform vec2 uTexSize;',
  '',
  '// X자 2대각선 최근접 점 + 거리 + along 정규화 절댓값',
  'void evalCrack(vec2 pix, out float nDist, out float alongAbs, out vec2 nPoint) {',
  '  vec2 d = pix - uCenter;',
  '  // diag1: (0.7071, 0.7071)',
  '  float a1 = (d.x + d.y) * 0.7071068;',
  '  float c1 = clamp(a1, -uHalfLen, uHalfLen);',
  '  vec2 np1 = uCenter + vec2(c1, c1) * 0.7071068;',
  '  float d1 = distance(pix, np1);',
  '  float aa1 = abs(c1) / uHalfLen;',
  '  // diag2: (-0.7071, 0.7071)',
  '  float a2 = (-d.x + d.y) * 0.7071068;',
  '  float c2 = clamp(a2, -uHalfLen, uHalfLen);',
  '  vec2 np2 = uCenter + vec2(-c2, c2) * 0.7071068;',
  '  float d2 = distance(pix, np2);',
  '  float aa2 = abs(c2) / uHalfLen;',
  '  if (d1 < d2) { nDist = d1; alongAbs = aa1; nPoint = np1; }',
  '  else         { nDist = d2; alongAbs = aa2; nPoint = np2; }',
  '}',
  '',
  'void main(void) {',
  '  vec2 pix = vTextureCoord * uTexSize;',
  '',
  '  if (uStrength + uFlashT <= 0.01) {',
  '    gl_FragColor = texture2D(uSampler, vTextureCoord);',
  '    return;',
  '  }',
  '',
  '  float nd, an;',
  '  vec2 np;',
  '  evalCrack(pix, nd, an, np);',
  '',
  '  // ── 1. 흡입 왜곡 — 크랙 쪽으로 당김 (3D 깊이 착시) ──',
  '  float pullRange = 160.0;',
  '  float falloff = 1.0 - clamp(nd / pullRange, 0.0, 1.0);',
  '  falloff *= falloff;',
  '  float pullMag = (uStrength * 0.58 + uFlashT * 0.95) * falloff;',
  '  vec2 sampleCoord = pix + (np - pix) * pullMag;',
  '',
  '  vec4 color = texture2D(uSampler, sampleCoord / uTexSize);',
  '',
  '  // ── 2. 테이퍼 darkening — 중앙 두껍고 tip 얇게 ──',
  '  // alongAbs: 0=중앙, 1=tip. taperFrac: 1=중앙, 0=tip',
  '  float taperFrac = 1.0 - an;',
  '  // 약간 sharper: 곱하기 (pow 없이 곱으로)',
  '  taperFrac = taperFrac * (0.55 + taperFrac * 0.45);',
  '  float coreW = 15.0 * taperFrac + 0.3;',
  '  float rimW = 28.0 * taperFrac + 1.0;',
  '',
  '  if (nd < coreW) {',
  '    float t = nd / max(coreW, 0.01);',
  '    // 순검정에 가깝게',
  '    float darkMul = mix(0.015, 0.24, t * t);',
  '    color.rgb *= mix(1.0, darkMul, uStrength);',
  '  } else if (nd < coreW + rimW) {',
  '    float t = (nd - coreW) / rimW;',
  '    color.rgb *= mix(mix(1.0, 0.34, uStrength), 1.0, t);',
  '  }',
  '',
  '  // ── 3. 버스트 글로우 (주황/빨강, tip 근처 약하게) ──',
  '  float glowReach = 58.0 * taperFrac + 8.0;',
  '  if (uFlashT > 0.0 && nd < glowReach) {',
  '    float g = 1.0 - nd / glowReach;',
  '    g = g * g;',
  '    color.rgb += vec3(0.95, 0.42, 0.12) * g * uFlashT * 1.25;',
  '  }',
  '',
  '  gl_FragColor = color;',
  '}',
].join('\n');

// ── 상수 ──
const CRACK_HALF_LENGTH = 260;

const BURST_INTERVAL = 135;     // ~2.25초마다 폭발
const BURST_FLASH_LIFE = 30;

const PULL_RANGE = 230;
const PULL_LERP = 0.032;
const BURST_HIT_THRESHOLD = 42;
const BURST_DAMAGE = 90;
const BURST_KNOCKBACK = 10;

const BURST_PARTICLES_PER_ARM = 90; // 대각선당 이펙트 내부 파티클
const BURST_CENTER_PARTICLES = 90;  // 중앙 방사형 추가 파티클

// 45° / 135° 대각선
const DIAG1_ANGLE = Math.PI * 0.25;
const DIAG2_ANGLE = Math.PI * 0.75;
const DIAG1_COS = Math.cos(DIAG1_ANGLE);
const DIAG1_SIN = Math.sin(DIAG1_ANGLE);
const DIAG2_COS = Math.cos(DIAG2_ANGLE);
const DIAG2_SIN = Math.sin(DIAG2_ANGLE);

// ── 타입 ──
interface BurstParticle {
  x: number; y: number; // 로컬
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
  type: 0 | 1 | 2; // 0=흙 1=불 2=암흑
}

export class EarthFireDarkEffect {
  private container: PIXI.Container;
  private gfx: PIXI.Graphics;
  private glowGfx: PIXI.Graphics;
  private worldContainer: PIXI.Container; // 실제로는 groundLayer (규칙 7)
  private filter: PIXI.Filter | null = null;

  // ── 팔레트 ──
  private readonly COL_STONE_900 = 0x1c1917;
  private readonly COL_STONE_700 = 0x44403c;
  private readonly COL_STONE_600 = 0x57534e;
  private readonly COL_RED_900 = 0x7f1d1d;
  private readonly COL_RED_700 = 0xb91c1c;
  private readonly COL_ORANGE_500 = 0xf97316;
  private readonly COL_ORANGE_600 = 0xea580c;
  private readonly COL_YELLOW_400 = 0xfacc15;
  private readonly COL_YELLOW_300 = 0xfde047;
  private readonly COL_VIOLET_900 = 0x4c1d95;
  private readonly COL_VIOLET_700 = 0x6d28d9;
  private readonly COL_INDIGO_950 = 0x1e1b4b;

  active = false;
  private installedX = 0;
  private installedY = 0;
  private cameraX = 0;
  private cameraY = 0;
  private time = 0;

  // 버스트 주기 상태
  private burstTimer = 0;
  private burstFlashLife = 0;
  burstFiredThisFrame = false;

  // 버스트 파티클 (셀 제거 — 크랙 시각은 GLSL만)
  private particles: BurstParticle[] = [];

  constructor(overlayLayer: PIXI.Container, worldContainer: PIXI.Container) {
    this.worldContainer = worldContainer;
    this.container = new PIXI.Container();
    overlayLayer.addChild(this.container);

    this.glowGfx = new PIXI.Graphics();
    this.glowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.glowGfx);

    this.gfx = new PIXI.Graphics();
    this.container.addChild(this.gfx);
  }

  /** setPosition — 설치형이라 no-op. 크랙은 start() 위치에 영구 고정 */
  setPosition(_x: number, _y: number) {
    // intentionally empty
  }

  start(x: number, y: number) {
    this.active = true;
    this.installedX = x;
    this.installedY = y;
    this.time = 0;
    this.burstTimer = 0;
    this.burstFlashLife = 0;
    this.burstFiredThisFrame = false;
    this.particles = [];

    if (!this.filter) {
      this.filter = new PIXI.Filter(undefined, ABYSSAL_RIFT_FRAG, {
        uCenter: [0, 0],
        uStrength: 0,
        uFlashT: 0,
        uHalfLen: CRACK_HALF_LENGTH,
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
    this.cameraX = cameraX;
    this.cameraY = cameraY;
    this.burstFiredThisFrame = false;

    // ── 버스트 타이머 ──
    this.burstTimer += dt;
    if (this.burstTimer >= BURST_INTERVAL) {
      this.burstTimer = 0;
      this.burstFlashLife = BURST_FLASH_LIFE;
      this.burstFiredThisFrame = true;
      this.spawnBurstParticles();
    }
    if (this.burstFlashLife > 0) {
      this.burstFlashLife -= dt;
      if (this.burstFlashLife < 0) this.burstFlashLife = 0;
    }

    // ── 파티클 업데이트 ──
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 0.13 * dt;
      p.vx *= 0.965;
      p.vy *= 0.985;
      p.life -= dt;
      if (p.life <= 0) swapPop(this.particles, i);
    }

    // ── 셰이더 uniform ──
    this.filter.uniforms.uCenter = [this.installedX - cameraX, this.installedY - cameraY];
    this.filter.uniforms.uStrength = 1.0;
    // flashT 스파이크: life 끝쪽이 0, 시작쪽이 1 (갓 발동 순간 최대)
    const flashNorm = this.burstFlashLife / BURST_FLASH_LIFE;
    // 초반 급상승 후 감쇠
    this.filter.uniforms.uFlashT = flashNorm * flashNorm;
    this.filter.uniforms.uTime = this.time * 0.016;

    this.draw();
  }

  // ── 버스트 파티클 spawn (이펙트 내부) ──
  private spawnBurstParticles() {
    const arms = [
      { cosA: DIAG1_COS, sinA: DIAG1_SIN },
      { cosA: DIAG2_COS, sinA: DIAG2_SIN },
    ];

    // 1) 각 대각선 따라 수직 외측 분출 (강화 버전)
    for (const arm of arms) {
      const perpX = -arm.sinA;
      const perpY = arm.cosA;

      for (let k = 0; k < BURST_PARTICLES_PER_ARM; k++) {
        const alongT = (Math.random() - 0.5) * 1.85;
        const along = alongT * CRACK_HALF_LENGTH;
        const lx = arm.cosA * along;
        const ly = arm.sinA * along;

        const side = Math.random() < 0.5 ? -1 : 1;
        const spread = (Math.random() - 0.5) * 1.05;
        const cosS = Math.cos(spread);
        const sinS = Math.sin(spread);
        const bvx = perpX * side;
        const bvy = perpY * side;
        const vxL = bvx * cosS - bvy * sinS;
        const vyL = bvx * sinS + bvy * cosS;
        const speed = 2.8 + Math.random() * 4.8;

        const r = Math.random();
        let type: 0 | 1 | 2;
        let size: number;
        let maxLife: number;
        if (r < 0.34) {
          // 흙
          type = 0;
          size = 2.0 + Math.random() * 2.2;
          maxLife = 34 + Math.random() * 18;
        } else if (r < 0.67) {
          // 불
          type = 1;
          size = 1.9 + Math.random() * 2.4;
          maxLife = 26 + Math.random() * 14;
        } else {
          // 암흑
          type = 2;
          size = 2.2 + Math.random() * 2.2;
          maxLife = 38 + Math.random() * 20;
        }

        this.particles.push({
          x: lx, y: ly,
          vx: vxL * speed,
          vy: vyL * speed - 0.6,
          life: maxLife, maxLife, size, type,
        });
      }
    }

    // 2) 중앙 방사형 폭발 (전방위)
    for (let k = 0; k < BURST_CENTER_PARTICLES; k++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 3.2 + Math.random() * 5.0;
      const r = Math.random();
      let type: 0 | 1 | 2;
      let size: number;
      let maxLife: number;
      if (r < 0.34) {
        type = 0;
        size = 2.2 + Math.random() * 2.2;
        maxLife = 38 + Math.random() * 18;
      } else if (r < 0.67) {
        type = 1;
        size = 2.4 + Math.random() * 2.4;
        maxLife = 30 + Math.random() * 14;
      } else {
        type = 2;
        size = 2.6 + Math.random() * 2.2;
        maxLife = 44 + Math.random() * 20;
      }
      this.particles.push({
        x: 0, y: 0,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 0.9,
        life: maxLife, maxLife, size, type,
      });
    }
  }

  // ── 그리기 ──
  private draw() {
    this.gfx.clear();
    this.glowGfx.clear();

    const sx = this.installedX - this.cameraX;
    const sy = this.installedY - this.cameraY;

    // 크랙 시각은 GLSL 셰이더가 담당 — Graphics는 버스트 파티클만
    this.drawParticles(sx, sy);
  }

  private drawParticles(cx: number, cy: number) {
    for (const p of this.particles) {
      const x = cx + p.x;
      const y = cy + p.y;
      const lifeFrac = p.life / p.maxLife;
      let color: number;
      if (p.type === 0) {
        // 흙
        if (lifeFrac > 0.60) color = this.COL_STONE_600;
        else if (lifeFrac > 0.30) color = this.COL_STONE_700;
        else color = this.COL_STONE_900;
      } else if (p.type === 1) {
        // 불
        if (lifeFrac > 0.70) color = this.COL_YELLOW_300;
        else if (lifeFrac > 0.50) color = this.COL_YELLOW_400;
        else if (lifeFrac > 0.30) color = this.COL_ORANGE_500;
        else if (lifeFrac > 0.12) color = this.COL_RED_700;
        else color = this.COL_RED_900;
      } else {
        // 암흑
        color = lifeFrac > 0.5 ? this.COL_VIOLET_700 : this.COL_VIOLET_900;
      }
      const alpha = lifeFrac;
      const sz = p.size * (0.7 + lifeFrac * 0.3);

      if (p.type === 1) {
        this.glowGfx.beginFill(color, alpha * 0.6);
        this.glowGfx.drawCircle(x, y, sz * 1.9);
        this.glowGfx.endFill();
      } else if (p.type === 2) {
        this.glowGfx.beginFill(color, alpha * 0.32);
        this.glowGfx.drawCircle(x, y, sz * 1.5);
        this.glowGfx.endFill();
      }
      this.gfx.beginFill(color, alpha);
      this.gfx.drawCircle(x, y, sz);
      this.gfx.endFill();
    }
  }

  // ── 외부 통신 ──

  /** 설치점 월드 좌표 */
  installedCenter(): { x: number; y: number } {
    return { x: this.installedX, y: this.installedY };
  }

  /** 4 tip 월드 좌표 */
  installedTips(): Array<{ x: number; y: number }> {
    return [
      { x: this.installedX - DIAG1_COS * CRACK_HALF_LENGTH, y: this.installedY - DIAG1_SIN * CRACK_HALF_LENGTH },
      { x: this.installedX + DIAG1_COS * CRACK_HALF_LENGTH, y: this.installedY + DIAG1_SIN * CRACK_HALF_LENGTH },
      { x: this.installedX - DIAG2_COS * CRACK_HALF_LENGTH, y: this.installedY - DIAG2_SIN * CRACK_HALF_LENGTH },
      { x: this.installedX + DIAG2_COS * CRACK_HALF_LENGTH, y: this.installedY + DIAG2_SIN * CRACK_HALF_LENGTH },
    ];
  }

  /** 활성 크랙의 X자 2대각선 세그먼트 — 풀링 + 버스트 피해 판정용 */
  getCrackSegments(): Array<{ x0: number; y0: number; x1: number; y1: number }> {
    if (!this.active) return [];
    return [
      {
        x0: this.installedX - DIAG1_COS * CRACK_HALF_LENGTH,
        y0: this.installedY - DIAG1_SIN * CRACK_HALF_LENGTH,
        x1: this.installedX + DIAG1_COS * CRACK_HALF_LENGTH,
        y1: this.installedY + DIAG1_SIN * CRACK_HALF_LENGTH,
      },
      {
        x0: this.installedX - DIAG2_COS * CRACK_HALF_LENGTH,
        y0: this.installedY - DIAG2_SIN * CRACK_HALF_LENGTH,
        x1: this.installedX + DIAG2_COS * CRACK_HALF_LENGTH,
        y1: this.installedY + DIAG2_SIN * CRACK_HALF_LENGTH,
      },
    ];
  }

  pullRange(): number { return PULL_RANGE; }
  pullLerp(): number { return PULL_LERP; }
  burstHitThreshold(): number { return BURST_HIT_THRESHOLD; }
  burstDamage(): number { return BURST_DAMAGE; }
  burstKnockback(): number { return BURST_KNOCKBACK; }

  stop() {
    this.active = false;
    this.particles = [];
    this.burstFiredThisFrame = false;
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
