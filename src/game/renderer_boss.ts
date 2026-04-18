import * as PIXI from 'pixi.js';
import { EnemyType, EnemyState } from './types';

/**
 * 보스 전용 렌더러 — 각 속성별 고유 실루엣 + 프레임별 애니메이션.
 * 퀄리티 우선 — 여러 레이어(5~10), bezier 커브, 장식(왕관/뿔/룬), 유동 애니메이션.
 * 이모지 사용 안 함. PIXI Graphics만.
 */

export function drawBoss(g: PIXI.Graphics, e: EnemyState, frameCount: number) {
  g.clear();
  const r = e.width / 2;
  const t = frameCount;

  switch (e.type as EnemyType) {
    case 'boss_water':    drawWaterBoss(g, r, t); break;
    case 'boss_fire':     drawFireBoss(g, r, t); break;
    case 'boss_earth':    drawEarthBoss(g, r, t); break;
    case 'boss_electric': drawElectricBoss(g, r, t); break;
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

function polygonPoints(pts: Array<{ x: number; y: number }>): number[] {
  const arr: number[] = [];
  for (const p of pts) { arr.push(p.x, p.y); }
  return arr;
}

// ═══════════════════════════════════════════════════════════════════
// 1) 해일의 군주 (Water Lord)
// ═══════════════════════════════════════════════════════════════════
function drawWaterBoss(g: PIXI.Graphics, r: number, t: number) {
  // ── 외곽 해일 halo (3겹) ──
  g.beginFill(0x0c4a6e, 0.18);  // sky-900
  g.drawCircle(0, 0, r * 1.55);
  g.endFill();
  g.beginFill(0x1e3a8a, 0.22);
  g.drawCircle(0, 0, r * 1.35);
  g.endFill();
  g.beginFill(0x2563eb, 0.22);
  g.drawCircle(0, 0, r * 1.15);
  g.endFill();

  // 외곽 잔물결 링 3개 주기 확장 (phase offset)
  for (let ri = 0; ri < 3; ri++) {
    const phase = (t + ri * 28) % 84;
    const rt = phase / 84;
    const alpha = (1 - rt) * 0.6;
    g.lineStyle(2 - ri * 0.3, ri === 0 ? 0x38bdf8 : ri === 1 ? 0x7dd3fc : 0xbae6fd, alpha);
    g.drawCircle(0, 0, r * (1.0 + rt * 0.55));
  }
  g.lineStyle(0);

  // ── 파도 crest (상단 3개 봉우리, 흔들림) ──
  const crestPhase = t * 0.05;
  const crestBase = -r * 0.75;
  for (let i = 0; i < 3; i++) {
    const cx = (i - 1) * r * 0.42;
    const sway = Math.sin(crestPhase + i * 1.7) * r * 0.05;
    const height = r * (0.42 + Math.sin(crestPhase * 1.3 + i) * 0.09);

    // 외곽 다크 블루
    const peak = { x: cx + sway, y: crestBase - height };
    const leftBase = { x: cx - r * 0.22, y: crestBase + r * 0.1 };
    const rightBase = { x: cx + r * 0.22, y: crestBase + r * 0.1 };
    const ctrlL = { x: peak.x - r * 0.18, y: peak.y + r * 0.15 };
    const ctrlR = { x: peak.x + r * 0.18, y: peak.y + r * 0.15 };
    const leftCurve = quadBezier(leftBase.x, leftBase.y, ctrlL.x, ctrlL.y, peak.x, peak.y, 8);
    const rightCurve = quadBezier(peak.x, peak.y, ctrlR.x, ctrlR.y, rightBase.x, rightBase.y, 8);
    const shape = [...leftCurve, ...rightCurve];
    g.beginFill(0x1e3a8a, 0.95);
    g.drawPolygon(polygonPoints(shape));
    g.endFill();
    // 내부 중간
    const mid = shape.map(p => ({ x: cx + (p.x - cx) * 0.75, y: crestBase + (p.y - crestBase) * 0.82 }));
    g.beginFill(0x2563eb, 0.88);
    g.drawPolygon(polygonPoints(mid));
    g.endFill();
    // 끝 foam (sky-300 tip)
    g.beginFill(0xbae6fd, 0.85);
    g.drawCircle(peak.x, peak.y, r * 0.08);
    g.endFill();
    g.beginFill(0xe0f2fe, 0.9);
    g.drawCircle(peak.x, peak.y, r * 0.04);
    g.endFill();
  }

  // ── 본체 (둥근 물방울 몸체, 수면 wavy) ──
  const bodyPts: Array<{ x: number; y: number }> = [];
  const bodySegs = 32;
  for (let i = 0; i <= bodySegs; i++) {
    const a = -Math.PI / 2 + (i / bodySegs) * Math.PI * 2;
    // 상단은 crest 쪽으로 조금 평평, 하단은 둥글게
    const topFactor = Math.sin(a) < 0 ? 0.85 : 1.02;
    const wavy = 1 + Math.sin(a * 6 + t * 0.1) * 0.025 + Math.sin(a * 11 - t * 0.07) * 0.015;
    const rr = r * topFactor * wavy;
    bodyPts.push({ x: Math.cos(a) * rr, y: Math.sin(a) * rr });
  }
  g.beginFill(0x0c4a6e, 0.96);  // sky-900
  g.drawPolygon(polygonPoints(bodyPts));
  g.endFill();
  g.beginFill(0x1e40af, 0.92);
  g.drawPolygon(polygonPoints(bodyPts.map(p => ({ x: p.x * 0.82, y: p.y * 0.82 }))));
  g.endFill();
  g.beginFill(0x2563eb, 0.85);
  g.drawPolygon(polygonPoints(bodyPts.map(p => ({ x: p.x * 0.6, y: p.y * 0.6 }))));
  g.endFill();

  // ── 내부 소용돌이 — 동심 곡선 3개 (시간따라 회전) ──
  const swirlRot = t * 0.04;
  for (let si = 0; si < 3; si++) {
    const srad = r * (0.5 - si * 0.13);
    g.lineStyle(1.6, si === 0 ? 0x60a5fa : si === 1 ? 0x93c5fd : 0xbae6fd, 0.55);
    const arcStart = swirlRot + si * 1.2;
    g.arc(0, 0, srad, arcStart, arcStart + Math.PI * 1.4);
  }
  g.lineStyle(0);

  // ── 수평 wave 라인 3개 (파동) ──
  for (let k = 0; k < 3; k++) {
    const y = (k - 1) * r * 0.28;
    const width = r * 0.65;
    g.lineStyle(2, 0xbae6fd, 0.45);
    g.moveTo(-width, y);
    const steps = 12;
    for (let s = 1; s <= steps; s++) {
      const sx = -width + (s / steps) * width * 2;
      const sy = y + Math.sin(s * 0.8 + t * 0.14 + k * 1.7) * 3;
      g.lineTo(sx, sy);
    }
  }
  g.lineStyle(0);

  // ── 떠다니는 물방울 (5개 공전) ──
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + t * 0.02;
    const orbR = r * 1.08 + Math.sin(t * 0.08 + k) * 4;
    const ox = Math.cos(a) * orbR;
    const oy = Math.sin(a) * orbR;
    g.beginFill(0x0ea5e9, 0.55);
    g.drawCircle(ox, oy, 3.8);
    g.endFill();
    g.beginFill(0xbae6fd, 0.85);
    g.drawCircle(ox - 0.8, oy - 0.8, 1.8);
    g.endFill();
  }

  // ── 눈 (세로 슬릿, 물고기 느낌) + 밝게 ──
  const eyeY = -r * 0.28;
  const eyeX = r * 0.26;
  const eyePulse = 0.75 + Math.sin(t * 0.09) * 0.25;
  // 외곽 다크 아이소켓
  g.beginFill(0x0c4a6e, 0.95);
  g.drawEllipse(-eyeX, eyeY, 7, 10);
  g.drawEllipse(eyeX, eyeY, 7, 10);
  g.endFill();
  // 눈 흰자
  g.beginFill(0xe0f2fe, 0.95);
  g.drawEllipse(-eyeX, eyeY, 5, 7.5);
  g.drawEllipse(eyeX, eyeY, 5, 7.5);
  g.endFill();
  // 세로 슬릿 동공
  g.beginFill(0x0c4a6e, 0.95);
  g.drawEllipse(-eyeX, eyeY, 1.8, 6.5 * eyePulse);
  g.drawEllipse(eyeX, eyeY, 1.8, 6.5 * eyePulse);
  g.endFill();
  // 밝은 하이라이트
  g.beginFill(0xffffff, 0.9);
  g.drawCircle(-eyeX - 1.5, eyeY - 2, 1);
  g.drawCircle(eyeX - 1.5, eyeY - 2, 1);
  g.endFill();

  // ── 아랫턱 foam 라인 (미소/긴장감) ──
  g.lineStyle(2, 0xbae6fd, 0.7);
  g.arc(0, r * 0.25, r * 0.28, -0.3, Math.PI + 0.3);
  g.lineStyle(0);
}

// ═══════════════════════════════════════════════════════════════════
// 2) 화염의 군주 (Fire Lord)
// ═══════════════════════════════════════════════════════════════════
function drawFireBoss(g: PIXI.Graphics, r: number, t: number) {
  // ── 외곽 열기 halo (4겹) ──
  g.beginFill(0x450a0a, 0.18);  // red-950
  g.drawCircle(0, 0, r * 1.7);
  g.endFill();
  g.beginFill(0x7f1d1d, 0.2);
  g.drawCircle(0, 0, r * 1.45);
  g.endFill();
  g.beginFill(0xdc2626, 0.22);
  g.drawCircle(0, 0, r * 1.22);
  g.endFill();
  g.beginFill(0xf97316, 0.16);
  g.drawCircle(0, 0, r * 1.06);
  g.endFill();

  // ── 본체 — 하단 반원 (용암 덩어리) ──
  const bodyPts: Array<{ x: number; y: number }> = [];
  const bodySegs = 16;
  for (let i = 0; i <= bodySegs; i++) {
    const a = Math.PI + (i / bodySegs) * Math.PI;  // π→2π (하단 반원)
    const wobble = 1 + Math.sin(a * 3 + t * 0.1) * 0.04;
    const rr = r * wobble;
    bodyPts.push({ x: Math.cos(a) * rr, y: Math.sin(a) * rr });
  }

  // ── 상단 — 불꽃 혀 11개 (흔들림) ──
  const tongues = 11;
  const tonguePhase = t * 0.14;
  const topPts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= tongues; i++) {
    const segT = i / tongues;
    const baseA = Math.PI - segT * Math.PI;
    const baseR = r;
    const startX = Math.cos(baseA) * baseR;
    const startY = Math.sin(baseA) * baseR;
    topPts.push({ x: startX, y: startY });

    if (i === tongues) break;
    // 혀 끝 (위로 뾰족)
    const midA = Math.PI - (segT + 0.5 / tongues) * Math.PI;
    const wobble = Math.sin(tonguePhase + i * 1.4) * 0.2;
    const tongueA = midA + wobble;
    // 혀 크기 (가운데 혀가 가장 크게)
    const heightBoost = 1 + Math.sin(segT * Math.PI) * 0.35;
    const tongueR = r * (1.1 + Math.sin(tonguePhase * 1.5 + i) * 0.1) * heightBoost;
    const tipX = Math.cos(tongueA) * tongueR;
    const tipY = Math.sin(tongueA) * tongueR - r * 0.08;
    topPts.push({ x: tipX, y: tipY });
  }

  // 합치기 (상단 혀들 + 하단 반원)
  const fullShape = [...topPts, ...bodyPts];

  // 3겹 렌더
  g.beginFill(0x7f1d1d, 0.98);
  g.drawPolygon(polygonPoints(fullShape));
  g.endFill();
  g.beginFill(0xdc2626, 0.94);
  g.drawPolygon(polygonPoints(fullShape.map(p => ({ x: p.x * 0.82, y: p.y * 0.82 }))));
  g.endFill();
  g.beginFill(0xf97316, 0.9);
  g.drawPolygon(polygonPoints(fullShape.map(p => ({ x: p.x * 0.62, y: p.y * 0.62 }))));
  g.endFill();
  g.beginFill(0xfbbf24, 0.88);
  g.drawPolygon(polygonPoints(fullShape.map(p => ({ x: p.x * 0.38, y: p.y * 0.38 }))));
  g.endFill();

  // ── 뿔 2개 (양 옆 위로) ──
  const hornPhase = Math.sin(t * 0.05) * 0.04;
  [-1, 1].forEach(side => {
    const baseX = side * r * 0.6;
    const baseY = -r * 0.2;
    const tipX = side * r * 0.95;
    const tipY = -r * 1.0;
    const ctrlX = side * r * 0.78 + hornPhase * r * 0.05;
    const ctrlY = -r * 0.72;
    const bX = side * r * 0.42;
    const bY = -r * 0.05;
    const rightCurve = quadBezier(baseX, baseY, ctrlX + side * r * 0.15, ctrlY, tipX, tipY, 8);
    const leftCurve = quadBezier(tipX, tipY, ctrlX - side * r * 0.02, ctrlY + r * 0.08, bX, bY, 8);
    const hornShape = [...rightCurve, ...leftCurve];
    g.beginFill(0x450a0a, 0.98);
    g.drawPolygon(polygonPoints(hornShape));
    g.endFill();
    g.beginFill(0x7f1d1d, 0.9);
    const hornInner = hornShape.map(p => ({ x: (p.x + baseX) / 2, y: (p.y + baseY) / 2 }));
    g.drawPolygon(polygonPoints(hornInner));
    g.endFill();
  });

  // ── 용암 crack (4개, 중심에서 방사) ──
  const crackDirs = [0.7, 2.2, -0.9, -2.3];
  for (const d of crackDirs) {
    const cx1 = Math.cos(d) * r * 0.15;
    const cy1 = Math.sin(d) * r * 0.15;
    const cx2 = Math.cos(d) * r * 0.75;
    const cy2 = Math.sin(d) * r * 0.75;
    g.lineStyle(4, 0xfbbf24, 0.4);
    g.moveTo(cx1, cy1);
    g.lineTo(cx2, cy2);
    g.lineStyle(2, 0xfef08a, 0.85);
    g.moveTo(cx1, cy1);
    g.lineTo(cx2, cy2);
  }
  g.lineStyle(0);

  // ── 중심 밝은 코어 (맥동) ──
  const corePulse = 0.85 + Math.sin(t * 0.18) * 0.15;
  g.beginFill(0xfef3c7, 0.85 * corePulse);
  g.drawCircle(0, r * 0.08, r * 0.22 * corePulse);
  g.endFill();
  g.beginFill(0xffffff, 0.75 * corePulse);
  g.drawCircle(0, r * 0.08, r * 0.11 * corePulse);
  g.endFill();

  // ── 떠오르는 불씨 (ember) 8개 ──
  for (let k = 0; k < 8; k++) {
    const kt = (t * 0.08 + k * 1.3) % 6.28;
    const emberBaseX = Math.cos(k * 0.78) * r * (0.3 + (k % 2) * 0.3);
    const baseY = -r * 0.3;
    const lift = Math.sin(kt) * r * 0.5 + r * 0.2;
    const ex = emberBaseX + Math.sin(kt * 1.3) * 6;
    const ey = baseY - lift;
    const alpha = Math.max(0, Math.cos(kt * 0.5));
    const sz = 2.2 + (k % 3) * 0.6;
    g.beginFill(0xf97316, 0.7 * alpha);
    g.drawCircle(ex, ey, sz * 1.8);
    g.endFill();
    g.beginFill(0xfbbf24, 0.9 * alpha);
    g.drawCircle(ex, ey, sz);
    g.endFill();
  }

  // ── 눈 (가로 슬릿, 이글거림) ──
  const eyeY = -r * 0.05;
  const eyeX = r * 0.25;
  const eyePulse = 0.65 + Math.sin(t * 0.15) * 0.35;
  // 외곽 다크 소켓
  g.beginFill(0x450a0a, 0.98);
  g.drawEllipse(-eyeX, eyeY, 9, 5);
  g.drawEllipse(eyeX, eyeY, 9, 5);
  g.endFill();
  // 불타는 내부
  g.beginFill(0xdc2626, 0.95);
  g.drawEllipse(-eyeX, eyeY, 7, 3.5);
  g.drawEllipse(eyeX, eyeY, 7, 3.5);
  g.endFill();
  g.beginFill(0xf97316, 0.95 * eyePulse);
  g.drawEllipse(-eyeX, eyeY, 5.5, 2.5);
  g.drawEllipse(eyeX, eyeY, 5.5, 2.5);
  g.endFill();
  g.beginFill(0xfef3c7, 0.95 * eyePulse);
  g.drawEllipse(-eyeX, eyeY, 3, 1.5);
  g.drawEllipse(eyeX, eyeY, 3, 1.5);
  g.endFill();
  // 눈 위의 불꽃 장식
  [-1, 1].forEach(side => {
    g.beginFill(0xf97316, 0.8 * eyePulse);
    g.drawPolygon([
      side * eyeX - 3, eyeY - 6,
      side * eyeX + 0, eyeY - 12,
      side * eyeX + 3, eyeY - 6,
    ]);
    g.endFill();
  });
}

// ═══════════════════════════════════════════════════════════════════
// 3) 대지의 군주 (Earth Lord)
// ═══════════════════════════════════════════════════════════════════
function drawEarthBoss(g: PIXI.Graphics, r: number, t: number) {
  // ── 바닥 먼지 (3겹) ──
  g.beginFill(0x451a03, 0.28);
  g.drawEllipse(0, r * 1.0, r * 1.5, r * 0.28);
  g.endFill();
  g.beginFill(0x78350f, 0.22);
  g.drawEllipse(0, r * 0.98, r * 1.2, r * 0.22);
  g.endFill();
  g.beginFill(0xa16207, 0.16);
  g.drawEllipse(0, r * 0.96, r * 0.95, r * 0.16);
  g.endFill();

  // ── 외곽 어두운 halo ──
  g.beginFill(0x1c0a03, 0.16);
  g.drawCircle(0, 0, r * 1.3);
  g.endFill();

  // ── 본체 — 비대칭 9각 바위 (각진, 고정 seed) ──
  const sides = 10;
  const seedR = [0.92, 1.08, 0.88, 1.02, 0.95, 1.10, 0.87, 1.05, 0.96, 1.03];
  const rockPts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2 - Math.PI / 2;
    const rr = r * seedR[i];
    // 꼭짓점에 작은 chip 효과
    const jag = ((i * 13) % 7) - 3;
    rockPts.push({ x: Math.cos(a) * rr + jag * 0.2, y: Math.sin(a) * rr + jag * 0.15 });
  }

  // 본체 (3겹)
  g.beginFill(0x1c0a03, 0.98);
  g.drawPolygon(polygonPoints(rockPts));
  g.endFill();
  g.beginFill(0x451a03, 0.95);
  g.drawPolygon(polygonPoints(rockPts.map(p => ({ x: p.x * 0.92, y: p.y * 0.92 }))));
  g.endFill();
  // 왼쪽 상단 밝은 면 (조명)
  g.beginFill(0x92400e, 0.78);
  const lightSide = [{ x: 0, y: 0 }];
  for (let i = 0; i < Math.ceil(sides / 2); i++) lightSide.push(rockPts[i]);
  g.drawPolygon(polygonPoints(lightSide));
  g.endFill();
  // 오른쪽 하단 어두운
  g.beginFill(0x78350f, 0.68);
  const darkSide = [{ x: 0, y: 0 }];
  for (let i = Math.floor(sides / 2); i < sides; i++) darkSide.push(rockPts[i]);
  g.drawPolygon(polygonPoints(darkSide));
  g.endFill();

  // ── 어깨 바위 2개 (좌우, 작은 돌) ──
  [-1, 1].forEach(side => {
    const sx = side * r * 0.75;
    const sy = -r * 0.55;
    const shoulderPts: Array<{ x: number; y: number }> = [];
    const shoulderSides = 6;
    for (let i = 0; i < shoulderSides; i++) {
      const a = (i / shoulderSides) * Math.PI * 2 - Math.PI / 2;
      const rr = r * 0.3 * (0.85 + (i % 2) * 0.2);
      shoulderPts.push({ x: sx + Math.cos(a) * rr, y: sy + Math.sin(a) * rr });
    }
    g.beginFill(0x1c0a03, 0.98);
    g.drawPolygon(polygonPoints(shoulderPts));
    g.endFill();
    g.beginFill(0x78350f, 0.88);
    g.drawPolygon(polygonPoints(shoulderPts.map(p => ({ x: sx + (p.x - sx) * 0.72, y: sy + (p.y - sy) * 0.72 }))));
    g.endFill();
    // 이끼 (녹색 반점 1-2개)
    g.beginFill(0x4d7c0f, 0.85);
    g.drawCircle(sx - r * 0.05, sy - r * 0.18, 3);
    g.drawCircle(sx + r * 0.08, sy - r * 0.12, 2.2);
    g.endFill();
    g.beginFill(0x65a30d, 0.75);
    g.drawCircle(sx - r * 0.05, sy - r * 0.18, 1.5);
    g.endFill();
  });

  // ── 상단 돌기 (머리 뿔 3개) ──
  [-0.48, 0, 0.48].forEach(sign => {
    const bx = sign * r * 0.5;
    const by = -r * 0.82;
    const tipY = by - r * 0.35;
    const leftX = bx - r * 0.14;
    const rightX = bx + r * 0.14;
    g.beginFill(0x1c0a03, 0.98);
    g.drawPolygon([leftX, by, bx, tipY, rightX, by]);
    g.endFill();
    g.beginFill(0x451a03, 0.88);
    g.drawPolygon([leftX + r * 0.03, by - r * 0.02, bx, tipY + r * 0.05, rightX - r * 0.03, by - r * 0.02]);
    g.endFill();
    // 이끼 작은 점
    if (sign === 0) {
      g.beginFill(0x4d7c0f, 0.8);
      g.drawCircle(bx, by - r * 0.1, 1.5);
      g.endFill();
    }
  });

  // ── 용암 crack (4개) ──
  const cracks: Array<[number, number, number, number]> = [
    [-r * 0.55, -r * 0.15, r * 0.3, r * 0.15],
    [-r * 0.2, -r * 0.65, r * 0.25, r * 0.45],
    [-r * 0.6, r * 0.3, -r * 0.15, r * 0.6],
    [r * 0.15, r * 0.1, r * 0.55, r * 0.5],
  ];
  for (const c of cracks) {
    // glow (넓은 오렌지)
    g.lineStyle(5, 0xf97316, 0.3);
    g.moveTo(c[0], c[1]);
    g.lineTo(c[2], c[3]);
    // 용암 코어 (red-700)
    g.lineStyle(1.8, 0xdc2626, 0.88);
    g.moveTo(c[0], c[1]);
    g.lineTo(c[2], c[3]);
    // 가장 밝은 hint (yellow-400)
    g.lineStyle(0.8, 0xfde047, 0.75);
    g.moveTo(c[0], c[1]);
    g.lineTo(c[2], c[3]);
  }
  g.lineStyle(0);

  // ── 중앙 거대 눈 (단일, 노랑 맥동) ──
  const eyeY = -r * 0.02;
  const eyePulse = 0.65 + Math.sin(t * 0.07) * 0.35;
  // 검은 눈구멍 (깊이)
  g.beginFill(0x0c0a09, 0.95);
  g.drawCircle(0, eyeY, r * 0.24);
  g.endFill();
  g.beginFill(0x1c0a03, 0.9);
  g.drawCircle(0, eyeY, r * 0.20);
  g.endFill();
  // 노랑 글로우
  g.beginFill(0xdc2626, 0.8 * eyePulse);
  g.drawCircle(0, eyeY, r * 0.14);
  g.endFill();
  g.beginFill(0xf97316, 0.92 * eyePulse);
  g.drawCircle(0, eyeY, r * 0.10);
  g.endFill();
  g.beginFill(0xfbbf24, 0.98 * eyePulse);
  g.drawCircle(0, eyeY, r * 0.055);
  g.endFill();
  g.beginFill(0xfef3c7, 0.95);
  g.drawCircle(0, eyeY - r * 0.015, r * 0.025);
  g.endFill();

  // ── 공전하는 돌 파편 (4개) ──
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + t * 0.015;
    const orbR = r * 1.25 + Math.sin(t * 0.05 + k) * 6;
    const ox = Math.cos(a) * orbR;
    const oy = Math.sin(a) * orbR * 0.7;  // 타원 공전
    const shardSize = 3 + (k % 2) * 1.5;
    g.beginFill(0x1c0a03, 0.9);
    g.drawPolygon([
      ox - shardSize, oy - shardSize * 0.5,
      ox + shardSize, oy - shardSize * 0.7,
      ox + shardSize * 0.8, oy + shardSize * 0.8,
      ox - shardSize * 0.6, oy + shardSize * 0.5,
    ]);
    g.endFill();
    g.beginFill(0x78350f, 0.85);
    g.drawCircle(ox, oy, shardSize * 0.5);
    g.endFill();
  }
}

// ═══════════════════════════════════════════════════════════════════
// 4) 뇌전의 군주 (Electric Lord)
// ═══════════════════════════════════════════════════════════════════
function drawElectricBoss(g: PIXI.Graphics, r: number, t: number) {
  // ── 외곽 전기 halo (5겹) ──
  g.beginFill(0x1e1b4b, 0.18);
  g.drawCircle(0, 0, r * 1.7);
  g.endFill();
  g.beginFill(0x3b0764, 0.22);
  g.drawCircle(0, 0, r * 1.45);
  g.endFill();
  g.beginFill(0x581c87, 0.2);
  g.drawCircle(0, 0, r * 1.25);
  g.endFill();
  g.beginFill(0x7c3aed, 0.16);
  g.drawCircle(0, 0, r * 1.1);
  g.endFill();

  // ── 외곽 동심 링 3개 (각자 회전) ──
  for (let ri = 0; ri < 3; ri++) {
    const ringR = r * (1.05 + ri * 0.16);
    const rotation = t * (0.03 + ri * 0.015) * (ri % 2 === 0 ? 1 : -1);
    const dashes = 8 + ri * 2;
    for (let d = 0; d < dashes; d++) {
      const a1 = rotation + (d / dashes) * Math.PI * 2;
      const a2 = a1 + Math.PI / dashes * 0.6;
      g.lineStyle(1.5, ri === 0 ? 0xa855f7 : ri === 1 ? 0x8b5cf6 : 0x6d28d9, 0.7 - ri * 0.15);
      g.arc(0, 0, ringR, a1, a2);
    }
  }
  g.lineStyle(0);

  // ── 방사 spike 8개 (테슬라 왕관, 회전) ──
  const spikes = 8;
  const rotOffset = t * 0.018;
  for (let i = 0; i < spikes; i++) {
    const a = (i / spikes) * Math.PI * 2 + rotOffset;
    const baseR = r * 0.75;
    const tipR = r * 1.28 + Math.sin(t * 0.1 + i) * 3;
    const sideW = 0.12;
    const aL = a - sideW;
    const aR = a + sideW;
    const pts = [
      Math.cos(aL) * baseR, Math.sin(aL) * baseR,
      Math.cos(a) * tipR, Math.sin(a) * tipR,
      Math.cos(aR) * baseR, Math.sin(aR) * baseR,
    ];
    // 외곽 다크 퍼플
    g.beginFill(0x3b0764, 0.95);
    g.drawPolygon(pts);
    g.endFill();
    // 중간 보라
    g.beginFill(0x6d28d9, 0.88);
    g.drawPolygon([
      Math.cos(aL) * baseR * 0.93, Math.sin(aL) * baseR * 0.93,
      Math.cos(a) * tipR * 0.88, Math.sin(a) * tipR * 0.88,
      Math.cos(aR) * baseR * 0.93, Math.sin(aR) * baseR * 0.93,
    ]);
    g.endFill();
    // 밝은 코어 줄
    g.beginFill(0xc4b5fd, 0.75);
    g.drawPolygon([
      Math.cos(aL) * baseR * 0.98, Math.sin(aL) * baseR * 0.98,
      Math.cos(a) * tipR * 0.75, Math.sin(a) * tipR * 0.75,
      Math.cos(aR) * baseR * 0.98, Math.sin(aR) * baseR * 0.98,
    ]);
    g.endFill();
  }

  // ── 중심 구체 (여러 겹 + 맥동) ──
  const pulse = 0.8 + Math.sin(t * 0.2) * 0.2;
  g.beginFill(0x1e1b4b, 0.98);
  g.drawCircle(0, 0, r * 0.72);
  g.endFill();
  g.beginFill(0x3b0764, 0.95);
  g.drawCircle(0, 0, r * 0.6);
  g.endFill();
  g.beginFill(0x581c87, 0.92);
  g.drawCircle(0, 0, r * 0.5);
  g.endFill();
  g.beginFill(0x7c3aed, 0.88);
  g.drawCircle(0, 0, r * 0.38);
  g.endFill();
  g.beginFill(0xa855f7, 0.85 * pulse);
  g.drawCircle(0, 0, r * 0.25);
  g.endFill();
  g.beginFill(0xc4b5fd, 0.9 * pulse);
  g.drawCircle(0, 0, r * 0.14);
  g.endFill();
  g.beginFill(0xe0d8ff, 0.95 * pulse);
  g.drawCircle(0, 0, r * 0.06);
  g.endFill();

  // ── 전기 아크 5개 (화려한 지그재그, 매 프레임 jitter) ──
  const arcCount = 5;
  for (let k = 0; k < arcCount; k++) {
    const aStart = (k / arcCount) * Math.PI * 2 + t * 0.04;
    const aEnd = aStart + Math.PI * 0.55 + Math.sin(t * 0.1 + k) * 0.25;
    const rr = r * (0.82 + (k % 2) * 0.13);
    const sx = Math.cos(aStart) * rr;
    const sy = Math.sin(aStart) * rr;
    const ex = Math.cos(aEnd) * rr;
    const ey = Math.sin(aEnd) * rr;
    const segs = 7;
    // 외곽 halo
    g.lineStyle(4, 0x6d28d9, 0.4);
    g.moveTo(sx, sy);
    for (let s = 1; s < segs; s++) {
      const tt = s / segs;
      const mx = sx + (ex - sx) * tt;
      const my = sy + (ey - sy) * tt;
      const jit = ((s * 37 + k * 19 + t * 3) % 11) - 5;
      g.lineTo(mx + jit * 1.2, my + jit * 1.4);
    }
    g.lineTo(ex, ey);
    // glow
    g.lineStyle(2.2, 0xa855f7, 0.75);
    g.moveTo(sx, sy);
    for (let s = 1; s < segs; s++) {
      const tt = s / segs;
      const mx = sx + (ex - sx) * tt;
      const my = sy + (ey - sy) * tt;
      const jit = ((s * 29 + k * 13 + t * 5) % 9) - 4;
      g.lineTo(mx + jit, my + jit * 1.1);
    }
    g.lineTo(ex, ey);
    // core
    g.lineStyle(1, 0xe0d8ff, 0.95);
    g.moveTo(sx, sy);
    for (let s = 1; s < segs; s++) {
      const tt = s / segs;
      const mx = sx + (ex - sx) * tt;
      const my = sy + (ey - sy) * tt;
      const jit = ((s * 23 + k * 17 + t * 7) % 7) - 3;
      g.lineTo(mx + jit * 0.8, my + jit * 0.9);
    }
    g.lineTo(ex, ey);
  }
  g.lineStyle(0);

  // ── 정면 눈 2개 (전기 눈) ──
  const eyeY = -r * 0.1;
  const eyeX = r * 0.13;
  // 외곽 다크
  g.beginFill(0x1e1b4b, 0.98);
  g.drawCircle(-eyeX, eyeY, 4);
  g.drawCircle(eyeX, eyeY, 4);
  g.endFill();
  // 보라 글로우
  g.beginFill(0x7c3aed, 0.92);
  g.drawCircle(-eyeX, eyeY, 3);
  g.drawCircle(eyeX, eyeY, 3);
  g.endFill();
  g.beginFill(0xe0d8ff, 0.95 * pulse);
  g.drawCircle(-eyeX, eyeY, 1.8);
  g.drawCircle(eyeX, eyeY, 1.8);
  g.endFill();
  // 안광 번쩍
  if (Math.sin(t * 0.3) > 0.85) {
    g.beginFill(0xffffff, 0.9);
    g.drawCircle(-eyeX, eyeY, 0.9);
    g.drawCircle(eyeX, eyeY, 0.9);
    g.endFill();
  }
}

// ═══════════════════════════════════════════════════════════════════
// 5) 광휘의 군주 (Light Lord)
// ═══════════════════════════════════════════════════════════════════
function drawLightBoss(g: PIXI.Graphics, r: number, t: number) {
  // ── 외곽 신성 halo (5겹) ──
  g.beginFill(0xfef3c7, 0.22);
  g.drawCircle(0, 0, r * 1.8);
  g.endFill();
  g.beginFill(0xfde68a, 0.22);
  g.drawCircle(0, 0, r * 1.55);
  g.endFill();
  g.beginFill(0xfde047, 0.2);
  g.drawCircle(0, 0, r * 1.35);
  g.endFill();
  g.beginFill(0xfbbf24, 0.18);
  g.drawCircle(0, 0, r * 1.15);
  g.endFill();

  // ── 외곽 룬 4개 (북/남/동/서, 회전) ──
  const runeRot = t * 0.012;
  for (let k = 0; k < 4; k++) {
    const a = runeRot + (k / 4) * Math.PI * 2;
    const rx = Math.cos(a) * r * 1.42;
    const ry = Math.sin(a) * r * 1.42;
    // 룬 원형 받침
    g.beginFill(0xb45309, 0.85);
    g.drawCircle(rx, ry, 9);
    g.endFill();
    g.beginFill(0xfde047, 0.92);
    g.drawCircle(rx, ry, 6.5);
    g.endFill();
    // 룬 심볼 (십자 + 점)
    g.lineStyle(1.2, 0x7c2d12, 0.9);
    g.moveTo(rx - 4, ry);
    g.lineTo(rx + 4, ry);
    g.moveTo(rx, ry - 4);
    g.lineTo(rx, ry + 4);
    g.lineStyle(0);
    g.beginFill(0x7c2d12, 0.9);
    g.drawCircle(rx, ry, 1.2);
    g.endFill();
  }

  // ── 긴 회전 rays 16개 (주황+노랑 2색 교대) ──
  const raysOuter = 16;
  const rotOuter = t * 0.014;
  for (let i = 0; i < raysOuter; i++) {
    const a = (i / raysOuter) * Math.PI * 2 + rotOuter;
    const w = 0.075;
    const baseR = r * 0.95;
    const tipR = r * 1.38 + Math.sin(t * 0.08 + i) * 5;
    const col1 = i % 2 === 0 ? 0xf59e0b : 0xfbbf24;
    g.beginFill(col1, 0.78);
    g.drawPolygon([
      Math.cos(a - w) * baseR, Math.sin(a - w) * baseR,
      Math.cos(a) * tipR, Math.sin(a) * tipR,
      Math.cos(a + w) * baseR, Math.sin(a + w) * baseR,
    ]);
    g.endFill();
    // 내부 밝은 코어 라인
    g.beginFill(0xfde047, 0.72);
    g.drawPolygon([
      Math.cos(a - w * 0.4) * baseR * 1.02, Math.sin(a - w * 0.4) * baseR * 1.02,
      Math.cos(a) * tipR * 0.93, Math.sin(a) * tipR * 0.93,
      Math.cos(a + w * 0.4) * baseR * 1.02, Math.sin(a + w * 0.4) * baseR * 1.02,
    ]);
    g.endFill();
  }

  // ── 짧은 rays 12개 (반대 회전, 빠름) ──
  const raysInner = 12;
  const rotInner = -t * 0.025;
  for (let i = 0; i < raysInner; i++) {
    const a = (i / raysInner) * Math.PI * 2 + rotInner;
    const w = 0.11;
    const baseR = r * 0.83;
    const tipR = r * 1.08 + Math.sin(t * 0.12 + i * 1.3) * 3;
    g.beginFill(0xfbbf24, 0.9);
    g.drawPolygon([
      Math.cos(a - w) * baseR, Math.sin(a - w) * baseR,
      Math.cos(a) * tipR, Math.sin(a) * tipR,
      Math.cos(a + w) * baseR, Math.sin(a + w) * baseR,
    ]);
    g.endFill();
    g.beginFill(0xfde047, 0.85);
    g.drawPolygon([
      Math.cos(a - w * 0.5) * baseR * 1.02, Math.sin(a - w * 0.5) * baseR * 1.02,
      Math.cos(a) * tipR * 0.94, Math.sin(a) * tipR * 0.94,
      Math.cos(a + w * 0.5) * baseR * 1.02, Math.sin(a + w * 0.5) * baseR * 1.02,
    ]);
    g.endFill();
  }

  // ── 중심 태양 (6겹 그라디언트) ──
  const sunPulse = 0.85 + Math.sin(t * 0.18) * 0.15;
  g.beginFill(0xb45309, 0.95);
  g.drawCircle(0, 0, r * 0.82);
  g.endFill();
  g.beginFill(0xea580c, 0.92);
  g.drawCircle(0, 0, r * 0.72);
  g.endFill();
  g.beginFill(0xf59e0b, 0.92);
  g.drawCircle(0, 0, r * 0.62);
  g.endFill();
  g.beginFill(0xfbbf24, 0.9);
  g.drawCircle(0, 0, r * 0.48);
  g.endFill();
  g.beginFill(0xfde047, 0.9 * sunPulse);
  g.drawCircle(0, 0, r * 0.34);
  g.endFill();
  g.beginFill(0xfef9c3, 0.92 * sunPulse);
  g.drawCircle(0, 0, r * 0.20);
  g.endFill();
  g.beginFill(0xffffff, 0.95);
  g.drawCircle(0, 0, r * 0.10);
  g.endFill();

  // ── 왕관 3개 (상단 3점) ──
  const crownPhase = Math.sin(t * 0.08) * 0.02;
  [-0.45, 0, 0.45].forEach(sign => {
    const bx = sign * r * 0.55;
    const by = -r * 0.72;
    const tx = bx + crownPhase * r * 0.03;
    const ty = -r * 1.02;
    const leftX = bx - r * 0.1;
    const rightX = bx + r * 0.1;
    g.beginFill(0x92400e, 0.98);
    g.drawPolygon([leftX, by, tx, ty, rightX, by]);
    g.endFill();
    g.beginFill(0xea580c, 0.92);
    g.drawPolygon([leftX + r * 0.02, by - r * 0.015, tx, ty + r * 0.05, rightX - r * 0.02, by - r * 0.015]);
    g.endFill();
    // 끝 보석
    g.beginFill(0xfde047, 0.95);
    g.drawCircle(tx, ty + r * 0.015, 2.4);
    g.endFill();
    g.beginFill(0xffffff, 0.95);
    g.drawCircle(tx - 0.6, ty, 1);
    g.endFill();
  });

  // ── 날개 형태 2개 (빛 날개, 좌우로 퍼지는 깃털 같은 삼각형들) ──
  [-1, 1].forEach(side => {
    for (let k = 0; k < 5; k++) {
      const baseX = side * r * 0.7;
      const baseY = -r * 0.15 + k * r * 0.15;
      const tipAngle = side * (Math.PI * 0.2 + k * Math.PI * 0.08);
      const len = r * (0.6 - k * 0.06);
      const tipX = baseX + Math.cos(tipAngle + (side > 0 ? 0 : Math.PI)) * len;
      const tipY = baseY + Math.sin(tipAngle + (side > 0 ? 0 : Math.PI)) * len * 0.3;
      const pts = [
        baseX, baseY - 3,
        tipX, tipY,
        baseX, baseY + 3,
      ];
      g.beginFill(0xfbbf24, 0.45);
      g.drawPolygon(pts);
      g.endFill();
      g.beginFill(0xfde047, 0.35);
      g.drawPolygon(pts);
      g.endFill();
    }
  });

  // ── 중앙 슬릿 눈 (금색, 신성함) ──
  const eyeY = 0;
  const eyeX = r * 0.15;
  g.beginFill(0x7c2d12, 0.95);
  g.drawEllipse(-eyeX, eyeY, 3.5, 1.8);
  g.drawEllipse(eyeX, eyeY, 3.5, 1.8);
  g.endFill();
  g.beginFill(0xffffff, 0.92);
  g.drawEllipse(-eyeX, eyeY, 2.2, 0.9);
  g.drawEllipse(eyeX, eyeY, 2.2, 0.9);
  g.endFill();
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
  g.drawPolygon(polygonPoints(massPts.map(p => ({ x: p.x * 0.9, y: p.y * 0.9 }))));
  g.endFill();
  g.beginFill(0x1e1b4b, 0.9);
  g.drawPolygon(polygonPoints(massPts.map(p => ({ x: p.x * 0.75, y: p.y * 0.75 }))));
  g.endFill();
  g.beginFill(0x3b0764, 0.82);
  g.drawPolygon(polygonPoints(massPts.map(p => ({ x: p.x * 0.55, y: p.y * 0.55 }))));
  g.endFill();
  g.beginFill(0x581c87, 0.7);
  g.drawPolygon(polygonPoints(massPts.map(p => ({ x: p.x * 0.35, y: p.y * 0.35 }))));
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
    const innerHorn = hornShape.map(p => ({ x: (p.x + baseX) * 0.55, y: (p.y + baseY) * 0.5 }));
    g.drawPolygon(polygonPoints(innerHorn));
    g.endFill();
    g.beginFill(0x3b0764, 0.78);
    const innerHorn2 = hornShape.map(p => ({ x: (p.x + baseX) * 0.3, y: (p.y + baseY) * 0.3 }));
    g.drawPolygon(polygonPoints(innerHorn2));
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
