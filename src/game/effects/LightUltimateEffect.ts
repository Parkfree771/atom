import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 빛 × 3 (AAA) — 신광 폭격 (Divine Salvo)
 *
 * 슬롯 3칸이 모두 빛일 때만 발동. 1단계 빛(레이저 빔)과 별개의 고유 클래스.
 *
 * 거동 — 머리 위 코어 + 다중 호밍 발사체 무한 연사:
 *   - 캐릭터 머리 위에 작은 코어 (지속, 사이클 X)
 *   - 사방에서 광점이 끊임없이 모이며 회전 광륜 3겹이 펄스
 *   - engine이 매 9f마다 코어에서 일자 발사체 1발 spawn → 가장 가까운 적에게 호밍
 *   - 발사체 적중 시 → 입자 폭발 + 코어 플래시 + 광역 데미지 (engine이 처리)
 *   - 동시 활성 발사체 ~6~10개 (자연스럽게 누적)
 *
 * 시각 디자인 원칙 (개발서 규칙 6):
 *   - 발사체는 절대 원형 X — 진행 방향 길쭉한 4겹 라인 패스
 *   - 차징 광점은 원형 OK (자연 현상)
 *   - 회전 광륜은 끊긴 호 5세그먼트 (닫힌 원 X)
 *   - 색은 순수 노랑 계열 5톤 (amber-700 → yellow-200, 파란색 X — 물속성과 차별)
 *
 * 검증된 컴포넌트:
 *   - WaterLightEffect 나선 차징 + 꼬리 패턴
 *   - LightEffect 빔 4겹 라인 (크기 축소 → 발사체)
 *   - FireUltimateEffect 머리 위 추적 (-Y offset) + popImpacts 패턴
 *   - ElectricUltimateEffect 적중 입자 폭발 패턴 (작게)
 *   - boltId 매핑 — engine 측에서 enemyIdx ↔ boltId Map (풀 재사용 방어)
 *
 * 좌표계: effectLayer 자식 컨테이너 (0,0) 고정. 모든 좌표 월드 좌표 직접.
 *   - 캐릭터 위치 매 프레임 setPosition으로 갱신
 *   - 코어/차징은 캐릭터 머리 위 (-42px Y offset)
 *   - 발사체는 spawn 시점 코어 위치에서 출발 → 자체 호밍 궤적
 */

// ── 색상 (순수 황금 계열, 백/파랑 X — 물속성과 차별) ──
const COL_AMBER_DEEP    = 0xb45309; // amber-700 (가장 어두움)
const COL_AMBER_MAIN    = 0xd97706; // amber-600 (따뜻한 금)
const COL_AMBER_BRIGHT  = 0xf59e0b; // amber-500 (따뜻한 메인)
const COL_AMBER_LIGHT   = 0xfbbf24; // amber-400 (따뜻한 밝음)
const COL_GOLD_MAIN     = 0xeab308; // yellow-500 (시원한 메인)
const COL_GOLD_BRIGHT   = 0xfde047; // yellow-300 (시원한 밝음)
const COL_GOLD_LIGHT    = 0xfef08a; // yellow-200 (가장 밝은 노랑)
const COL_CREAM         = 0xfef9c3; // yellow-100 (크림)
const COL_NEAR_WHITE    = 0xfffef5; // 거의 백 (코어/심선만 사용)

// ── 차징 광점 ──
interface ChargeParticle {
  /** 코어 기준 로컬 좌표 */
  x: number; y: number;
  prevX: number; prevY: number;
  speed: number;
  spinBias: number;
  size: number;
  /** 노랑 계열 5톤 인덱스 (0~4) */
  colorIdx: number;
}

// ── 발사체 (일자 호밍 빔) ──
interface LightBolt {
  id: number;
  x: number; y: number;
  vx: number; vy: number;
  /** 추적 대상 위치 (engine이 매 프레임 갱신) */
  targetX: number; targetY: number;
  targetAlive: boolean;
  life: number; maxLife: number;
  trail: Array<{ x: number; y: number }>;
  /** 적중 처리됐는지 (한 번만 트리거) */
  hit: boolean;
  /** 제거 대상 */
  dead: boolean;
}

// ── 적중 입자 ──
interface HitParticle {
  x: number; y: number;
  prevX: number; prevY: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
  color: number;
}

// ── 상수 ──
const CORE_OFFSET_Y = -42;          // 캐릭터 머리 위 거리
const CORE_RADIUS = 8;              // 코어 작은 원 반경
const CHARGE_RANGE_MAX = 145;       // 광점 사방 spawn 반경
const CHARGE_MAX = 45;              // 차징 광점 동시 최대 (사용자 피드백: 약간 줄임)
const BOLT_LENGTH = 32;             // 발사체 길이 (head ~ tail)
const BOLT_SPEED = 18;              // 발사체 속도 (px/f)
const BOLT_HOMING_LERP = 0.12;      // 호밍 강도 (속도 lerp)
const BOLT_HIT_RADIUS = 14;         // 적중 판정 거리
const BOLT_MAX_LIFE = 60;           // 사거리 ~ 1080px

export class LightUltimateEffect {
  private container: PIXI.Container;
  /** NORMAL — 발사체 코어, 광점 코어, 코어 본체 */
  private gfx: PIXI.Graphics;
  /** ADD — 글로우, 꼬리, 회전 광륜 */
  private glowGfx: PIXI.Graphics;

  active = false;

  // 코어 머리 위 위치 (캐릭터 위치 + Y offset, engine이 매 프레임 갱신)
  private coreX = 0;
  private coreY = 0;

  // 시간 (애니메이션용 누적)
  private time = 0;

  // 차징
  private chargeParticles: ChargeParticle[] = [];

  // 발사체
  private bolts: LightBolt[] = [];
  private nextBoltId = 1;

  // 적중 효과 (입자만, 코어 플래시 X — 사용자 피드백)
  private hitParticles: HitParticle[] = [];

  // 코어 발사 임팩트 (spawn 시점 1프레임 코어 1.4x 팽창)
  private coreFireBulge = 0;

  // engine이 popImpacts/popDeadBoltIds로 가져감
  private pendingImpacts: Array<{ id: number; x: number; y: number }> = [];
  private pendingDeadIds: number[] = [];

  constructor(parent: PIXI.Container) {
    this.container = new PIXI.Container();
    parent.addChild(this.container);

    this.glowGfx = new PIXI.Graphics();
    this.glowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.glowGfx);

    this.gfx = new PIXI.Graphics();
    this.container.addChild(this.gfx);
  }

  start(x: number, y: number) {
    this.active = true;
    this.coreX = x;
    this.coreY = y + CORE_OFFSET_Y;
    this.time = 0;
    this.chargeParticles = [];
    this.bolts = [];
    this.hitParticles = [];
    this.pendingImpacts = [];
    this.pendingDeadIds = [];
    this.coreFireBulge = 0;
  }

  setPosition(x: number, y: number) {
    this.coreX = x;
    this.coreY = y + CORE_OFFSET_Y;
  }

  /**
   * 발사체 1발 spawn — engine이 발사 주기마다 호출.
   * 초기 위치 = 코어 위치. 초기 vel = 적 방향 × BOLT_SPEED.
   * 반환 = boltId (engine이 enemyIdx와 매핑)
   */
  fireBolt(targetX: number, targetY: number): number {
    const id = this.nextBoltId++;
    const dx = targetX - this.coreX;
    const dy = targetY - this.coreY;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const vx = (dx / dist) * BOLT_SPEED;
    const vy = (dy / dist) * BOLT_SPEED;
    this.bolts.push({
      id,
      x: this.coreX, y: this.coreY,
      vx, vy,
      targetX, targetY,
      targetAlive: true,
      life: BOLT_MAX_LIFE, maxLife: BOLT_MAX_LIFE,
      trail: [],
      hit: false,
      dead: false,
    });
    this.coreFireBulge = 1;
    return id;
  }

  /** engine이 매 프레임 호출 — 활성 발사체 각각의 추적 좌표 업데이트 */
  updateBoltTarget(id: number, targetX: number, targetY: number, alive: boolean) {
    for (const b of this.bolts) {
      if (b.id === id) {
        b.targetX = targetX;
        b.targetY = targetY;
        b.targetAlive = alive;
        return;
      }
    }
  }

  /** engine이 적중 처리 후 호출 — 이번 프레임에 적중한 발사체 정보 */
  popImpacts(): Array<{ id: number; x: number; y: number }> {
    const arr = this.pendingImpacts;
    this.pendingImpacts = [];
    return arr;
  }

  /** engine이 호출 — 이번 프레임에 사망한 발사체 ID들 (engine이 매핑 정리) */
  popDeadBoltIds(): number[] {
    const arr = this.pendingDeadIds;
    this.pendingDeadIds = [];
    return arr;
  }

  /** 활성 발사체가 있는지 (engine이 호밍 좌표 전달 호출 여부 결정) */
  hasActiveBolts(): boolean {
    return this.bolts.length > 0;
  }

  // ═══════════════════════════════════════════════════════════
  //  업데이트
  // ═══════════════════════════════════════════════════════════

  update(dt: number) {
    if (!this.active) return;
    this.time += dt;

    // 코어 발사 팽창 페이드
    if (this.coreFireBulge > 0) {
      this.coreFireBulge -= dt * 0.18;
      if (this.coreFireBulge < 0) this.coreFireBulge = 0;
    }

    // ── 차징 광점 spawn (지속, 사이클 X) ──
    if (this.chargeParticles.length < CHARGE_MAX && Math.random() < 0.85) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 75 + Math.random() * 70;
      const sign = Math.random() < 0.5 ? -1 : 1;
      // 5톤 균등 분포 (amber-deep / amber-main / amber-light / gold-bright / gold-light)
      const colorIdx = Math.floor(Math.random() * 5);
      this.chargeParticles.push({
        x: Math.cos(angle) * dist,
        y: Math.sin(angle) * dist,
        prevX: Math.cos(angle) * dist,
        prevY: Math.sin(angle) * dist,
        speed: 1.0 + Math.random() * 0.7,
        spinBias: sign * (0.7 + Math.random() * 0.6),
        // 사이즈 (사용자 피드백 2회 반영): 1.4~3.6 → 0.8~2.2 → 1.2~2.8
        size: 1.2 + Math.random() * 1.6,
        colorIdx,
      });
    }

    // ── 차징 광점 이동 (나선 흡수, 가까울수록 가속) ──
    for (let i = this.chargeParticles.length - 1; i >= 0; i--) {
      const p = this.chargeParticles[i];
      p.prevX = p.x;
      p.prevY = p.y;
      const d = Math.sqrt(p.x * p.x + p.y * p.y);
      if (d < 3) {
        swapPop(this.chargeParticles, i);
        continue;
      }
      const nx = -p.x / d;
      const ny = -p.y / d;
      const tx = -ny * p.spinBias;
      const ty = nx * p.spinBias;
      const closeBoost = 1 + Math.max(0, (CHARGE_RANGE_MAX - d) / 100);
      const radSpeed = p.speed * closeBoost;
      const tanSpeed = 0.4 + (CHARGE_RANGE_MAX - d) / 80;
      p.x += (nx * radSpeed + tx * tanSpeed) * dt;
      p.y += (ny * radSpeed + ty * tanSpeed) * dt;
    }

    // ── 발사체 업데이트 (호밍 + 충돌) ──
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];

      // 트레일 갱신
      b.trail.unshift({ x: b.x, y: b.y });
      if (b.trail.length > 6) b.trail.length = 6;

      // 호밍: 적이 살아있으면 vel을 target 방향으로 lerp
      if (b.targetAlive) {
        const dxh = b.targetX - b.x;
        const dyh = b.targetY - b.y;
        const dh = Math.sqrt(dxh * dxh + dyh * dyh) || 1;
        const desiredVx = (dxh / dh) * BOLT_SPEED;
        const desiredVy = (dyh / dh) * BOLT_SPEED;
        b.vx += (desiredVx - b.vx) * BOLT_HOMING_LERP * dt;
        b.vy += (desiredVy - b.vy) * BOLT_HOMING_LERP * dt;
        // 속도 정규화 (BOLT_SPEED 유지)
        const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy) || 1;
        b.vx = (b.vx / sp) * BOLT_SPEED;
        b.vy = (b.vy / sp) * BOLT_SPEED;
      }

      // 위치 진행
      b.x += b.vx * dt;
      b.y += b.vy * dt;

      // 적중 판정 (적이 살아있을 때만)
      if (b.targetAlive && !b.hit) {
        const dxi = b.x - b.targetX;
        const dyi = b.y - b.targetY;
        if (dxi * dxi + dyi * dyi < BOLT_HIT_RADIUS * BOLT_HIT_RADIUS) {
          b.hit = true;
          b.dead = true;
          this.spawnHitEffect(b.x, b.y);
          this.pendingImpacts.push({ id: b.id, x: b.x, y: b.y });
        }
      }

      // 수명 만료 → 제거 (적중 없이)
      b.life -= dt;
      if (b.life <= 0) {
        b.dead = true;
      }

      if (b.dead) {
        this.pendingDeadIds.push(b.id);
        swapPop(this.bolts, i);
      }
    }

    // ── 적중 입자 업데이트 ──
    for (let i = this.hitParticles.length - 1; i >= 0; i--) {
      const p = this.hitParticles[i];
      p.prevX = p.x;
      p.prevY = p.y;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.92;
      p.vy *= 0.92;
      p.life -= dt;
      if (p.life <= 0) swapPop(this.hitParticles, i);
    }

    this.draw();
  }

  // ── 적중 효과 spawn (입자 32개) ──
  // 노랑 계열 5톤 다양화. 사용자 피드백: 코어 플래시(원 배경) 제거 — 입자만
  private spawnHitEffect(x: number, y: number) {
    const N = 32;
    const HIT_COLORS = [
      COL_AMBER_BRIGHT,
      COL_AMBER_LIGHT,
      COL_GOLD_BRIGHT,
      COL_GOLD_LIGHT,
      COL_CREAM,
    ];
    for (let i = 0; i < N; i++) {
      const angle = (i / N) * Math.PI * 2 + Math.random() * 0.4;
      const speed = 4 + Math.random() * 6;
      const life = 18 + Math.random() * 18;
      const color = HIT_COLORS[Math.floor(Math.random() * HIT_COLORS.length)];
      const size = 1.4 + Math.random() * 2.0;
      this.hitParticles.push({
        x, y,
        prevX: x, prevY: y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life, maxLife: life,
        size,
        color,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  드로우
  // ═══════════════════════════════════════════════════════════

  private draw() {
    this.gfx.clear();
    this.glowGfx.clear();

    // 차징 → 회전 광륜 → 코어 → 발사체 → 적중 입자 (코어 플래시 X)
    this.drawCharging();
    this.drawHaloRings();
    this.drawCore();
    this.drawBolts();
    this.drawHitParticles();
  }

  // ── 차징 광점 + 꼬리 (코어 기준 로컬 좌표 → 월드 변환) ──
  // 노랑 계열 5톤: amber-deep / amber-main / amber-light / gold-bright / gold-light
  private drawCharging() {
    const cx = this.coreX;
    const cy = this.coreY;
    for (const p of this.chargeParticles) {
      const wx = cx + p.x;
      const wy = cy + p.y;
      const wpx = cx + p.prevX;
      const wpy = cy + p.prevY;
      const d = Math.sqrt(p.x * p.x + p.y * p.y);
      const closeFrac = Math.min(1, (CHARGE_RANGE_MAX - d) / 130);
      const alpha = 0.55 + closeFrac * 0.40;

      let color: number;
      switch (p.colorIdx) {
        case 0: color = COL_AMBER_DEEP;   break; // 가장 어두움 (따뜻)
        case 1: color = COL_AMBER_MAIN;   break;
        case 2: color = COL_AMBER_LIGHT;  break;
        case 3: color = COL_GOLD_BRIGHT;  break;
        default: color = COL_GOLD_LIGHT;  break;
      }

      // 꼬리 (이전 → 현재) — ADD
      this.glowGfx.lineStyle(p.size * 1.2, color, alpha * 0.55);
      this.glowGfx.moveTo(wpx, wpy);
      this.glowGfx.lineTo(wx, wy);
      this.glowGfx.lineStyle(0);

      // 글로우 — ADD (사이즈: ×2.6 → ×1.8 → ×2.1)
      this.glowGfx.beginFill(color, alpha * 0.40);
      this.glowGfx.drawCircle(wx, wy, p.size * 2.1);
      this.glowGfx.endFill();

      // 코어 점 — NORMAL
      this.gfx.beginFill(color, alpha);
      this.gfx.drawCircle(wx, wy, p.size);
      this.gfx.endFill();
    }
  }

  // ── 회전 광륜 3겹 (다른 속도/방향, 끊긴 호 5세그먼트) ──
  private drawHaloRings() {
    const cx = this.coreX;
    const cy = this.coreY;
    const t = this.time;

    const rings: Array<{ r: number; rotSpeed: number; color: number; alpha: number; lineW: number }> = [
      { r: 14, rotSpeed:  0.040, color: COL_GOLD_LIGHT,  alpha: 0.60, lineW: 1.8 },
      { r: 22, rotSpeed: -0.025, color: COL_GOLD_BRIGHT, alpha: 0.55, lineW: 1.5 },
      { r: 32, rotSpeed:  0.015, color: COL_AMBER_LIGHT, alpha: 0.50, lineW: 1.2 },
    ];

    for (const ring of rings) {
      const breath = 1 + Math.sin(t * 0.06 + ring.r) * 0.06;
      const rr = ring.r * breath;
      const rotBase = t * ring.rotSpeed;
      // 5 세그먼트 끊긴 호 (절대 닫힌 원 X)
      const SEG_COUNT = 5;
      const SEG_GAP = (Math.PI * 2) / SEG_COUNT;
      const SEG_ARC = SEG_GAP * 0.55;
      this.glowGfx.lineStyle(ring.lineW, ring.color, ring.alpha);
      for (let s = 0; s < SEG_COUNT; s++) {
        const startA = rotBase + s * SEG_GAP;
        const endA = startA + SEG_ARC;
        const STEPS = 8;
        for (let k = 0; k <= STEPS; k++) {
          const a = startA + (endA - startA) * (k / STEPS);
          const wx = cx + Math.cos(a) * rr;
          const wy = cy + Math.sin(a) * rr;
          if (k === 0) this.glowGfx.moveTo(wx, wy);
          else this.glowGfx.lineTo(wx, wy);
        }
      }
      this.glowGfx.lineStyle(0);
    }
  }

  // ── 중심 코어 (작은 원 + 별빛 leak + 발사 임팩트 팽창) ──
  private drawCore() {
    const cx = this.coreX;
    const cy = this.coreY;
    const t = this.time;
    const breath = 0.92 + Math.sin(t * 0.12) * 0.08;
    const fireBulge = 1 + this.coreFireBulge * 0.4;
    const r = CORE_RADIUS * breath * fireBulge;

    // 작은 ADD 글로우 (외곽 → 안)
    this.glowGfx.beginFill(COL_GOLD_MAIN, 0.45);
    this.glowGfx.drawCircle(cx, cy, r * 1.8);
    this.glowGfx.endFill();
    this.glowGfx.beginFill(COL_GOLD_BRIGHT, 0.55);
    this.glowGfx.drawCircle(cx, cy, r * 1.2);
    this.glowGfx.endFill();

    // NORMAL 코어 3층 (외곽 황금 → 중간 cream → 코어 거의백)
    this.gfx.beginFill(COL_GOLD_MAIN, 0.85);
    this.gfx.drawCircle(cx, cy, r);
    this.gfx.endFill();
    this.gfx.beginFill(COL_CREAM, 0.95);
    this.gfx.drawCircle(cx, cy, r * 0.55);
    this.gfx.endFill();
    this.gfx.beginFill(COL_NEAR_WHITE, 1.0);
    this.gfx.drawCircle(cx, cy, r * 0.28);
    this.gfx.endFill();

    // 별빛 leak (8방향 짧은 광선이 코어 외곽에서 사방으로 뿜음)
    const RAY_COUNT = 8;
    this.glowGfx.lineStyle(1.2, COL_GOLD_BRIGHT, 0.65);
    for (let i = 0; i < RAY_COUNT; i++) {
      const a = (i / RAY_COUNT) * Math.PI * 2 + t * 0.02;
      const len = 5 + Math.sin(t * 0.08 + i) * 3;
      const x0 = cx + Math.cos(a) * (r * 0.95);
      const y0 = cy + Math.sin(a) * (r * 0.95);
      const x1 = cx + Math.cos(a) * (r * 0.95 + len);
      const y1 = cy + Math.sin(a) * (r * 0.95 + len);
      this.glowGfx.moveTo(x0, y0);
      this.glowGfx.lineTo(x1, y1);
    }
    this.glowGfx.lineStyle(0);
  }

  // ── 발사체 (4겹 라인, 진행 방향 길쭉) ──
  private drawBolts() {
    for (const b of this.bolts) {
      const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy) || 1;
      const dirX = b.vx / sp;
      const dirY = b.vy / sp;
      // 본체 라인: 머리 ~ 꼬리 (현재 위치 중심)
      const headX = b.x + dirX * BOLT_LENGTH * 0.5;
      const headY = b.y + dirY * BOLT_LENGTH * 0.5;
      const tailX = b.x - dirX * BOLT_LENGTH * 0.5;
      const tailY = b.y - dirY * BOLT_LENGTH * 0.5;

      // 트레일 (이전 위치 6 segment, 시작 흐림 → 현재 진함)
      const trail = b.trail;
      for (let i = trail.length - 1; i > 0; i--) {
        const t1 = trail[i];
        const t2 = trail[i - 1];
        const segT = (trail.length - i) / trail.length;
        const alpha = segT * 0.65;
        const w = 2.5 * (0.4 + segT * 0.6);
        this.glowGfx.lineStyle(w, COL_GOLD_BRIGHT, alpha * 0.65);
        this.glowGfx.moveTo(t1.x, t1.y);
        this.glowGfx.lineTo(t2.x, t2.y);
      }
      this.glowGfx.lineStyle(0);

      // 4겹 라인 본체 (개발서 규칙: 절대 원형 X)

      // 1) 외곽 글로우 — ADD
      this.glowGfx.lineStyle(8, COL_GOLD_MAIN, 0.35);
      this.glowGfx.moveTo(tailX, tailY);
      this.glowGfx.lineTo(headX, headY);
      this.glowGfx.lineStyle(0);

      // 2) 중간 — NORMAL
      this.gfx.lineStyle(4.5, COL_GOLD_BRIGHT, 0.78);
      this.gfx.moveTo(tailX, tailY);
      this.gfx.lineTo(headX, headY);

      // 3) 코어 — NORMAL
      this.gfx.lineStyle(2.5, COL_CREAM, 0.92);
      this.gfx.moveTo(tailX, tailY);
      this.gfx.lineTo(headX, headY);

      // 4) 심선 — NORMAL (거의 백)
      this.gfx.lineStyle(1.0, COL_NEAR_WHITE, 1.0);
      this.gfx.moveTo(tailX, tailY);
      this.gfx.lineTo(headX, headY);
      this.gfx.lineStyle(0);
    }
  }

  private drawHitParticles() {
    for (const p of this.hitParticles) {
      const t = p.life / p.maxLife;
      const alpha = t * 0.92;
      const sz = p.size * (0.5 + t * 0.5);

      // 트레일 (이전 → 현재) ADD
      this.glowGfx.lineStyle(sz * 0.6, p.color, alpha * 0.55);
      this.glowGfx.moveTo(p.prevX, p.prevY);
      this.glowGfx.lineTo(p.x, p.y);
      this.glowGfx.lineStyle(0);

      // 코어 점 NORMAL
      this.gfx.beginFill(p.color, alpha);
      this.gfx.drawCircle(p.x, p.y, sz);
      this.gfx.endFill();
    }
  }

  stop() {
    this.active = false;
    this.chargeParticles = [];
    this.bolts = [];
    this.hitParticles = [];
    this.pendingImpacts = [];
    this.pendingDeadIds = [];
    this.coreFireBulge = 0;
    this.gfx.clear();
    this.glowGfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
