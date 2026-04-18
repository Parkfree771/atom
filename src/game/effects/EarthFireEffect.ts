import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 흙+불 2단계 — 마그마 균열 (Magma Fissures)
 *
 * 캐릭터 중심으로 동심원 3링이 동시에 가열되고, 안 → 중 → 바깥 순서로 7프레임 간격
 * 팡팡팡 순차 폭발한다. 바깥 링일수록 셀 수/충격파/풀 모두 효과가 커진다.
 *
 * 장판형 — 컨테이너가 캐릭터를 매 프레임 따라가서 캐릭터가 항상 폭발 중심.
 *
 * 사이클 100f ≈ 1.67초:
 *   A. 예열 (HEATING,    22f) — 3링 동시 가열, 막바지 진동
 *   B. 순차 폭발 (BURST_SEQ, 22f) — 7f 간격 안→밖 팡팡팡 (0f, 7f, 14f)
 *   C. 도넛 풀 (POOL,    44f) — 3링 도넛 풀 부글부글
 *   D. 소멸 (COOLING,    12f) — 식어가며 사라짐 → 새 사이클
 *
 * 데미지 영역 = 도넛 (각 링의 radius ± ringWidth/2)
 * 분출 방향 = 외측만 (캐릭터 안 가림)
 *
 * 디자인 원칙:
 *   - 폴리곤 X, 셀이 형태 (균열선이 둘레의 셀, 풀이 도넛 안의 셀)
 *   - 색상 연속 보간 (10스톱 lerpLavaColor)
 *   - 끝까지 강렬한 색 (마지막은 검은 흙)
 *   - 캐릭터 보호 (안쪽 링도 70px이라 캐릭터 본체 가리지 않음)
 *   - 바깥일수록 큰 효과 = 클라이맥스 구조
 */

// ───────────────────────────────────────────────────────────────
//  타입
// ───────────────────────────────────────────────────────────────

const enum SteamPhase {
  HEATING = 0,
  BURST_SEQ = 1,
  POOL = 2,
  COOLING = 3,
}

interface CrackCell {
  x: number; y: number; // 컨테이너 로컬 (캐릭터 기준 상대)
  size: number;
  /** 둘레 진행 0~1 (가열 시점 분산용) */
  linePos: number;
}

interface DustCell {
  x: number; y: number;
  vy: number;
  life: number; maxLife: number;
  size: number;
}

interface BurstCell {
  x: number; y: number;
  vx: number; vy: number;
  /** 시각용 수직 점프 (음수=위) */
  jumpY: number;
  jumpVy: number;
  life: number; maxLife: number;
  size: number;
  /** 0=백열코어, 1=용암본체, 2=검댕 */
  type: 0 | 1 | 2;
}

interface PoolCell {
  baseX: number; baseY: number;
  /** 도넛 가장자리에서 중심선 거리 0~1 (0=중심선 가장 뜨거움, 1=가장자리) */
  rNorm: number;
  size: number;
  seed: number;
}

interface Bubble {
  x: number; y: number;
  life: number; maxLife: number;
  baseSize: number;
}

/** 동심원 링 하나 — 캐릭터 중심에서 일정 반경의 균열/풀 */
interface Ring {
  ringIdx: number;     // 0=안, 1=중, 2=바깥
  radius: number;      // 균열 둘레의 반경 (캐릭터 중심에서)
  ringWidth: number;   // 도넛 두께 (데미지/풀 영역)
  burstDelay: number;  // BURST_SEQ 단계 시작부터의 폭발 딜레이
  scale: number;       // 효과 크기 스케일 (셀 수, 충격파 등)

  burstFired: boolean; // 이번 사이클에서 폭발됐는지
  shockProgress: number; // -1=비활성

  crackCells: CrackCell[];
  dustCells: DustCell[];
  burstCells: BurstCell[];
  poolCells: PoolCell[];
  bubbles: Bubble[];
}

// ───────────────────────────────────────────────────────────────
//  색상 보간 — 용암 톤
// ───────────────────────────────────────────────────────────────

interface ColorStop { t: number; r: number; g: number; b: number; }

const LAVA_STOPS: ColorStop[] = [
  { t: 0.00, r: 0xff, g: 0xf7, b: 0xed }, // warm white
  { t: 0.08, r: 0xfd, g: 0xe0, b: 0x47 }, // yellow-300
  { t: 0.16, r: 0xfa, g: 0xcc, b: 0x15 }, // yellow-400
  { t: 0.25, r: 0xfb, g: 0x92, b: 0x3c }, // orange-400
  { t: 0.40, r: 0xea, g: 0x58, b: 0x0c }, // orange-600
  { t: 0.55, r: 0xc2, g: 0x41, b: 0x0c }, // orange-700
  { t: 0.70, r: 0x9a, g: 0x34, b: 0x12 }, // orange-800
  { t: 0.85, r: 0x44, g: 0x40, b: 0x3c }, // stone-700
  { t: 1.00, r: 0x1c, g: 0x19, b: 0x17 }, // stone-900
];

const CRACK_STOPS: ColorStop[] = [
  { t: 0.00, r: 0x57, g: 0x53, b: 0x4e },
  { t: 0.30, r: 0x6b, g: 0x39, b: 0x18 },
  { t: 0.55, r: 0x9a, g: 0x34, b: 0x12 },
  { t: 0.78, r: 0xea, g: 0x58, b: 0x0c },
  { t: 1.00, r: 0xfa, g: 0xcc, b: 0x15 },
];

function lerpStops(stops: ColorStop[], t: number): number {
  const tt = t < 0 ? 0 : t > 1 ? 1 : t;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (tt >= a.t && tt <= b.t) {
      const u = (tt - a.t) / (b.t - a.t);
      const r = Math.round(a.r + (b.r - a.r) * u);
      const g = Math.round(a.g + (b.g - a.g) * u);
      const bl = Math.round(a.b + (b.b - a.b) * u);
      return (r << 16) | (g << 8) | bl;
    }
  }
  const last = stops[stops.length - 1];
  return (last.r << 16) | (last.g << 8) | last.b;
}

const lerpLavaColor = (t: number) => lerpStops(LAVA_STOPS, t);
const lerpCrackColor = (t: number) => lerpStops(CRACK_STOPS, t);

// ───────────────────────────────────────────────────────────────
//  메인 클래스
// ───────────────────────────────────────────────────────────────

export class EarthFireEffect {
  private container: PIXI.Container;
  private glowGfx: PIXI.Graphics;
  private cellGfx: PIXI.Graphics;
  private coreGfx: PIXI.Graphics;

  active = false;

  // 글로벌 페이즈
  private phase: SteamPhase = SteamPhase.HEATING;
  private phaseTimer = 0;
  private time = 0;

  // 페이즈 길이 (총 122f ≈ 2.03초)
  private readonly HEATING_DURATION = 12;
  private readonly BURST_SEQ_DURATION = 70; // 0/30/60에 폭발 + 10f 잔여
  private readonly POOL_DURATION = 30;
  private readonly COOLING_DURATION = 10;

  // 링 설정 — 안/중/바깥 (살짝 떨어진 동심원, 0.5초 간격 팡-팡-팡)
  private readonly RING_CONFIGS = [
    { radius: 50,  ringWidth: 24, burstDelay: 0,  scale: 0.85 },
    { radius: 85,  ringWidth: 28, burstDelay: 30, scale: 1.15 },
    { radius: 125, ringWidth: 30, burstDelay: 60, scale: 1.50 },
  ];

  private rings: Ring[] = [];

  // 폭발/풀 정보 (엔진이 매 프레임 읽음)
  /** 이번 프레임에 폭발이 시작된 링들 */
  burstFiredThisFrame: Array<{ radius: number; ringWidth: number }> = [];
  /** 현재 활성 도넛 풀들 */
  activePools: Array<{ radius: number; ringWidth: number }> = [];

  constructor(parent: PIXI.Container) {
    this.container = new PIXI.Container();
    parent.addChild(this.container);

    this.glowGfx = new PIXI.Graphics();
    this.glowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.glowGfx);

    this.cellGfx = new PIXI.Graphics();
    this.container.addChild(this.cellGfx);

    this.coreGfx = new PIXI.Graphics();
    this.container.addChild(this.coreGfx);
  }

  start(x: number, y: number) {
    this.active = true;
    this.time = 0;
    this.rings = [];
    this.burstFiredThisFrame = [];
    this.activePools = [];
    this.container.position.set(x, y);
    this.container.visible = true;
    this.startNewCycle();
  }

  /** 매 프레임 캐릭터 위치로 컨테이너 갱신 (장판형) */
  setPosition(x: number, y: number) {
    this.container.position.set(x, y);
  }

  // ═══════════════════════════════════════════════════════════
  //  사이클 시작 — 3링 새로 생성
  // ═══════════════════════════════════════════════════════════

  private startNewCycle() {
    this.phase = SteamPhase.HEATING;
    this.phaseTimer = 0;
    this.rings = [];

    for (let i = 0; i < this.RING_CONFIGS.length; i++) {
      const cfg = this.RING_CONFIGS[i];
      const ring: Ring = {
        ringIdx: i,
        radius: cfg.radius,
        ringWidth: cfg.ringWidth,
        burstDelay: cfg.burstDelay,
        scale: cfg.scale,
        burstFired: false,
        shockProgress: -1,
        crackCells: [],
        dustCells: [],
        burstCells: [],
        poolCells: [],
        bubbles: [],
      };
      this.createCrackCells(ring);
      this.rings.push(ring);
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  업데이트
  // ═══════════════════════════════════════════════════════════

  update(dt: number) {
    if (!this.active) return;
    this.time += dt;
    this.phaseTimer += dt;
    this.burstFiredThisFrame = [];
    this.activePools = [];

    switch (this.phase) {
      case SteamPhase.HEATING:
        for (const ring of this.rings) this.updateHeating(ring, dt);
        if (this.phaseTimer >= this.HEATING_DURATION) {
          this.phase = SteamPhase.BURST_SEQ;
          this.phaseTimer = 0;
        }
        break;

      case SteamPhase.BURST_SEQ:
        for (const ring of this.rings) {
          // 자기 burstDelay 시점에 폭발
          if (!ring.burstFired && this.phaseTimer >= ring.burstDelay) {
            ring.burstFired = true;
            this.createBurstCells(ring);
            this.createPoolCells(ring);
            ring.shockProgress = 0;
            this.burstFiredThisFrame.push({
              radius: ring.radius,
              ringWidth: ring.ringWidth,
            });
          }
          if (ring.burstFired) {
            this.updateBurst(ring, dt);
            this.updateShock(ring, dt);
            this.updatePool(ring, dt);
            // 이미 폭발한 링은 활성 풀로 등록
            this.activePools.push({
              radius: ring.radius,
              ringWidth: ring.ringWidth,
            });
          }
        }
        if (this.phaseTimer >= this.BURST_SEQ_DURATION) {
          this.phase = SteamPhase.POOL;
          this.phaseTimer = 0;
        }
        break;

      case SteamPhase.POOL:
        for (const ring of this.rings) {
          this.updateBurst(ring, dt);
          this.updateShock(ring, dt);
          this.updatePool(ring, dt);
          this.activePools.push({
            radius: ring.radius,
            ringWidth: ring.ringWidth,
          });
        }
        if (this.phaseTimer >= this.POOL_DURATION) {
          this.phase = SteamPhase.COOLING;
          this.phaseTimer = 0;
        }
        break;

      case SteamPhase.COOLING:
        for (const ring of this.rings) this.updatePool(ring, dt);
        if (this.phaseTimer >= this.COOLING_DURATION) {
          this.startNewCycle();
        }
        break;
    }

    this.draw();
  }

  // ───────────────────────────────────────────────────────────
  //  셀 생성 (페이즈 전이 / 사이클 시작 시)
  // ───────────────────────────────────────────────────────────

  private createCrackCells(ring: Ring) {
    // 둘레의 셀 분포 — 둘레 길이에 비례 (8px 간격)
    const circumference = 2 * Math.PI * ring.radius;
    const cellCount = Math.max(40, Math.floor(circumference / 8));

    for (let i = 0; i < cellCount; i++) {
      const angle = (i / cellCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.06;
      // 약간의 반경 노이즈 (둘레가 정확한 원이 아니게)
      const r = ring.radius + (Math.random() - 0.5) * 4;
      ring.crackCells.push({
        x: Math.cos(angle) * r,
        y: Math.sin(angle) * r,
        size: 1.4 + Math.random() * 1.0,
        linePos: i / cellCount,
      });
    }

    // 작은 분기 — 둘레의 일부 위치에서 외/내 짧은 가지 (분위기용)
    const branchCount = Math.floor(cellCount * 0.18);
    for (let b = 0; b < branchCount; b++) {
      const angle = Math.random() * Math.PI * 2;
      const baseX = Math.cos(angle) * ring.radius;
      const baseY = Math.sin(angle) * ring.radius;
      const outward = Math.random() < 0.65 ? 1 : -1; // 외측이 더 많음
      const branchLen = 5 + Math.random() * 7;
      const branchCells = 3;
      for (let i = 0; i < branchCells; i++) {
        const t = (i / (branchCells - 1)) * branchLen * outward;
        ring.crackCells.push({
          x: baseX + Math.cos(angle) * t + (Math.random() - 0.5) * 1.4,
          y: baseY + Math.sin(angle) * t + (Math.random() - 0.5) * 1.4,
          size: 0.9 + Math.random() * 0.7,
          linePos: 0.4 + Math.random() * 0.6,
        });
      }
    }
  }

  private createBurstCells(ring: Ring) {
    // 셀 개수: ring scale에 비례 (안=125, 중=160, 바깥=210)
    const total = Math.floor(80 + ring.scale * 90);
    for (let i = 0; i < total; i++) {
      const angle = (i / total) * Math.PI * 2 + (Math.random() - 0.5) * 0.18;
      // 시작 위치: 링 둘레 위 (약간의 폭)
      const startR = ring.radius + (Math.random() - 0.5) * (ring.ringWidth * 0.4);
      const sx = Math.cos(angle) * startR;
      const sy = Math.sin(angle) * startR;

      // 분출 방향: 외측만 (캐릭터 안 가림). 약간의 접선 성분 추가
      const dirAngle = angle + (Math.random() - 0.5) * 0.5;
      const speed = (4.5 + Math.random() * 5) * ring.scale;

      const r = Math.random();
      let type: 0 | 1 | 2;
      let size: number;
      let maxLife: number;
      if (r < 0.15) {
        type = 0;
        size = 2.2 + Math.random() * 2.2;
        maxLife = 20 + Math.random() * 10;
      } else if (r < 0.75) {
        type = 1;
        size = 2.5 + Math.random() * 2.8;
        maxLife = 26 + Math.random() * 12;
      } else {
        type = 2;
        size = 1.5 + Math.random() * 1.7;
        maxLife = 22 + Math.random() * 12;
      }

      ring.burstCells.push({
        x: sx,
        y: sy,
        vx: Math.cos(dirAngle) * speed,
        vy: Math.sin(dirAngle) * speed,
        jumpY: 0,
        jumpVy: type === 0
          ? -3.0 - Math.random() * 1.8
          : -1.8 - Math.random() * 1.6,
        life: 0,
        maxLife,
        size: size * (0.85 + ring.scale * 0.2), // 바깥 링 셀이 살짝 더 큼
        type,
      });
    }
  }

  private createPoolCells(ring: Ring) {
    const innerR = ring.radius - ring.ringWidth / 2;
    const outerR = ring.radius + ring.ringWidth / 2;
    const innerR2 = innerR * innerR;
    const outerR2 = outerR * outerR;
    // 도넛 면적의 일부에 셀 분포 (성능 위해 적당히)
    const count = Math.floor(60 + ring.scale * 110); // 안=154, 중=187, 바깥=225
    for (let i = 0; i < count; i++) {
      // 도넛 안 균등 분포 (각도 + 반경)
      const angle = Math.random() * Math.PI * 2;
      const r = innerR + Math.random() * (outerR - innerR);
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      // 도넛 중심선까지의 거리 → 0=중심선 가장 뜨거움, 1=가장자리
      const localR = (r - ring.radius) / (ring.ringWidth / 2);
      ring.poolCells.push({
        baseX: x,
        baseY: y,
        rNorm: Math.abs(localR),
        size: (3.0 + Math.random() * 3.5) * (0.9 + ring.scale * 0.15),
        seed: Math.random() * Math.PI * 2,
      });
    }
  }

  // ───────────────────────────────────────────────────────────
  //  페이즈 업데이트 (링별 시각 데이터)
  // ───────────────────────────────────────────────────────────

  private updateHeating(ring: Ring, dt: number) {
    // 흙먼지 — 둘레 위 랜덤 위치에서 떠오름
    if (Math.random() < 0.35 * dt) {
      const angle = Math.random() * Math.PI * 2;
      const baseR = ring.radius + (Math.random() - 0.5) * 4;
      ring.dustCells.push({
        x: Math.cos(angle) * baseR,
        y: Math.sin(angle) * baseR,
        vy: -0.35 - Math.random() * 0.3,
        life: 0,
        maxLife: 14 + Math.random() * 8,
        size: 0.8 + Math.random() * 1.0,
      });
    }
    for (let i = ring.dustCells.length - 1; i >= 0; i--) {
      const d = ring.dustCells[i];
      d.life += dt;
      if (d.life >= d.maxLife) { swapPop(ring.dustCells, i); continue; }
      d.y += d.vy * dt;
      d.vy *= 0.97;
    }
  }

  private updateBurst(ring: Ring, dt: number) {
    for (let i = ring.burstCells.length - 1; i >= 0; i--) {
      const p = ring.burstCells[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        swapPop(ring.burstCells, i);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const drag = p.type === 2 ? 0.92 : 0.94;
      p.vx *= drag;
      p.vy *= drag;
      p.jumpY += p.jumpVy * dt;
      p.jumpVy += 0.18 * dt;
      if (p.jumpY > 0) {
        p.jumpY = 0;
        p.jumpVy = 0;
      }
    }
  }

  private updateShock(ring: Ring, dt: number) {
    if (ring.shockProgress < 0) return;
    ring.shockProgress += dt / 22;
    if (ring.shockProgress >= 1) ring.shockProgress = -1;
  }

  private updatePool(ring: Ring, dt: number) {
    if (!ring.burstFired) return;
    // 글로벌 POOL 단계나 BURST_SEQ에서 폭발한 링은 거품 생성
    if (this.phase !== SteamPhase.COOLING) {
      // 거품 빈도: ring scale에 비례
      const rate = 0.7 + ring.scale * 0.6;
      let acc = rate * dt;
      while (acc > 0) {
        if (Math.random() < acc) {
          const angle = Math.random() * Math.PI * 2;
          const innerR = ring.radius - ring.ringWidth / 2;
          const r = innerR + Math.random() * ring.ringWidth;
          ring.bubbles.push({
            x: Math.cos(angle) * r,
            y: Math.sin(angle) * r,
            life: 0,
            maxLife: 6 + Math.random() * 7,
            baseSize: (1.4 + Math.random() * 1.6) * (0.9 + ring.scale * 0.15),
          });
        }
        acc -= 1;
      }
    }
    for (let i = ring.bubbles.length - 1; i >= 0; i--) {
      const b = ring.bubbles[i];
      b.life += dt;
      if (b.life >= b.maxLife) { swapPop(ring.bubbles, i); continue; }
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  드로우
  // ═══════════════════════════════════════════════════════════

  private draw() {
    this.glowGfx.clear();
    this.cellGfx.clear();
    this.coreGfx.clear();

    // 1) 풀 베이스 — 폭발한 링부터 (안→밖 순서로 그려서 바깥이 위에)
    for (const ring of this.rings) {
      if (ring.burstFired || this.phase === SteamPhase.POOL || this.phase === SteamPhase.COOLING) {
        this.drawPool(ring);
      }
    }
    // 2) 균열선 — 아직 폭발 안 한 링 (예열/BURST_SEQ 폭발 전)
    for (const ring of this.rings) {
      if (this.phase === SteamPhase.HEATING || (this.phase === SteamPhase.BURST_SEQ && !ring.burstFired)) {
        this.drawHeating(ring);
      }
    }
    // 3) 충격파
    for (const ring of this.rings) {
      if (ring.shockProgress >= 0) this.drawShock(ring);
    }
    // 4) 폭발 셀 (위에)
    for (const ring of this.rings) {
      if (ring.burstFired) this.drawBurst(ring);
    }
    // 5) 거품 (가장 위)
    for (const ring of this.rings) {
      if (ring.burstFired && this.phase !== SteamPhase.COOLING && ring.bubbles.length > 0) {
        this.drawBubbles(ring);
      }
    }
  }

  // ───────────────────────────────────────────────────────────
  //  드로우: 예열 (균열선)
  // ───────────────────────────────────────────────────────────

  private drawHeating(ring: Ring) {
    let heatProgress: number;
    let preEruptShake = 0;

    if (this.phase === SteamPhase.HEATING) {
      // 글로벌 예열 진행도 (모든 링 동일)
      heatProgress = this.phaseTimer / this.HEATING_DURATION;
      // 막바지 진동 (모든 링 같이)
      if (heatProgress > 0.78) {
        preEruptShake = (heatProgress - 0.78) / 0.22;
      }
    } else {
      // BURST_SEQ 단계: 아직 폭발 안 한 링은 백열 + 강한 진동 (다음 폭발 임박)
      heatProgress = 1.0;
      // 자기 burstDelay까지 남은 프레임 수에 따라 진동 강도
      const remain = ring.burstDelay - this.phaseTimer;
      preEruptShake = remain < 4 ? Math.min(1, (4 - remain) / 4) : 0.5;
    }

    this.cellGfx.lineStyle(0);
    for (const c of ring.crackCells) {
      const localT = Math.max(0, Math.min(1, heatProgress - c.linePos * 0.12));
      const color = lerpCrackColor(localT);
      const alpha = 0.7 + localT * 0.25;

      const shakeX = preEruptShake > 0 ? (Math.random() - 0.5) * preEruptShake * 1.6 : 0;
      const shakeY = preEruptShake > 0 ? (Math.random() - 0.5) * preEruptShake * 1.6 : 0;

      this.cellGfx.beginFill(color, alpha);
      this.cellGfx.drawCircle(c.x + shakeX, c.y + shakeY, c.size);
      this.cellGfx.endFill();

      if (localT > 0.4) {
        const glowAlpha = (localT - 0.4) / 0.6 * 0.55;
        this.glowGfx.beginFill(color, glowAlpha);
        this.glowGfx.drawCircle(c.x + shakeX, c.y + shakeY, c.size * 2.6);
        this.glowGfx.endFill();
      }
    }

    // 흙먼지 (HEATING 단계만)
    if (this.phase === SteamPhase.HEATING) {
      for (const d of ring.dustCells) {
        const lifeFrac = d.life / d.maxLife;
        const alpha = (1 - lifeFrac) * 0.55;
        const color = lerpStops([
          { t: 0, r: 0xa8, g: 0xa2, b: 0x9e },
          { t: 1, r: 0x78, g: 0x71, b: 0x6c },
        ], lifeFrac);
        this.cellGfx.beginFill(color, alpha);
        this.cellGfx.drawCircle(d.x, d.y, d.size);
        this.cellGfx.endFill();
      }
    }
  }

  // ───────────────────────────────────────────────────────────
  //  드로우: 충격파 (링 둘레에서 외측으로 팽창)
  // ───────────────────────────────────────────────────────────

  private drawShock(ring: Ring) {
    if (ring.shockProgress < 0) return;
    const p = ring.shockProgress;
    // 가속 곡선
    const expandFrac = p < 0.2 ? p / 0.2 * 0.7 : 0.7 + (p - 0.2) / 0.8 * 0.3;
    // 확장 폭 = ringWidth * 0.8 + 30 * scale (바깥 링이 더 크게 확장)
    const expansion = (ring.ringWidth * 0.8 + 30 * ring.scale) * expandFrac;
    const r = ring.radius + expansion;
    const fade = (1 - p) * (1 - p);
    const lineW = ring.scale * 1.2;

    // 외곽 — 옅은 오렌지 글로우
    this.glowGfx.lineStyle(10 * lineW * (1 - p * 0.4), 0xea580c, fade * 0.45);
    this.glowGfx.drawCircle(0, 0, r);
    // 중간 — 노랑
    this.glowGfx.lineStyle(6 * lineW * (1 - p * 0.3), 0xfde047, fade * 0.65);
    this.glowGfx.drawCircle(0, 0, r);
    // 코어 — 백열
    this.glowGfx.lineStyle(2.5 * lineW, 0xfff7ed, fade * 0.85);
    this.glowGfx.drawCircle(0, 0, r);
    this.glowGfx.lineStyle(0);
  }

  // ───────────────────────────────────────────────────────────
  //  드로우: 폭발 셀
  // ───────────────────────────────────────────────────────────

  private drawBurst(ring: Ring) {
    this.cellGfx.lineStyle(0);

    for (const p of ring.burstCells) {
      const lifeFrac = p.life / p.maxLife;
      const sizePhase = lifeFrac < 0.2
        ? 1 + lifeFrac * 1.0
        : 1.2 - (lifeFrac - 0.2) * 0.45;
      const r = p.size * sizePhase;

      const drawX = p.x;
      const drawY = p.y + p.jumpY;

      let color: number;
      let alpha: number;
      let glowColor: number;
      let glowAlpha: number;
      let glowMul: number;

      if (p.type === 0) {
        color = lerpLavaColor(lifeFrac * 0.7);
        alpha = (1 - lifeFrac * 0.5) * 0.95;
        glowColor = lerpLavaColor(lifeFrac * 0.4);
        glowAlpha = (1 - lifeFrac) * 0.6;
        glowMul = 2.6;
      } else if (p.type === 1) {
        color = lerpLavaColor(0.20 + lifeFrac * 0.55);
        alpha = (1 - lifeFrac * 0.45) * 0.88;
        glowColor = lerpLavaColor(0.18 + lifeFrac * 0.45);
        glowAlpha = (1 - lifeFrac) * 0.45;
        glowMul = 2.2;
      } else {
        color = lerpLavaColor(0.55 + lifeFrac * 0.4);
        alpha = (1 - lifeFrac * 0.55) * 0.85;
        glowColor = lerpLavaColor(0.55 + lifeFrac * 0.3);
        glowAlpha = (1 - lifeFrac) * 0.18;
        glowMul = 1.8;
      }

      this.glowGfx.beginFill(glowColor, glowAlpha);
      this.glowGfx.drawCircle(drawX, drawY, r * glowMul);
      this.glowGfx.endFill();

      this.cellGfx.beginFill(color, alpha);
      this.cellGfx.drawCircle(drawX, drawY, r);
      this.cellGfx.endFill();

      if (p.type === 0 && lifeFrac < 0.45) {
        const sparkA = (1 - lifeFrac / 0.45) * 0.7;
        this.coreGfx.beginFill(0xffffff, sparkA);
        this.coreGfx.drawCircle(drawX, drawY, r * 0.4);
        this.coreGfx.endFill();
      }
    }
  }

  // ───────────────────────────────────────────────────────────
  //  드로우: 도넛 풀
  // ───────────────────────────────────────────────────────────

  private drawPool(ring: Ring) {
    let coolFrac = 0;
    let alphaMul = 1;

    if (this.phase === SteamPhase.BURST_SEQ) {
      // 막 폭발한 링 — 풀이 갓 형성
      coolFrac = 0;
    } else if (this.phase === SteamPhase.POOL) {
      coolFrac = (this.phaseTimer / this.POOL_DURATION) * 0.5;
    } else if (this.phase === SteamPhase.COOLING) {
      const frac = this.phaseTimer / this.COOLING_DURATION;
      coolFrac = 0.5 + frac * 0.5;
      alphaMul = 1 - frac * 0.85;
    }

    if (alphaMul < 0.05) return;

    // 도넛 둘레 글로우 — 둘레의 N개 점에 큰 원 그리기
    const glowPoints = Math.max(20, Math.floor((2 * Math.PI * ring.radius) / 16));
    const baseGlowAlpha = (1 - coolFrac) * 0.22 * alphaMul;
    const ringGlowR = ring.ringWidth * 0.7;

    for (let i = 0; i < glowPoints; i++) {
      const angle = (i / glowPoints) * Math.PI * 2;
      const gx = Math.cos(angle) * ring.radius;
      const gy = Math.sin(angle) * ring.radius;
      this.glowGfx.beginFill(0xea580c, baseGlowAlpha);
      this.glowGfx.drawCircle(gx, gy, ringGlowR);
      this.glowGfx.endFill();
      this.glowGfx.beginFill(0xfb923c, baseGlowAlpha * 0.7);
      this.glowGfx.drawCircle(gx, gy, ringGlowR * 0.55);
      this.glowGfx.endFill();
    }
    // 백열 코어 — 폭발 직후만 (coolFrac < 0.3)
    if (coolFrac < 0.3) {
      const coreInt = (0.3 - coolFrac) / 0.3;
      const coreAlpha = coreInt * 0.3 * alphaMul;
      const coreR = ring.ringWidth * 0.32;
      // 절반 위치에 (홀짝 교차로 분포 다양화)
      for (let i = 0; i < glowPoints; i++) {
        const angle = (i / glowPoints) * Math.PI * 2 + 0.13;
        const gx = Math.cos(angle) * ring.radius;
        const gy = Math.sin(angle) * ring.radius;
        this.glowGfx.beginFill(0xfde047, coreAlpha);
        this.glowGfx.drawCircle(gx, gy, coreR);
        this.glowGfx.endFill();
      }
    }

    // 풀 셀들 — 일렁임
    this.cellGfx.lineStyle(0);
    for (const p of ring.poolCells) {
      const wobble = Math.sin(this.time * 0.18 + p.seed) * 1.5;
      const wobbleY = Math.cos(this.time * 0.14 + p.seed * 1.3) * 1.5;
      const x = p.baseX + wobble;
      const y = p.baseY + wobbleY;

      // 색상: rNorm(0=중심선 뜨거움, 1=가장자리 식음) + coolFrac
      const colorT = Math.min(1, p.rNorm * 0.45 + coolFrac);
      const color = lerpLavaColor(0.18 + colorT * 0.7);
      const alpha = (0.78 - p.rNorm * 0.18) * alphaMul;

      this.cellGfx.beginFill(color, alpha);
      this.cellGfx.drawCircle(x, y, p.size);
      this.cellGfx.endFill();
    }
  }

  // ───────────────────────────────────────────────────────────
  //  드로우: 거품
  // ───────────────────────────────────────────────────────────

  private drawBubbles(ring: Ring) {
    for (const b of ring.bubbles) {
      const lifeFrac = b.life / b.maxLife;
      const grow = lifeFrac < 0.7 ? 0.5 + lifeFrac / 0.7 * 1.5 : 2.0 - (lifeFrac - 0.7) / 0.3 * 0.5;
      const r = b.baseSize * grow;
      const alpha = lifeFrac < 0.85 ? 0.85 : (1 - lifeFrac) / 0.15 * 0.85;

      this.glowGfx.beginFill(0xfde047, alpha * 0.6);
      this.glowGfx.drawCircle(b.x, b.y, r * 2.0);
      this.glowGfx.endFill();
      this.glowGfx.beginFill(0xfff7ed, alpha * 0.85);
      this.glowGfx.drawCircle(b.x, b.y, r * 1.1);
      this.glowGfx.endFill();
      this.coreGfx.beginFill(0xffffff, alpha * 0.7);
      this.coreGfx.drawCircle(b.x, b.y, r * 0.5);
      this.coreGfx.endFill();
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  정리
  // ═══════════════════════════════════════════════════════════

  stop() {
    this.active = false;
    this.container.visible = false;
    this.rings = [];
    this.burstFiredThisFrame = [];
    this.activePools = [];
    this.glowGfx.clear();
    this.cellGfx.clear();
    this.coreGfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
