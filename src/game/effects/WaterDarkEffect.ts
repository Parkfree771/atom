import * as PIXI from 'pixi.js';
import { CANVAS_W, CANVAS_H } from '../types';
import { swapPop } from './utils';

/**
 * 물+암흑 2단계 — 메일스트롬 (설치형)
 *
 * 컨셉: 바다 한가운데에 거대한 소용돌이가 형성된다.
 * 1단계 암흑(블랙홀)의 설치형 + GLSL 디스토션 패턴을 그대로 가져와서
 * "물의 와류" 로 재해석. 검은 구멍이 아니라 푸른 심해의 입구.
 *
 * 시각:
 *   GLSL Filter — 케플러 회전 + 중심 압축 디스토션 → worldContainer
 *     · 안쪽으로 갈수록 빠른 회전 (실제 소용돌이 공식)
 *     · 중심으로 좌표 압축 (블랙홀과 동일 원리)
 *     · 푸른 심해 톤 입힘
 *     · 가장자리에 부서지는 흰 거품 링
 *   Graphics — overlayLayer (스크린 좌표)
 *     · 수축 파도 링 (바깥→중심)
 *     · 중심 심해 코어 (짙은 남색)
 *     · 가장자리 부서지는 거품 링
 *     · 물 셀 입자 (사방→중심 나선 흡입)
 *     · 거품 셀 (안쪽 빠른 회전, 흰/시안)
 *     · 나선 흐름선 (소용돌이 윤곽)
 *
 * ★ 좌표계 통일 (개발서 규칙 4):
 *   gfx — overlayLayer(stage 직속)에 스크린 좌표로 그림
 *   셰이더 — uTexSize는 apply 오버라이드로 실제 렌더 텍스처 크기 주입
 */

// ── GLSL 와류 + 중력 압축 셰이더 ──
const MAELSTROM_FRAG = [
  'varying vec2 vTextureCoord;',
  'uniform sampler2D uSampler;',
  '',
  'uniform vec2 uCenter;',
  'uniform float uRadius;',
  'uniform float uTime;',
  'uniform vec2 uTexSize;',
  '',
  'void main(void) {',
  '  vec2 pixCoord = vTextureCoord * uTexSize;',
  '  vec2 delta = pixCoord - uCenter;',
  '  float dist = length(delta);',
  '',
  '  if (dist > uRadius) {',
  '    gl_FragColor = texture2D(uSampler, vTextureCoord);',
  '    return;',
  '  }',
  '',
  '  float t = clamp(dist / uRadius, 0.0, 1.0);',
  '',
  '  // ── 와류 회전: 안쪽일수록 빠르게 (케플러 가속 흉내, 천천히 묵직하게) ──',
  '  float baseAngle = atan(delta.y, delta.x);',
  '  float swirlAmount = (1.0 - t) * (1.0 - t) * 4.0 + uTime * 0.6;',
  '  float newAngle = baseAngle + swirlAmount;',
  '',
  '  // ── 중심으로 압축 (블랙홀 흡입 원리) ──',
  '  float warpedDist = dist * pow(max(t, 0.02), 0.45);',
  '',
  '  vec2 warpedCoord = uCenter + vec2(cos(newAngle), sin(newAngle)) * warpedDist;',
  '  vec2 warpedUV = warpedCoord / uTexSize;',
  '  vec4 color = texture2D(uSampler, warpedUV);',
  '',
  '  // ── 푸른 심해 톤 입힘 (안쪽일수록 진함) ──',
  '  vec3 deepBlue = vec3(0.04, 0.12, 0.32);',
  '  vec3 midBlue = vec3(0.10, 0.25, 0.55);',
  '  float depthFactor = 1.0 - smoothstep(0.0, 1.0, t);',
  '  vec3 tintColor = mix(midBlue, deepBlue, depthFactor);',
  '  color.rgb = mix(color.rgb, tintColor, depthFactor * 0.78);',
  '',
  '  // ── 중심 어두운 코어 (심해의 어둠) ──',
  '  float voidMask = smoothstep(0.0, 0.13, t);',
  '  color.rgb *= voidMask;',
  '',
  '  // ── 가장자리 부서지는 거품 링 (옅은 시안, 각도 따라 끊김) ──',
  '  float ringDist = (t - 0.88) * 9.0;',
  '  float foam = exp(-(ringDist * ringDist));',
  '  float foamBreak = sin(baseAngle * 9.0 - uTime * 2.5) * 0.5 + 0.5;',
  '  color.rgb += vec3(0.45, 0.65, 0.85) * foam * foamBreak * 0.30;',
  '',
  '  // ── 안쪽 회전 줄무늬 (와류의 시각화, 천천히) ──',
  '  float stripeAngle = baseAngle * 5.0 - uTime * 1.4 + (1.0 - t) * 8.0;',
  '  float stripe = sin(stripeAngle) * 0.5 + 0.5;',
  '  float stripeMask = (1.0 - t) * smoothstep(0.05, 0.4, t);',
  '  color.rgb += vec3(0.20, 0.40, 0.65) * stripe * stripeMask * 0.32;',
  '',
  '  gl_FragColor = color;',
  '}',
].join('\n');

// ── 물 셀 입자 (사방→중심 나선 흡입, 묵직한 덩어리) ──
interface WaterCell {
  angle: number;
  radius: number;
  speed: number;
  angularSpeed: number;
  size: number;
  spawnRadius: number;
  hue: number; // 0~1, 색 변화용
}

// ── 수축 나선 (외곽에서 시작해 중심으로 빨려드는 나선) ──
interface ContractRing {
  progress: number; // 1.0 (바깥) → 0 (소멸)
  thickness: number;
  startAngle: number; // 나선 시작 각도 (ring마다 다름)
}

export class WaterDarkEffect {
  private container: PIXI.Container;
  private gfx: PIXI.Graphics;
  private worldContainer: PIXI.Container;
  private filter: PIXI.Filter | null = null;

  active = false;
  private posX = 0;
  private posY = 0;
  private screenX = 0;
  private screenY = 0;
  private effectRadius = 180;
  private time = 0;

  private waterCells: WaterCell[] = [];
  private contractRings: ContractRing[] = [];

  constructor(screenLayer: PIXI.Container, worldContainer: PIXI.Container) {
    this.worldContainer = worldContainer;
    this.container = new PIXI.Container();
    screenLayer.addChild(this.container);
    this.gfx = new PIXI.Graphics();
    this.container.addChild(this.gfx);
  }

  start(x: number, y: number, radius: number) {
    this.active = true;
    this.posX = x;
    this.posY = y;
    this.effectRadius = radius;
    this.time = 0;
    this.waterCells = [];
    this.contractRings = [];

    if (!this.filter) {
      this.filter = new PIXI.Filter(undefined, MAELSTROM_FRAG, {
        uCenter: [0, 0],
        uRadius: radius,
        uTime: 0,
        uTexSize: [CANVAS_W, CANVAS_H],
      });
      this.filter.padding = 0;

      // ★ apply 오버라이드: 매 프레임 실제 렌더 텍스처 크기 주입 (개발서 규칙 4)
      const f = this.filter;
      f.apply = function (filterManager: any, input: any, output: any, clearMode: any) {
        if (input && input.width > 0) {
          f.uniforms.uTexSize = [input.width, input.height];
        }
        filterManager.applyFilter(f, input, output, clearMode);
      };
    }
    this.filter.uniforms.uRadius = radius;

    this.worldContainer.filterArea = new PIXI.Rectangle(0, 0, CANVAS_W, CANVAS_H);

    const existing = this.worldContainer.filters || [];
    if (!existing.includes(this.filter)) {
      this.worldContainer.filters = [...existing, this.filter];
    }
  }

  update(dt: number, cameraX: number, cameraY: number) {
    if (!this.active || !this.filter) return;
    this.time += dt;

    // ★ 스크린 좌표 — gfx와 셰이더 모두 이 값 사용
    this.screenX = this.posX - cameraX;
    this.screenY = this.posY - cameraY;

    this.filter.uniforms.uCenter = [this.screenX, this.screenY];
    this.filter.uniforms.uTime = this.time * 0.016;

    const R = this.effectRadius;

    // ── 물 셀 생성 (사방에서, 천천히 묵직하게) ──
    // 3프레임마다 1개씩 (덜 빈번하지만 셀 자체가 묵직함)
    if (this.time % 3 < 1 && this.waterCells.length < 110) {
      this.spawnWaterCell();
    }

    // ── 물 셀 업데이트 (천천히 묵직하게 빨려드는 나선) ──
    for (let i = this.waterCells.length - 1; i >= 0; i--) {
      const p = this.waterCells[i];
      p.radius -= p.speed * dt;
      p.angle += p.angularSpeed * dt;
      // 가속도: 중력에 끌리듯 점점 빨라짐 (단 처음엔 매우 느림)
      p.speed += 0.012 * dt;
      // 안쪽으로 갈수록 회전 빠르게 (케플러), 단 천천히
      p.angularSpeed += 0.0008 * dt;
      if (p.radius < R * 0.06) {
        swapPop(this.waterCells, i);
      }
    }

    // ── 수축 나선 생성 (45프레임마다, 무겁게) ──
    // 더 자주 생성해서 다중 나선 동시 회전 효과
    if (this.time % 45 < 1) {
      this.contractRings.push({
        progress: 1.0,
        thickness: 3.0 + Math.random() * 1.2,
        startAngle: Math.random() * Math.PI * 2,
      });
    }

    // ── 수축 링 업데이트 (바깥→중심, 매우 느리게) ──
    for (let i = this.contractRings.length - 1; i >= 0; i--) {
      const ring = this.contractRings[i];
      ring.progress -= 0.0055 * dt;
      if (ring.progress <= 0) {
        swapPop(this.contractRings, i);
      }
    }

    this.draw();
  }

  private spawnWaterCell() {
    const R = this.effectRadius;
    const angle = Math.random() * Math.PI * 2;
    const radius = R * (0.78 + Math.random() * 0.25);
    this.waterCells.push({
      angle,
      radius,
      // 천천히 묵직하게: 초기 속도 매우 느림 (반)
      speed: 0.12 + Math.random() * 0.18,
      // 회전도 천천히 (반)
      angularSpeed: 0.006 + Math.random() * 0.008,
      // 사이즈는 더 큼 (덩어리)
      size: 2.2 + Math.random() * 2.8,
      spawnRadius: radius,
      hue: Math.random(),
    });
  }

  private draw() {
    this.gfx.clear();
    const R = this.effectRadius;
    const px = this.screenX;
    const py = this.screenY;

    // ── 수축 나선 (외곽→중심으로 빨려드는 보조 나선들, 흐름 강화) ──
    for (const ring of this.contractRings) {
      // progress 1.0 → 0.0: 나선의 외곽 시작점이 점점 안쪽으로
      const outerR = R * (0.06 + ring.progress * 0.85);
      const innerR = R * 0.04;
      const turns = 2.2;
      const segments = 80;
      // 시간 따라 회전 (영구 나선과 같은 방향)
      const baseAngle = ring.startAngle + this.time * 0.022;
      const alpha = ring.progress * 0.55;

      // 외곽 — 진한 남색 글로우
      this.gfx.lineStyle(ring.thickness * 1.6, 0x1e3a8a, alpha * 0.6);
      this.drawSpiralPath(px, py, outerR, innerR, turns, segments, baseAngle);
      // 코어 — 옅은 시안
      this.gfx.lineStyle(ring.thickness * 0.8, 0x60a5fa, alpha);
      this.drawSpiralPath(px, py, outerR, innerR, turns, segments, baseAngle);
    }
    this.gfx.lineStyle(0);

    // ── 영구 외곽 회전 나선 (2겹, 사라지지 않음) ──
    // 가장 바깥에서 큰 나선이 계속 회전 — 단순 원이 아니라 흐름 자체
    {
      const eternalOuterR = R * 0.93;
      const eternalInnerR = R * 0.07;
      const eternalTurns = 2.6;
      const eternalSegments = 110;
      const eternalBaseAngle = this.time * 0.018;

      for (let g = 0; g < 2; g++) {
        // 두 가닥 — 180도 위상 차이
        const phase = eternalBaseAngle + g * Math.PI;
        // 외곽 진한 남색 글로우 (무게감)
        this.gfx.lineStyle(4.5 - g * 0.8, 0x1e3a8a, 0.42 - g * 0.10);
        this.drawSpiralPath(px, py, eternalOuterR, eternalInnerR, eternalTurns, eternalSegments, phase);
        // 코어 시안 라인
        this.gfx.lineStyle(2.0 - g * 0.4, 0x60a5fa, 0.52 - g * 0.12);
        this.drawSpiralPath(px, py, eternalOuterR, eternalInnerR, eternalTurns, eternalSegments, phase);
      }
      this.gfx.lineStyle(0);
    }

    // ── 안쪽 와류 윤곽 링 (천천히 회전, 3겹 겹친 나선) ──
    // 바깥쪽에서 안쪽까지 나선 흐름선
    for (let layer = 0; layer < 3; layer++) {
      const layerT = layer / 3;
      const r = R * (0.35 + layerT * 0.45);
      // 회전 속도 절반 (천천히)
      const phaseShift = this.time * (0.018 - layerT * 0.006);
      this.gfx.lineStyle(1.4 + (1 - layerT) * 0.7, 0x3b82f6, 0.22 - layerT * 0.05);
      // 끊어진 호 (소용돌이 줄무늬)
      const segments = 5;
      for (let s = 0; s < segments; s++) {
        const a0 = (s / segments) * Math.PI * 2 + phaseShift;
        const a1 = a0 + (Math.PI * 2) / segments * 0.55;
        this.drawArc(px, py, r, a0, a1);
      }
    }
    this.gfx.lineStyle(0);

    // ── 물 셀 입자 (묵직한 덩어리, 나선 흡입) ──
    for (const p of this.waterCells) {
      const x = px + Math.cos(p.angle) * p.radius;
      const y = py + Math.sin(p.angle) * p.radius;
      const progress = 1 - p.radius / p.spawnRadius;
      // 알파 더 진하게 (덩어리 느낌)
      const alpha = (1 - progress * 0.4) * 0.85;
      // 크기는 거의 유지하다가 끝에서 살짝 줄어듦
      const sz = p.size * (1 - progress * 0.25);

      // 색: 바깥(파랑) → 안쪽(짙은 남색)
      const baseColor = progress < 0.5 ? 0x2563eb : 0x1e3a8a;
      this.gfx.beginFill(baseColor, alpha);
      this.gfx.drawCircle(x, y, sz);
      this.gfx.endFill();
    }

    // ── 중심 심해 코어 (짙은 남색, 빛이 닿지 않는 곳) ──
    this.gfx.beginFill(0x040814, 0.78);
    this.gfx.drawCircle(px, py, R * 0.13);
    this.gfx.endFill();
    this.gfx.beginFill(0x0a1530, 0.50);
    this.gfx.drawCircle(px, py, R * 0.20);
    this.gfx.endFill();
    this.gfx.beginFill(0x0d2447, 0.30);
    this.gfx.drawCircle(px, py, R * 0.28);
    this.gfx.endFill();

    // 코어 가장자리 얇은 시안 글로우 (입수구 느낌)
    this.gfx.lineStyle(1.2, 0x60a5fa, 0.35);
    this.gfx.drawCircle(px, py, R * 0.135);
    this.gfx.lineStyle(0);
  }

  /** 아르키메데스 나선 경로 그리기 — outerR에서 시작해 innerR까지 N바퀴 돌며 수렴 */
  private drawSpiralPath(
    cx: number,
    cy: number,
    outerR: number,
    innerR: number,
    turns: number,
    segments: number,
    startAngle: number,
  ) {
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const r = outerR + (innerR - outerR) * t;
      const ang = startAngle + t * Math.PI * 2 * turns;
      const x = cx + Math.cos(ang) * r;
      const y = cy + Math.sin(ang) * r;
      if (i === 0) this.gfx.moveTo(x, y);
      else this.gfx.lineTo(x, y);
    }
  }

  /** 짧은 호 그리기 (나선 줄무늬용) */
  private drawArc(cx: number, cy: number, radius: number, a0: number, a1: number) {
    const steps = 10;
    const x0 = cx + Math.cos(a0) * radius;
    const y0 = cy + Math.sin(a0) * radius;
    this.gfx.moveTo(x0, y0);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const a = a0 + (a1 - a0) * t;
      this.gfx.lineTo(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
    }
  }

  stop() {
    this.active = false;
    this.waterCells = [];
    this.contractRings = [];
    this.gfx.clear();

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
