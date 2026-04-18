import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 빛+전기+암흑 3단계 — 심연 진동 (Voidpulse Cascade)
 *
 * 구조 (물+빛+전기 = Prism Cascade 미러링, 팔레트만 교체):
 *   - 머리 위 수렴점에 검은 광자 + 전기 입자 상시 수렴 (chargeT 누적)
 *   - chargeT=1 → 반경 내 최대 N마리로 **유도 암흑 광선** 일제 발사
 *   - 레이저는 매끄러운 곡선 유도 (지그재그 X)
 *   - 명중 → 주변 3마리로 **전기 번개 체인 확산** (지그재그, 여기만 번개)
 *   - 명중점에 **작은 중력장 생성** (엔진이 주변 적 약한 흡인)
 *   - 사이클 자동 반복: 수렴 → 발사 → 수렴
 *
 * 개발서 규칙:
 *   - 규칙 5: 유도 레이저 enemyIdx + lastSafeX/Y fallback
 *   - 규칙 6(1): 폴리곤 없음. 셀/파티클/라인 only
 *   - 규칙 6(2): 장식 금지
 *
 * 팔레트:
 *   - 암흑 주조 — C_BLACK / I_950 / P_950
 *   - 전기 액센트 — V_700 / V_500 / V_400 / V_300
 *   - 희귀 하이라이트 — V_200 (거의 흰 violet)
 *   - 사이안 hint — 매우 소량
 */

// ── 수렴점 (WLE 파라미터 완전 동일) ──
const GATHER_OFFSET_Y = 78;        // 머리 위 (posY - OFFSET)
const GATHER_MAX_COUNT = 130;
const GATHER_SOURCE_Y_ABOVE = 180;
const GATHER_SOURCE_X_RANGE = 360;

// ── 충전 ──
const CHARGE_DURATION = 90;        // ~1.5초마다 발사
const MAX_STRIKE_TARGETS = 20;

// ── 유도 레이저 (느리게, 두껍게) ──
const PROJECTILE_SPEED = 5.2;          // 이전 9 → 5.2 (천천히)
const PROJECTILE_HIT_RADIUS = 28;
const PROJECTILE_MAX_LIFE = 180;       // 이동 속도 느려진 만큼 수명 길게
const HOMING_TURN_RATE = 0.10;
const TRAIL_LENGTH = 12;               // 더 긴 꼬리
const NODE_MAX_TRAVEL2 = 120 * 120;

// ── 중력장 (1단계 암흑 디자인 복제, 크기만 작게) ──
const GRAVITY_LIFE = 300;          // 5초 @ 60fps
const GRAVITY_MAX_R = 38;          // DarkEffect 보다 작게
const GRAVITY_RAMPUP = 18;
const GRAVITY_FADE = 18;
const GRAVITY_PARTICLES_MAX = 10;

// ── 팔레트 ──
const C_BLACK   = 0x05010a;
const C_I_950   = 0x1e1b4b;
const C_P_950   = 0x2e1065;
const C_P_900   = 0x3b0764;
const C_P_800   = 0x581c87;
const C_V_700   = 0x6d28d9;
const C_V_500   = 0x8b5cf6;
const C_V_400   = 0xa78bfa;
const C_V_300   = 0xc4b5fd;
const C_V_200   = 0xe0d8ff;
const C_CYAN_300= 0x67e8f9;  // 매우 소량 hint

// 수렴 입자 색 팔레트 (검정:다크보라:전기보라:사이안 = 3:4:2:1)
const GATHER_PALETTE = [
  C_BLACK, C_BLACK, C_BLACK,
  C_I_950, C_P_950, C_P_900, C_P_800,
  C_V_700, C_V_500,
  C_CYAN_300,
];

// ── 타입 ──
interface GatherParticle {
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
  color: number;
  phase: number;
}

interface Projectile {
  x: number; y: number;
  vx: number; vy: number;
  targetIdx: number;
  lastSafeX: number; lastSafeY: number;
  life: number;
  color: number;
  trailPts: Array<{ x: number; y: number }>;
}

interface ProjectileHit {
  targetIdx: number;
  hitX: number;
  hitY: number;
}

interface ChainLink {
  fromX: number; fromY: number;
  toX: number; toY: number;
  life: number; maxLife: number;
  delay: number;
  path: Array<{ x: number; y: number }>;
}

interface GravityParticle {
  angle: number;
  radius: number;        // 현재 반경 (감소 → 흡입)
  speed: number;
  angularSpeed: number;
  size: number;
  spawnRadius: number;
}

interface GravityField {
  x: number; y: number;
  life: number; maxLife: number;
  phase: number;
  particles: GravityParticle[];
  spawnTimer: number;
}

interface EnemyRef {
  x: number; y: number;
  active: boolean;
}

export class LightElectricDarkEffect {
  private container: PIXI.Container;
  private gfx: PIXI.Graphics;
  private glowGfx: PIXI.Graphics;

  active = false;
  private time = 0;
  private posX = 0;
  private posY = 0;
  private camX = 0;
  private camY = 0;

  // 충전 상태
  private chargeT = 0;
  private _chargeReadyFlag = false;
  private postFireFlash = 0;

  // 풀
  private gatherParticles: GatherParticle[] = [];
  private projectiles: Projectile[] = [];
  private chainLinks: ChainLink[] = [];
  private gravities: GravityField[] = [];

  // 엔진 통신
  private hitsBuffer: ProjectileHit[] = [];

  constructor(parent: PIXI.Container, _worldContainer: PIXI.Container) {
    void _worldContainer;
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
    this.posX = x;
    this.posY = y;
    this.time = 0;
    this.chargeT = 0;
    this._chargeReadyFlag = false;
    this.postFireFlash = 0;
    this.gatherParticles = [];
    this.projectiles = [];
    this.chainLinks = [];
    this.gravities = [];
    this.hitsBuffer = [];
  }

  setPosition(x: number, y: number) {
    this.posX = x;
    this.posY = y;
  }

  stop() {
    this.active = false;
    this.chargeT = 0;
    this._chargeReadyFlag = false;
    this.postFireFlash = 0;
    this.gatherParticles = [];
    this.projectiles = [];
    this.chainLinks = [];
    this.gravities = [];
    this.hitsBuffer = [];
    this.gfx.clear();
    this.glowGfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }

  // ── 엔진 통신 ──
  chargeReady(): boolean { return this._chargeReadyFlag; }
  hitsThisFrame(): ProjectileHit[] { return this.hitsBuffer; }
  maxStrikeTargets(): number { return MAX_STRIKE_TARGETS; }
  activeGravities(): GravityField[] { return this.gravities; }
  gravityMaxRadius(): number { return GRAVITY_MAX_R; }
  /** 수렴점 월드 좌표 (캐릭터 머리 위) */
  getGatherPoint(): { x: number; y: number } {
    return { x: this.posX, y: this.posY - GATHER_OFFSET_Y };
  }

  /** 충전 완료 시 엔진이 수집한 타겟 리스트를 받아 발사체 스폰 */
  setStrikeTargets(targets: Array<{ worldX: number; worldY: number; enemyIdx: number }>) {
    const srcX = this.posX;
    const srcY = this.posY - GATHER_OFFSET_Y;

    for (const tgt of targets) {
      const dx = tgt.worldX - srcX;
      const dy = tgt.worldY - srcY;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const perpX = -dy / len;
      const perpY = dx / len;
      const curveBias = (Math.random() - 0.5) * 0.95;
      const forwardBias = 0.55 + Math.random() * 0.25;
      const ivx = (dx / len) * forwardBias + perpX * curveBias;
      const ivy = (dy / len) * forwardBias + perpY * curveBias;
      const iMag = Math.sqrt(ivx * ivx + ivy * ivy) || 1;
      const vx = (ivx / iMag) * PROJECTILE_SPEED;
      const vy = (ivy / iMag) * PROJECTILE_SPEED;

      // 다크 퍼플 팔레트 (원본 RAINBOW 대체)
      const trailPalette = [C_V_700, C_V_500, C_V_400, C_V_300, C_P_900];
      this.projectiles.push({
        x: srcX + (Math.random() - 0.5) * 12,
        y: srcY + (Math.random() - 0.5) * 12,
        vx, vy,
        targetIdx: tgt.enemyIdx,
        lastSafeX: tgt.worldX,
        lastSafeY: tgt.worldY,
        life: PROJECTILE_MAX_LIFE,
        color: trailPalette[Math.floor(Math.random() * trailPalette.length)],
        trailPts: [],
      });
    }

    this.chargeT = 0;
    this._chargeReadyFlag = false;
    this.postFireFlash = 18;
  }

  /** 엔진 → 체인 번개 라인 추가 (적 → 적 지그재그) */
  addChainLines(lines: Array<{ x0: number; y0: number; x1: number; y1: number }>) {
    for (const l of lines) {
      const life = 20;
      this.chainLinks.push({
        fromX: l.x0, fromY: l.y0,
        toX: l.x1, toY: l.y1,
        life, maxLife: life,
        delay: 0,
        path: this.makeZigzagPath(l.x0, l.y0, l.x1, l.y1),
      });
    }
  }

  /** 명중점 중력장 스폰 (1단계 암흑 스타일, 크기만 작음) */
  spawnGravityAt(x: number, y: number) {
    this.gravities.push({
      x, y,
      life: GRAVITY_LIFE,
      maxLife: GRAVITY_LIFE,
      phase: Math.random() * Math.PI * 2,
      particles: [],
      spawnTimer: 0,
    });
  }

  // ── 수렴 입자 spawn (사방 전방위, 느리게) ──
  private spawnGatherParticle() {
    const domeCX = this.posX;
    const domeCY = this.posY - GATHER_OFFSET_Y;
    // 전방위, 반경 110~170 (이전 180~280 → 더 가까이)
    const ang = Math.random() * Math.PI * 2;
    const r = 110 + Math.random() * 60;
    const sourceX = domeCX + Math.cos(ang) * r;
    const sourceY = domeCY + Math.sin(ang) * r;
    const dx = domeCX - sourceX;
    const dy = domeCY - sourceY;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    // 초기 속도는 플레이어 기본속도(2)보다 여유있게 시작
    const speed = 2.2 + Math.random() * 1.0;
    this.gatherParticles.push({
      x: sourceX,
      y: sourceY,
      vx: (dx / len) * speed,
      vy: (dy / len) * speed,
      life: 140 + Math.random() * 50,
      maxLife: 190,
      size: 2.2 + Math.random() * 1.6,   // 작게 (이전 3.8~6.4 → 2.2~3.8)
      color: GATHER_PALETTE[Math.floor(Math.random() * GATHER_PALETTE.length)],
      phase: Math.random() * Math.PI * 2,
    });
  }

  // ── 지그재그 경로 (체인 번개) ──
  private makeZigzagPath(x0: number, y0: number, x1: number, y1: number): Array<{ x: number; y: number }> {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 2) return [{ x: x0, y: y0 }, { x: x1, y: y1 }];
    const segs = Math.max(6, Math.floor(dist / 14));
    const jitter = dist * 0.16;
    const perpX = -dy / dist;
    const perpY = dx / dist;
    const pts: Array<{ x: number; y: number }> = [{ x: x0, y: y0 }];
    for (let i = 1; i < segs; i++) {
      const t = i / segs;
      const j = (Math.random() - 0.5) * jitter;
      pts.push({
        x: x0 + dx * t + perpX * j,
        y: y0 + dy * t + perpY * j,
      });
    }
    pts.push({ x: x1, y: y1 });
    return pts;
  }

  // ── 메인 업데이트 ──
  update(dt: number, cameraX: number, cameraY: number) {
    if (!this.active) return;
    this.time += dt;
    this.camX = cameraX;
    this.camY = cameraY;
    this.hitsBuffer = [];

    // 충전
    if (this.chargeT < 1 && !this._chargeReadyFlag) {
      this.chargeT += dt / CHARGE_DURATION;
      if (this.chargeT >= 1) {
        this.chargeT = 1;
        this._chargeReadyFlag = true;
      }
    }
    if (this.postFireFlash > 0) {
      this.postFireFlash -= dt;
      if (this.postFireFlash < 0) this.postFireFlash = 0;
    }

    // 수렴 입자 spawn (WLE 동일 패턴: chargeT 비례 1~5/frame)
    const spawnIntensity = 1 + this.chargeT * 4;
    const floorN = Math.floor(spawnIntensity);
    for (let i = 0; i < floorN; i++) {
      if (this.gatherParticles.length < GATHER_MAX_COUNT) this.spawnGatherParticle();
    }
    if (Math.random() < spawnIntensity - floorN && this.gatherParticles.length < GATHER_MAX_COUNT) {
      this.spawnGatherParticle();
    }

    // 수렴 입자 업데이트 — 속도 하한 보장 (플레이어 이동속도 2보다 항상 빠르게)
    const domeCX = this.posX;
    const domeCY = this.posY - GATHER_OFFSET_Y;
    const MAX_SPEED = 5;                   // 최대 5 px/frame (플레이어 속도의 ~2.5배)
    const MAX_V2 = MAX_SPEED * MAX_SPEED;  // 25
    const MIN_SPEED = 2.6;                 // 항상 플레이어(2)보다 빠르게
    const MIN_V2 = MIN_SPEED * MIN_SPEED;
    for (let i = this.gatherParticles.length - 1; i >= 0; i--) {
      const p = this.gatherParticles[i];
      const dx = domeCX - p.x;
      const dy = domeCY - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 100) { swapPop(this.gatherParticles, i); continue; }
      p.life -= dt;
      if (p.life <= 0) { swapPop(this.gatherParticles, i); continue; }
      const dist = Math.sqrt(d2);
      const invDist = 1 / dist;
      const ux = dx * invDist;
      const uy = dy * invDist;
      const pull = 0.08 + (1 - Math.min(1, dist / 220)) * 0.12;
      p.vx += ux * pull;
      p.vy += uy * pull;
      const v2 = p.vx * p.vx + p.vy * p.vy;
      if (v2 > MAX_V2) {
        const vInv = MAX_SPEED / Math.sqrt(v2);
        p.vx *= vInv;
        p.vy *= vInv;
      } else if (v2 < MIN_V2) {
        // 항상 MIN_SPEED 이상 — 타겟 방향으로 재정렬
        p.vx = ux * MIN_SPEED;
        p.vy = uy * MIN_SPEED;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }

    // 체인 수명
    for (let i = this.chainLinks.length - 1; i >= 0; i--) {
      const c = this.chainLinks[i];
      if (c.delay > 0) { c.delay -= dt; continue; }
      c.life -= dt;
      if (c.life <= 0) swapPop(this.chainLinks, i);
    }

    // 중력장 수명 + 내부 나선 입자 (DarkEffect 패턴)
    for (let i = this.gravities.length - 1; i >= 0; i--) {
      const g = this.gravities[i];
      g.life -= dt;
      g.phase += 0.08 * dt;
      g.spawnTimer += dt;
      // ~6 프레임마다 1 입자 (최대 10개)
      if (g.spawnTimer >= 6 && g.particles.length < GRAVITY_PARTICLES_MAX) {
        g.spawnTimer = 0;
        const R = GRAVITY_MAX_R;
        g.particles.push({
          angle: Math.random() * Math.PI * 2,
          radius: R * (0.75 + Math.random() * 0.25),
          speed: 0.18 + Math.random() * 0.18,
          angularSpeed: 0.01 + Math.random() * 0.008,
          size: 1.2 + Math.random() * 1.0,
          spawnRadius: R * 0.95,
        });
      }
      // 입자 나선 흡입
      const minR = GRAVITY_MAX_R * 0.08;
      for (let pi = g.particles.length - 1; pi >= 0; pi--) {
        const p = g.particles[pi];
        p.radius -= p.speed * dt;
        p.angle += p.angularSpeed * dt;
        p.speed += 0.005 * dt;
        if (p.radius < minR) swapPop(g.particles, pi);
      }
      if (g.life <= 0) swapPop(this.gravities, i);
    }

    this.draw();
  }

  /** 엔진이 매 프레임 호출 — 유도 레이저 추적 (규칙 5 fallback) */
  updateHoming(dt: number, enemies: EnemyRef[]) {
    if (!this.active) return;
    const enemyCount = enemies.length;

    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];

      let tx = p.lastSafeX;
      let ty = p.lastSafeY;
      let targetAlive = false;
      if (p.targetIdx < enemyCount) {
        const e = enemies[p.targetIdx];
        if (e && e.active) {
          const dxn = e.x - p.lastSafeX;
          const dyn = e.y - p.lastSafeY;
          if (dxn * dxn + dyn * dyn <= NODE_MAX_TRAVEL2) {
            p.lastSafeX = e.x;
            p.lastSafeY = e.y;
            tx = e.x;
            ty = e.y;
            targetAlive = true;
          }
        }
      }

      const ddx = tx - p.x;
      const ddy = ty - p.y;
      const dist = Math.sqrt(ddx * ddx + ddy * ddy);
      if (dist > 0.1) {
        const ux = ddx / dist;
        const uy = ddy / dist;
        p.vx += (ux * PROJECTILE_SPEED - p.vx) * HOMING_TURN_RATE;
        p.vy += (uy * PROJECTILE_SPEED - p.vy) * HOMING_TURN_RATE;
        const vMag = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
        if (vMag > 0.1) {
          p.vx = (p.vx / vMag) * PROJECTILE_SPEED;
          p.vy = (p.vy / vMag) * PROJECTILE_SPEED;
        }
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;

      p.trailPts.push({ x: p.x, y: p.y });
      if (p.trailPts.length > TRAIL_LENGTH) p.trailPts.shift();

      if (targetAlive && dist < PROJECTILE_HIT_RADIUS) {
        this.hitsBuffer.push({
          targetIdx: p.targetIdx,
          hitX: tx,
          hitY: ty,
        });
        swapPop(this.projectiles, i);
        continue;
      }

      p.life -= dt;
      if (p.life <= 0 || !targetAlive) {
        swapPop(this.projectiles, i);
      }
    }
  }

  // ── 그리기 ──
  private draw() {
    this.gfx.clear();
    this.glowGfx.clear();

    // 1. 수렴 입자
    this.drawGatherParticles();

    // 2. 수렴점 코어 (중력 검은 코어 + 보라 halo)
    this.drawGatherCore();

    // 3. 유도 레이저 + 트레일
    for (const p of this.projectiles) this.drawProjectile(p);

    // 4. 체인 번개 (몬스터 간)
    for (const c of this.chainLinks) {
      if (c.delay > 0) continue;
      this.drawChainBolt(c);
    }

    // 5. 중력장 (명중점)
    for (const g of this.gravities) this.drawGravity(g);
  }

  private drawGatherParticles() {
    for (const p of this.gatherParticles) {
      const life = p.life / p.maxLife;
      const alpha = 0.7 + (1 - life) * 0.3;
      const sz = p.size * (0.85 + (1 - life) * 0.35);
      const sx = p.x - this.camX;
      const sy = p.y - this.camY;

      // 2겹 halo (더 크게)
      this.glowGfx.beginFill(p.color, alpha * 0.35);
      this.glowGfx.drawCircle(sx, sy, sz * 2.7);
      this.glowGfx.endFill();
      this.glowGfx.beginFill(p.color, alpha * 0.55);
      this.glowGfx.drawCircle(sx, sy, sz * 1.7);
      this.glowGfx.endFill();
      // 코어
      this.gfx.beginFill(p.color, alpha);
      this.gfx.drawCircle(sx, sy, sz);
      this.gfx.endFill();
    }
  }

  private drawGatherCore() {
    const cx = this.posX - this.camX;
    const cy = this.posY - GATHER_OFFSET_Y - this.camY;
    const flashBoost = this.postFireFlash > 0 ? (this.postFireFlash / 18) * 0.5 : 0;
    const base = 0.55 + this.chargeT * 0.35 + flashBoost;
    const pulse = 0.88 + Math.sin(this.time * 0.2) * 0.12;
    const size = (1 + this.chargeT * 0.35) * pulse;

    // 외곽 보라 halo 3겹
    this.glowGfx.beginFill(C_V_700, 0.22 * base);
    this.glowGfx.drawCircle(cx, cy, 68 * size);
    this.glowGfx.endFill();
    this.glowGfx.beginFill(C_V_500, 0.28 * base);
    this.glowGfx.drawCircle(cx, cy, 44 * size);
    this.glowGfx.endFill();
    this.glowGfx.beginFill(C_V_300, 0.36 * base);
    this.glowGfx.drawCircle(cx, cy, 24 * size);
    this.glowGfx.endFill();

    // 검은 중력 코어
    this.gfx.beginFill(C_BLACK, 0.92 * base);
    this.gfx.drawCircle(cx, cy, 16 * size);
    this.gfx.endFill();

    // 바이올렛 중심 점
    if (this.chargeT > 0.2) {
      this.gfx.beginFill(C_V_300, 0.88);
      this.gfx.drawCircle(cx, cy, 5 * size);
      this.gfx.endFill();
    }

    // 사건지평선 얇은 호 (chargeT 높을 때)
    if (this.chargeT > 0.5) {
      const rot = this.time * 0.09;
      this.glowGfx.lineStyle(1.6, C_V_400, 0.6 * (this.chargeT - 0.5) * 2);
      this.glowGfx.arc(cx, cy, 30 * size, rot, rot + Math.PI * 1.3);
      this.glowGfx.lineStyle(0);
    }
  }

  // ── 유도 레이저 (3패스, 두껍게) ──
  private drawProjectile(p: Projectile) {
    const pts = p.trailPts;
    if (pts.length >= 2) {
      for (let i = 0; i < pts.length - 1; i++) {
        const ageT = i / (pts.length - 1);
        const alpha = ageT * 0.9;
        const width = 5 + ageT * 7;         // 이전 2.8+4 → 5+7 (두껍게)
        const x0 = pts[i].x - this.camX;
        const y0 = pts[i].y - this.camY;
        const x1 = pts[i + 1].x - this.camX;
        const y1 = pts[i + 1].y - this.camY;
        // 외곽 다크 halo
        this.glowGfx.lineStyle(width * 2.6, C_P_950, alpha * 0.38);
        this.glowGfx.moveTo(x0, y0);
        this.glowGfx.lineTo(x1, y1);
        // 중간 violet glow
        this.glowGfx.lineStyle(width * 1.6, p.color, alpha * 0.55);
        this.glowGfx.moveTo(x0, y0);
        this.glowGfx.lineTo(x1, y1);
        // 밝은 코어
        this.gfx.lineStyle(width * 0.55, C_V_300, alpha * 0.95);
        this.gfx.moveTo(x0, y0);
        this.gfx.lineTo(x1, y1);
      }
      this.gfx.lineStyle(0);
      this.glowGfx.lineStyle(0);
    }

    // 헤드 (3층)
    const hx = p.x - this.camX;
    const hy = p.y - this.camY;
    this.glowGfx.beginFill(p.color, 0.78);
    this.glowGfx.drawCircle(hx, hy, 16);
    this.glowGfx.endFill();
    this.glowGfx.beginFill(C_V_500, 0.78);
    this.glowGfx.drawCircle(hx, hy, 9);
    this.glowGfx.endFill();
    this.gfx.beginFill(C_V_200, 0.98);
    this.gfx.drawCircle(hx, hy, 4.5);
    this.gfx.endFill();
  }

  // ── 체인 번개 (몬스터간만, 4패스) ──
  private drawChainBolt(c: ChainLink) {
    const life = c.life / c.maxLife;
    const flicker = 0.75 + Math.random() * 0.25;
    const a = life * flicker;
    const pts = c.path;
    if (pts.length < 2) return;

    const drawPath = (gfx: PIXI.Graphics, w: number, color: number, alpha: number) => {
      gfx.lineStyle(w, color, alpha);
      gfx.moveTo(pts[0].x - this.camX, pts[0].y - this.camY);
      for (let i = 1; i < pts.length; i++) gfx.lineTo(pts[i].x - this.camX, pts[i].y - this.camY);
      gfx.lineStyle(0);
    };

    drawPath(this.glowGfx, 16, C_P_950, a * 0.30);
    drawPath(this.glowGfx, 10, C_V_700, a * 0.45);
    drawPath(this.gfx, 4.5, C_V_400, a * 0.90);
    drawPath(this.gfx, 1.8, C_V_200, a * 0.95);
  }

  // ── 중력장 (1단계 암흑 디자인 복제, 크기만 작게) ──
  private drawGravity(g: GravityField) {
    const age = g.maxLife - g.life;
    const rampK = Math.min(1, age / GRAVITY_RAMPUP);
    const fadeK = g.life < GRAVITY_FADE ? g.life / GRAVITY_FADE : 1;
    const alpha = rampK * fadeK;
    const px = g.x - this.camX;
    const py = g.y - this.camY;
    const R = GRAVITY_MAX_R;

    // 얇은 보라 링 (호흡)
    const pulse = 1 + Math.sin(this.time * 0.05 + g.phase) * 0.04;
    const ringR = R * 0.78 * pulse;
    this.gfx.lineStyle(1.5, 0x7c3aed, 0.32 * alpha);
    this.gfx.drawCircle(px, py, ringR);
    this.gfx.lineStyle(1.0, 0xa78bfa, 0.18 * alpha);
    this.gfx.drawCircle(px, py, ringR * 1.06);
    this.gfx.lineStyle(0);

    // 중심 코어 (작은 검은 점)
    this.gfx.beginFill(0x0a0015, 0.85 * alpha);
    this.gfx.drawCircle(px, py, R * 0.10);
    this.gfx.endFill();
    this.gfx.beginFill(0x1a0530, 0.40 * alpha);
    this.gfx.drawCircle(px, py, R * 0.18);
    this.gfx.endFill();

    // 흡입 입자 (보라 점, 천천히)
    for (const p of g.particles) {
      const x = px + Math.cos(p.angle) * p.radius;
      const y = py + Math.sin(p.angle) * p.radius;
      const progress = 1 - p.radius / p.spawnRadius;
      const a = (1 - progress * 0.5) * 0.55 * alpha;
      const sz = p.size * (1 - progress * 0.4);
      this.gfx.beginFill(0x7c3aed, a);
      this.gfx.drawCircle(x, y, sz);
      this.gfx.endFill();
    }
  }
}
