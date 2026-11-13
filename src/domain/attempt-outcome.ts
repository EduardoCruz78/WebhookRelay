/** What happened when we tried to hand a message to its destination. */
export type AttemptOutcome =
  | {
      readonly kind: 'response';
      readonly status: number;
      /** Parsed `Retry-After`, in milliseconds from now (rule D7). */
      readonly retryAfterMs?: number;
    }
  | { readonly kind: 'timeout'; readonly timeoutMs: number }
  | { readonly kind: 'network_error'; readonly message: string }
  /** Refused before sending: the target resolves to a private or reserved address (SSRF). */
  | { readonly kind: 'blocked'; readonly reason: string }
  /** A non-HTTP channel (SMTP) took the message. */
  | { readonly kind: 'accepted'; readonly detail: string }
  /**
   * A non-HTTP channel refused it. The channel decides whether that is temporary, because status
   * codes mean different things per protocol: SMTP 4xx is temporary, HTTP 4xx is not.
   */
  | { readonly kind: 'rejected'; readonly retryable: boolean; readonly reason: string };

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
    case 'blocked':
      return 'permanent';
    case 'accepted':
      return 'success';
    case 'rejected':
      return outcome.retryable ? 'retryable' : 'permanent';
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
    case 'blocked':
      return `Blocked: ${outcome.reason}`;
    case 'accepted':
      return `Accepted: ${outcome.detail}`;
    case 'rejected':
      return `Rejected: ${outcome.reason}`;
  }
}
