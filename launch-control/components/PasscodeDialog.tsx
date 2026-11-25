'use client';

import { useEffect, useRef, useState } from 'react';
import { cx } from './cx';

/** Asks once per browser session for the demo passcode that guards Claude runs and Linear writes. */
export default function PasscodeDialog({
  open,
  error,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  error?: string;
  onSubmit: (passcode: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState('');
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setValue('');
      d.showModal();
    }
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog ref={ref} className={cx('dlg')} aria-labelledby="pc-title" onCancel={(e) => (e.preventDefault(), onCancel())}>
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <h2 id="pc-title">Demo passcode</h2>
        <p className={cx('sub')}>
          Running Claude and writing to Linear are protected on this public demo. Enter the passcode once for this
          browser session.
        </p>
        <input
          className={cx('pcin')}
          type="password"
          autoComplete="current-password"
          aria-label="Passcode"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
        {error && (
          <p className={cx('msg', 'bad')} role="alert">
            {error}
          </p>
        )}
        <div className={cx('btns')}>
          <button type="submit" className={cx('go')} disabled={!value.trim()}>
            Continue
          </button>
          <button type="button" className={cx('ghost')} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
