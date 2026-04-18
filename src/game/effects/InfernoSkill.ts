import * as PIXI from 'pixi.js';
import { EnemyState, ParticleState, CANVAS_W, CANVAS_H } from '../types';
import { isBossType } from '../types';
import { spawnHitParticles, spawnExplosionParticles } from '../particles';

/**
 * 불 액티브 스킬 — 지옥염 (Inferno)
 *
 * 컨셉: 현재 보이는 화면 전체에 일정 간격(grid)으로 화염 ember 를 월드좌표에 심음.
 *       짧은 차징 후 중심→외곽 ripple 순서로 연쇄 폭발. 대해일과 겹치지 않게
 *       "카펫 폭격 + 체류형 2차 불꽃" 컨셉.
 *
 * 좌표계 (개발서 규칙 4/7):
 *   - ember 는 월드 좌표 (start 시점의 카메라 기반 화면 그리드 → 월드좌표로 변환하여 저장)
 *   - 자체 container 를 overlayLayer 에 추가하고 매 프레임 cameraX/Y 만큼 역시프트
 *     → 내부 Graphics 는 월드좌표 그대로 써도 카메라 따라 자연스럽게 이동
 *   - GLSL 열기 shimmer 는 groundLayer 에만 (캐릭터 안 가려짐)
 *
 * 시각 디자인 (규칙 6 — 흰색 피함, 연속 색 보간):
 *   red-900 → red-600 → orange-500 → amber-400 → yellow-400
 */

// ── GLSL 열기 셰이더 ──
// 낮은 진폭의 수직 사인 + 점점 커지는 amplitude, 폭발 순간 radial brightness spike.
const INFERNO_FRAG = [
  'varying vec2 vTextureCoord;',
  'uniform sampler2D uSampler;',
  'uniform float uTime;',
  'uniform float uShimmer;',     // 0..1 — 열기 강도 (charge 단계에 증가)
  'uniform float uBrightness;',  // 0..1 — 폭발 시 적열
  'uniform vec2 uTexSize;',
  '',
  'void main(void) {',
  '  vec2 pix = vTextureCoord * uTexSize;',
  '  float s = uShimmer;',
  '',
  '  // 수직 사인 왜곡 (열기)',
  '  float w1 = sin(pix.y * 0.045 + uTime * 3.0) * 3.5 * s;',
  '  float w2 = sin(pix.y * 0.11  - uTime * 2.1) * 1.8 * s;',
  '  float w3 = sin(pix.x * 0.05  + uTime * 2.6) * 1.2 * s;',
  '  vec2 distorted = pix + vec2(w1 + w2, w3);',
  '  vec4 color = texture2D(uSampler, distorted / uTexSize);',
  '',
  '  // 바닥 warm tint (하단으로 갈수록 강함)',
  '  float depth = clamp(pix.y / uTexSize.y, 0.0, 1.0);',
  '  vec3 warm = vec3(0.55, 0.18, 0.06);',
  '  color.rgb = mix(color.rgb, color.rgb * (1.0 - 0.55 * s) + warm * depth * s * 0.55, s);',
  '',
  '  // 폭발 적열 — 전체 화면 red-orange 브라이트',
  '  if (uBrightness > 0.001) {',
  '    vec3 hot = vec3(0.98, 0.36, 0.08);',
  '    color.rgb = mix(color.rgb, color.rgb + hot, uBrightness * 0.55);',
  '  }',
  '',
  '  gl_FragColor = color;',
  '}',
].join('\n');

// 팔레트
const COL_DEEP   = 0x7f1d1d; // red-900
const COL_RED    = 0xdc2626; // red-600
const COL_ORANGE = 0xf97316; // orange-500
const COL_AMBER  = 0xfbbf24; // amber-400
const COL_YEL    = 0xfacc15; // yellow-400

const COLOR_STOPS: Array<[number, number, number, number]> = [
  [0.00, 250, 204,  21], // yellow-400
  [0.25, 251, 191,  36], // amber-400
  [0.55, 249, 115,  22], // orange-500
  [0.80, 220,  38,  38], // red-600
  [1.00, 127,  29,  29], // red-900
];

function lerpHotColor(t: number): number {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < COLOR_STOPS.length; i++) {
    const [t1, r1, g1, b1] = COLOR_STOPS[i];
    if (t <= t1) {
      const [t0, r0, g0, b0] = COLOR_STOPS[i - 1];
      const k = (t - t0) / (t1 - t0);
      const r = Math.round(r0 + (r1 - r0) * k);
      const g = Math.round(g0 + (g1 - g0) * k);
      const b = Math.round(b0 + (b1 - b0) * k);
      return (r << 16) | (g << 8) | b;
    }
  }
  const last = COLOR_STOPS[COLOR_STOPS.length - 1];
  return (last[1] << 16) | (last[2] << 8) | last[3];
}

// ── 페이즈 타이밍 (frames, 60fps 가정) ──
const PHASE_SEED   = 18;   // 0.30s — ember 순차 스폰
const PHASE_CHARGE = 36;   // 0.60s — 차징
const PHASE_BLAST  = 60;   // 1.00s — ripple 폭발
const PHASE_FADE   = 18;   // 0.30s — 잔연
const PHASE_TOTAL  = PHASE_SEED + PHASE_CHARGE + PHASE_BLAST + PHASE_FADE; // 132

// ── Grid 규모 ──
const GRID_COLS = 8;
const GRID_ROWS = 5;
const BLAST_RADIUS = 86;
const DMG_REG  = 230;
const DMG_BOSS = 150;

interface Ember {
  wx: number; wy: number;    // 월드 좌표
  spawnDelay: number;        // seed 단계에서 언제 등장할지 (0..PHASE_SEED)
  blastDelay: number;        // blast 단계에서 언제 터질지 (0..PHASE_BLAST)
  spawned: boolean;
  exploded: boolean;
  explodedAt: number;        // frame (blast 단계 기준)
  damaged: Set<number>;      // 해당 폭발로 이미 타격된 적 idx
}

interface InfernoState {
  frame: number;             // 현재 프레임 (0..PHASE_TOTAL)
  embers: Ember[];
  cameraStartX: number;      // 시작 시 카메라 — ripple 중심 계산용
  cameraStartY: number;
  canvasW: number;
  canvasH: number;
  active: boolean;
  shimmer: number;           // 현재 uShimmer uniform
  brightness: number;        // 현재 uBrightness uniform
  shakeAcc: number;          // 카메라 쉐이크용 (상태로 반영 X, 외부에서 접근)
}

export class InfernoSkill {
  private overlayLayer: PIXI.Container;
  private groundLayer: PIXI.Container;

  // 월드좌표 시뮬 컨테이너 (overlayLayer 안에 두고 매 프레임 -camera 시프트)
  private worldWrap: PIXI.Container;
  private markerGfx: PIXI.Graphics;
  private coreGfx: PIXI.Graphics;
  private glowGfx: PIXI.Graphics;

  // 추가 스크린 오버레이 (flash)
  private screenOverlay: PIXI.Graphics;

  private filter: PIXI.Filter | null = null;
  private runtime: InfernoState | null = null;
  private time = 0;

  constructor(overlayLayer: PIXI.Container, groundLayer: PIXI.Container) {
    this.overlayLayer = overlayLayer;
    this.groundLayer = groundLayer;

    this.worldWrap = new PIXI.Container();
    this.overlayLayer.addChild(this.worldWrap);

    this.glowGfx = new PIXI.Graphics();
    this.glowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.worldWrap.addChild(this.glowGfx);

    this.coreGfx = new PIXI.Graphics();
    this.coreGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.worldWrap.addChild(this.coreGfx);

    this.markerGfx = new PIXI.Graphics();
    this.worldWrap.addChild(this.markerGfx);

    this.screenOverlay = new PIXI.Graphics();
    this.screenOverlay.blendMode = PIXI.BLEND_MODES.ADD;
    this.overlayLayer.addChild(this.screenOverlay);
  }

  isActive(): boolean {
    return this.runtime !== null && this.runtime.active;
  }

  private ensureFilter() {
    if (this.filter) return;
    this.filter = new PIXI.Filter(undefined, INFERNO_FRAG, {
      uTime: 0,
      uShimmer: 0,
      uBrightness: 0,
      uTexSize: [CANVAS_W, CANVAS_H],
    });
    this.filter.padding = 0;
    const f = this.filter;
    f.apply = function (fm: any, input: any, output: any, clearMode: any) {
      if (input && input.width > 0) {
        f.uniforms.uTexSize = [input.width, input.height];
      }
      fm.applyFilter(f, input, output, clearMode);
    };
  }

  private attachFilter() {
    if (!this.filter) return;
    this.groundLayer.filterArea = new PIXI.Rectangle(0, 0, CANVAS_W, CANVAS_H);
    const existing = this.groundLayer.filters || [];
    if (!existing.includes(this.filter)) {
      this.groundLayer.filters = [...existing, this.filter];
    }
  }

  private detachFilter() {
    if (!this.filter || !this.groundLayer.filters) return;
    this.groundLayer.filters = this.groundLayer.filters.filter((f) => f !== this.filter);
  }

  /** 스킬 발동 — cameraX/Y 기준의 화면 전체를 grid 로 분할해 ember 배치 */
  start(cameraX: number, cameraY: number, canvasW: number, canvasH: number) {
    if (this.runtime && this.runtime.active) return;
    this.ensureFilter();
    this.attachFilter();

    // grid cell 크기
    const cellW = canvasW / GRID_COLS;
    const cellH = canvasH / GRID_ROWS;

    // ripple 중심 — 화면 중앙 (월드좌표)
    const centerWX = cameraX + canvasW / 2;
    const centerWY = cameraY + canvasH / 2;

    const embers: Ember[] = [];
    const maxDist = Math.hypot(canvasW / 2, canvasH / 2);

    for (let cy = 0; cy < GRID_ROWS; cy++) {
      for (let cx = 0; cx < GRID_COLS; cx++) {
        // cell 중심 + 약간 랜덤 오프셋 (정갈함 유지하려 범위 작게)
        const sx = cellW * (cx + 0.5) + (Math.random() - 0.5) * cellW * 0.22;
        const sy = cellH * (cy + 0.5) + (Math.random() - 0.5) * cellH * 0.22;
        const wx = cameraX + sx;
        const wy = cameraY + sy;

        // 스폰 딜레이 — 위에서 아래로 sweep
        const sweepT = cy / GRID_ROWS + (cx / GRID_COLS) * 0.15;
        const spawnDelay = Math.floor(sweepT * (PHASE_SEED - 2));

        // 폭발 딜레이 — 중심에서 가까울수록 먼저 터짐
        const dist = Math.hypot(wx - centerWX, wy - centerWY);
        const rippleT = dist / maxDist;
        const blastDelay = Math.floor(rippleT * (PHASE_BLAST - 10) + Math.random() * 4);

        embers.push({
          wx, wy,
          spawnDelay,
          blastDelay,
          spawned: false,
          exploded: false,
          explodedAt: 0,
          damaged: new Set<number>(),
        });
      }
    }

    this.runtime = {
      frame: 0,
      embers,
      cameraStartX: cameraX,
      cameraStartY: cameraY,
      canvasW,
      canvasH,
      active: true,
      shimmer: 0,
      brightness: 0,
      shakeAcc: 0,
    };
    this.time = 0;
  }

  update(
    dt: number,
    enemies: EnemyState[],
    particles: ParticleState[],
    cameraX: number,
    cameraY: number,
    canvasW: number,
    canvasH: number,
    onKill: (idx: number) => void,
  ) {
    const rt = this.runtime;
    if (!rt || !rt.active) return;

    this.time += dt;
    rt.frame += dt;

    // 월드 컨테이너를 카메라 반대로 시프트 → 내부 월드좌표 그대로 쓰기
    this.worldWrap.x = -cameraX;
    this.worldWrap.y = -cameraY;

    // 페이즈 판정
    const f = rt.frame;
    const inSeed    = f < PHASE_SEED;
    const inCharge  = f >= PHASE_SEED && f < PHASE_SEED + PHASE_CHARGE;
    const inBlast   = f >= PHASE_SEED + PHASE_CHARGE && f < PHASE_SEED + PHASE_CHARGE + PHASE_BLAST;
    const inFade    = f >= PHASE_SEED + PHASE_CHARGE + PHASE_BLAST;
    const fBlast    = Math.max(0, f - (PHASE_SEED + PHASE_CHARGE));
    const fFade     = Math.max(0, f - (PHASE_SEED + PHASE_CHARGE + PHASE_BLAST));

    // 1) Seed — ember 순차 등장
    if (inSeed) {
      for (const em of rt.embers) {
        if (!em.spawned && f >= em.spawnDelay) {
          em.spawned = true;
          // 스폰 순간 작은 파티클 튐
          spawnHitParticles(particles, em.wx, em.wy, COL_AMBER);
        }
      }
    } else {
      // 시드 완료 → 모두 spawned
      for (const em of rt.embers) em.spawned = true;
    }

    // 2) shimmer / brightness uniform 진행
    if (inSeed) {
      rt.shimmer = 0.15 * (f / PHASE_SEED);
    } else if (inCharge) {
      const k = (f - PHASE_SEED) / PHASE_CHARGE;
      rt.shimmer = 0.15 + 0.55 * k;                  // 0.15 → 0.70
    } else if (inBlast) {
      rt.shimmer = 0.70 + 0.25 * Math.min(1, fBlast / 20);  // 0.70 → 0.95 로 peak
    } else if (inFade) {
      const k = 1 - fFade / PHASE_FADE;
      rt.shimmer = 0.95 * Math.max(0, k);
    }

    // 3) Blast — ripple 폭발 트리거
    let justExplodedCount = 0;
    if (inBlast || inFade) {
      for (let i = 0; i < rt.embers.length; i++) {
        const em = rt.embers[i];
        if (em.exploded) continue;
        if (fBlast >= em.blastDelay) {
          em.exploded = true;
          em.explodedAt = fBlast;
          justExplodedCount++;
          this.detonate(em, enemies, particles, onKill);
        }
      }
    }

    // brightness — 방금 터진 ember 수에 비례해 누적 펄스
    if (justExplodedCount > 0) {
      rt.brightness = Math.min(1, rt.brightness + justExplodedCount * 0.18);
    }
    // brightness 자연 감쇠
    rt.brightness = Math.max(0, rt.brightness - 0.045 * dt);

    // uniform 주입
    if (this.filter) {
      this.filter.uniforms.uTime = this.time * 0.016;
      this.filter.uniforms.uShimmer = rt.shimmer;
      this.filter.uniforms.uBrightness = rt.brightness;
    }

    // 종료
    if (rt.frame >= PHASE_TOTAL) {
      rt.active = false;
      this.detachFilter();
      this.clearGfx();
      return;
    }

    // 4) 렌더
    this.render(rt, cameraX, cameraY, canvasW, canvasH);
  }

  private detonate(
    em: Ember,
    enemies: EnemyState[],
    particles: ParticleState[],
    onKill: (idx: number) => void,
  ) {
    // 폭발 파티클
    spawnExplosionParticles(particles, em.wx, em.wy, COL_ORANGE, 14);
    spawnExplosionParticles(particles, em.wx, em.wy, COL_YEL, 6);

    // 적 범위 판정
    const r2 = BLAST_RADIUS * BLAST_RADIUS;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.active) continue;
      if (em.damaged.has(i)) continue;
      const dx = e.x - em.wx;
      const dy = e.y - em.wy;
      if (dx * dx + dy * dy > r2) continue;
      em.damaged.add(i);
      const boss = isBossType(e.type);
      e.hp -= boss ? DMG_BOSS : DMG_REG;
      spawnHitParticles(particles, e.x, e.y, COL_ORANGE);
      if (e.hp <= 0) onKill(i);
    }
  }

  private clearGfx() {
    this.markerGfx.clear();
    this.coreGfx.clear();
    this.glowGfx.clear();
    this.screenOverlay.clear();
  }

  private render(
    rt: InfernoState,
    cameraX: number,
    cameraY: number,
    canvasW: number,
    canvasH: number,
  ) {
    this.clearGfx();
    void cameraX; void cameraY; void canvasW; void canvasH;

    const fBlast = Math.max(0, rt.frame - (PHASE_SEED + PHASE_CHARGE));
    const chargeK = rt.frame < PHASE_SEED
      ? 0
      : Math.min(1, (rt.frame - PHASE_SEED) / PHASE_CHARGE);

    // ── 마커 (charging 동안 펄스 + ring) ──
    for (const em of rt.embers) {
      if (!em.spawned) continue;

      // 폭발 후 afterburn — 코어 + 링 잔불
      if (em.exploded) {
        const sinceBlast = fBlast - em.explodedAt;
        const life = 30;  // 폭발 직후 30f 지속
        if (sinceBlast > life) continue;
        const k = 1 - sinceBlast / life;
        const rad = BLAST_RADIUS * (0.55 + (1 - k) * 0.65);

        // 큰 글로우 (ADD)
        this.glowGfx.beginFill(COL_ORANGE, 0.32 * k);
        this.glowGfx.drawCircle(em.wx, em.wy, rad);
        this.glowGfx.endFill();
        this.glowGfx.beginFill(COL_RED, 0.20 * k);
        this.glowGfx.drawCircle(em.wx, em.wy, rad * 0.6);
        this.glowGfx.endFill();

        // 코어
        this.coreGfx.beginFill(COL_YEL, 0.95 * k);
        this.coreGfx.drawCircle(em.wx, em.wy, 8 + (1 - k) * 10);
        this.coreGfx.endFill();
        this.coreGfx.beginFill(COL_AMBER, 0.75 * k);
        this.coreGfx.drawCircle(em.wx, em.wy, 14 + (1 - k) * 8);
        this.coreGfx.endFill();

        // 외곽 링
        this.markerGfx.lineStyle(3 * k, COL_ORANGE, 0.85 * k);
        this.markerGfx.drawCircle(em.wx, em.wy, rad * 0.9);
        this.markerGfx.lineStyle(1.5 * k, COL_YEL, 0.9 * k);
        this.markerGfx.drawCircle(em.wx, em.wy, rad * 0.65);
        this.markerGfx.lineStyle(0);
        continue;
      }

      // 대기 중 — 펄스 ember (charging 단계에서 강해짐)
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 0.2 + em.wx * 0.02 + em.wy * 0.02);
      const strength = 0.35 + chargeK * 0.65;
      const coreR = 3 + chargeK * 3.5 + pulse * 1.6;
      const ringR = 14 + chargeK * 10 + pulse * 3;

      // 중심 코어
      this.coreGfx.beginFill(COL_YEL, 0.75 * strength);
      this.coreGfx.drawCircle(em.wx, em.wy, coreR);
      this.coreGfx.endFill();
      this.coreGfx.beginFill(COL_ORANGE, 0.55 * strength);
      this.coreGfx.drawCircle(em.wx, em.wy, coreR * 1.8);
      this.coreGfx.endFill();

      // 타겟 링
      this.markerGfx.lineStyle(1.5 + chargeK * 1.2, COL_RED, 0.55 + chargeK * 0.4);
      this.markerGfx.drawCircle(em.wx, em.wy, ringR);
      this.markerGfx.lineStyle(0);

      // charging 막바지 — 두 번째 링
      if (chargeK > 0.5) {
        this.markerGfx.lineStyle(1, COL_ORANGE, (chargeK - 0.5) * 0.9);
        this.markerGfx.drawCircle(em.wx, em.wy, ringR * 0.65);
        this.markerGfx.lineStyle(0);
      }
    }

    // ── 스크린 오버레이 (flash) — 폭발 밝기에 비례 ──
    if (rt.brightness > 0.05) {
      const col = lerpHotColor(0.2 + (1 - rt.brightness) * 0.4);
      this.screenOverlay.beginFill(col, rt.brightness * 0.18);
      this.screenOverlay.drawRect(0, 0, CANVAS_W, CANVAS_H);
      this.screenOverlay.endFill();
    }
  }

  destroy() {
    this.detachFilter();
    if (this.filter) {
      this.filter.destroy?.();
      this.filter = null;
    }
    this.worldWrap.destroy({ children: true });
    this.screenOverlay.destroy();
    this.runtime = null;
  }
}

// 언사용 상수 경고 방지
void COL_DEEP;
