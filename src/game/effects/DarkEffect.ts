import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 암흑 1단계 — 미니 중력 우물 (Mini Gravity Well, 설치형)
 *
 * AAA 블랙홀(DarkUltimateEffect)과는 별개의 가벼운 1단계 이펙트.
 * GLSL 미사용, Graphics only. 작은 검은 점 + 얇은 보라 링 + 소량 입자.
 *
 * 컨셉:
 *   - "암흑 = 중력" 패러다임은 유지하되 시각·게임 거동 모두 미니멀
 *   - 흡인은 약하고, 데미지는 약하고, 시각은 담백하다
 *   - 본격 블랙홀(GLSL + 강착원반 + 사건의 지평선)은 슬롯 3칸이 모두 암흑일 때
 *
 * 시각:
 *   - 짙은 보라 코어 (작은 채움 원 2겹)
 *   - 얇은 보라 링 1~2겹 (호흡)
 *   - 나선으로 천천히 빨려드는 보라 입자 ~10개
 *
 * 좌표:
 *   - overlayLayer 자식 컨테이너에 그림. 매 프레임 카메라 받아 스크린 좌표 계산.
 *   - 설치형: 한 번 활성화 시 위치 고정, 이동 안 함.
 */

interface MiniDarkParticle {
  angle: number;
  radius: number;
  speed: number;
  angularSpeed: number;
  size: number;
  spawnRadius: number;
}

export class DarkEffect {
  private container: PIXI.Container;
  private gfx: PIXI.Graphics;

  active = false;
  private posX = 0;
  private posY = 0;
  private screenX = 0;
  private screenY = 0;
  private effectRadius = 90;
  private time = 0;
  private particles: MiniDarkParticle[] = [];

  // 시그니처는 기존 DarkEffect와 동일하게 유지 (worldContainer 인자는 사용하지 않음)
  constructor(screenLayer: PIXI.Container, _worldContainer: PIXI.Container) {
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
  }

  update(dt: number, cameraX: number, cameraY: number) {
    if (!this.active) return;
    this.time += dt;

    this.screenX = this.posX - cameraX;
    this.screenY = this.posY - cameraY;

    // 입자 생성 — 천천히, 동시에 ~10개만
    if (this.time % 6 < 1 && this.particles.length < 10) {
      this.spawnParticle();
    }

    // 입자 업데이트 (안쪽으로 나선 흡입, 가속 약함)
    const R = this.effectRadius;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.radius -= p.speed * dt;
      p.angle += p.angularSpeed * dt;
      // 가속은 매우 미미 — 미니 중력
      p.speed += 0.005 * dt;
      if (p.radius < R * 0.08) {
        swapPop(this.particles, i);
      }
    }

    this.draw();
  }

  private spawnParticle() {
    const R = this.effectRadius;
    this.particles.push({
      angle: Math.random() * Math.PI * 2,
      radius: R * (0.75 + Math.random() * 0.25),
      speed: 0.18 + Math.random() * 0.18,
      angularSpeed: 0.01 + Math.random() * 0.008,
      size: 1.2 + Math.random() * 1.0,
      spawnRadius: R * 0.95,
    });
  }

  private draw() {
    this.gfx.clear();
    const R = this.effectRadius;
    const px = this.screenX;
    const py = this.screenY;

    // ── 얇은 보라 링 (호흡) ──
    const pulse = 1 + Math.sin(this.time * 0.05) * 0.04;
    const ringR = R * 0.78 * pulse;
    this.gfx.lineStyle(1.5, 0x7c3aed, 0.32);
    this.gfx.drawCircle(px, py, ringR);
    this.gfx.lineStyle(1.0, 0xa78bfa, 0.18);
    this.gfx.drawCircle(px, py, ringR * 1.06);
    this.gfx.lineStyle(0);

    // ── 중심 코어 (작은 검은 점) ──
    this.gfx.beginFill(0x0a0015, 0.85);
    this.gfx.drawCircle(px, py, R * 0.10);
    this.gfx.endFill();
    this.gfx.beginFill(0x1a0530, 0.40);
    this.gfx.drawCircle(px, py, R * 0.18);
    this.gfx.endFill();

    // ── 흡입 입자 (보라 점, 천천히) ──
    for (const p of this.particles) {
      const x = px + Math.cos(p.angle) * p.radius;
      const y = py + Math.sin(p.angle) * p.radius;
      const progress = 1 - p.radius / p.spawnRadius;
      const alpha = (1 - progress * 0.5) * 0.55;
      const sz = p.size * (1 - progress * 0.4);

      this.gfx.beginFill(0x7c3aed, alpha);
      this.gfx.drawCircle(x, y, sz);
      this.gfx.endFill();
    }
  }

  stop() {
    this.active = false;
    this.particles = [];
    this.gfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
