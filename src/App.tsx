import { useState } from 'react';
import SurvivorsGame from './game/SurvivorsGame';
import AtomSoundLab from './sound/AtomSoundLab';
import './App.css';

function App() {
  const [labOpen, setLabOpen] = useState(true);

  return (
    <div className="app-root">
      <SurvivorsGame />
      {labOpen && <AtomSoundLab onContinue={() => setLabOpen(false)} />}
    </div>
  );
}

export default App;
