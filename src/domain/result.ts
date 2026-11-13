/** Expected outcomes are values, not exceptions: callers must handle the failure branch. */
export type Result<T, E = DomainError> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** Mapped to an HTTP status by the http layer (validation → 400, not_found → 404, conflict → 409). */
export type ErrorType = 'validation' | 'not_found' | 'conflict' | 'business_rule';

export interface DomainError {
  /** Stable, machine-readable code, e.g. `Delivery.NotDead`. */
  readonly code: string;
  readonly message: string;
  readonly type: ErrorType;
}
