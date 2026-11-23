import { AppPhase } from '../types';

/**
 * Uploaded CSV data is held only in memory, so a division saved in the
 * mapping phase can't resume there after a reload or division switch.
 * Returns the phase to show instead, or null when no redirect is needed.
 */
export const getMappingRecoveryPhase = (phase: AppPhase, hasCSVData: boolean): AppPhase | null =>
  phase === 'mapping' && !hasCSVData ? 'upload' : null;
