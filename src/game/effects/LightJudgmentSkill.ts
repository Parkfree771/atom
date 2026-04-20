import * as PIXI from 'pixi.js';
import { EnemyState, ParticleState } from '../types';
import { isBossType } from '../types';
import { spawnHitParticles } from '../particles';

/**
 * 빛 액티브 스킬 — 심판광 (Final Judgment)
 *
 * 컨셉:
 *   - GATHER → 적 머리 위에 금빛 십자가 마커 순차 스폰 (차징 광점이 주변에서 모여듦)
 *   - MARK → 마커 유지 (적 추적) — 입자 모이기 지속
 *   - VERDICT → 각 마커에서 **입자 폭발** (LightUltimate hit 패턴의 역 — 모였던 빛이 사방 분출)
 *       + 작은 중앙 플래시 오브 + 트레일 있는 burst particle 48개
 *   - FADE → 잔영 페이드
 *
 * 설계 원칙:
 *   - 빛 속성 = "입자 모이기 → 반대로 분출" (사용자 피드백)
 *   - 흰 배경 대응: 밝은 gold/yellow/cream 주조, amber-700 로만 외곽 대비
 *   - GLSL/screenFlash/수직빔 전부 제거, 원형 크레이터·wavy ring 제거
 *   - LightUltimateEffect spawnHitEffect 패턴 차용 (32개 입자 + 트레일)
 *
 * 좌표계: 월드좌표 worldWrap (overlayLayer, -camera 시프트)
 */

// ── 팔레트 (LightUltimate 과 동일 — 순수 골드/노랑, 흰 배경에서 amber-700 로 대비) ──
const COL_AMBER_DEEP   = 0xb45309; // amber-700 (흰 배경 대비 외곽)
const COL_AMBER_MAIN   = 0xd97706; // amber-600
const COL_AMBER_BRIGHT = 0xf59e0b; // amber-500
const COL_AMBER_LIGHT  = 0xfbbf24; // amber-400
const COL_GOLD_MAIN    = 0xeab308; // yellow-500
const COL_GOLD_BRIGHT  = 0xfde047; // yellow-300
const COL_GOLD_LIGHT   = 0xfef08a; // yellow-200
const COL_CREAM        = 0xfef9c3; // yellow-100
const COL_NEAR_WHITE   = 0xfffef5; // 거의 흰색 (코어 핀포인트)

// ── 페이즈 — MARK/VERDICT 는 적 수에 따라 동적 계산 (순차 진행 느낌) ──
const PHASE_GATHER      = 20;             // 0.33s 초반 차징 리드
const PHASE_FADE        = 24;             // 0.40s 잔영
const MARKER_SPACING    = 8;              // 마커 간 스폰 간격 (0.13s)
const EXPLOSION_SPACING = 10;             // 폭발 간 발동 간격 (0.17s)
const PHASE_MARK_BASE   = 18;             // 마지막 마커 + 이 만큼 추가 유지
const PHASE_VERDICT_TAIL = 30;            // 마지막 폭발 + 파티클 잔여 시간
const PHASE_MARK_MIN    = 36;
const PHASE_MARK_MAX    = 180;            // 최대 3s
const PHASE_VERDICT_MIN = 44;
const PHASE_VERDICT_MAX = 220;            // 최대 3.7s

// ── 판정 ──
const DMG_REG    = 500;
const DMG_BOSS   = 260;
const BOSS_STUN  = 120;
const REG_STUN   = 40;
const HIT_RADIUS = 88;

// ── 폭발 시각 ──
const BURST_COUNT      = 48;    // 폭발당 입자 수 (LightUltimate 32 보다 증강)
const BURST_SPEED_MIN  = 4;
const BURST_SPEED_MAX  = 11;
const BURST_LIFE_MIN   = 22;
const BURST_LIFE_MAX   = 42;
const BURST_SIZE_MIN   = 1.4;
const BURST_SIZE_MAX   = 3.2;
const CORE_FLASH_LIFE  = 14;    // 중앙 플래시 오브 수명 (입자 수명보다 짧게)

// ── 모이는 차징 광점 (GATHER + MARK 동안 마커 주변으로 수렴) ──
const CHARGE_PER_MARKER = 3;    // spawn 주기 rate 느낌 (실제는 timer 기반)
const CHARGE_SPAWN_INTERVAL = 3;   // frames
const CHARGE_SPAWN_RADIUS = 70;    // 마커 주변 spawn 반경
const CHARGE_ABSORB_SPEED = 1.9;   // 수렴 속도

interface Marker {
  enemyIdx: number;
  markerIdx: number;       // 거리순 정렬 후의 인덱스 (k)
  spawnFrame: number;      // MARK 페이즈 기준 스폰 오프셋
  fireDelay: number;       // VERDICT 페이즈 기준 폭발 발동 딜레이
  lockedWX: number;
  lockedWY: number;
  fired: boolean;          // 폭발 발동됨
}

interface BurstParticle {
  wx: number; wy: number;       // 월드 좌표
  prevWX: number; prevWY: number;
  vx: number; vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: number;
}

interface Explosion {
  wx: number; wy: number;
  birthFrame: number;
  particles: BurstParticle[];
  seed: number;
}

interface ChargeParticle {
  markerIdx: number;            // 소속 마커 (폭발 시 정리용)
  mx: number; my: number;       // 목적지 (마커 위치)
  wx: number; wy: number;
  prevWX: number; prevWY: number;
  size: number;
  color: number;
  spinBias: number;
  speed: number;
}

interface JudgmentRuntime {
  frame: number;
  markers: Marker[];
  explosions: Explosion[];
  charges: ChargeParticle[];
  chargeTimer: number;
  active: boolean;
  // 동적 페이즈 타이밍
  tMarkStart: number;
  tVerdictStart: number;
  tFadeStart: number;
  totalFrames: number;
}

export class LightJudgmentSkill {
  private overlayLayer: PIXI.Container;

  private worldWrap: PIXI.Container;
  private chargeGfx: PIXI.Graphics;     // 모여드는 차징 입자 + 트레일 (최하위)
  private burstGfx: PIXI.Graphics;      // 폭발 파티클 + 중앙 플래시 오브
  private markerGfx: PIXI.Graphics;     // 십자가 마커 (최상단)

  private runtime: JudgmentRuntime | null = null;
  private time = 0;

  constructor(overlayLayer: PIXI.Container, _groundLayer: PIXI.Container) {
    this.overlayLayer = overlayLayer;
    void _groundLayer;

    this.worldWrap = new PIXI.Container();
    this.overlayLayer.addChild(this.worldWrap);

    this.chargeGfx = new PIXI.Graphics();
    this.worldWrap.addChild(this.chargeGfx);

    this.burstGfx = new PIXI.Graphics();
    this.worldWrap.addChild(this.burstGfx);

    this.markerGfx = new PIXI.Graphics();
    this.worldWrap.addChild(this.markerGfx);
  }

  isActive(): boolean {
    return this.runtime !== null && this.runtime.active;
  }

  start(enemies: EnemyState[], cameraX: number, cameraY: number, canvasW: number, canvasH: number) {
    if (this.runtime && this.runtime.active) return;

    // 현재 화면 내 살아있는 적 수집
    const candidates: Array<{ idx: number; dist2: number; x: number; y: number }> = [];
    const centerWX = cameraX + canvasW / 2;
    const centerWY = cameraY + canvasH / 2;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.active) continue;
      const sx = e.x - cameraX;
      const sy = e.y - cameraY;
      if (sx < -30 || sx > canvasW + 30) continue;
      if (sy < -30 || sy > canvasH + 30) continue;
      const dx = e.x - centerWX;
      const dy = e.y - centerWY;
      candidates.push({ idx: i, dist2: dx * dx + dy * dy, x: e.x, y: e.y });
    }
    // 가까운 적부터 정렬 (착-착-착 순서)
    candidates.sort((a, b) => a.dist2 - b.dist2);

    const n = candidates.length;
    // 동적 페이즈 계산 — 마지막 마커/폭발까지 충분히 시간 확보
    const lastSpawn = n > 0 ? (n - 1) * MARKER_SPACING : 0;
    const lastFire  = n > 0 ? (n - 1) * EXPLOSION_SPACING : 0;
    const phaseMark = Math.max(PHASE_MARK_MIN, Math.min(PHASE_MARK_MAX, lastSpawn + PHASE_MARK_BASE));
    const phaseVerdict = Math.max(PHASE_VERDICT_MIN, Math.min(PHASE_VERDICT_MAX, lastFire + PHASE_VERDICT_TAIL));

    // MARK 페이즈 내 간격 재조정 (상한에 걸렸을 경우 조밀하게)
    const markerSpacing = n > 1 ? Math.min(MARKER_SPACING, (phaseMark - PHASE_MARK_BASE) / (n - 1)) : 0;
    const explosionSpacing = n > 1 ? Math.min(EXPLOSION_SPACING, (phaseVerdict - PHASE_VERDICT_TAIL) / (n - 1)) : 0;

    const markers: Marker[] = [];
    for (let k = 0; k < n; k++) {
      const c = candidates[k];
      markers.push({
        enemyIdx: c.idx,
        markerIdx: k,
        spawnFrame: Math.floor(k * markerSpacing),
        fireDelay: Math.floor(k * explosionSpacing),
        lockedWX: c.x,
        lockedWY: c.y,
        fired: false,
      });
    }

    const tMarkStart = PHASE_GATHER;
    const tVerdictStart = tMarkStart + phaseMark;
    const tFadeStart = tVerdictStart + phaseVerdict;
    const totalFrames = tFadeStart + PHASE_FADE;

    this.runtime = {
      frame: 0,
      markers,
      explosions: [],
      charges: [],
      chargeTimer: 0,
      active: true,
      tMarkStart,
      tVerdictStart,
      tFadeStart,
      totalFrames,
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
    void canvasW; void canvasH;

    this.time += dt;
    rt.frame += dt;

    this.worldWrap.x = -cameraX;
    this.worldWrap.y = -cameraY;

    const f = rt.frame;

    // 1) 차징 입자 spawn — 각 마커에 대해, 스폰된 후 ~폭발 직전까지 주변에서 수렴
    rt.chargeTimer -= dt;
    if (rt.chargeTimer <= 0) {
      rt.chargeTimer = CHARGE_SPAWN_INTERVAL;
      for (const m of rt.markers) {
        if (m.fired) continue;
        const absSpawn = rt.tMarkStart + m.spawnFrame;
        const absFire  = rt.tVerdictStart + m.fireDelay;
        // 마커 등장 직전~폭발 직전 사이만 차징
        if (f < absSpawn - 6) continue;
        if (f > absFire - 4) continue;

        const e = enemies[m.enemyIdx];
        const mx = (e && e.active) ? e.x : m.lockedWX;
        const my = ((e && e.active) ? e.y : m.lockedWY) - 32;

        const n = 1 + Math.floor(Math.random() * CHARGE_PER_MARKER);
        for (let k = 0; k < n; k++) {
          const angle = Math.random() * Math.PI * 2;
          const dist = CHARGE_SPAWN_RADIUS * (0.65 + Math.random() * 0.45);
          const sx = mx + Math.cos(angle) * dist;
          const sy = my + Math.sin(angle) * dist;
          const colors = [COL_AMBER_MAIN, COL_AMBER_LIGHT, COL_GOLD_BRIGHT, COL_GOLD_LIGHT, COL_CREAM];
          rt.charges.push({
            markerIdx: m.markerIdx,
            mx, my,
            wx: sx, wy: sy,
            prevWX: sx, prevWY: sy,
            size: 1.2 + Math.random() * 1.6,
            color: colors[Math.floor(Math.random() * colors.length)],
            spinBias: (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 0.7),
            speed: CHARGE_ABSORB_SPEED * (0.85 + Math.random() * 0.5),
          });
        }
      }
    }

    // 2) 차징 입자 수렴 (목적지 도달 시 제거)
    for (let i = rt.charges.length - 1; i >= 0; i--) {
      const p = rt.charges[i];
      p.prevWX = p.wx;
      p.prevWY = p.wy;

      const dx = p.mx - p.wx;
      const dy = p.my - p.wy;
      const d = Math.hypot(dx, dy);
      if (d < 4) { rt.charges.splice(i, 1); continue; }

      const nx = dx / d;
      const ny = dy / d;
      const tx = -ny * p.spinBias;
      const ty =  nx * p.spinBias;
      const closeBoost = 1 + Math.max(0, (CHARGE_SPAWN_RADIUS - d) / 80);
      const radSpeed = p.speed * closeBoost;
      const tanSpeed = 0.35 + (CHARGE_SPAWN_RADIUS - d) / 100;
      p.wx += (nx * radSpeed + tx * tanSpeed) * dt;
      p.wy += (ny * radSpeed + ty * tanSpeed) * dt;
    }

    // 3) Verdict — 마커별로 fireDelay 에 맞춰 순차 폭발 (가까운 적부터)
    if (f >= rt.tVerdictStart) {
      for (const m of rt.markers) {
        if (m.fired) continue;
        const absFire = rt.tVerdictStart + m.fireDelay;
        if (f < absFire) continue;
        m.fired = true;

        const e = enemies[m.enemyIdx];
        let wx: number, wy: number;
        if (e && e.active) { wx = e.x; wy = e.y; }
        else { wx = m.lockedWX; wy = m.lockedWY; }

        const explosion: Explosion = {
          wx, wy,
          birthFrame: f,
          particles: [],
          seed: Math.random() * 100,
        };
        this.spawnBurstParticles(explosion, wx, wy);
        rt.explosions.push(explosion);

        this.dealRadialDamage(wx, wy, enemies, particles, onKill);

        // 해당 마커의 남은 차징 입자 제거 (바로 폭발로 전환된 느낌)
        rt.charges = rt.charges.filter((c) => c.markerIdx !== m.markerIdx);
      }
    }

    // 4) 폭발 파티클 업데이트 (트레일 + drag + life)
    for (const ex of rt.explosions) {
      for (let i = ex.particles.length - 1; i >= 0; i--) {
        const p = ex.particles[i];
        p.prevWX = p.wx;
        p.prevWY = p.wy;
        p.wx += p.vx * dt;
        p.wy += p.vy * dt;
        p.vx *= 0.92;
        p.vy *= 0.92;
        p.life -= dt;
        if (p.life <= 0) {
          ex.particles.splice(i, 1);
        }
      }
    }

    // 5) 종료
    if (rt.frame >= rt.totalFrames) {
      rt.active = false;
      this.clearGfx();
      return;
    }

    this.render(rt, enemies);
  }

  /** 폭발 파티클 48개 spawn — LightUltimate spawnHitEffect 의 확장판 */
  private spawnBurstParticles(ex: Explosion, wx: number, wy: number) {
    const colors = [
      COL_AMBER_MAIN,
      COL_AMBER_BRIGHT,
      COL_AMBER_LIGHT,
      COL_GOLD_MAIN,
      COL_GOLD_BRIGHT,
      COL_GOLD_LIGHT,
      COL_CREAM,
      COL_NEAR_WHITE,
    ];
    for (let i = 0; i < BURST_COUNT; i++) {
      const angle = (i / BURST_COUNT) * Math.PI * 2 + Math.random() * 0.45;
      const speed = BURST_SPEED_MIN + Math.random() * (BURST_SPEED_MAX - BURST_SPEED_MIN);
      const life = BURST_LIFE_MIN + Math.random() * (BURST_LIFE_MAX - BURST_LIFE_MIN);
      const size = BURST_SIZE_MIN + Math.random() * (BURST_SIZE_MAX - BURST_SIZE_MIN);
      const color = colors[Math.floor(Math.random() * colors.length)];
      ex.particles.push({
        wx, wy,
        prevWX: wx, prevWY: wy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life, maxLife: life,
        size,
        color,
      });
    }
  }

  private dealRadialDamage(
    wx: number, wy: number,
    enemies: EnemyState[],
    particles: ParticleState[],
    onKill: (idx: number) => void,
  ) {
    const r2 = HIT_RADIUS * HIT_RADIUS;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.active) continue;
      const dx = e.x - wx;
      const dy = e.y - wy;
      if (dx * dx + dy * dy > r2) continue;
      const isB = isBossType(e.type);
      e.hp -= isB ? DMG_BOSS : DMG_REG;
      e.stunFrames = Math.max(e.stunFrames ?? 0, isB ? BOSS_STUN : REG_STUN);
      spawnHitParticles(particles, e.x, e.y, COL_GOLD_BRIGHT);
      spawnHitParticles(particles, e.x, e.y, COL_GOLD_LIGHT);
      spawnHitParticles(particles, e.x, e.y, COL_CREAM);
      if (e.hp <= 0) onKill(i);
    }
  }

  private clearGfx() {
    this.markerGfx.clear();
    this.burstGfx.clear();
    this.chargeGfx.clear();
  }

  private render(rt: JudgmentRuntime, enemies: EnemyState[]) {
    this.clearGfx();

    const t = this.time;
    const f = rt.frame;

    // ── 차징 입자 (모이는 빛) — GATHER+MARK 동안 마커 주변에서 안쪽으로 나선 수렴 ──
    for (const p of rt.charges) {
      const dx = p.mx - p.wx;
      const dy = p.my - p.wy;
      const d = Math.hypot(dx, dy);
      const closeFrac = Math.max(0, Math.min(1, (CHARGE_SPAWN_RADIUS - d) / CHARGE_SPAWN_RADIUS));
      const alpha = 0.55 + closeFrac * 0.40;

      // 트레일 (prev → 현재) — amber-700 으로 어둑하게 (흰 배경 대비)
      this.chargeGfx.lineStyle(p.size * 0.7, COL_AMBER_DEEP, alpha * 0.55);
      this.chargeGfx.moveTo(p.prevWX, p.prevWY);
      this.chargeGfx.lineTo(p.wx, p.wy);
      this.chargeGfx.lineStyle(0);

      // 코어 (밝은 gold 점)
      this.chargeGfx.beginFill(p.color, alpha);
      this.chargeGfx.drawCircle(p.wx, p.wy, p.size);
      this.chargeGfx.endFill();
    }

    // ── 마커 — 각 마커는 자기 폭발 발동 전까지만 표시 (순차 제거) ──
    for (const m of rt.markers) {
      if (m.fired) continue;
      const absSpawn = rt.tMarkStart + m.spawnFrame;
      if (f < absSpawn) continue;

      const e = enemies[m.enemyIdx];
      let wx: number, wy: number;
      if (e && e.active) { wx = e.x; wy = e.y; }
      else { wx = m.lockedWX; wy = m.lockedWY; }

      const mx = wx;
      const my = wy - 32;
      const age = f - absSpawn;
      const spawnK = Math.min(1, age / 8);
      const pulse = 0.75 + 0.25 * Math.sin(t * 0.3 + m.enemyIdx * 0.7);

      this.drawMarker(mx, my, spawnK, pulse, t, m.enemyIdx);
    }

    // ── 폭발: 중앙 플래시 오브 + 파티클 burst + 트레일 ──
    for (const ex of rt.explosions) {
      const age = f - ex.birthFrame;

      // (A) 중앙 플래시 오브 — 작고 빠르게 페이드 (화면을 덮지 않음)
      if (age < CORE_FLASH_LIFE) {
        const k = 1 - age / CORE_FLASH_LIFE;     // 1 → 0
        const kSq = k * k;
        const baseR = 6 + (1 - k) * 8;            // 6 → 14 px

        // 외곽 dark amber — 흰 배경 대비 (살짝만)
        this.burstGfx.beginFill(COL_AMBER_DEEP, 0.70 * k);
        this.burstGfx.drawCircle(ex.wx, ex.wy, baseR * 1.6);
        this.burstGfx.endFill();
        // 중간 gold
        this.burstGfx.beginFill(COL_AMBER_BRIGHT, 0.85 * k);
        this.burstGfx.drawCircle(ex.wx, ex.wy, baseR * 1.1);
        this.burstGfx.endFill();
        // 밝은 노랑
        this.burstGfx.beginFill(COL_GOLD_BRIGHT, 0.90 * kSq);
        this.burstGfx.drawCircle(ex.wx, ex.wy, baseR * 0.75);
        this.burstGfx.endFill();
        // 크림
        this.burstGfx.beginFill(COL_CREAM, 0.95 * kSq);
        this.burstGfx.drawCircle(ex.wx, ex.wy, baseR * 0.45);
        this.burstGfx.endFill();
        // 핀포인트 (거의 흰)
        this.burstGfx.beginFill(COL_NEAR_WHITE, 0.95 * kSq);
        this.burstGfx.drawCircle(ex.wx, ex.wy, baseR * 0.22);
        this.burstGfx.endFill();
      }

      // (B) 파티클 burst — 트레일 + 점
      for (const p of ex.particles) {
        const lifeK = p.life / p.maxLife;
        if (lifeK <= 0) continue;
        const alpha = lifeK * 0.95;
        const sz = p.size * (0.55 + lifeK * 0.45);

        // 트레일 (amber-700 기반 어두운 외곽 — 흰 배경 대비)
        this.burstGfx.lineStyle(sz * 0.9, COL_AMBER_DEEP, alpha * 0.35);
        this.burstGfx.moveTo(p.prevWX, p.prevWY);
        this.burstGfx.lineTo(p.wx, p.wy);
        this.burstGfx.lineStyle(0);

        // 트레일 내부 밝은 라인 (gold)
        this.burstGfx.lineStyle(sz * 0.5, p.color, alpha * 0.75);
        this.burstGfx.moveTo(p.prevWX, p.prevWY);
        this.burstGfx.lineTo(p.wx, p.wy);
        this.burstGfx.lineStyle(0);

        // 입자 외곽 (amber-deep stroke for white bg contrast)
        this.burstGfx.lineStyle(0.9, COL_AMBER_DEEP, alpha * 0.85);
        this.burstGfx.beginFill(p.color, alpha);
        this.burstGfx.drawCircle(p.wx, p.wy, sz);
        this.burstGfx.endFill();
        this.burstGfx.lineStyle(0);
      }
    }
  }

  /** 십자가 마커 — amber-deep 외곽 + gold 코어 + 크림 중심 점 + 회전 점선 링 */
  private drawMarker(
    mx: number, my: number,
    spawnK: number, pulse: number,
    t: number, idx: number,
  ) {
    const barLong = 14 * spawnK;
    const barShort = 14 * spawnK;
    const barW = 3.6;

    // 외곽 — amber-700 (흰 배경 대비)
    this.markerGfx.beginFill(COL_AMBER_DEEP, 0.95 * spawnK);
    this.markerGfx.drawRect(mx - barW / 2, my - barLong, barW, barLong * 2);
    this.markerGfx.drawRect(mx - barShort, my - barW / 2, barShort * 2, barW);
    this.markerGfx.endFill();

    // 코어 — gold-300 (밝음)
    this.markerGfx.beginFill(COL_GOLD_BRIGHT, 0.98 * spawnK);
    this.markerGfx.drawRect(mx - 1.2, my - barLong + 2, 2.4, barLong * 2 - 4);
    this.markerGfx.drawRect(mx - barShort + 2, my - 1.2, (barShort - 2) * 2, 2.4);
    this.markerGfx.endFill();

    // 중심 점 (박동) — 크림
    this.markerGfx.beginFill(COL_CREAM, 0.98 * spawnK * pulse);
    this.markerGfx.drawRect(mx - 1.6, my - 1.6, 3.2, 3.2);
    this.markerGfx.endFill();

    // 외곽 회전 점선 호 (amber-deep) — 타겟 락 표현
    this.markerGfx.lineStyle(1.6 * spawnK, COL_AMBER_DEEP, 0.85 * spawnK);
    const rotA = t * 0.08 + idx * 0.3;
    this.markerGfx.arc(mx, my, 13, rotA, rotA + Math.PI * 0.75);
    this.markerGfx.arc(mx, my, 13, rotA + Math.PI, rotA + Math.PI * 1.75);
    this.markerGfx.lineStyle(0);
  }

  destroy() {
    this.worldWrap.destroy({ children: true });
    this.runtime = null;
  }
}

// ── 팔레트 미사용 경고 방지 (COL_GOLD_MAIN 은 colors 배열에서만 사용) ──
void COL_GOLD_MAIN;
