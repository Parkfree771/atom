import { useState } from 'react';
import SurvivorsGame from './game/SurvivorsGame';
import AtomSoundLab from './sound/AtomSoundLab';
import './App.css';

// Open Sound Lab automatically only in dev builds with ?lab=1.
const LAB_DEFAULT_OPEN = import.meta.env.DEV
  && new URLSearchParams(window.location.search).get('lab') === '1';

function App() {
  const [labOpen, setLabOpen] = useState(LAB_DEFAULT_OPEN);

  return (
    <>
      <div className="size-warning">
        <div className="icon">📱</div>
        <h1>화면을 가로로 돌려주세요</h1>
        <p>이 게임은 가로 모드에서 플레이하도록 설계되었습니다. 기기를 가로로 회전하면 자동으로 시작됩니다.</p>
      </div>
      <div className="app-root">
        <SurvivorsGame />
        {labOpen && <AtomSoundLab onContinue={() => setLabOpen(false)} />}
      </div>
    </>
  );
}

export default App;
