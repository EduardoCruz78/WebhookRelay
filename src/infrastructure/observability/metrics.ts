import { timingSafeEqual } from 'node:crypto';

import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

import type { DeliverOutcome } from '../../application/deliver.js';
import { classifyOutcome } from '../../domain/attempt-outcome.js';
import type { Channel } from '../../domain/subscription.js';

/**
 * Prometheus metrics for one process. A registry per instance (not prom-client's global one) keeps
 * tests isolated and lets the web and worker processes each expose their own numbers.
 */
export class Metrics {
  readonly registry = new Registry();

  /** Every attempt, by channel and resulting delivery status (succeeded, failed, dead). */
  readonly deliveries = new Counter({
    name: 'deliveries_total',
    help: 'Delivery attempts by channel and resulting status',
    labelNames: ['channel', 'status'] as const,
    registers: [this.registry],
  });

  /** How long destinations take to answer: the p95 of this is the first thing to alert on. */
  readonly deliveryDuration = new Histogram({
    name: 'delivery_duration_seconds',
    help: 'Time spent on one delivery attempt',
    labelNames: ['channel', 'outcome'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  readonly events = new Counter({
    name: 'events_received_total',
    help: 'Events accepted by POST /events, new or duplicate',
    labelNames: ['source', 'duplicate'] as const,
    registers: [this.registry],
  });

  readonly httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP requests served, by route template and status code',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [this.registry],
  });

  constructor(queueDepth?: () => Promise<Record<string, number>>) {
    collectDefaultMetrics({ register: this.registry });
    if (queueDepth) {
      // Read on every scrape, so the gauge is never stale.
      new Gauge({
        name: 'queue_depth',
        help: 'Delivery jobs in the queue by state (created = waiting, active = being delivered)',
        labelNames: ['state'] as const,
        registers: [this.registry],
        async collect() {
          this.reset();
          for (const [state, count] of Object.entries(await queueDepth()))
            this.set({ state }, count);
        },
      });
    }
  }

  recordDelivery(outcome: DeliverOutcome, channel: Channel | undefined): void {
    if (outcome.kind === 'skipped') return;
    const label = channel ?? 'unknown';
    this.deliveries.inc({ channel: label, status: outcome.delivery.status });
    if (outcome.kind === 'attempted') {
      this.deliveryDuration.observe(
        { channel: label, outcome: classifyOutcome(outcome.result.outcome) },
        outcome.result.durationMs / 1000,
      );
    }
  }
}

/** Constant-time check of `Authorization: Bearer <token>` for the metrics endpoints. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const received = Buffer.from(header?.replace(/^Bearer /, '') ?? '');
  const expected = Buffer.from(token);
  return received.length === expected.length && timingSafeEqual(received, expected);
}
