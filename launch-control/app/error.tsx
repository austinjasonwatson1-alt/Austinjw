'use client';

import s from '@/components/lc.module.css';

/** Last-resort error screen: never a blank page in front of an audience. */
export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <section className={s.band}>
      <div className={s.wrap}>
        <h1>Something went wrong loading Launch Control</h1>
        <p className={s.sub}>Your data is safe; nothing was written. Try again, or reload the page to start from demo data.</p>
        <div className={s.btns}>
          <button type="button" className={s.go} onClick={reset}>
            Try again
          </button>
          <button
            type="button"
            className={s.ghost}
            onClick={() => {
              try {
                localStorage.removeItem('lc-source');
              } catch {
                /* ignore */
              }
              location.reload();
            }}
          >
            Reload with demo data
          </button>
        </div>
      </div>
    </section>
  );
}
