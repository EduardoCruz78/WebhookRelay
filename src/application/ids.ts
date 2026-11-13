import { v7 } from 'uuid';

/**
 * UUID v7: time-ordered, so new rows land at the right edge of the primary-key B-tree instead of
 * scattering across it like random v4 ids (less index fragmentation, better cache locality).
 */
export const newId = (): string => v7();
