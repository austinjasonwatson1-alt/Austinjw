import s from './lc.module.css';

/** Join CSS-module class names: cx('row', on && 'on'). */
export const cx = (...names: (string | false | null | undefined)[]): string =>
  names
    .filter((n): n is string => !!n)
    .map((n) => s[n] ?? n)
    .join(' ');

export { s };
