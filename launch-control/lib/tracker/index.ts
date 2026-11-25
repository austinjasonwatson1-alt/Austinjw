import { demoSource } from './demo';
import { linearConfigured, linearSource } from './linear';
import type { SourceKind, TrackerSource } from './types';

export * from './types';
export { demoSnapshot, demoSource } from './demo';

/** Adapter registry. Returns null when the source isn't configured (e.g. no Linear key). */
export function getSource(kind: SourceKind): TrackerSource | null {
  if (kind === 'demo') return demoSource;
  if (kind === 'linear') return linearConfigured() ? linearSource : null;
  return null;
}
