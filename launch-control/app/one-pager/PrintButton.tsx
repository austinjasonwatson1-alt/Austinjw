'use client';

import s from './onepager.module.css';

export default function PrintButton() {
  return (
    <button type="button" className={s.print} onClick={() => window.print()}>
      Save as PDF
    </button>
  );
}
