import { describe, expect, it } from 'vitest';
import { cn } from '@/lib/utils/cn';

describe('cn', () => {
  it('joins class names and skips falsy values', () => {
    expect(cn('a', false, 'b', null, undefined)).toBe('a b');
  });

  it('dedupes conflicting Tailwind classes', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
  });
});
