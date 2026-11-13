/** What happened when we tried to hand a message to its destination. */
export type AttemptOutcome =
  | {
      readonly kind: 'response';
      readonly status: number;
      /** Parsed `Retry-After`, in milliseconds from now (rule D7). */
      readonly retryAfterMs?: number;
    }
  | { readonly kind: 'timeout'; readonly timeoutMs: number }
  | { readonly kind: 'network_error'; readonly message: string };

export type OutcomeClass = 'success' | 'retryable' | 'permanent';

/**
 * D3: success is a 2xx. D4: timeouts, network errors, 5xx, 408 and 429 are temporary and retried.
 * D5: every other status is permanent. Redirects (3xx) are not followed (an SSRF vector) and are
 * treated as a misconfigured target, which retrying would not fix.
 */
export function classifyOutcome(outcome: AttemptOutcome): OutcomeClass {
  switch (outcome.kind) {
    case 'timeout':
    case 'network_error':
      return 'retryable';
    case 'response': {
      const { status } = outcome;
      if (status >= 200 && status < 300) return 'success';
      if (status >= 500 || status === 408 || status === 429) return 'retryable';
      return 'permanent';
    }
  }
}

export function describeOutcome(outcome: AttemptOutcome): string {
  switch (outcome.kind) {
    case 'response':
      return `HTTP ${outcome.status}`;
    case 'timeout':
      return `Timed out after ${outcome.timeoutMs} ms`;
    case 'network_error':
      return `Network error: ${outcome.message}`;
  }
}
