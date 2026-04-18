import * as PIXI from 'pixi.js';
import { CANVAS_W, CANVAS_H } from '../types';
import { swapPop } from './utils';

/**
 * 물 × 3 (AAA) — 대해일 (Tidal Wave)
 *
 * 슬롯 3칸이 모두 물일 때만 발동. 1단계 동심원 파동과 별개의 고유 클래스.
 *
 * 거동:
 *   - 캐릭터 위치 잠금 (사이클 시작 시점)
 *   - 5페이즈 사이클: 형성 → 확장 → 임계 → 폭발 → 잔류
 *   - 파도 띠가 0 → 350px로 확장하면서 적을 외측으로 강하게 밀어냄 (몰아붙임)
 *   - 350px 도달 시 그 자리에서 펑 — 광역 데미지 + 200셀 사방
 *   - 자동 stop → 다음 프레임 새 사이클
 *
 * 시각 핵심 — GLSL 동심원 디스토션:
 *   - 화면 자체가 파도 띠 부근에서 외측으로 휨 (실제 일렁임)
 *   - 사인파 일렁임 (반경 따라)
 *   - 파도 띠 부근 푸른 톤 강화
 *
 * 좌표계 (블랙홀/메일스트롬과 완전 동일, 개발서 규칙 4/7):
 *   - GLSL Filter → groundLayer (캐릭터/몬스터 안 가려짐)
 *   - Graphics → overlayLayer (stage 직속, 스크린 좌표)
 *   - apply 오버라이드로 uTexSize 매 프레임 주입
 *   - update(dt, cameraX, cameraY) — screenX/Y 계산
 *
 * 디자인 원칙:
 *   - 파도 띠 라인 (Graphics) ↔ GLSL uRadius 정확히 일치
 *   - 폭발 입자는 풍부 (200개, 사용자: "과해도 OK")
 *   - 백색 0 (포말은 sky-200)
 */

// ── GLSL 동심원 파도 디스토션 셰이더 ──
const WAVE_FRAG = [
  'varying vec2 vTextureCoord;',
  'uniform sampler2D uSampler;',
  '',
  'uniform vec2 uCenter;',
  'uniform float uRadius;',
  'uniform float uStrength;',
  'uniform float uTime;',
  'uniform vec2 uTexSize;',
  '',
  'void main(void) {',
  '  vec2 pixCoord = vTextureCoord * uTexSize;',
  '  vec2 delta = pixCoord - uCenter;',
  '  float dist = length(delta);',
  '',
  '  // 파도 띠 (현재 반경 ± waveWidth=58, 더 두꺼움)',
  '  float wavePos = dist - uRadius;',
  '  float waveWidth = 58.0;',
  '  float wave = exp(-(wavePos * wavePos) / (waveWidth * waveWidth));',
  '',
  '  // 너무 멀면 effect 0',
  '  if (wave < 0.01) {',
  '    gl_FragColor = texture2D(uSampler, vTextureCoord);',
  '    return;',
  '  }',
  '',
  '  // 외측 방향 디스토션 (파도가 강하게 미는 느낌)',
  '  vec2 dir = normalize(delta + vec2(0.0001));',
  '  float push = wave * uStrength * 70.0;',
  '',
  '  // 사인파 일렁임 (반경 따라, 더 강함)',
  '  float sinePush = sin(dist * 0.06 - uTime * 1.6) * wave * uStrength * 16.0;',
  '',
  '  // 접선 방향 일렁임 추가 (각도 따라 — 좌우로 움직이는 물결)',
  '  float angle = atan(delta.y, delta.x);',
  '  vec2 perp = vec2(-dir.y, dir.x);',
  '  float angularWave = sin(angle * 8.0 + uTime * 1.2) * wave * uStrength * 4.0;',
  '',
  '  vec2 distorted = pixCoord - dir * (push + sinePush) + perp * angularWave;',
  '  vec2 distortedUV = distorted / uTexSize;',
  '  vec4 color = texture2D(uSampler, distortedUV);',
  '',
  '  // 파도 띠 부근 푸른 톤 강하게 강화',
  '  color.rgb += vec3(0.18, 0.48, 0.92) * wave * 0.65 * uStrength;',
  '  // 띠 코어 부근 시안 추가',
  '  float coreBand = exp(-(wavePos * wavePos) / (18.0 * 18.0));',
  '  color.rgb += vec3(0.40, 0.72, 1.00) * coreBand * 0.30 * uStrength;',
  '',
  '  gl_FragColor = color;',
  '}',
].join('\n');

interface WaterCell {
  x: number; y: number;
  prevX: number; prevY: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
  type: number; // 0=포말, 1=시안 메인, 2=진청 잔해
  tStart: number;
  tEnd: number;
}

interface SplashParticle {
  x: number; y: number;
  prevX: number; prevY: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
}

const PHASE_FORMING = 0;
const PHASE_EXPANDING = 1;
const PHASE_BURST = 2;
const PHASE_LINGER = 3;

const P_FORMING = 14;
const P_EXPANDING = 100; // 천천히 확장 (1.67초)
const P_BURST = 25;      // 폭발 (셀 분출, 파도 빠른 페이드)
const P_LINGER = 14;     // 짧은 잔류

const MAX_RADIUS = 190; // 좁힘 (240 → 190)
const WAVE_BAND_HALF = 35; // 데미지 판정 띠 두께 (시각 ring과 동기화)

export class WaterUltimateEffect {
  private container: PIXI.Container;
  private gfx: PIXI.Graphics;
  private glowGfx: PIXI.Graphics;
  private worldContainer: PIXI.Container;
  private filter: PIXI.Filter | null = null;

  // 색상 팔레트 (물 톤, 백/흰끼 X)
  private readonly COL_DEEP   = 0x1e3a8a; // blue-900
  private readonly COL_MAIN   = 0x2563eb; // blue-600
  private readonly COL_LIGHT  = 0x3b82f6; // blue-500
  private readonly COL_CYAN   = 0x60a5fa; // blue-400
  private readonly COL_SKY    = 0x38bdf8; // sky-400 (흰끼 방지)
  private readonly COL_FOAM   = 0x0ea5e9; // sky-500 (흰끼 방지, 가장 밝지만 진한 푸름)

  // 폭발 셀 색 보간 (sky-500 → blue-900, 백 X)
  private readonly COLOR_STOPS: Array<{ t: number; r: number; g: number; b: number }> = [
    { t: 0.00, r:  14, g: 165, b: 233 }, // sky-500 (가장 밝음, 백 X)
    { t: 0.18, r:  56, g: 189, b: 248 }, // sky-400
    { t: 0.35, r:  96, g: 165, b: 250 }, // blue-400
    { t: 0.52, r:  59, g: 130, b: 246 }, // blue-500
    { t: 0.68, r:  37, g:  99, b: 235 }, // blue-600
    { t: 0.82, r:  30, g:  64, b: 175 }, // blue-800
    { t: 1.00, r:  30, g:  58, b: 138 }, // blue-900
  ];

  active = false;
  private posX = 0;
  private posY = 0;
  private screenX = 0;
  private screenY = 0;
  private waveRadius = 0;
  private uStrength = 0;
  private phase = PHASE_FORMING;
  private phaseTimer = 0;
  private time = 0;

  private cells: WaterCell[] = [];
  private splashes: SplashParticle[] = [];

  burstFiredThisFrame = false;
  private splashSpawnCounter = 0;

  constructor(screenLayer: PIXI.Container, worldContainer: PIXI.Container) {
    this.worldContainer = worldContainer;
    this.container = new PIXI.Container();
    screenLayer.addChild(this.container);
    this.glowGfx = new PIXI.Graphics();
    this.glowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.glowGfx);
    this.gfx = new PIXI.Graphics();
    this.container.addChild(this.gfx);
  }

  start(x: number, y: number) {
    this.active = true;
    this.posX = x;
    this.posY = y;
    this.phase = PHASE_FORMING;
    this.phaseTimer = 0;
    this.time = 0;
    this.waveRadius = 0;
    this.uStrength = 0;
    this.cells = [];
    this.splashes = [];
    this.burstFiredThisFrame = false;
    this.splashSpawnCounter = 0;

    if (!this.filter) {
      this.filter = new PIXI.Filter(undefined, WAVE_FRAG, {
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
    this.burstFiredThisFrame = false;

    // ★ 스크린 좌표 (GLSL과 Graphics 모두 이 값 사용 — 일치 보장)
    this.screenX = this.posX - cameraX;
    this.screenY = this.posY - cameraY;

    // ── 페이즈 머신 ──
    switch (this.phase) {
      case PHASE_FORMING: {
        // uStrength 0 → 0.5
        this.uStrength = (this.phaseTimer / P_FORMING) * 0.5;
        this.waveRadius = 0;
        if (this.phaseTimer >= P_FORMING) {
          this.phase = PHASE_EXPANDING;
          this.phaseTimer = 0;
        }
        break;
      }
      case PHASE_EXPANDING: {
        // 파도 반경 0 → MAX (linear), uStrength 0.5 → 1.0
        const t = this.phaseTimer / P_EXPANDING;
        this.waveRadius = MAX_RADIUS * t;
        this.uStrength = 0.5 + t * 0.5;

        // 매 프레임 물보라 spawn (확장 중) — 풍부하게
        this.splashSpawnCounter += dt;
        if (this.splashSpawnCounter >= 1) {
          this.splashSpawnCounter = 0;
          this.spawnSplashes(8); // 매 프레임 8개
        }

        if (this.phaseTimer >= P_EXPANDING) {
          // 끝 도달 즉시 폭발 (CRITICAL 제거 — 잔상 X)
          this.phase = PHASE_BURST;
          this.phaseTimer = 0;
          this.waveRadius = MAX_RADIUS;
          this.burstFiredThisFrame = true;
          this.spawnBurst();
        }
        break;
      }
      case PHASE_BURST: {
        // 폭발 — 파도 띠는 첫 5f 안에 빠르게 페이드 (잔상 즉시 사라짐)
        // GLSL uStrength도 빠르게 페이드
        this.waveRadius = MAX_RADIUS;
        this.uStrength = Math.max(0, 1.0 - this.phaseTimer / 6);
        if (this.phaseTimer >= P_BURST) {
          this.phase = PHASE_LINGER;
          this.phaseTimer = 0;
          this.uStrength = 0;
        }
        break;
      }
      case PHASE_LINGER: {
        // 셀만 페이드, GLSL 비활성
        this.uStrength = 0;
        if (this.phaseTimer >= P_LINGER) {
          this.stop();
          return;
        }
        break;
      }
    }

    // ── GLSL uniform 갱신 ──
    this.filter.uniforms.uCenter = [this.screenX, this.screenY];
    this.filter.uniforms.uRadius = this.waveRadius;
    this.filter.uniforms.uStrength = this.uStrength;
    this.filter.uniforms.uTime = this.time * 0.016;

    // ── 셀/물보라 update ──
    this.updateCells(dt);
    this.updateSplashes(dt);

    this.draw();
  }

  // ── 폭발 셀 spawn (400개) — 사인파 파도 곡선 위에서 spawn (원형 X) ──
  private spawnBurst() {
    const N = 400;
    const t = this.time;
    // drawWaveBand의 outerR과 동일한 사인파 함수
    const wavyR = (a: number) =>
      MAX_RADIUS
      + Math.sin(a * 5 + t * 0.10) * 11
      + Math.sin(a * 9 + t * 0.07) * 5
      + Math.sin(a * 14 + t * 0.13) * 2.5;

    for (let i = 0; i < N; i++) {
      const angle = (i / N) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
      // 시작 위치: 사인파 곡선 위 (파도 형태 그대로 터짐)
      const baseR = wavyR(angle);
      const r = baseR + (Math.random() - 0.5) * 18;
      const sx = this.screenX + Math.cos(angle) * r;
      const sy = this.screenY + Math.sin(angle) * r;
      const speed = 5 + Math.random() * 9;

      const rType = Math.random();
      let type: number;
      let size: number;
      let life: number;
      let tStart: number;
      let tEnd: number;
      if (rType < 0.25) {
        // 포말 (밝음, 짧음)
        type = 0;
        size = 2.0 + Math.random() * 2.0;
        life = 18 + Math.random() * 14;
        tStart = 0.00;
        tEnd = 0.45;
      } else if (rType < 0.75) {
        // 시안 메인
        type = 1;
        size = 1.8 + Math.random() * 2.4;
        life = 24 + Math.random() * 18;
        tStart = 0.18;
        tEnd = 0.72;
      } else {
        // 진청 잔해
        type = 2;
        size = 1.5 + Math.random() * 2.0;
        life = 28 + Math.random() * 20;
        tStart = 0.55;
        tEnd = 1.00;
      }

      this.cells.push({
        x: sx, y: sy,
        prevX: sx, prevY: sy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life, maxLife: life,
        size,
        type,
        tStart,
        tEnd,
      });
    }
  }

  // ── 물보라 spawn (확장 페이즈 동안 파도 띠 위치에서, 풍부하게) ──
  private spawnSplashes(count: number) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      // 띠 외곽 부근에서 spawn (앞면 거품)
      const r = this.waveRadius + 5 + Math.random() * 25;
      const sx = this.screenX + Math.cos(angle) * r;
      const sy = this.screenY + Math.sin(angle) * r;
      // 외측으로 강하게 튐
      const outwardSpeed = 2.0 + Math.random() * 3.5;
      this.splashes.push({
        x: sx, y: sy,
        prevX: sx, prevY: sy,
        vx: Math.cos(angle) * outwardSpeed,
        vy: Math.sin(angle) * outwardSpeed,
        life: 18 + Math.random() * 16,
        maxLife: 34,
        size: 1.5 + Math.random() * 2.2,
      });
    }
  }

  // ── 색 보간 ──
  private lerpWaterColor(t: number): number {
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

  // ── 페이즈 헬퍼 update ──
  private updateCells(dt: number) {
    for (let i = this.cells.length - 1; i >= 0; i--) {
      const c = this.cells[i];
      c.prevX = c.x;
      c.prevY = c.y;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.vx *= 0.94;
      c.vy *= 0.94;
      c.life -= dt;
      if (c.life <= 0) {
        swapPop(this.cells, i);
      }
    }
  }

  private updateSplashes(dt: number) {
    for (let i = this.splashes.length - 1; i >= 0; i--) {
      const s = this.splashes[i];
      s.prevX = s.x;
      s.prevY = s.y;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vx *= 0.95;
      s.vy *= 0.95;
      s.life -= dt;
      if (s.life <= 0) {
        swapPop(this.splashes, i);
      }
    }
  }

  // ── 그리기 ──
  private draw() {
    this.gfx.clear();
    this.glowGfx.clear();

    // 1. 캐릭터 중심 코어 (LINGER 제외)
    if (this.phase !== PHASE_LINGER) {
      this.drawCenterCore();
    }

    // 2. 파도 띠 — 확장 페이즈만 그림. BURST에서는 첫 6f 동안 빠른 페이드.
    if (this.phase === PHASE_EXPANDING) {
      this.drawWaveBand(1.0);
    } else if (this.phase === PHASE_BURST && this.phaseTimer < 6) {
      const fade = 1.0 - this.phaseTimer / 6; // 6f 안에 사라짐
      this.drawWaveBand(fade);
    }

    // 3. 물보라
    this.drawSplashes();

    // 4. 폭발 셀
    this.drawCells();
  }

  private drawCenterCore() {
    const r = 8 + Math.sin(this.time * 0.08) * 2;
    this.gfx.beginFill(this.COL_DEEP, 0.55);
    this.gfx.drawCircle(this.screenX, this.screenY, r);
    this.gfx.endFill();
    this.gfx.beginFill(this.COL_MAIN, 0.45);
    this.gfx.drawCircle(this.screenX, this.screenY, r * 0.55);
    this.gfx.endFill();
    this.gfx.beginFill(this.COL_CYAN, 0.65);
    this.gfx.drawCircle(this.screenX, this.screenY, r * 0.30);
    this.gfx.endFill();
  }

  private drawWaveBand(fade: number = 1.0) {
    const r = this.waveRadius;
    if (r < 5 || fade <= 0.01) return;
    // 파도 띠 — 사인파로 일렁이는 폴리곤 (drawCircle X)
    // 1단계 WaterEffect 패턴 차용 — 다중 주파수 중첩으로 진짜 파도 형태
    const SEGS = 96;
    const t = this.time;

    // 외곽 곡선 (메인 파도)
    const outerR = (a: number) =>
      r
      + Math.sin(a * 5 + t * 0.10) * 11
      + Math.sin(a * 9 + t * 0.07) * 5
      + Math.sin(a * 14 + t * 0.13) * 2.5;

    // 내곽 곡선 (살짝 다른 위상으로)
    const innerR = (a: number) =>
      r - 22
      + Math.sin(a * 5 + t * 0.10 + 0.6) * 9
      + Math.sin(a * 9 + t * 0.07 + 0.4) * 4;

    // ── 1. 두꺼운 채움 영역 (외곽~내곽) — 진짜 파도 띠 ──
    // beginFill + 외곽 따라 그리고 내곽 역순으로 → 닫힌 폴리곤 채움
    const drawFilledBand = (color: number, alpha: number, outerOffset: number, innerOffset: number) => {
      this.gfx.beginFill(color, alpha);
      // 외곽 한 바퀴 (시계방향)
      for (let i = 0; i <= SEGS; i++) {
        const a = (i / SEGS) * Math.PI * 2;
        const rr = outerR(a) + outerOffset;
        const x = this.screenX + Math.cos(a) * rr;
        const y = this.screenY + Math.sin(a) * rr;
        if (i === 0) this.gfx.moveTo(x, y);
        else this.gfx.lineTo(x, y);
      }
      // 내곽 역순 (반시계방향, 구멍 형성)
      for (let i = SEGS; i >= 0; i--) {
        const a = (i / SEGS) * Math.PI * 2;
        const rr = innerR(a) + innerOffset;
        const x = this.screenX + Math.cos(a) * rr;
        const y = this.screenY + Math.sin(a) * rr;
        this.gfx.lineTo(x, y);
      }
      this.gfx.endFill();
    };

    // 채움 — 메인 띠 (fade 곱)
    drawFilledBand(this.COL_DEEP, 0.35 * fade, +6, -6);
    drawFilledBand(this.COL_MAIN, 0.50 * fade, 0, 0);
    drawFilledBand(this.COL_LIGHT, 0.55 * fade, -6, +6);

    // ── 2. 외곽 곡선 라인 (파도 정상) ──
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

    // ADD 글로우 (외곽 곡선) — fade 곱
    drawWavyLine(this.glowGfx, outerR, 18, this.COL_MAIN, 0.28 * fade);
    drawWavyLine(this.glowGfx, outerR, 10, this.COL_LIGHT, 0.32 * fade);

    // NORMAL 외곽 곡선 (파봉 강조) — fade 곱
    drawWavyLine(this.gfx, outerR, 4, this.COL_CYAN, 0.85 * fade);
    drawWavyLine(this.gfx, outerR, 2, this.COL_SKY, 0.95 * fade);
    drawWavyLine(this.gfx, outerR, 1, this.COL_FOAM, 1.00 * fade);

    // 내곽 곡선 (옅은 잔물결)
    drawWavyLine(this.gfx, innerR, 1.5, this.COL_LIGHT, 0.55 * fade);
  }

  private drawSplashes() {
    this.gfx.lineStyle(0);
    for (const s of this.splashes) {
      const t = s.life / s.maxLife;
      const alpha = t * 0.85;
      const sz = s.size * (0.6 + t * 0.4);

      this.gfx.lineStyle(sz * 0.5, this.COL_SKY, alpha * 0.50);
      this.gfx.moveTo(s.prevX, s.prevY);
      this.gfx.lineTo(s.x, s.y);
      this.gfx.lineStyle(0);

      this.gfx.beginFill(this.COL_FOAM, alpha);
      this.gfx.drawCircle(s.x, s.y, sz);
      this.gfx.endFill();
    }
  }

  private drawCells() {
    this.gfx.lineStyle(0);
    for (const c of this.cells) {
      const lifeFrac = c.life / c.maxLife;
      const t = c.tStart + (1 - lifeFrac) * (c.tEnd - c.tStart);
      const color = this.lerpWaterColor(t);
      const alpha = lifeFrac * 0.92;
      const sz = c.size * (0.6 + lifeFrac * 0.4);

      // 포말 셀만 작은 ADD 글로우 (흰끼 방지 — 알파 줄임)
      if (c.type === 0) {
        this.glowGfx.beginFill(color, alpha * 0.20);
        this.glowGfx.drawCircle(c.x, c.y, sz * 1.3);
        this.glowGfx.endFill();
      }

      // 트레일
      this.gfx.lineStyle(sz * 0.55, color, alpha * 0.50);
      this.gfx.moveTo(c.prevX, c.prevY);
      this.gfx.lineTo(c.x, c.y);
      this.gfx.lineStyle(0);

      // 코어
      this.gfx.beginFill(color, alpha);
      this.gfx.drawCircle(c.x, c.y, sz);
      this.gfx.endFill();
    }
  }

  // ── 외부 통신 ──
  get centerX() { return this.posX; }
  get centerY() { return this.posY; }
  get currentRadius() { return this.waveRadius; }
  get burstRadius() { return MAX_RADIUS; }
  get bandHalfThickness() { return WAVE_BAND_HALF; }
  isExpanding(): boolean { return this.phase === PHASE_EXPANDING; }

  stop() {
    this.active = false;
    this.cells = [];
    this.splashes = [];
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
