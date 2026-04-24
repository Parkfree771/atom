import { useState } from 'react';
import SurvivorsGame from './game/SurvivorsGame';
import SoundPreviewPanel from './sound/SoundPreviewPanel';
import type { VariantSet } from './sound/types';
import { waterTier1Attacks } from './sound/presets/water/tier1/attack';
import { waterTier1Hits } from './sound/presets/water/tier1/hit';
import './App.css';

const CURRENT_PREVIEW: VariantSet = {
  title: '물 1단계 사운드 프리뷰 · 파동 장판',
  attacks: waterTier1Attacks,
  hits: waterTier1Hits,
  attacksAreContinuous: true,
  attackSectionSubtitle: '플레이어 주변 지속 필드 · 반경 130, 슬로우 유지',
  hitSectionSubtitle: '0.5초마다 넉백 펄스 + 8 피해 시 재생',
};

function App() {
  const [soundPanelOpen, setSoundPanelOpen] = useState(false);

  return (
    <div className="app-root">
      <SurvivorsGame />
      <button
        onClick={() => setSoundPanelOpen(true)}
        style={{
          position: 'fixed', top: 12, right: 12, zIndex: 9998,
          padding: '8px 14px',
          background: 'linear-gradient(180deg, #2563eb, #1d4ed8)',
          color: '#fff', border: 'none', borderRadius: 6,
          fontSize: 13, fontWeight: 600, cursor: 'pointer',
          boxShadow: '0 4px 12px rgba(37, 99, 235, 0.4)',
        }}
      >
        물 1단계 사운드
      </button>
      {soundPanelOpen && (
        <SoundPreviewPanel set={CURRENT_PREVIEW} onClose={() => setSoundPanelOpen(false)} />
      )}
    </div>
  );
}

export default App;
