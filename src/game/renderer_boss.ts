import * as PIXI from 'pixi.js';
import { GlowFilter } from '@pixi/filter-glow';
import { EnemyType, EnemyState } from './types';

/**
 * 보스 전용 렌더러 — 각 속성별 고유 실루엣 + 프레임별 애니메이션.
 * 퀄리티 우선 — GlowFilter로 진짜 bloom, 궤도 3D 폐색 등 PIXI 고급 기법 활용.
 */

// 공유 GlowFilter (보스별 warm/cool bloom)
let _electricGlowFilter: GlowFilter | null = null;
export function getElectricGlowFilter(): GlowFilter {
  if (!_electricGlowFilter) {
    _electricGlowFilter = new GlowFilter({
      distance: 22,
      outerStrength: 2.8,
      innerStrength: 0.4,
      color: 0xffffff,
      quality: 0.5,
    });
  }
  return _electricGlowFilter;
}

let _lightGlowFilter: GlowFilter | null = null;
export function getLightGlowFilter(): GlowFilter {
  if (!_lightGlowFilter) {
    _lightGlowFilter = new GlowFilter({
      distance: 28,
      outerStrength: 3.6,
      innerStrength: 0.7,
      color: 0xffb347, // warm amber bloom tint
      quality: 0.5,
    });
  }
  return _lightGlowFilter;
}

export function drawBoss(g: PIXI.Graphics, e: EnemyState, frameCount: number, glow?: PIXI.Graphics) {
  g.clear();
  const r = e.width / 2;
  const t = frameCount;

  switch (e.type as EnemyType) {
    case 'boss_water':    drawWaterBoss(g, r, t); break;
    case 'boss_fire':     drawFireBoss(g, r, t); break;
    case 'boss_earth':    drawEarthBoss(g, r, t); break;
    case 'boss_electric': drawElectricBoss(g, r, t, glow); break;
    case 'boss_light':    drawLightBoss(g, r, t); break;
    case 'boss_dark':     drawDarkBoss(g, r, t); break;
  }

  // ── HP 바 (공통) ──
  if (e.hp < e.maxHp) {
    const barW = e.width * 1.15;
    const barH = 6;
    const barY = -r - 18;
    // 바깥 테두리 (보스 느낌)
    g.beginFill(0x0f172a, 0.92);
    g.drawRoundedRect(-barW / 2 - 2, barY - 2, barW + 4, barH + 4, 2);
    g.endFill();
    // 내부 바닥
    g.beginFill(0x1f2937);
    g.drawRoundedRect(-barW / 2, barY, barW, barH, 1.5);
    g.endFill();
    // 체력 게이지 (구간별 색)
    const hpRatio = Math.max(0, e.hp / e.maxHp);
    const hpColor = hpRatio > 0.6 ? 0xef4444 : hpRatio > 0.3 ? 0xf59e0b : 0xfecaca;
    g.beginFill(hpColor);
    g.drawRoundedRect(-barW / 2, barY, barW * hpRatio, barH, 1.5);
    g.endFill();
    // 하이라이트 라인
    g.beginFill(0xffffff, 0.35);
    g.drawRect(-barW / 2, barY, barW * hpRatio, 1.5);
    g.endFill();
  }
}

// ═══════════════════════════════════════════════════════════════════
// 유틸 — bezier 다각형 + 별 모양
// ═══════════════════════════════════════════════════════════════════
function quadBezier(x0: number, y0: number, xc: number, yc: number, x1: number, y1: number, segs: number): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let s = 0; s <= segs; s++) {
    const tt = s / segs;
    const mt = 1 - tt;
    out.push({
      x: mt * mt * x0 + 2 * mt * tt * xc + tt * tt * x1,
      y: mt * mt * y0 + 2 * mt * tt * yc + tt * tt * y1,
    });
  }
  return out;
}

// drawPolygon은 내부적으로 flat number[]를 즉시 복사하므로 scratch 재사용 안전.
const _polyScratch: number[] = [];

function polygonPoints(pts: Array<{ x: number; y: number }>): number[] {
  _polyScratch.length = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    _polyScratch.push(p.x, p.y);
  }
  return _polyScratch;
}

/** 균일 스케일 버전 — pts.map(p=>({x:p.x*s,y:p.y*s})) + polygonPoints 를 한번에. */
function polygonPointsScaled(pts: Array<{ x: number; y: number }>, s: number): number[] {
  _polyScratch.length = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    _polyScratch.push(p.x * s, p.y * s);
  }
  return _polyScratch;
}

/** affine: (p.x*sx+tx, p.y*sy+ty). 중심점 스케일 / 오프셋+스케일 등 범용. */
function polygonPointsAffine(
  pts: Array<{ x: number; y: number }>,
  sx: number, tx: number, sy: number, ty: number,
): number[] {
  _polyScratch.length = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    _polyScratch.push(p.x * sx + tx, p.y * sy + ty);
  }
  return _polyScratch;
}

// ═══════════════════════════════════════════════════════════════════
// 1) Phase Resonator (물 속성) — atom 테마: 핵 + 궤도 + 파동 간섭
// ═══════════════════════════════════════════════════════════════════
/** 임의 기울기 타원(호)을 현재 lineStyle로 스트로크 */
function strokeTiltedEllipse(
  g: PIXI.Graphics,
  cx: number, cy: number, a: number, b: number, tilt: number,
) {
  const segs = 48;
  const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
  // start @ angle 0
  const x0 = a * cosT + cx;
  const y0 = a * sinT + cy;
  g.moveTo(x0, y0);
  for (let i = 1; i <= segs; i++) {
    const ang = (i / segs) * Math.PI * 2;
    const ex = Math.cos(ang) * a;
    const ey = Math.sin(ang) * b;
    g.lineTo(ex * cosT - ey * sinT + cx, ex * sinT + ey * cosT + cy);
  }
}

function drawWaterBoss(g: PIXI.Graphics, r: number, t: number) {
  // 팔레트
  const C_VOID    = 0x020617; // slate-950
  const C_DEEP    = 0x0c4a6e; // sky-900
  const C_BODY    = 0x075985; // sky-800
  const C_MID     = 0x0284c7; // sky-600
  const C_ACCENT  = 0x38bdf8; // sky-400
  const C_HILITE  = 0x7dd3fc; // sky-300
  const C_SOFT    = 0xbae6fd; // sky-200
  const C_FLASH   = 0xe0f2fe; // sky-100
  const C_WHITE   = 0xffffff;

  // ── 1. 파동 간섭 링 4개 (phase-shifted 확장, thin stroke) — halo 원 없음 ──
  const WAVE_CYCLE = 96;
  for (let ri = 0; ri < 4; ri++) {
    const phase = ((t + ri * 24) % WAVE_CYCLE) / WAVE_CYCLE;
    const rad = r * (0.82 + phase * 0.78);
    const alpha = (1 - phase) * 0.55;
    g.lineStyle(1.9 - phase * 1.3, C_ACCENT, alpha);
    g.drawCircle(0, 0, rad);
  }
  g.lineStyle(0);

  // ── 3. 대형 공명 shockwave (느린 주기, 두꺼운 링) ──
  const SHOCK_CYCLE = 118;
  const shockPhase = (t % SHOCK_CYCLE) / SHOCK_CYCLE;
  if (shockPhase > 0.03) {
    const rad = r * (0.9 + shockPhase * 1.05);
    const alpha = (1 - shockPhase) * 0.75;
    g.lineStyle(2.6 * (1 - shockPhase) + 0.6, C_SOFT, alpha);
    g.drawCircle(0, 0, rad);
    g.lineStyle(0);
  }

  // ── 4. 육각 컨테인먼트 프레임 (천천히 회전) ──
  const hexRot = t * 0.012;
  const hexR = r * 0.92;
  g.lineStyle(1.8, C_MID, 0.45);
  for (let i = 0; i <= 6; i++) {
    const a = hexRot + (i / 6) * Math.PI * 2;
    const hx = Math.cos(a) * hexR;
    const hy = Math.sin(a) * hexR;
    if (i === 0) g.moveTo(hx, hy); else g.lineTo(hx, hy);
  }
  g.lineStyle(0);
  // 모서리 노드 (6개)
  for (let i = 0; i < 6; i++) {
    const a = hexRot + (i / 6) * Math.PI * 2;
    const hx = Math.cos(a) * hexR;
    const hy = Math.sin(a) * hexR;
    g.beginFill(C_HILITE, 0.85);
    g.drawCircle(hx, hy, 2.4);
    g.endFill();
    g.beginFill(C_WHITE, 0.9);
    g.drawCircle(hx, hy, 1.1);
    g.endFill();
  }

  // ── 5. 두 개의 기울기 궤도 (atom 아이콘 모티프) ──
  const TILT = 0.52; // ~30°
  const ORB_A = r * 1.04;
  const ORB_B = r * 0.52;
  g.lineStyle(1.3, C_ACCENT, 0.55);
  strokeTiltedEllipse(g, 0, 0, ORB_A, ORB_B,  TILT);
  g.lineStyle(1.3, C_ACCENT, 0.55);
  strokeTiltedEllipse(g, 0, 0, ORB_A, ORB_B, -TILT);
  g.lineStyle(0);

  // ── 6. 궤도 위 전자 (반대 방향 회전, 글로우) ──
  const drawElectron = (phase: number, tilt: number, coreColor: number, sz: number) => {
    const ex = Math.cos(phase) * ORB_A;
    const ey = Math.sin(phase) * ORB_B;
    const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
    const rx = ex * cosT - ey * sinT;
    const ry = ex * sinT + ey * cosT;
    g.beginFill(C_ACCENT, 0.22); g.drawCircle(rx, ry, sz * 2.4); g.endFill();
    g.beginFill(C_ACCENT, 0.45); g.drawCircle(rx, ry, sz * 1.5); g.endFill();
    g.beginFill(coreColor, 0.95); g.drawCircle(rx, ry, sz);       g.endFill();
    g.beginFill(C_WHITE, 1.0);   g.drawCircle(rx - sz * 0.3, ry - sz * 0.3, sz * 0.45); g.endFill();
  };
  drawElectron( t * 0.042,                    TILT, C_FLASH, 2.9);
  drawElectron(-t * 0.036 + Math.PI * 0.65,  -TILT, C_SOFT,  2.6);

  // ── 7. 코어 (6겹 깊이감) ──
  const corePulse = 0.94 + Math.sin(t * 0.06) * 0.06;
  g.beginFill(C_VOID, 0.98); g.drawCircle(0, 0, r * 0.60);               g.endFill();
  g.beginFill(C_DEEP, 0.96); g.drawCircle(0, 0, r * 0.50 * corePulse);   g.endFill();
  g.beginFill(C_BODY, 0.92); g.drawCircle(0, 0, r * 0.40 * corePulse);   g.endFill();
  g.beginFill(C_MID,  0.88); g.drawCircle(0, 0, r * 0.28 * corePulse);   g.endFill();
  g.beginFill(C_HILITE, 0.92); g.drawCircle(0, 0, r * 0.16 * corePulse); g.endFill();
  g.beginFill(C_WHITE, 0.88); g.drawCircle(0, 0, r * 0.07 * corePulse);  g.endFill();

  // ── 8. 코어 관통 phase 라인 (회전) ──
  const phaseRot = t * 0.07;
  const phaseLen = r * 0.55;
  const pcos = Math.cos(phaseRot), psin = Math.sin(phaseRot);
  g.lineStyle(1.4, C_SOFT, 0.75);
  g.moveTo(-pcos * phaseLen, -psin * phaseLen);
  g.lineTo( pcos * phaseLen,  psin * phaseLen);
  // 수직 phase 라인 (dimmer)
  g.lineStyle(1.0, C_ACCENT, 0.4);
  g.moveTo( psin * phaseLen * 0.6, -pcos * phaseLen * 0.6);
  g.lineTo(-psin * phaseLen * 0.6,  pcos * phaseLen * 0.6);
  g.lineStyle(0);

  // ── 9. 계측 tick marks (4방향, 코어 바깥 링에 계기판 느낌) ──
  const TICK_IN = r * 0.62;
  const TICK_OUT = r * 0.72;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    const lw = i % 2 === 0 ? 1.8 : 1.0;
    const al = i % 2 === 0 ? 0.8 : 0.45;
    g.lineStyle(lw, C_SOFT, al);
    g.moveTo(c * TICK_IN, s * TICK_IN);
    g.lineTo(c * TICK_OUT, s * TICK_OUT);
  }
  g.lineStyle(0);
}

// ═══════════════════════════════════════════════════════════════════
// 2) 화염의 군주 (Fire Lord)
// ═══════════════════════════════════════════════════════════════════
function drawFireBoss(g: PIXI.Graphics, r: number, t: number) {
  // Plasma Star — Water와 같은 atom DNA(핵/궤도/프레임/tick), Fire 개성은
  // 12방 삼각 flame spike 실루엣 + 더 많은 코어층 + 더 빠른 애니.
  const C_DEEP  = 0x7f1d1d; // red-900
  const C_RED   = 0xb91c1c; // red-700
  const C_CRIM  = 0xdc2626; // red-600
  const C_FLAME = 0xea580c; // orange-600
  const C_ORNG  = 0xf97316; // orange-500
  const C_AMBER = 0xfbbf24; // amber-400
  const C_HOT   = 0xfde047; // yellow-300
  const C_PALE  = 0xfef3c7; // amber-50
  const C_WHITE = 0xffffff;

  // ── 1. Flame corona (확장 링만 — filled halo 제거해서 muddy bg 방지) ──
  const CORONA_CYCLE = 60;
  for (let ri = 0; ri < 4; ri++) {
    const phase = ((t + ri * 15) % CORONA_CYCLE) / CORONA_CYCLE;
    const rad = r * (0.88 + phase * 0.75);
    const alpha = (1 - phase) * 0.55;
    g.lineStyle(2.2 - phase * 1.4, C_FLAME, alpha);
    g.drawCircle(0, 0, rad);
  }
  g.lineStyle(0);

  // ── 3. 12방 플레임 스파이크 (실루엣 — 각진 sun-star) ──
  const spikes = 12;
  const baseR = r * 0.82;
  const halfBaseAng = Math.PI / spikes;
  for (let k = 0; k < spikes; k++) {
    const a = (k / spikes) * Math.PI * 2;
    const flicker = 0.78 + (Math.sin(t * 0.22 + k * 1.3) * 0.5 + 0.5) * 0.52;
    const tipR = r * (1.28 * flicker);
    // 3겹 nested 삼각형 (다크 없음, warm 밝기 단계)
    const bLx1 = Math.cos(a - halfBaseAng * 0.92) * baseR;
    const bLy1 = Math.sin(a - halfBaseAng * 0.92) * baseR;
    const bRx1 = Math.cos(a + halfBaseAng * 0.92) * baseR;
    const bRy1 = Math.sin(a + halfBaseAng * 0.92) * baseR;
    const tx1  = Math.cos(a) * tipR;
    const ty1  = Math.sin(a) * tipR;
    g.beginFill(C_RED, 0.95);
    g.drawPolygon([tx1, ty1, bLx1, bLy1, bRx1, bRy1]);
    g.endFill();
    const bLx2 = Math.cos(a - halfBaseAng * 0.72) * baseR * 1.01;
    const bLy2 = Math.sin(a - halfBaseAng * 0.72) * baseR * 1.01;
    const bRx2 = Math.cos(a + halfBaseAng * 0.72) * baseR * 1.01;
    const bRy2 = Math.sin(a + halfBaseAng * 0.72) * baseR * 1.01;
    const tx2  = Math.cos(a) * tipR * 0.82;
    const ty2  = Math.sin(a) * tipR * 0.82;
    g.beginFill(C_FLAME, 0.94);
    g.drawPolygon([tx2, ty2, bLx2, bLy2, bRx2, bRy2]);
    g.endFill();
    const bLx3 = Math.cos(a - halfBaseAng * 0.48) * baseR * 1.02;
    const bLy3 = Math.sin(a - halfBaseAng * 0.48) * baseR * 1.02;
    const bRx3 = Math.cos(a + halfBaseAng * 0.48) * baseR * 1.02;
    const bRy3 = Math.sin(a + halfBaseAng * 0.48) * baseR * 1.02;
    const tx3  = Math.cos(a) * tipR * 0.62;
    const ty3  = Math.sin(a) * tipR * 0.62;
    g.beginFill(C_AMBER, 0.9);
    g.drawPolygon([tx3, ty3, bLx3, bLy3, bRx3, bRy3]);
    g.endFill();
  }

  // ── 4. 12각 frame (Water의 hex frame 대응 — atom 규칙성) ──
  const frameRot = t * 0.015;
  const frameR = r * 0.82;
  g.lineStyle(1.8, C_AMBER, 0.5);
  for (let i = 0; i <= spikes; i++) {
    const a = frameRot + (i / spikes) * Math.PI * 2;
    const fx = Math.cos(a) * frameR;
    const fy = Math.sin(a) * frameR;
    if (i === 0) g.moveTo(fx, fy); else g.lineTo(fx, fy);
  }
  g.lineStyle(0);
  // 12개 정점 노드
  for (let i = 0; i < spikes; i++) {
    const a = frameRot + (i / spikes) * Math.PI * 2;
    const fx = Math.cos(a) * frameR;
    const fy = Math.sin(a) * frameR;
    g.beginFill(C_HOT, 0.9);
    g.drawCircle(fx, fy, 2.4);
    g.endFill();
    g.beginFill(C_WHITE, 0.92);
    g.drawCircle(fx, fy, 1.1);
    g.endFill();
  }

  // ── 5. 두 기울어진 궤도 (atom 공통) ──
  const TILT = 0.52;
  const ORB_A = r * 1.00;
  const ORB_B = r * 0.50;
  g.lineStyle(1.3, C_ORNG, 0.55);
  strokeTiltedEllipse(g, 0, 0, ORB_A, ORB_B,  TILT);
  g.lineStyle(1.3, C_ORNG, 0.55);
  strokeTiltedEllipse(g, 0, 0, ORB_A, ORB_B, -TILT);
  g.lineStyle(0);

  // ── 6. 궤도 전자 (Water보다 빠름 — fire 개성) ──
  const drawElectron = (phase: number, tilt: number, coreColor: number, sz: number) => {
    const ex = Math.cos(phase) * ORB_A;
    const ey = Math.sin(phase) * ORB_B;
    const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
    const rx = ex * cosT - ey * sinT;
    const ry = ex * sinT + ey * cosT;
    g.beginFill(C_ORNG,  0.25); g.drawCircle(rx, ry, sz * 2.4); g.endFill();
    g.beginFill(C_FLAME, 0.50); g.drawCircle(rx, ry, sz * 1.5); g.endFill();
    g.beginFill(coreColor, 0.95); g.drawCircle(rx, ry, sz);     g.endFill();
    g.beginFill(C_WHITE, 1);    g.drawCircle(rx - sz * 0.3, ry - sz * 0.3, sz * 0.45); g.endFill();
  };
  drawElectron( t * 0.058,                   TILT, C_PALE, 2.9);
  drawElectron(-t * 0.050 + Math.PI * 0.65, -TILT, C_HOT,  2.6);

  // ── 7. 코어 (9겹 warm — Water의 6겹보다 더 뜨거운 느낌) ──
  const corePulse = 0.94 + Math.sin(t * 0.13) * 0.06;
  g.beginFill(C_DEEP,  0.98); g.drawCircle(0, 0, r * 0.64);                g.endFill();
  g.beginFill(C_RED,   0.96); g.drawCircle(0, 0, r * 0.54 * corePulse);    g.endFill();
  g.beginFill(C_CRIM,  0.94); g.drawCircle(0, 0, r * 0.45 * corePulse);    g.endFill();
  g.beginFill(C_FLAME, 0.92); g.drawCircle(0, 0, r * 0.37 * corePulse);    g.endFill();
  g.beginFill(C_ORNG,  0.90); g.drawCircle(0, 0, r * 0.29 * corePulse);    g.endFill();
  g.beginFill(C_AMBER, 0.92); g.drawCircle(0, 0, r * 0.21 * corePulse);    g.endFill();
  g.beginFill(C_HOT,   0.94); g.drawCircle(0, 0, r * 0.14 * corePulse);    g.endFill();
  g.beginFill(C_PALE,  0.95); g.drawCircle(0, 0, r * 0.08 * corePulse);    g.endFill();
  g.beginFill(C_WHITE, 0.92); g.drawCircle(0, 0, r * 0.04 * corePulse);    g.endFill();

  // ── 8. 내부 회전 flame arc (Water의 phase line 대체 — 2개 호 역회전) ──
  const arcRot = t * 0.09;
  g.lineStyle(2.2, C_AMBER, 0.8);
  g.arc(0, 0, r * 0.44, arcRot, arcRot + Math.PI * 1.1);
  g.lineStyle(1.2, C_HOT, 0.95);
  g.arc(0, 0, r * 0.44, arcRot + 0.04, arcRot + 0.04 + Math.PI * 1.05);
  g.lineStyle(0);
  g.lineStyle(1.8, C_ORNG, 0.75);
  g.arc(0, 0, r * 0.30, -arcRot * 1.3 + 1.5, -arcRot * 1.3 + 1.5 + Math.PI * 0.9);
  g.lineStyle(1.0, C_PALE, 0.92);
  g.arc(0, 0, r * 0.30, -arcRot * 1.3 + 1.54, -arcRot * 1.3 + 1.54 + Math.PI * 0.85);
  g.lineStyle(0);

  // ── 9. 계측 tick 8방향 (Water와 동일 규칙) ──
  const TICK_IN = r * 0.68;
  const TICK_OUT = r * 0.78;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    const lw = i % 2 === 0 ? 1.8 : 1.0;
    const al = i % 2 === 0 ? 0.8 : 0.45;
    g.lineStyle(lw, C_PALE, al);
    g.moveTo(c * TICK_IN, s * TICK_IN);
    g.lineTo(c * TICK_OUT, s * TICK_OUT);
  }
  g.lineStyle(0);
}

// ═══════════════════════════════════════════════════════════════════
// 3) Planet Earth (흙 속성) — atom DNA, 지구본 컨셉 (구체+대륙+위경도+달)
// ═══════════════════════════════════════════════════════════════════
function drawEarthBoss(g: PIXI.Graphics, r: number, t: number) {
  // 팔레트 (Earth element — 구체 색 + 위경도선만, 내부 디테일 없음)
  const C_ATMOS_LIT = 0x92400e; // 대기 rim warm (amber)
  const C_ATMOS     = 0x451a03; // 대기 glow 갈색
  const C_SOIL_DK   = 0x1c0a03; // 흙 가장 깊은
  const C_SOIL      = 0x451a03; // 흙 기본 (base)
  const C_SOIL_LT   = 0x78350f; // 빛 받는 흙
  const C_WOOD      = 0x92400e; // 나무 갈색
  const C_CLAY      = 0xb45309; // 점토
  const C_ICE       = 0xe0f2fe; // 극지
  const C_GRID      = 0xfde68a; // 위·경도선
  const C_WHITE     = 0xffffff;

  const TILT = 0.40; // ~23° 자전축 기울기

  // 자전 위상 (시간에 따른 경도 회전)
  const rotPhase = t * 0.006;

  // ── 1. 대기 atmosphere 외곽 링 (stroked, muddy 방지) ──
  for (let ri = 0; ri < 3; ri++) {
    const rad = r * (1.10 + ri * 0.16);
    const alpha = (0.45 - ri * 0.12) * (0.85 + Math.sin(t * 0.03 + ri) * 0.1);
    g.lineStyle(2.2 - ri * 0.5, C_ATMOS_LIT, alpha);
    g.drawCircle(0, 0, rad);
  }
  g.lineStyle(0);

  // ── 2. 구체 본체 (흙 base) + 빛 받는 면 shading — 내부 디테일 없음, 대기 halo 없음 ──
  g.beginFill(C_SOIL_DK, 0.98);
  g.drawCircle(0, 0, r);
  g.endFill();
  // 태양광 shading (왼쪽 상단이 밝은 흙)
  g.beginFill(C_SOIL, 0.95);
  g.drawCircle(-r * 0.10, -r * 0.12, r * 0.92);
  g.endFill();
  g.beginFill(C_SOIL_LT, 0.80);
  g.drawCircle(-r * 0.22, -r * 0.26, r * 0.72);
  g.endFill();
  g.beginFill(C_WOOD, 0.55);
  g.drawCircle(-r * 0.32, -r * 0.36, r * 0.48);
  g.endFill();
  g.beginFill(C_CLAY, 0.25);
  g.drawCircle(-r * 0.38, -r * 0.42, r * 0.25);
  g.endFill();

  // ── 5. 위·경도선 (기울어진 grid — 자전축 TILT 반영) ──
  const cosT = Math.cos(TILT), sinT = Math.sin(TILT);
  // 위도선 5개 (수평 타원, 크기 다름)
  for (let li = 0; li < 5; li++) {
    const latFrac = (li - 2) / 2.4; // -0.83 ~ +0.83
    const latY = latFrac * r * 0.88;
    const latA = r * Math.sqrt(Math.max(0, 1 - latFrac * latFrac)) * 0.95;
    const latB = latA * 0.20; // 타원 납작 (구 정면 투영)
    // 기울어진 위도: 타원 center/회전
    const cx = latY * sinT * (-1);
    const cy = latY * cosT;
    g.lineStyle(1.0, C_GRID, 0.35);
    strokeTiltedEllipse(g, cx, cy, latA, latB, TILT);
    g.lineStyle(0);
  }
  // 경도선 6개 (수직 타원, 회전 phase에 따라 shift)
  for (let lo = 0; lo < 6; lo++) {
    const lonPhase = rotPhase + (lo / 6) * Math.PI * 2;
    const visibleScale = Math.cos(lonPhase); // -1 뒷면 ~ +1 정면
    if (visibleScale < 0) continue; // 뒤쪽은 그리지 않음
    const lonA = r * 0.96 * Math.abs(visibleScale);
    const lonB = r * 0.96;
    // 경도는 자전축에 수직하게 기울어진 타원 (TILT 적용)
    g.lineStyle(1.0, C_GRID, 0.3 + visibleScale * 0.15);
    strokeTiltedEllipse(g, 0, 0, lonA, lonB, TILT + Math.PI / 2);
    g.lineStyle(0);
  }

  // 극지/자전축/공전 달 전부 제거 — 구체 + 위경도만.
}

// ═══════════════════════════════════════════════════════════════════
// 4) Quantum Atom (전기) — GlowFilter bloom + 궤도 3D 폐색
// ═══════════════════════════════════════════════════════════════════

/** 타원 궤도의 "앞 반" 또는 "뒤 반"만 스트로크 (3D 폐색용).
 *  half='back' = sin(φ) < 0 쪽, half='front' = sin(φ) > 0 쪽.
 *  파라미터 φ에서 sin이 음수인 구간 = 뷰어 기준 뒤쪽 (z<0). */
function strokeOrbitHalf(
  g: PIXI.Graphics, aR: number, bR: number, tilt: number,
  rotPhase: number, half: 'front' | 'back',
  color: number, thickness: number, alpha: number,
) {
  const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
  const segs = 48;
  g.lineStyle(thickness, color, alpha);
  // 파라미터 범위: back = π ~ 2π, front = 0 ~ π
  const start = half === 'back' ? Math.PI : 0;
  const end   = half === 'back' ? Math.PI * 2 : Math.PI;
  for (let i = 0; i <= segs; i++) {
    const phi = start + (end - start) * (i / segs);
    const ang = phi + rotPhase;
    const ex = Math.cos(ang) * aR;
    const ey = Math.sin(ang) * bR;
    const x = ex * cosT - ey * sinT;
    const y = ex * sinT + ey * cosT;
    // 하지만 sin(ang+rotPhase) 기준이 아니라 sin(phi) 기준으로 앞/뒤 결정해야 z 일관됨
    // 실제로 3D로는 phi가 파라미터. rotPhase 적용 후 sin(ang) 기준이면 회전 따라 z 바뀜.
    // 궤도가 회전해도 시점에서 보는 앞/뒤가 바뀌면 자연스러움.
    // → 실제 그릴 때 sin(ang)로 판단해야 맞음. loop 다시 짜자.
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.lineStyle(0);
}

/** 궤도 반쪽 스트로크 — sin(ang) 기준으로 앞/뒤 결정 (회전 시점 고정). */
function strokeOrbitSplitByZ(
  g: PIXI.Graphics, aR: number, bR: number, tilt: number,
  rotPhase: number, drawBack: boolean,
  color: number, thickness: number, alpha: number,
) {
  void strokeOrbitHalf; // 사용 안함
  const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
  const segs = 72;
  let inSegment = false;
  g.lineStyle(thickness, color, alpha);
  for (let i = 0; i <= segs; i++) {
    const ang = (i / segs) * Math.PI * 2 + rotPhase;
    // z depth: 타원면이 X축 중심 tilt 회전됐다고 가정 시 z = sin(ang) * depth
    // 여기서는 단순화 — sin(ang) < 0 이면 뒤쪽으로 판정
    const isBack = Math.sin(ang) < 0;
    if (isBack !== drawBack) {
      inSegment = false;
      continue;
    }
    const ex = Math.cos(ang) * aR;
    const ey = Math.sin(ang) * bR;
    const x = ex * cosT - ey * sinT;
    const y = ex * sinT + ey * cosT;
    if (!inSegment) { g.moveTo(x, y); inSegment = true; }
    else g.lineTo(x, y);
  }
  g.lineStyle(0);
}

function drawElectricBoss(g: PIXI.Graphics, r: number, t: number, _glow?: PIXI.Graphics) {
  void _glow;
  // 팔레트 — 매우 채도 높은 bright 색상 (dark bg에서 뚜렷하게 pop)
  const C_CORE_DK  = 0x0c0a25; // core 뒤 dark violet-blue
  const C_HALO_BLUE = 0x1e3a8a; // outer soft blue halo
  const C_CYAN_DK  = 0x0369a1;
  const C_CYAN     = 0x06b6d4;
  const C_CYAN_LT  = 0x22d3ee;
  const C_ICE      = 0x67e8f9;
  const C_PALE     = 0xa5f3fc;
  const C_AMBER_DK = 0xb45309;
  const C_AMBER    = 0xf59e0b;
  const C_ORANGE   = 0xfb923c;
  const C_GOLD     = 0xfbbf24;
  const C_SUN      = 0xfde047;
  const C_VIOLET   = 0x7c3aed;
  const C_LAVENDER = 0xa78bfa;
  const C_LILAC    = 0xc4b5fd;
  const C_WHITE    = 0xffffff;

  // 궤도 정의 (5개 — 각자 고유 tilt/회전/색/두께)
  type Orbit = {
    aR: number; bR: number; tilt: number; rotPhase: number;
    colorBack: number; colorFront: number; thickBack: number; thickFront: number;
    alphaBack: number; alphaFront: number;
  };
  const orbits: Orbit[] = [
    // 메인 amber (수평, 가장 prominent)
    { aR: r * 1.42, bR: r * 0.58, tilt: 0.08, rotPhase: t * 0.032,
      colorBack: C_AMBER_DK, colorFront: C_GOLD, thickBack: 4.5, thickFront: 5.5,
      alphaBack: 0.45, alphaFront: 1.0 },
    // warm 보조 (반대 방향, 작음)
    { aR: r * 1.14, bR: r * 0.40, tilt: -0.42, rotPhase: -t * 0.046,
      colorBack: C_AMBER, colorFront: C_ORANGE, thickBack: 2.2, thickFront: 3.2,
      alphaBack: 0.40, alphaFront: 0.95 },
    // cyan (steep tilt)
    { aR: r * 1.32, bR: r * 0.30, tilt: 0.70, rotPhase: t * 0.050,
      colorBack: C_CYAN_DK, colorFront: C_CYAN_LT, thickBack: 2.0, thickFront: 3.0,
      alphaBack: 0.40, alphaFront: 0.95 },
    // violet (steepest)
    { aR: r * 1.25, bR: r * 0.24, tilt: -0.95, rotPhase: -t * 0.042,
      colorBack: C_VIOLET, colorFront: C_LILAC, thickBack: 2.0, thickFront: 3.0,
      alphaBack: 0.35, alphaFront: 0.95 },
    // 수직
    { aR: r * 1.10, bR: r * 0.18, tilt: Math.PI / 2 + 0.15, rotPhase: t * 0.060,
      colorBack: C_CYAN, colorFront: C_ICE, thickBack: 1.6, thickFront: 2.4,
      alphaBack: 0.35, alphaFront: 0.90 },
  ];

  // ══════════════════════════════════════════════
  // 그리기 순서 (3D 폐색):
  // 1) 외곽 soft halo  →  2) 궤도 BACK 반  →  3) 코어 bloom  →
  // 4) 궤도 FRONT 반  →  5) 전자 (z-sort)  →  6) cross gleam + sparkle
  // ══════════════════════════════════════════════

  // ── 1. 궤도 BACK 반쪽 (코어 뒤로 들어감 — dim, halo 원 없음 GlowFilter가 처리) ──
  for (const o of orbits) {
    // outer thick dim
    strokeOrbitSplitByZ(g, o.aR, o.bR, o.tilt, o.rotPhase, true,
      o.colorBack, o.thickBack * 1.6, o.alphaBack * 0.7);
    // inner line
    strokeOrbitSplitByZ(g, o.aR, o.bR, o.tilt, o.rotPhase, true,
      o.colorBack, o.thickBack * 0.6, o.alphaBack);
  }

  // ── 3. 코어 bloom (가운데 bright, 뒤쪽 궤도를 가림) ──
  const corePulse = 0.92 + Math.sin(t * 0.20) * 0.08;
  g.beginFill(C_CORE_DK,   0.98); g.drawCircle(0, 0, r * 0.50); g.endFill();
  g.beginFill(C_VIOLET,    0.88); g.drawCircle(0, 0, r * 0.42 * corePulse); g.endFill();
  g.beginFill(C_LAVENDER,  0.88); g.drawCircle(0, 0, r * 0.34 * corePulse); g.endFill();
  g.beginFill(C_LILAC,     0.92); g.drawCircle(0, 0, r * 0.27 * corePulse); g.endFill();
  g.beginFill(C_ICE,       0.92); g.drawCircle(0, 0, r * 0.20 * corePulse); g.endFill();
  g.beginFill(C_PALE,      0.95); g.drawCircle(0, 0, r * 0.15 * corePulse); g.endFill();
  g.beginFill(C_WHITE,     0.92); g.drawCircle(0, 0, r * 0.10 * corePulse); g.endFill();
  g.beginFill(C_WHITE,     1.00); g.drawCircle(0, 0, r * 0.05); g.endFill();

  // ── 4. 궤도 FRONT 반쪽 (코어 위로 올라옴 — bright, motion blur trail) ──
  for (const o of orbits) {
    // motion blur: 여러 offset copy
    for (let m = 0; m < 3; m++) {
      const rotOff = o.rotPhase - m * 0.06;
      const a = o.alphaFront * (1 - m * 0.28);
      const th = o.thickFront * (1 - m * 0.15);
      strokeOrbitSplitByZ(g, o.aR, o.bR, o.tilt, rotOff, false,
        o.colorFront, th * 1.7, a * 0.55); // outer glow
      strokeOrbitSplitByZ(g, o.aR, o.bR, o.tilt, rotOff, false,
        o.colorFront, th * 0.8, a * 0.95); // mid
      strokeOrbitSplitByZ(g, o.aR, o.bR, o.tilt, rotOff, false,
        C_WHITE, th * 0.3, a); // core white line
    }
  }

  // ── 5. 전자 (z-sort — 앞쪽이면 코어 위, 뒤쪽이면 코어 뒤에 이미 그려져야 함) ──
  const drawElectronZ = (aR: number, bR: number, tilt: number, phase: number, color: number, sz: number) => {
    const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
    // z-depth: sin(phase) < 0 이면 뒤쪽. 뒤쪽 전자는 dim+작게, 앞쪽은 밝고 크게.
    const isBack = Math.sin(phase) < 0;
    const ex = Math.cos(phase) * aR;
    const ey = Math.sin(phase) * bR;
    const x = ex * cosT - ey * sinT;
    const y = ex * sinT + ey * cosT;
    const depthAlpha = isBack ? 0.35 : 1.0;
    const depthSz    = isBack ? 0.65 : 1.0;
    // head
    g.beginFill(color, 0.45 * depthAlpha); g.drawCircle(x, y, sz * depthSz * 2.8); g.endFill();
    g.beginFill(color, 0.85 * depthAlpha); g.drawCircle(x, y, sz * depthSz * 1.6); g.endFill();
    g.beginFill(C_WHITE, 1 * depthAlpha); g.drawCircle(x, y, sz * depthSz); g.endFill();
    // 앞쪽 전자만 trail (뒤에서는 눈에 안띔)
    if (!isBack) {
      for (let i = 4; i >= 1; i--) {
        const p = phase - i * 0.10;
        if (Math.sin(p) < 0) continue; // trail도 뒤쪽 넘어가면 skip
        const tex = Math.cos(p) * aR;
        const tey = Math.sin(p) * bR;
        const tx = tex * cosT - tey * sinT;
        const ty = tex * sinT + tey * cosT;
        const fade = (5 - i) / 5;
        g.beginFill(color, 0.4 * fade * fade); g.drawCircle(tx, ty, sz * fade * 1.5); g.endFill();
      }
    }
  };
  drawElectronZ(r * 1.42, r * 0.58,  0.08,            t * 0.08,              C_SUN,     3.6);
  drawElectronZ(r * 1.32, r * 0.30,  0.70,            t * 0.10  + 0.4,       C_CYAN_LT, 2.9);
  drawElectronZ(r * 1.25, r * 0.24, -0.95,           -t * 0.09  + 1.2,       C_LILAC,   2.8);
  drawElectronZ(r * 1.14, r * 0.40, -0.42,           -t * 0.095 + 2.3,       C_GOLD,    2.7);

  // ── 6. Star cross gleam (코어 정면 위, 얇은 빛살) ──
  const gleamLen = r * (1.45 + Math.sin(t * 0.1) * 0.10);
  const gleamGlint = 0.7 + Math.sin(t * 0.25) * 0.3;
  for (let d = 0; d < 4; d++) {
    const a = d * Math.PI / 2 + t * 0.008;
    const cosA = Math.cos(a), sinA = Math.sin(a);
    const perpX = -sinA, perpY = cosA;
    g.beginFill(C_LILAC, 0.60 * gleamGlint);
    g.drawPolygon([
      cosA * gleamLen,   sinA * gleamLen,
      perpX * r * 0.045, perpY * r * 0.045,
      -cosA * gleamLen, -sinA * gleamLen,
      -perpX * r * 0.045, -perpY * r * 0.045,
    ]);
    g.endFill();
    g.beginFill(C_WHITE, 0.95 * gleamGlint);
    g.drawPolygon([
      cosA * gleamLen * 0.92,   sinA * gleamLen * 0.92,
      perpX * r * 0.013,         perpY * r * 0.013,
      -cosA * gleamLen * 0.92, -sinA * gleamLen * 0.92,
      -perpX * r * 0.013,        -perpY * r * 0.013,
    ]);
    g.endFill();
  }

  // ── 7. 떠다니는 sparkle (작은 bright 점, flicker) ──
  for (let k = 0; k < 14; k++) {
    const seedA = (k * 137.508) % 6.283;
    const seedR = r * (0.7 + ((k * 23) % 11) * 0.05);
    const drift = t * 0.012 + k * 0.4;
    const px = Math.cos(seedA + Math.sin(drift) * 0.25) * seedR;
    const py = Math.sin(seedA + Math.sin(drift) * 0.25) * seedR;
    const flick = Math.sin(t * 0.15 + k * 1.2);
    if (flick < 0.1) continue;
    const intensity = (flick - 0.1) / 0.9;
    g.beginFill(C_CYAN_LT, 0.7 * intensity); g.drawCircle(px, py, 2.4 * intensity); g.endFill();
    g.beginFill(C_WHITE,   intensity);        g.drawCircle(px, py, 1.1 * intensity); g.endFill();
  }
}

// ═══════════════════════════════════════════════════════════════════
// 5) Photon Core (빛 속성) — warm photonic orb, swirling wisps + GlowFilter
// ═══════════════════════════════════════════════════════════════════
function drawLightBoss(g: PIXI.Graphics, r: number, t: number) {
  // 팔레트 — warm photonic (reference 이미지의 tone)
  const C_DEEP_WARM = 0x7c2d12; // orange-900
  const C_CRIM      = 0x991b1b; // red-800 (core tinge)
  const C_RED       = 0xdc2626;
  const C_ORANGE    = 0xea580c;
  const C_AMBER_DK  = 0xb45309;
  const C_AMBER     = 0xf59e0b;
  const C_GOLD      = 0xfbbf24;
  const C_YELLOW    = 0xfde047;
  const C_CREAM     = 0xfef9c3;
  const C_PALE      = 0xfffbeb;
  const C_WHITE     = 0xffffff;

  // Wisp 정의 — 서로 다른 tilt/회전/색/arc 범위의 소용돌이 호
  type Wisp = {
    aR: number; bR: number; tilt: number; rotPhase: number;
    arcStart: number; arcEnd: number;
    colorOuter: number; colorCore: number; thick: number; alpha: number;
  };
  const wisps: Wisp[] = [
    { aR: r * 1.18, bR: r * 0.52, tilt:  0.10, rotPhase:  t * 0.028,
      arcStart: 0.4, arcEnd: 5.3, colorOuter: C_AMBER,  colorCore: C_YELLOW, thick: 5.5, alpha: 0.95 },
    { aR: r * 1.00, bR: r * 0.42, tilt: -0.35, rotPhase: -t * 0.035,
      arcStart: 0.9, arcEnd: 5.6, colorOuter: C_GOLD,   colorCore: C_CREAM,  thick: 4.5, alpha: 1.00 },
    { aR: r * 0.92, bR: r * 0.56, tilt:  0.62, rotPhase:  t * 0.042,
      arcStart: -0.4, arcEnd: 4.3, colorOuter: C_ORANGE, colorCore: C_GOLD,   thick: 4.0, alpha: 0.90 },
    { aR: r * 0.80, bR: r * 0.32, tilt: -0.80, rotPhase: -t * 0.048,
      arcStart: 0.2, arcEnd: 5.0,  colorOuter: C_AMBER,  colorCore: C_YELLOW, thick: 3.5, alpha: 1.00 },
    { aR: r * 1.28, bR: r * 0.36, tilt:  0.95, rotPhase:  t * 0.022,
      arcStart: 0.3, arcEnd: 5.9,  colorOuter: C_RED,    colorCore: C_ORANGE, thick: 3.0, alpha: 0.75 },
    { aR: r * 0.72, bR: r * 0.62, tilt:  1.25, rotPhase: -t * 0.055,
      arcStart: 0.5, arcEnd: 4.6,  colorOuter: C_YELLOW, colorCore: C_CREAM,  thick: 2.8, alpha: 0.90 },
    { aR: r * 1.08, bR: r * 0.28, tilt: -1.15, rotPhase:  t * 0.038,
      arcStart: 0.7, arcEnd: 5.2,  colorOuter: C_AMBER,  colorCore: C_WHITE,  thick: 2.6, alpha: 0.85 },
  ];

  // Wisp 한쪽 반 (back/front) 그리기 — 길이에 따라 taper envelope 적용
  const drawWisp = (w: Wisp, drawBack: boolean) => {
    const cosT = Math.cos(w.tilt), sinT = Math.sin(w.tilt);
    const segs = 48;
    const span = w.arcEnd - w.arcStart;
    for (let i = 0; i < segs; i++) {
      const s1 = i / segs;
      const s2 = (i + 1) / segs;
      const ang1 = w.arcStart + s1 * span + w.rotPhase;
      const ang2 = w.arcStart + s2 * span + w.rotPhase;
      const avgSin = (Math.sin(ang1) + Math.sin(ang2)) * 0.5;
      const isBack = avgSin < 0;
      if (isBack !== drawBack) continue;
      // taper envelope: sin(πs) — 양 끝 0, 가운데 1
      const env = Math.sin(s1 * Math.PI);
      if (env < 0.05) continue;
      const thickness = w.thick * env;
      const alpha = w.alpha * env;
      const depthFade = isBack ? 0.45 : 1.0;
      const ex1 = Math.cos(ang1) * w.aR;
      const ey1 = Math.sin(ang1) * w.bR;
      const ex2 = Math.cos(ang2) * w.aR;
      const ey2 = Math.sin(ang2) * w.bR;
      const x1 = ex1 * cosT - ey1 * sinT;
      const y1 = ex1 * sinT + ey1 * cosT;
      const x2 = ex2 * cosT - ey2 * sinT;
      const y2 = ex2 * sinT + ey2 * cosT;
      // outer warm glow
      g.lineStyle(thickness * 2.0, w.colorOuter, alpha * 0.4 * depthFade);
      g.moveTo(x1, y1); g.lineTo(x2, y2);
      // mid
      g.lineStyle(thickness * 1.0, w.colorOuter, alpha * 0.95 * depthFade);
      g.moveTo(x1, y1); g.lineTo(x2, y2);
      // core bright line
      g.lineStyle(thickness * 0.35, w.colorCore, alpha * depthFade);
      g.moveTo(x1, y1); g.lineTo(x2, y2);
      // 앞쪽만 white-hot 중심 thread
      if (!isBack) {
        g.lineStyle(thickness * 0.12, C_WHITE, alpha * 0.95);
        g.moveTo(x1, y1); g.lineTo(x2, y2);
      }
    }
    g.lineStyle(0);
  };

  // ══════════════════════════════════════════════
  // 그리기 순서 (3D 폐색):
  // 1) Wisp BACK 반 → 2) 코어 bloom → 3) Wisp FRONT 반 → 4) photon rays → 5) sparkles
  // (외곽 filled halo 없음 — GlowFilter가 bloom 처리)
  // ══════════════════════════════════════════════

  // 1. BACK 반쪽 wisps
  for (const w of wisps) drawWisp(w, true);

  // 2. 코어 bloom (warm gradient, 레퍼런스의 reddish-pink 중심 포함)
  const corePulse = 0.92 + Math.sin(t * 0.14) * 0.08;
  g.beginFill(C_DEEP_WARM, 0.95); g.drawCircle(0, 0, r * 0.44); g.endFill();
  g.beginFill(C_CRIM,      0.90); g.drawCircle(0, 0, r * 0.36 * corePulse); g.endFill();
  g.beginFill(C_RED,       0.85); g.drawCircle(0, 0, r * 0.28 * corePulse); g.endFill();
  g.beginFill(C_ORANGE,    0.88); g.drawCircle(0, 0, r * 0.22 * corePulse); g.endFill();
  g.beginFill(C_AMBER_DK,  0.70); g.drawCircle(0, 0, r * 0.18 * corePulse); g.endFill();
  g.beginFill(C_AMBER,     0.90); g.drawCircle(0, 0, r * 0.14 * corePulse); g.endFill();
  g.beginFill(C_GOLD,      0.94); g.drawCircle(0, 0, r * 0.10 * corePulse); g.endFill();
  g.beginFill(C_YELLOW,    0.95); g.drawCircle(0, 0, r * 0.07 * corePulse); g.endFill();
  g.beginFill(C_CREAM,     0.96); g.drawCircle(0, 0, r * 0.045 * corePulse); g.endFill();
  g.beginFill(C_WHITE,     1.00); g.drawCircle(0, 0, r * 0.025); g.endFill();

  // 3. FRONT 반쪽 wisps (밝음, motion blur — 2단 offset)
  for (const w of wisps) {
    drawWisp(w, false);
    // motion blur trail — 궤도 rot phase 살짝 뒤로 이동 + alpha 감소
    const trail = { ...w, rotPhase: w.rotPhase - 0.06, alpha: w.alpha * 0.6 };
    drawWisp(trail, false);
    const trail2 = { ...w, rotPhase: w.rotPhase - 0.12, alpha: w.alpha * 0.35 };
    drawWisp(trail2, false);
  }

  // 4. Photon rays — 방사형 얇은 빛살 (길이 flicker)
  const rayCount = 14;
  for (let i = 0; i < rayCount; i++) {
    const a = (i / rayCount) * Math.PI * 2 + t * 0.010;
    const flicker = 0.4 + Math.sin(t * 0.17 + i * 1.5) * 0.6;
    const startR = r * 0.45;
    const endR = r * (1.15 + flicker * 0.30);
    const cosA = Math.cos(a), sinA = Math.sin(a);
    // 외곽 amber glow
    g.lineStyle(3.0, C_AMBER, 0.25 * flicker);
    g.moveTo(cosA * startR, sinA * startR);
    g.lineTo(cosA * endR, sinA * endR);
    // 중간 gold
    g.lineStyle(1.4, C_GOLD, 0.65 * flicker);
    g.moveTo(cosA * startR, sinA * startR);
    g.lineTo(cosA * endR, sinA * endR);
    // 코어 white
    g.lineStyle(0.5, C_WHITE, flicker);
    g.moveTo(cosA * startR, sinA * startR);
    g.lineTo(cosA * endR, sinA * endR);
  }
  g.lineStyle(0);

  // 5. Sparkle 입자 (밝은 photon flecks, flicker)
  for (let k = 0; k < 18; k++) {
    const seedA = (k * 137.508) % 6.283;
    const seedR = r * (0.55 + ((k * 23) % 11) * 0.06);
    const drift = t * 0.014 + k * 0.4;
    const px = Math.cos(seedA + Math.sin(drift) * 0.3) * seedR;
    const py = Math.sin(seedA + Math.sin(drift) * 0.3) * seedR;
    const flick = Math.sin(t * 0.18 + k * 1.3);
    if (flick < 0.15) continue;
    const intensity = (flick - 0.15) / 0.85;
    g.beginFill(C_GOLD,   0.75 * intensity); g.drawCircle(px, py, 2.4 * intensity); g.endFill();
    g.beginFill(C_YELLOW, 0.95 * intensity); g.drawCircle(px, py, 1.4 * intensity); g.endFill();
    g.beginFill(C_WHITE,  intensity);        g.drawCircle(px, py, 0.7 * intensity); g.endFill();
  }
  void C_PALE;
}

// ═══════════════════════════════════════════════════════════════════
// 6) 심연의 군주 (Dark Lord)
// ═══════════════════════════════════════════════════════════════════
function drawDarkBoss(g: PIXI.Graphics, r: number, t: number) {
  // ── 어둠 halo (5겹) ──
  g.beginFill(0x020010, 0.32);
  g.drawCircle(0, 0, r * 1.7);
  g.endFill();
  g.beginFill(0x0a0416, 0.30);
  g.drawCircle(0, 0, r * 1.45);
  g.endFill();
  g.beginFill(0x1e1b4b, 0.28);
  g.drawCircle(0, 0, r * 1.22);
  g.endFill();
  g.beginFill(0x3b0764, 0.22);
  g.drawCircle(0, 0, r * 1.05);
  g.endFill();

  // ── 그림자 연기 입자 (불규칙, 회전) ──
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2 + t * 0.018;
    const sr = r * (1.15 + ((k * 7) % 5) * 0.06) + Math.sin(t * 0.06 + k) * 5;
    const sx = Math.cos(a) * sr;
    const sy = Math.sin(a) * sr;
    g.beginFill(0x020010, 0.5);
    g.drawCircle(sx, sy, 6 + (k % 3) * 1.5);
    g.endFill();
    g.beginFill(0x3b0764, 0.3);
    g.drawCircle(sx, sy, 10 + (k % 3) * 2);
    g.endFill();
  }

  // ── 하단 촉수 8개 (bezier, 휘어짐) ──
  const tentacles = 8;
  for (let i = 0; i < tentacles; i++) {
    const baseA = Math.PI * 0.1 + (i / (tentacles - 1)) * Math.PI * 0.8;  // 하단 반원
    const sway = Math.sin(t * 0.05 + i * 1.2) * 0.22;
    const aRoot = baseA + sway;
    const rootX = Math.cos(aRoot) * r * 0.82;
    const rootY = Math.sin(aRoot) * r * 0.82;
    const lenMul = 0.52 + Math.sin(t * 0.08 + i) * 0.14;
    const tipX = rootX + Math.cos(aRoot + sway * 0.5) * r * lenMul;
    const tipY = rootY + Math.sin(aRoot + sway * 0.5) * r * lenMul + r * 0.1;
    const midX = (rootX + tipX) * 0.5 + Math.sin(t * 0.07 + i * 2) * 7;
    const midY = (rootY + tipY) * 0.5 + r * 0.1;

    // 촉수 — 여러 구간으로 두께 타퍼
    const segs = 10;
    let prevX = rootX, prevY = rootY;
    for (let s = 1; s <= segs; s++) {
      const tt = s / segs;
      const mt = 1 - tt;
      const bx = mt * mt * rootX + 2 * mt * tt * midX + tt * tt * tipX;
      const by = mt * mt * rootY + 2 * mt * tt * midY + tt * tt * tipY;
      const thick = r * 0.13 * (1 - tt * 0.88);
      // 외곽
      g.lineStyle(thick * 2.4, 0x020010, 0.95);
      g.moveTo(prevX, prevY);
      g.lineTo(bx, by);
      // 중간
      g.lineStyle(thick * 1.5, 0x1e1b4b, 0.85);
      g.moveTo(prevX, prevY);
      g.lineTo(bx, by);
      // 보라 하이라이트
      g.lineStyle(thick * 0.6, 0x581c87, 0.75);
      g.moveTo(prevX, prevY);
      g.lineTo(bx, by);
      prevX = bx;
      prevY = by;
    }
    g.lineStyle(0);
    // 촉수 끝 (suction cup)
    g.beginFill(0x3b0764, 0.92);
    g.drawCircle(tipX, tipY, 3);
    g.endFill();
    g.beginFill(0x7e22ce, 0.78);
    g.drawCircle(tipX, tipY, 1.5);
    g.endFill();
  }

  // ── 본체 — 불규칙 비대칭 덩어리 (고정 seed + 느린 진동) ──
  const massPts: Array<{ x: number; y: number }> = [];
  const massSegs = 28;
  const shadowSeed = [0.88, 1.05, 0.92, 1.08, 0.85, 1.1, 0.9, 1.04, 0.95, 1.02, 0.88, 1.06, 0.9, 1.08, 0.86, 1.12, 0.92, 1.04, 0.98, 0.88, 1.06, 0.94, 1.0, 0.9, 1.02, 0.87, 1.05, 0.93];
  for (let i = 0; i < massSegs; i++) {
    const a = (i / massSegs) * Math.PI * 2 - Math.PI / 2;
    const baseShape = Math.sin(a) > 0 ? 0.98 : (0.75 + 0.25 * (1 + Math.sin(a)) / 2);  // 하단 둥글게 상단 뾰족
    const jitter = shadowSeed[i] || 1;
    const wobble = 1 + Math.sin(a * 3 + t * 0.04) * 0.035 + Math.sin(a * 7 - t * 0.06) * 0.02;
    const rr = r * baseShape * jitter * wobble;
    massPts.push({ x: Math.cos(a) * rr, y: Math.sin(a) * rr });
  }

  // 5겹 본체
  g.beginFill(0x020010, 0.98);
  g.drawPolygon(polygonPoints(massPts));
  g.endFill();
  g.beginFill(0x0a0416, 0.93);
  g.drawPolygon(polygonPointsScaled(massPts, 0.9));
  g.endFill();
  g.beginFill(0x1e1b4b, 0.9);
  g.drawPolygon(polygonPointsScaled(massPts, 0.75));
  g.endFill();
  g.beginFill(0x3b0764, 0.82);
  g.drawPolygon(polygonPointsScaled(massPts, 0.55));
  g.endFill();
  g.beginFill(0x581c87, 0.7);
  g.drawPolygon(polygonPointsScaled(massPts, 0.35));
  g.endFill();

  // ── 상단 뿔 2개 (날카로운, 휘어짐) ──
  [-1, 1].forEach(side => {
    const baseX = side * r * 0.45;
    const baseY = -r * 0.55;
    const tipX = side * r * 0.82;
    const tipY = -r * 1.1;
    const ctrl1X = side * r * 0.7;
    const ctrl1Y = -r * 0.9;
    const ctrl2X = side * r * 0.52;
    const ctrl2Y = -r * 0.45;
    const rightCurve = quadBezier(baseX, baseY, ctrl1X, ctrl1Y, tipX, tipY, 10);
    const leftCurve = quadBezier(tipX, tipY, ctrl2X, ctrl2Y, side * r * 0.28, baseY + r * 0.05, 10);
    const hornShape = [...rightCurve, ...leftCurve];
    g.beginFill(0x020010, 0.98);
    g.drawPolygon(polygonPoints(hornShape));
    g.endFill();
    g.beginFill(0x1e1b4b, 0.92);
    g.drawPolygon(polygonPointsAffine(hornShape, 0.55, baseX * 0.55, 0.5, baseY * 0.5));
    g.endFill();
    g.beginFill(0x3b0764, 0.78);
    g.drawPolygon(polygonPointsAffine(hornShape, 0.3, baseX * 0.3, 0.3, baseY * 0.3));
    g.endFill();
  });

  // ── 내부 소용돌이 arc 3개 (회전) ──
  const swirlRot = t * 0.045;
  for (let si = 0; si < 3; si++) {
    const srad = r * (0.48 - si * 0.12);
    g.lineStyle(1.5 - si * 0.3, si === 0 ? 0xa855f7 : si === 1 ? 0x8b5cf6 : 0x7c3aed, 0.55);
    g.arc(0, 0, srad, swirlRot + si * 1.5, swirlRot + si * 1.5 + Math.PI * 1.3);
  }
  g.lineStyle(0);

  // ── 빨간 쌍안 (공포감) ──
  const eyeY = -r * 0.28;
  const eyeX = r * 0.22;
  const eyePulse = 0.7 + Math.sin(t * 0.18) * 0.3;
  // 외곽 붉은 글로우
  g.beginFill(0x7f1d1d, 0.55 * eyePulse);
  g.drawCircle(-eyeX, eyeY, 10);
  g.drawCircle(eyeX, eyeY, 10);
  g.endFill();
  g.beginFill(0xb91c1c, 0.6 * eyePulse);
  g.drawCircle(-eyeX, eyeY, 7);
  g.drawCircle(eyeX, eyeY, 7);
  g.endFill();
  // 눈 본체 (블랙)
  g.beginFill(0x020010, 0.98);
  g.drawCircle(-eyeX, eyeY, 4.5);
  g.drawCircle(eyeX, eyeY, 4.5);
  g.endFill();
  // 붉은 슬릿 (정교)
  g.beginFill(0xdc2626, 0.98 * eyePulse);
  g.drawEllipse(-eyeX, eyeY, 3.2, 1.5);
  g.drawEllipse(eyeX, eyeY, 3.2, 1.5);
  g.endFill();
  g.beginFill(0xfca5a5, 0.95 * eyePulse);
  g.drawEllipse(-eyeX, eyeY, 1.8, 0.8);
  g.drawEllipse(eyeX, eyeY, 1.8, 0.8);
  g.endFill();
  // 눈 바깥 흐르는 그림자 (눈물 같은)
  g.lineStyle(1.5, 0x020010, 0.85);
  g.moveTo(-eyeX, eyeY + 6);
  g.quadraticCurveTo(-eyeX - 2, eyeY + 12, -eyeX - 5, eyeY + 22);
  g.moveTo(eyeX, eyeY + 6);
  g.quadraticCurveTo(eyeX + 2, eyeY + 12, eyeX + 5, eyeY + 22);
  g.lineStyle(0);

  // ── 이빨 (하단 좌/우, 날카로운 송곳니) ──
  const fangOffsetX = r * 0.12;
  [-1, 1].forEach(side => {
    const fangTopX = side * fangOffsetX;
    const fangTopY = r * 0.08;
    const fangTipX = side * fangOffsetX * 1.3;
    const fangTipY = r * 0.32;
    g.beginFill(0xe5e5e5, 0.92);
    g.drawPolygon([
      fangTopX - 2, fangTopY,
      fangTopX + 2, fangTopY,
      fangTipX, fangTipY,
    ]);
    g.endFill();
    g.beginFill(0xf5f5f5, 0.95);
    g.drawPolygon([
      fangTopX - 0.6, fangTopY + 1,
      fangTopX + 0.6, fangTopY + 1,
      fangTipX, fangTipY - 1,
    ]);
    g.endFill();
  });
}
