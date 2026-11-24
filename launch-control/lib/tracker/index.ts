import { demoSource } from './demo';
import type { SourceKind, TrackerSource } from './types';

export * from './types';
export { demoSnapshot, demoSource } from './demo';

/** Adapter registry. The Linear adapter is added in M3. */
export function getSource(kind: SourceKind): TrackerSource | null {
  if (kind === 'demo') return demoSource;
  return null;
}
