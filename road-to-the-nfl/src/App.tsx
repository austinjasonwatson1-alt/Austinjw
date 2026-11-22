import { useState, type CSSProperties } from 'react';
import { CONFIG } from './config';
import { Practice } from './screens/Practice';

type Screen = 'start' | 'practice';

export function App() {
  const [screen, setScreen] = useState<Screen>('start');

  if (screen === 'practice') return <Practice onExit={() => setScreen('start')} />;

  return (
    <div className="screen start" style={{ '--accent': CONFIG.practice.accent } as CSSProperties}>
      <div className="start-inner">
        <div className="kicker-tag">A kicker's career</div>
        <h1 className="title">
          Road to the <span>NFL</span>
        </h1>
        <div className="menu">
          <button className="primary" onClick={() => setScreen('practice')}>
            Free Practice
          </button>
          <button disabled title="Arrives with the high school milestone">
            New Career <small>coming soon</small>
          </button>
          <button disabled title="Arrives with the high school milestone">
            Continue <small>coming soon</small>
          </button>
        </div>
      </div>
    </div>
  );
}
