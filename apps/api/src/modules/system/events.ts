import { z } from 'zod';
import { defineEvent } from '@devflow/events';

/** Wave 0 foundation-proving event — not a real domain event. */
export const SystemPinged = defineEvent({
  type: 'system.pinged',
  schemaVersion: 1,
  schema: z.object({ message: z.string() }),
});
