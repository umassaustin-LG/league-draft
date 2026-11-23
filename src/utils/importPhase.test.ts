import { describe, expect, it } from 'vitest';
import { AppPhase } from '../types';
import { getMappingRecoveryPhase } from './importPhase';

describe('getMappingRecoveryPhase', () => {
  it('sends a resumed mapping phase without CSV data back to upload', () => {
    expect(getMappingRecoveryPhase('mapping', false)).toBe('upload');
  });

  it('keeps the mapping phase while the uploaded CSV is still in memory', () => {
    expect(getMappingRecoveryPhase('mapping', true)).toBeNull();
  });

  it('leaves every other phase alone', () => {
    const phases: AppPhase[] = ['upload', 'review', 'config', 'draft', 'complete'];
    for (const phase of phases) {
      expect(getMappingRecoveryPhase(phase, false)).toBeNull();
    }
  });
});
