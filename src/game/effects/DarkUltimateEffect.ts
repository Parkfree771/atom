import * as PIXI from 'pixi.js';
import { CANVAS_W, CANVAS_H } from '../types';
import { swapPop } from './utils';

/**
 * 암흑 × 3 (AAA) — 블랙홀 (1단계 극대화 형태)
 *
 * 슬롯 3칸이 모두 암흑일 때 발동되는 고유 이펙트.
 * 1단계 암흑(미니 중력 우물, DarkEffect)과는 별개의 클래스이며,
 * 시각·게임 거동 모두 본질적으로 다른 "완전체 블랙홀" 형태.
 *
 * 시각:
 *   GLSL Filter — 공간 왜곡 (배경이 블랙홀 중심으로 빨려듦) → groundLayer
 *   Graphics — 사건의 지평선 링 + 어두운 코어 + 흡입 입자 → overlayLayer(스크린 좌표)
 *
 * ★ 좌표계 통일 (개발서 규칙 4):
 *   gfx — overlayLayer(stage 직속)에 스크린 좌표로 그림
 *   셰이더 — uTexSize는 apply 오버라이드로 실제 렌더 텍스처 크기 주입
 *
 * ★ 컨테이너 (개발서 규칙 7):
 *   GLSL Filter는 groundLayer(=worldContainer 인자)에만 적용 — 캐릭터/몬스터 안 가려짐
 */

// ── GLSL 중력 렌즈 셰이더 ──
const DISTORT_FRAG = [
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
  '  if (dist > uRadius * 0.85) {',
  '    gl_FragColor = texture2D(uSampler, vTextureCoord);',
  '    return;',
  '  }',
  '',
  '  float r = uRadius * 0.85;',
  '  float t = clamp(dist / r, 0.0, 1.0);',
  '  float warp = pow(max(t, 0.02), 0.35 + uStrength * 0.5);',
  '  vec2 dir = normalize(delta + vec2(0.0001));',
  '  vec2 warpedCoord = uCenter + dir * r * warp;',
  '  vec2 warpedUV = warpedCoord / uTexSize;',
  '  vec4 color = texture2D(uSampler, warpedUV);',
  '',
  '  float darkness = smoothstep(0.0, 0.45, t);',
  '  color.rgb *= darkness;',
  '',
  '  float ringDist = (t - 0.82) * 7.0;',
  '  float ring = exp(-(ringDist * ringDist));',
  '  float swirl = sin(atan(delta.y, delta.x) * 4.0 - uTime * 2.0) * 0.5 + 0.5;',
  '  color.rgb += vec3(0.30, 0.10, 0.55) * ring * 0.5 * (0.6 + swirl * 0.4);',
  '',
  '  float voidMask = smoothstep(0.0, 0.18, t);',
  '  color.rgb *= voidMask;',
  '',
  '  gl_FragColor = color;',
  '}',
].join('\n');

// ── 흡입 입자 ──
interface DarkParticle {
  angle: number;
  radius: number;
  speed: number;
  angularSpeed: number;
  size: number;
  spawnRadius: number;
}

export class DarkUltimateEffect {
  private container: PIXI.Container;
  private gfx: PIXI.Graphics;
  private worldContainer: PIXI.Container;
  private filter: PIXI.Filter | null = null;

  active = false;
  private posX = 0;
  private posY = 0;
  private screenX = 0;
  private screenY = 0;
  private effectRadius = 200;
  private time = 0;
  private particles: DarkParticle[] = [];

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
    this.particles = [];

    if (!this.filter) {
      this.filter = new PIXI.Filter(undefined, DISTORT_FRAG, {
        uCenter: [0, 0],
        uRadius: radius,
        uStrength: 0.5,
        uTime: 0,
        uTexSize: [CANVAS_W, CANVAS_H],
      });
      this.filter.padding = 0;

      // ★ apply 오버라이드: 실제 렌더 텍스처 크기를 매 프레임 uTexSize에 주입 (개발서 규칙 4)
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

    // 흡입 입자 생성
    if (this.time % 3 < 1 && this.particles.length < 50) {
      this.spawnParticle();
    }

    // 입자 업데이트 (안쪽으로 나선 흡입)
    const R = this.effectRadius;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.radius -= p.speed * dt;
      p.angle += p.angularSpeed * dt;
      p.speed += 0.02 * dt;
      p.angularSpeed += 0.002 * dt;
      if (p.radius < R * 0.05) {
        swapPop(this.particles, i);
      }
    }

    this.draw();
  }

  private spawnParticle() {
    const R = this.effectRadius;
    const angle = Math.random() * Math.PI * 2;
    const radius = R * (0.7 + Math.random() * 0.3);
    this.particles.push({
      angle,
      radius,
      speed: 0.3 + Math.random() * 0.4,
      angularSpeed: 0.015 + Math.random() * 0.01,
      size: 1.5 + Math.random() * 2,
      spawnRadius: radius,
    });
  }

  private draw() {
    this.gfx.clear();
    const R = this.effectRadius;
    const px = this.screenX;
    const py = this.screenY;

    // ── 사건의 지평선 링 (보라빛, 맥동) ──
    const pulse = 1 + Math.sin(this.time * 0.06) * 0.04;
    const ringR = R * 0.82 * pulse;

    this.gfx.lineStyle(3, 0x7c3aed, 0.4);
    this.gfx.drawCircle(px, py, ringR);
    this.gfx.lineStyle(1.5, 0xa78bfa, 0.25);
    this.gfx.drawCircle(px, py, ringR * 1.05);
    this.gfx.lineStyle(0);

    // ── 중심 코어 (짙은 보라/검정) ──
    this.gfx.beginFill(0x0a0015, 0.7);
    this.gfx.drawCircle(px, py, R * 0.15);
    this.gfx.endFill();
    this.gfx.beginFill(0x1a0530, 0.4);
    this.gfx.drawCircle(px, py, R * 0.25);
    this.gfx.endFill();

    // ── 흡입 입자 (어두운 보라, 중심으로 나선) ──
    this.gfx.lineStyle(0);
    for (const p of this.particles) {
      const x = px + Math.cos(p.angle) * p.radius;
      const y = py + Math.sin(p.angle) * p.radius;
      const progress = 1 - p.radius / p.spawnRadius;
      const alpha = (1 - progress * 0.6) * 0.6;
      const sz = p.size * (1 - progress * 0.5);

      this.gfx.beginFill(0x7c3aed, alpha);
      this.gfx.drawCircle(x, y, sz);
      this.gfx.endFill();
    }
  }

  stop() {
    this.active = false;
    this.particles = [];
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
