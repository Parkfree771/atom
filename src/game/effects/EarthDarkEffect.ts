import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 흙+암흑 2단계 — 유성우 (Meteor Shower)
 *
 * 컨셉: 캐릭터 주변에 어두운 운석들이 지속적으로 위에서 떨어져 다중 폭발.
 *        운석 = 흙(돌/모래) + 암흑(검은 코어 + 보라 trail).
 *        다른 모든 효과와 거동 완전 새로움 — 위에서 떨어지는 다중 착탄.
 *
 * 구조 — 지속형 (사이클 머신 X):
 *   - 매 16f마다 운석 1개 spawn → 캐릭터 주변 80~250px 랜덤 위치
 *   - 동시 활성 운석 ~5개
 *
 * 각 운석 흐름 (~50f / 0.83초):
 *   1. 예고 (PREDICT, 25f) — 지면에 어두운 보라 그림자 원이 점점 커짐
 *   2. 낙하 (FALLING,  15f) — 작은 운석이 위쪽 80px에서 그림자 위치로 떨어짐 + trail
 *   3. 착탄 (IMPACT,   10f) — 작은 충격파 + 폭발 셀 + 데미지 발동
 *
 * 검증된 컴포넌트:
 *   - 폭발 셀/충격파 → WaterFireEffect.spawnBurst/drawShockwaves 패턴 (작게)
 *   - 운석 trail → WaterLightEffect 광점 trail 패턴 (모래/보라)
 *   - 다중 인스턴스 → FireElectricEffect 체인 봄버 패턴
 *
 * ★ 흰 원 방지 룰 (처음부터 적용):
 *   - ADD 글로우 사이즈 ≤ r*1.2, 알파 ≤ 0.20
 *   - NORMAL 우선 — 큰 원은 NORMAL로 채움
 *   - 백색 0 — 가장 밝은 톤도 모래 라이트 (0xd4a53c)
 *   - 어두운 컨셉이라 밝은 글로우 자체가 적음
 */

const enum MeteorPhase {
  FALLING = 0,
  IMPACT = 1,
}

// ── 운석 인스턴스 ──
interface Meteor {
  /** 컨테이너 로컬 — 착탄 위치 (지면) */
  targetX: number;
  targetY: number;
  /** 낙하 시작 오프셋 (사선 — targetX/Y 기준 상대 위치) */
  startOffsetX: number;
  startOffsetY: number;
  phase: MeteorPhase;
  /** 페이즈 내 진행 시간 */
  timer: number;
  /** 폭발 셀 (착탄 후 사용) */
  burstParticles: BurstParticle[];
  /** 충격파 (착탄 후 사용) */
  shockwaveProgress: number;
  /** 운석 본체 색 톤 인덱스 (다양성) */
  toneIdx: number;
  /** 착탄 발동 알림 (엔진이 한 번만 데미지 처리) */
  impactFired: boolean;
}

// ── 폭발 셀 ──
interface BurstParticle {
  x: number; y: number;
  vx: number; vy: number;
  life: number;
  maxLife: number;
  size: number;
  /** 0=어둠 잔해, 1=모래 분진, 2=검 잔해, 3=황금 화염 (소수) */
  type: 0 | 1 | 2 | 3;
}

// ── 운석 본체 색 톤 (다양성 — 단일 톤 누적 흰끼 방지) ──
interface MeteorTone {
  outer: number; // 외곽 (어두운 갈색)
  inner: number; // 코어 (진보라/검)
}
const METEOR_TONES: MeteorTone[] = [
  { outer: 0x3a1a0a, inner: 0x44168b }, // 갈/진보라
  { outer: 0x2d1a04, inner: 0x2e1065 }, // 진갈/violet-950
  { outer: 0x5c3d08, inner: 0x1a0530 }, // 갈/짙은보라
  { outer: 0x3a1a0a, inner: 0x0a0015 }, // 갈/거의검정
];

export class EarthDarkEffect {
  private container: PIXI.Container;
  /** ADD (작게만) — 운석 본체 약한 글로우, 폭발 약한 글로우 */
  private glowGfx: PIXI.Graphics;
  /** NORMAL — 모든 본체 (그림자, 운석, trail, 충격파, 폭발 셀) */
  private cellGfx: PIXI.Graphics;

  active = false;
  private posX = 0;
  private posY = 0;

  // 운석 인스턴스 풀
  private meteors: Meteor[] = [];

  // spawn 타이머
  private spawnTimer = 0;
  private readonly SPAWN_INTERVAL = 9; // 매 9f마다 새 운석 (다다다닥)

  // 운석 spawn 반경 (좁힘 — 캐릭터 주변 집중)
  private readonly SPAWN_MIN_DIST = 30;
  private readonly SPAWN_MAX_DIST = 140;

  // 페이즈 길이 (PREDICT 제거 — 예고 원 X, spawn 즉시 낙하)
  private readonly FALLING_DURATION = 22; // 유성 천천히
  private readonly IMPACT_DURATION = 8;

  // 폭발 반경
  readonly impactRadius = 50;

  // 이번 프레임 착탄 좌표 (월드) — 엔진이 데미지 처리에 사용
  impactsThisFrame: Array<{ x: number; y: number }> = [];

  // ── 색 (백색 0, 흙 + 암흑 본질 살림) ──
  // 흙
  private readonly COL_EARTH_DARKEST = 0x1a0f02;
  private readonly COL_EARTH_DARK    = 0x2d1a04;
  private readonly COL_EARTH_BROWN   = 0x78520a;
  private readonly COL_EARTH_MAIN    = 0xa16207; // amber-700
  private readonly COL_EARTH_MID     = 0xb8860b;
  private readonly COL_EARTH_SAND    = 0xd4a53c;
  // 암흑
  private readonly COL_DARK_BLACK    = 0x0a0015;
  private readonly COL_DARK_DEEP     = 0x1a0530;
  private readonly COL_DARK_VIOLET   = 0x2e1065;
  private readonly COL_DARK_PURPLE   = 0x44168b;

  constructor(parent: PIXI.Container) {
    this.container = new PIXI.Container();
    parent.addChild(this.container);

    // 글로우 (가장 아래, ADD — 매우 작게만 사용)
    this.glowGfx = new PIXI.Graphics();
    this.glowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.glowGfx);

    // NORMAL — 모든 본체
    this.cellGfx = new PIXI.Graphics();
    this.container.addChild(this.cellGfx);
  }

  start(x: number, y: number) {
    this.active = true;
    this.posX = x;
    this.posY = y;
    this.meteors = [];
    this.spawnTimer = 0;
    this.impactsThisFrame = [];
    this.container.position.set(x, y);
    this.container.visible = true;
  }

  setPosition(x: number, y: number) {
    this.posX = x;
    this.posY = y;
    this.container.position.set(x, y);
  }

  update(dt: number) {
    if (!this.active) return;
    this.impactsThisFrame = [];

    // 운석 spawn 타이머
    this.spawnTimer += dt;
    while (this.spawnTimer >= this.SPAWN_INTERVAL) {
      this.spawnTimer -= this.SPAWN_INTERVAL;
      this.spawnMeteor();
    }

    // 운석 인스턴스 업데이트
    for (let i = this.meteors.length - 1; i >= 0; i--) {
      const m = this.meteors[i];
      m.timer += dt;

      switch (m.phase) {
        case MeteorPhase.FALLING:
          // trail은 매 프레임 drawTrail에서 시작점→현재점으로 직접 그림 (점 배열 X — 잔상 방지)
          if (m.timer >= this.FALLING_DURATION) {
            m.phase = MeteorPhase.IMPACT;
            m.timer = 0;
            // 착탄 — 폭발 셀 spawn + 엔진 데미지 알림
            this.spawnImpactBurst(m);
            m.shockwaveProgress = 0;
            m.impactFired = true;
            this.impactsThisFrame.push({
              x: this.posX + m.targetX,
              y: this.posY + m.targetY,
            });
          }
          break;

        case MeteorPhase.IMPACT:
          // 폭발 셀 + 충격파 진행
          for (let j = m.burstParticles.length - 1; j >= 0; j--) {
            const p = m.burstParticles[j];
            p.life += dt;
            if (p.life >= p.maxLife) {
              swapPop(m.burstParticles, j);
              continue;
            }
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.vx *= 0.92;
            p.vy *= 0.92;
          }
          m.shockwaveProgress += dt / 12;

          // IMPACT 단계 끝 + 셀이 모두 사라지면 인스턴스 종료
          if (m.timer >= this.IMPACT_DURATION && m.burstParticles.length === 0) {
            swapPop(this.meteors, i);
          }
          break;
      }
    }

    this.draw();
  }

  // ═══════════════════════════════════════════════════════════
  //  운석 spawn
  // ═══════════════════════════════════════════════════════════

  private spawnMeteor() {
    // 캐릭터 기준 30~140px 랜덤 위치 (좁힘)
    const angle = Math.random() * Math.PI * 2;
    const dist = this.SPAWN_MIN_DIST + Math.random() * (this.SPAWN_MAX_DIST - this.SPAWN_MIN_DIST);
    // ★ 사선 시작 오프셋 — 모두 우상 → 좌하 한 방향, 일관된 45° 각도
    // X: +양수 (오른쪽 위에서 시작), Y: -양수 (위쪽에서 시작)
    // 거리는 약간 변동하되 비율은 정확히 1:1 유지 (각도 일관)
    const offsetMagnitude = 95 + Math.random() * 30; // 95~125px
    const startOffsetX = +offsetMagnitude; // 오른쪽
    const startOffsetY = -offsetMagnitude; // 위쪽 → 같은 거리 → 정확히 45° 사선

    this.meteors.push({
      targetX: Math.cos(angle) * dist,
      targetY: Math.sin(angle) * dist,
      startOffsetX,
      startOffsetY,
      phase: MeteorPhase.FALLING, // 즉시 낙하 시작 (PREDICT 제거)
      timer: 0,
      burstParticles: [],
      shockwaveProgress: 0,
      toneIdx: Math.floor(Math.random() * METEOR_TONES.length),
      impactFired: false,
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  착탄 시 폭발 셀 spawn
  // ═══════════════════════════════════════════════════════════

  private spawnImpactBurst(m: Meteor) {
    // 폭발 셀 24개 (12 → 24, 파바박)
    const total = 24;
    for (let i = 0; i < total; i++) {
      const angle = (i / total) * Math.PI * 2 + (Math.random() - 0.5) * 0.35;
      // 속도 더 빠르게 (3~7)
      const speed = 3 + Math.random() * 4;

      const r = Math.random();
      let type: 0 | 1 | 2 | 3;
      let size: number;
      let maxLife: number;
      // 황금 제거 — 흙/암흑 위주
      if (r < 0.40) {
        type = 0; // 어둠 잔해 (진보라) — 비율 늘림
        size = 1.5 + Math.random() * 1.8;
        maxLife = 20 + Math.random() * 12;
      } else if (r < 0.75) {
        type = 1; // 모래 분진 — 비율 유지
        size = 1.4 + Math.random() * 1.6;
        maxLife = 24 + Math.random() * 14;
      } else {
        type = 2; // 검 잔해 — 비율 늘림
        size = 1.4 + Math.random() * 1.5;
        maxLife = 26 + Math.random() * 14;
      }

      const startDist = 2 + Math.random() * 4;
      m.burstParticles.push({
        x: m.targetX + Math.cos(angle) * startDist,
        y: m.targetY + Math.sin(angle) * startDist,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        maxLife,
        size,
        type,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  렌더링
  // ═══════════════════════════════════════════════════════════

  private draw() {
    this.glowGfx.clear();
    this.cellGfx.clear();

    for (const m of this.meteors) {
      switch (m.phase) {
        case MeteorPhase.FALLING:
          // 예고 그림자 X — trail + 운석 본체만
          this.drawTrail(m);
          this.drawMeteor(m);
          break;
        case MeteorPhase.IMPACT:
          this.drawShockwave(m);
          this.drawBurstParticles(m);
          break;
      }
    }
  }

  // ── 낙하 trail — 매 프레임 시작점→현재점 직선 (segment 분할로 alpha 페이드) ──
  // 점 배열 X — 잔상 0
  private drawTrail(m: Meteor) {
    const fallT = m.timer / this.FALLING_DURATION;
    const ease = fallT * fallT;

    // 현재 운석 위치 (사선 lerp)
    const fx = m.startOffsetX * (1 - ease);
    const fy = m.startOffsetY * (1 - ease);
    const curX = m.targetX + fx;
    const curY = m.targetY + fy;

    // 시작점 (target + 시작 오프셋, 사선 위쪽)
    let startX = m.targetX + m.startOffsetX;
    let startY = m.targetY + m.startOffsetY;

    // trail 길이 제한 (최대 90px) — 너무 길어지지 않게
    const maxTrailLen = 90;
    const dx = curX - startX;
    const dy = curY - startY;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > maxTrailLen) {
      const ratio = maxTrailLen / len;
      startX = curX - dx * ratio;
      startY = curY - dy * ratio;
    }
    if (len < 4) return;

    const tone = METEOR_TONES[m.toneIdx];
    const segments = 6;
    // 시작점 → 현재점, 시작 측은 흐림 / 현재 측은 진함
    for (let i = 0; i < segments; i++) {
      const t1 = i / segments;
      const t2 = (i + 1) / segments;
      const x1 = startX + (curX - startX) * t1;
      const y1 = startY + (curY - startY) * t1;
      const x2 = startX + (curX - startX) * t2;
      const y2 = startY + (curY - startY) * t2;
      // alpha: i = segments-1 (현재 측) 진함 → i = 0 (시작 측) 흐림
      const alpha = ((i + 1) / segments) * 0.90;

      // 1) 외곽 보라
      this.cellGfx.lineStyle(5, tone.inner, alpha * 0.55);
      this.cellGfx.moveTo(x1, y1);
      this.cellGfx.lineTo(x2, y2);

      // 2) 중간 검
      this.cellGfx.lineStyle(3, this.COL_DARK_BLACK, alpha * 0.80);
      this.cellGfx.moveTo(x1, y1);
      this.cellGfx.lineTo(x2, y2);

      // 3) 코어 갈 (운석 본체 색)
      this.cellGfx.lineStyle(1.4, tone.outer, alpha * 0.95);
      this.cellGfx.moveTo(x1, y1);
      this.cellGfx.lineTo(x2, y2);
    }
    this.cellGfx.lineStyle(0);
  }

  // ── 운석 본체 (낙하 중 — 사선 방향 길쭉한 불규칙 다각형) ──
  private drawMeteor(m: Meteor) {
    const fallT = m.timer / this.FALLING_DURATION;
    const ease = fallT * fallT;
    // 사선 시작 오프셋 → 0 (착탄)
    const fx = m.startOffsetX * (1 - ease);
    const fy = m.startOffsetY * (1 - ease);
    const x = m.targetX + fx;
    const y = m.targetY + fy;

    // 사이즈 점점 커짐 (가까워짐)
    const sz = 4.5 + ease * 4.5; // 4.5 → 9

    const tone = METEOR_TONES[m.toneIdx];

    // 사선 운동 방향 (시작 → target = -startOffset 방향)
    // 우상→좌하 = (-startOffsetX, -startOffsetY) = (음수, 양수)
    // motionAngle = atan2(positive, negative)
    const motionAngle = Math.atan2(-m.startOffsetY, -m.startOffsetX);
    const cosA = Math.cos(motionAngle);
    const sinA = Math.sin(motionAngle);

    // 운석 외곽 — 6각형 길쭉 (X 방향 1.6배)
    // 점은 toneIdx 기반으로 결정론적으로 생성 (매 프레임 동일 → 깜박임 X)
    const outerPoints: number[] = [];
    const seed = m.toneIdx + 1;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      // 약간 불규칙 (seed 기반 결정론)
      const noise = Math.sin(a * 3 + seed * 1.7) * 0.18;
      const rx = Math.cos(a) * sz * (1.6 + noise); // X 길쭉
      const ry = Math.sin(a) * sz * (0.85 + noise * 0.5);
      // motionAngle 회전
      const wx = rx * cosA - ry * sinA;
      const wy = rx * sinA + ry * cosA;
      outerPoints.push(x + wx, y + wy);
    }
    this.cellGfx.beginFill(tone.outer, 0.95);
    this.cellGfx.drawPolygon(outerPoints);
    this.cellGfx.endFill();

    // 중간 (진보라/검) — 6각형, 0.65x 사이즈
    const innerPoints: number[] = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3; // 살짝 회전
      const noise = Math.sin(a * 3 + seed * 2.1) * 0.15;
      const rx = Math.cos(a) * sz * (1.05 + noise);
      const ry = Math.sin(a) * sz * (0.55 + noise * 0.5);
      const wx = rx * cosA - ry * sinA;
      const wy = rx * sinA + ry * cosA;
      innerPoints.push(x + wx, y + wy);
    }
    this.cellGfx.beginFill(tone.inner, 0.95);
    this.cellGfx.drawPolygon(innerPoints);
    this.cellGfx.endFill();

    // 코어 (거의 검정) — 작은 원 한 점
    this.cellGfx.beginFill(this.COL_DARK_BLACK, 0.95);
    this.cellGfx.drawCircle(x, y, sz * 0.40);
    this.cellGfx.endFill();
  }

  // ── 착탄 충격파 (NORMAL 라인, 더 두껍고 임팩트, 흙/암흑 위주) ──
  private drawShockwave(m: Meteor) {
    const p = m.shockwaveProgress;
    if (p >= 1) return;

    // 더 빠르게 팽창 (40% → 100%)
    const r = (0.40 + p * 0.60) * this.impactRadius;
    const fade = (1 - p) * (1 - p);

    // 가장 외곽 — 진보라 (더 굵음)
    this.cellGfx.lineStyle(6 * (1 - p * 0.30), this.COL_DARK_PURPLE, fade * 0.65);
    this.cellGfx.drawCircle(m.targetX, m.targetY, r);

    // 외곽 — 짙은 보라
    this.cellGfx.lineStyle(4 * (1 - p * 0.25), this.COL_DARK_DEEP, fade * 0.75);
    this.cellGfx.drawCircle(m.targetX, m.targetY, r);

    // 중간 — 검
    this.cellGfx.lineStyle(2.5 * (1 - p * 0.20), this.COL_DARK_BLACK, fade * 0.85);
    this.cellGfx.drawCircle(m.targetX, m.targetY, r);

    // 코어 — 갈색 흙 (분진)
    this.cellGfx.lineStyle(1.4, this.COL_EARTH_BROWN, fade * 0.70);
    this.cellGfx.drawCircle(m.targetX, m.targetY, r);

    this.cellGfx.lineStyle(0);
  }

  // ── 폭발 셀 (NORMAL only — 글로우 X, 흙/암흑 위주) ──
  private drawBurstParticles(m: Meteor) {
    for (const p of m.burstParticles) {
      const lifeFrac = p.life / p.maxLife;
      const sizePhase = lifeFrac < 0.20
        ? 1 + lifeFrac * 1.2
        : 1.24 - (lifeFrac - 0.20) * 0.5;
      const r = p.size * sizePhase;

      let color: number;
      let alpha: number;

      if (p.type === 0) {
        // 어둠 잔해 (진보라) — 톤 다양화
        const darkTones = [this.COL_DARK_PURPLE, this.COL_DARK_VIOLET, this.COL_DARK_DEEP];
        color = darkTones[Math.floor((p.x + p.y) * 7) & 3 % darkTones.length];
        alpha = (1 - lifeFrac * 0.40) * 0.94;
      } else if (p.type === 1) {
        // 모래 분진 — 4톤 다양화
        const sandTones = [this.COL_EARTH_MAIN, this.COL_EARTH_MID, this.COL_EARTH_SAND, this.COL_EARTH_BROWN];
        color = sandTones[Math.floor((p.x + p.y) * 7) & 3];
        alpha = (1 - lifeFrac * 0.35) * 0.92;
      } else {
        // 검 잔해 (어두움)
        const blackTones = [this.COL_DARK_DEEP, this.COL_DARK_BLACK, this.COL_EARTH_DARKEST];
        color = blackTones[Math.floor((p.x + p.y) * 5) & 3 % blackTones.length];
        alpha = (1 - lifeFrac * 0.30) * 0.90;
      }

      this.cellGfx.beginFill(color, alpha);
      this.cellGfx.drawCircle(p.x, p.y, r);
      this.cellGfx.endFill();
    }
  }

  stop() {
    this.active = false;
    this.container.visible = false;
    this.meteors = [];
    this.impactsThisFrame = [];
    this.spawnTimer = 0;
    this.glowGfx.clear();
    this.cellGfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
