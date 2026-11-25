import { useState, type CSSProperties } from 'react';
import { CONFIG } from './config';
import { newCareer, seasonLabel } from './career/career';
import { overall } from './career/progression';
import { deleteCareer, exportCode, importCode, loadCareer, saveCareer, SLOTS } from './career/save';
import { readLegacy, readSettings, writeSettings, type Difficulty } from './career/story';
import type { Career } from './career/types';
import { Practice } from './screens/Practice';
import { CareerApp } from './screens/career/CareerApp';

type Screen = { name: 'start' } | { name: 'practice' } | { name: 'create'; slot: number } | { name: 'career'; career: Career };

const STAGE = { hs: 'High school', college: 'College', draft: 'Draft', nfl: 'NFL', retired: 'Retired' };

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'start' });
  const [, refresh] = useState(0);

  if (screen.name === 'practice') return <Practice onExit={() => setScreen({ name: 'start' })} />;
  if (screen.name === 'create') return <CreateKicker slot={screen.slot} onBack={() => setScreen({ name: 'start' })} onCreate={(c) => setScreen({ name: 'career', career: c })} />;
  if (screen.name === 'career') return <CareerApp initial={screen.career} onMenu={() => setScreen({ name: 'start' })} />;

  const slots = SLOTS.map((s) => ({ slot: s, c: loadCareer(s) }));
  return (
    <div className="screen start" style={{ '--accent': CONFIG.practice.accent } as CSSProperties}>
      <div className="start-inner">
        <div className="kicker-tag">A kicker's career</div>
        <h1 className="title">
          Road to the <span>NFL</span>
        </h1>
        <div className="slots">
          {slots.map(({ slot, c }) => (
            <div key={slot} className={`slot ${c ? 'used' : ''}`}>
              <div className="slot-n">Slot {slot}</div>
              {c ? (
                <>
                  <div className="slot-name">{c.kicker.name}</div>
                  <div className="slot-meta">
                    {STAGE[c.stage]}
                    {c.stage !== 'retired' && c.stage !== 'draft' ? ` · ${seasonLabel(c)}` : ''} · {c.team?.short ?? '—'} · OVR {overall(c.skills)} · {c.year}
                  </div>
                  <div className="slot-btns">
                    <button className="primary small" onClick={() => setScreen({ name: 'career', career: c })}>
                      {c.stage === 'retired' ? 'View' : 'Continue'}
                    </button>
                    <CopyCode career={c} />
                    <DeleteButton
                      onDelete={() => {
                        deleteCareer(slot);
                        refresh((n) => n + 1);
                      }}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="slot-name dim">Empty</div>
                  <div className="slot-btns">
                    <button className="ghost small" onClick={() => setScreen({ name: 'create', slot })}>
                      New career
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
        <div className="menu">
          <button className="ghost" onClick={() => setScreen({ name: 'practice' })}>
            Free Practice
          </button>
        </div>
        <Settings />
        <LegacyWall />
        <ImportSave
          used={slots.filter((s) => s.c).map((s) => s.slot)}
          onImported={() => refresh((n) => n + 1)}
        />
      </div>
    </div>
  );
}

function DeleteButton({ onDelete }: { onDelete: () => void }) {
  const [sure, setSure] = useState(false);
  return sure ? (
    <button className="ghost small danger" onClick={onDelete}>
      Delete for good
    </button>
  ) : (
    <button className="ghost small" onClick={() => setSure(true)}>
      Delete
    </button>
  );
}

function CreateKicker({ slot, onBack, onCreate }: { slot: number; onBack: () => void; onCreate: (c: Career) => void }) {
  const [name, setName] = useState(CONFIG.practice.kickerName);
  const [hometown, setHometown] = useState('');
  const [school, setSchool] = useState('');
  const [foot, setFoot] = useState<'R' | 'L'>('R');
  const [number, setNumber] = useState(CONFIG.practice.kickerNumber);
  const ok = name.trim() && school.trim();
  return (
    <div className="screen setup" style={{ '--accent': CONFIG.practice.accent } as CSSProperties}>
      <header className="screen-head">
        <button className="link" onClick={onBack}>
          ← Menu
        </button>
        <h1>Create a kicker</h1>
        <div className="sub">High school junior, ratings in the 40s, a leg good for about 40 yards. Slot {slot}.</div>
      </header>
      <form
        className="card create"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ok) return;
          const seed = Math.floor(Math.random() * 2 ** 31);
          onCreate(newCareer(slot, { name: name.trim(), hometown: hometown.trim(), school: school.trim(), foot, number: number.trim() || '3' }, seed));
        }}
      >
        <label htmlFor="cname">Name</label>
        <input id="cname" value={name} onChange={(e) => setName(e.target.value)} maxLength={28} />
        <label htmlFor="ctown">Hometown</label>
        <input id="ctown" value={hometown} onChange={(e) => setHometown(e.target.value)} placeholder="Where you grew up" maxLength={28} />
        <label htmlFor="cschool">High school</label>
        <input id="cschool" value={school} onChange={(e) => setSchool(e.target.value)} placeholder="e.g. Lakeview High" maxLength={28} />
        <label>Kicking foot</label>
        <div className="seg">
          {(['R', 'L'] as const).map((f) => (
            <button type="button" key={f} className={foot === f ? 'on' : ''} onClick={() => setFoot(f)}>
              {f === 'R' ? 'Right' : 'Left'}
            </button>
          ))}
        </div>
        <label htmlFor="cnum">Jersey number</label>
        <input id="cnum" value={number} onChange={(e) => setNumber(e.target.value.replace(/\D/g, '').slice(0, 2))} inputMode="numeric" />
        <div className="btn-row">
          <button className="primary" type="submit" disabled={!ok}>
            Start career
          </button>
        </div>
      </form>
    </div>
  );
}

function CopyCode({ career }: { career: Career }) {
  const [state, setState] = useState<'idle' | 'copied' | 'show'>('idle');
  const code = state === 'show' ? exportCode(career) : '';
  return (
    <>
      <button
        className="ghost small"
        onClick={() => {
          const text = exportCode(career);
          navigator.clipboard
            .writeText(text)
            .then(() => setState('copied'))
            .catch(() => setState('show'));
        }}
      >
        {state === 'copied' ? 'Copied' : 'Copy save code'}
      </button>
      {state === 'show' && (
        <textarea
          className="code-box"
          readOnly
          value={code}
          aria-label="Save code"
          onFocus={(e) => e.currentTarget.select()}
          autoFocus
        />
      )}
    </>
  );
}

function ImportSave({ used, onImported }: { used: number[]; onImported: () => void }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [slot, setSlot] = useState(SLOTS.find((s) => !used.includes(s)) ?? 1);
  const [msg, setMsg] = useState('');
  const [confirm, setConfirm] = useState(false);
  if (!open)
    return (
      <button className="link import-link" onClick={() => setOpen(true)}>
        Import a save code
      </button>
    );
  const doImport = () => {
    const c = importCode(code, slot);
    if (!c) {
      setMsg("That doesn't look like a save code. Copy it again from the slot's Copy save code button.");
      return;
    }
    if (used.includes(slot) && !confirm) {
      setConfirm(true);
      setMsg(`Slot ${slot} has a career in it. Import again to replace it.`);
      return;
    }
    if (!saveCareer(c)) {
      setMsg('This browser is blocking saved games, so the career cannot be stored here.');
      return;
    }
    setMsg(`Imported ${c.kicker.name} into slot ${slot}.`);
    setCode('');
    setConfirm(false);
    onImported();
  };
  return (
    <div className="import card">
      <label htmlFor="importcode">Paste a save code</label>
      <textarea id="importcode" className="code-box" value={code} onChange={(e) => { setCode(e.target.value); setConfirm(false); }} placeholder="RTN1:..." />
      <div className="seg">
        {SLOTS.map((s) => (
          <button key={s} type="button" className={slot === s ? 'on' : ''} onClick={() => { setSlot(s); setConfirm(false); }}>
            Slot {s}
            {used.includes(s) ? ' (used)' : ''}
          </button>
        ))}
      </div>
      {msg && <p className="note">{msg}</p>}
      <div className="slot-btns">
        <button className="primary small" onClick={doImport} disabled={!code.trim()}>
          {confirm ? 'Replace and import' : 'Import'}
        </button>
        <button className="ghost small" onClick={() => { setOpen(false); setMsg(''); }}>
          Close
        </button>
      </div>
    </div>
  );
}

function Settings() {
  const [st, setSt] = useState(readSettings());
  const set = (d: Difficulty) => {
    writeSettings({ difficulty: d });
    setSt({ ...st, difficulty: d });
  };
  return (
    <div className="settings">
      <div className="settings-row">
        <span className="settings-l">Difficulty</span>
        <div className="seg">
          {(['easy', 'normal', 'hard'] as Difficulty[]).map((d) => (
            <button key={d} className={st.difficulty === d ? 'on' : ''} onClick={() => set(d)}>
              {CONFIG.difficulty[d].label}
            </button>
          ))}
        </div>
      </div>
      <button
        className="link import-link"
        onClick={() => {
          writeSettings({ tutorialDone: false });
          setSt({ ...st, tutorialDone: false });
        }}
      >
        {st.tutorialDone ? 'Show the kicking tutorial again' : 'The kicking tutorial will show on your next kick'}
      </button>
    </div>
  );
}

function LegacyWall() {
  const list = readLegacy();
  if (!list.length) return null;
  return (
    <div className="legacy">
      <div className="settings-l">Legacy wall</div>
      {list.map((e, i) => (
        <div key={i} className="legacy-row">
          <div>
            <div className="legacy-name">{e.name}</div>
            <div className="note">
              {e.years} · {e.points} pts · long {e.longest}
              {e.titles ? ` · ${e.titles} title${e.titles > 1 ? 's' : ''}` : ''}
              {e.honors ? ` · ${e.honors} honors` : ''}
            </div>
          </div>
          <div className="legacy-verdict">{e.verdict}</div>
        </div>
      ))}
    </div>
  );
}
