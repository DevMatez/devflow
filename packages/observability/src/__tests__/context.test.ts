import { describe, expect, it } from 'vitest';
import { runWithCorrelationId, getCorrelationId, generateCorrelationId } from '../context';

describe('correlation context', () => {
  it('returns undefined outside any context', () => {
    expect(getCorrelationId()).toBeUndefined();
  });

  it('exposes the id inside runWithCorrelationId', () => {
    const id = generateCorrelationId();

    runWithCorrelationId(id, () => {
      expect(getCorrelationId()).toBe(id);
    });
  });

  it('isolates nested contexts', () => {
    runWithCorrelationId('outer', () => {
      runWithCorrelationId('inner', () => {
        expect(getCorrelationId()).toBe('inner');
      });
      expect(getCorrelationId()).toBe('outer');
    });
  });

  it('generates unique ids', () => {
    expect(generateCorrelationId()).not.toBe(generateCorrelationId());
  });
});
