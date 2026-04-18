import { useState } from 'react';
import { ElementType, LevelEvent, LevelEventResolution } from '../types';

const SUIT_SYMBOL: Record<ElementType, string> = {
  '물': '💧',
  '흙': '⛰️',
  '불': '🔥',
  '빛': '✨',
  '전기': '⚡',
  '암흑': '🌑',
};

const SUIT_HEX: Record<ElementType, string> = {
  '물': '#3b82f6',
  '흙': '#a16207',
  '불': '#ef4444',
  '빛': '#fef08a',
  '전기': '#a78bfa',
  '암흑': '#7c3aed',
};

interface Props {
  event: LevelEvent | null;
  onResolve: (r: LevelEventResolution) => void;
}

export function LevelUpOverlay({ event, onResolve }: Props) {
  if (!event) return null;

  return (
    <div style={overlayStyle}>
      <div style={panelStyle}>
        <div style={headerStyle}>Level {event.level}</div>
        {event.kind === 'element_select' && (
          <ElementSelectView event={event} onResolve={onResolve} />
        )}
        {event.kind === 'element_place' && (
          <ElementPlaceView event={event} onResolve={onResolve} />
        )}
        {event.kind === 'stat_upgrade' && (
          <StatUpgradeView event={event} onResolve={onResolve} />
        )}
      </div>
    </div>
  );
}

function ElementSelectView({ event, onResolve }: Pick<Props, 'event' | 'onResolve'>) {
  const choices = event!.elementChoices || [];
  const weaponIdx = event!.targetWeaponIndex ?? 0;
  return (
    <>
      <div style={subtitleStyle}>
        속성 선택 — 무기 {weaponIdx + 1}번의 첫 칸에 배치됩니다
      </div>
      <div style={rowStyle}>
        {choices.map((el) => (
          <ElementCard
            key={el}
            element={el}
            onClick={() => onResolve({ kind: 'element_select', element: el })}
          />
        ))}
      </div>
    </>
  );
}

function ElementPlaceView({ event, onResolve }: Pick<Props, 'event' | 'onResolve'>) {
  const choices = event!.elementChoices || [];
  const slots = event!.slotsSnapshot || [[null, null, null], [null, null, null], [null, null, null]];
  const [picked, setPicked] = useState<ElementType | null>(null);

  function handleSlotClick(weaponIndex: number, slotIndex: number) {
    if (!picked) return;
    if (slots[weaponIndex][slotIndex] !== null) return;
    onResolve({ kind: 'element_place', element: picked, weaponIndex, slotIndex });
  }

  return (
    <>
      <div style={subtitleStyle}>
        {picked ? (
          <>
            <b style={{ color: SUIT_HEX[picked] }}>{SUIT_SYMBOL[picked]} {picked}</b>
            {' '}을(를) 배치할 <b>빈 칸</b>을 선택하세요
          </>
        ) : (
          '① 속성 하나를 선택하세요'
        )}
      </div>

      {/* 속성 후보 */}
      <div style={{ ...rowStyle, marginBottom: 22 }}>
        {choices.map((el) => {
          const isPicked = picked === el;
          return (
            <ElementCard
              key={el}
              element={el}
              size={96}
              selected={isPicked}
              onClick={() => setPicked(el)}
            />
          );
        })}
      </div>

      {/* 슬롯 그리드 */}
      <div style={{ fontSize: 12, color: '#a0a7b8', textAlign: 'center', marginBottom: 8 }}>
        ② 배치할 슬롯
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' }}>
        {slots.map((slotElements, w) => (
          <div key={w} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 44, fontSize: 12, color: '#7a8299', textAlign: 'right' }}>
              무기 {w + 1}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {slotElements.map((el, s) => {
                const filled = el !== null;
                const clickable = !filled && picked !== null;
                return (
                  <button
                    key={s}
                    onClick={() => handleSlotClick(w, s)}
                    disabled={!clickable}
                    style={{
                      width: 52,
                      height: 52,
                      borderRadius: 8,
                      background: filled
                        ? `linear-gradient(135deg, ${SUIT_HEX[el!]}33, #0b0d14)`
                        : '#1a1e2a',
                      border: filled
                        ? `2px solid ${SUIT_HEX[el!]}`
                        : clickable
                          ? '2px dashed #4b5566'
                          : '2px dashed #2a2f3d',
                      color: '#fff',
                      cursor: clickable ? 'pointer' : 'default',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: filled ? 26 : 20,
                      opacity: filled || clickable ? 1 : 0.45,
                      transition: 'transform 0.1s, border-color 0.1s',
                    }}
                    onMouseEnter={(e) => {
                      if (clickable) {
                        (e.currentTarget as HTMLElement).style.transform = 'scale(1.08)';
                        (e.currentTarget as HTMLElement).style.borderColor = SUIT_HEX[picked!];
                      }
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.transform = 'scale(1)';
                      if (clickable) (e.currentTarget as HTMLElement).style.borderColor = '#4b5566';
                    }}
                  >
                    {filled ? SUIT_SYMBOL[el!] : clickable ? '+' : ''}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function StatUpgradeView({ event, onResolve }: Pick<Props, 'event' | 'onResolve'>) {
  const choices = event!.statChoices || [];
  return (
    <>
      <div style={subtitleStyle}>스탯 강화 — 하나를 선택하세요</div>
      <div style={rowStyle}>
        {choices.map((c) => (
          <button
            key={c.id}
            onClick={() => onResolve({ kind: 'stat_upgrade', choiceId: c.id })}
            style={statCardStyle}
          >
            <div style={{ fontSize: 44, lineHeight: 1 }}>{c.icon}</div>
            <div style={{ fontWeight: 700, marginTop: 10, fontSize: 16 }}>{c.label}</div>
            <div style={{ fontSize: 12, marginTop: 8, opacity: 0.8 }}>{c.description}</div>
          </button>
        ))}
      </div>
    </>
  );
}

export function ElementCard({ element, onClick, size = 110, selected = false }: {
  element: ElementType;
  onClick?: () => void;
  size?: number;
  selected?: boolean;
}) {
  const color = SUIT_HEX[element];
  const symbol = SUIT_SYMBOL[element];
  return (
    <button
      onClick={onClick}
      style={{
        width: size,
        height: size * 1.3,
        borderRadius: 10,
        background: selected
          ? `radial-gradient(circle at 50% 30%, ${color}55, #11131a)`
          : `radial-gradient(circle at 50% 30%, ${color}22, #11131a)`,
        border: `${selected ? 3 : 2}px solid ${color}`,
        boxShadow: selected ? `0 0 16px ${color}99` : 'none',
        color: '#fff',
        cursor: onClick ? 'pointer' : 'default',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        padding: 8,
        transform: selected ? 'translateY(-4px)' : 'none',
        transition: 'transform 0.12s, box-shadow 0.12s, background 0.12s',
      }}
      onMouseEnter={(e) => {
        if (onClick && !selected) (e.currentTarget as HTMLElement).style.transform = 'scale(1.05)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.transform = selected ? 'translateY(-4px)' : 'scale(1)';
      }}
    >
      <div style={{ fontSize: size * 0.33 }}>{symbol}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color }}>{element}</div>
    </button>
  );
}

// ── styles ──
const overlayStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'rgba(0,0,0,0.75)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 100,
};

const panelStyle: React.CSSProperties = {
  background: '#151822',
  color: '#fff',
  padding: '24px 28px',
  borderRadius: 12,
  minWidth: 420,
  maxWidth: 640,
  border: '1px solid #2a2f3d',
  boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
};

const headerStyle: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 800,
  letterSpacing: 2,
  color: '#fbbf24',
  textAlign: 'center',
  marginBottom: 6,
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#a0a7b8',
  textAlign: 'center',
  marginBottom: 18,
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 14,
  justifyContent: 'center',
  flexWrap: 'wrap',
};

const statCardStyle: React.CSSProperties = {
  width: 150,
  minHeight: 170,
  borderRadius: 10,
  background: '#1e2230',
  border: '1px solid #333a4d',
  color: '#fff',
  cursor: 'pointer',
  padding: 14,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  textAlign: 'center',
  transition: 'transform 0.1s, border-color 0.1s',
};
