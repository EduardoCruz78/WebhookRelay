import { describe, expect, it } from 'vitest';

import { bearerMatches, Metrics } from '../../src/infrastructure/observability/metrics.js';
import { installShutdown } from '../../src/infrastructure/observability/shutdown.js';
import { aDelivery } from '../support/builders.js';

const silentLog = { info: () => undefined, error: () => undefined };

describe('installShutdown', () => {
  it('runs the steps in order, then exits 0', async () => {
    const calls: string[] = [];
    const exits: number[] = [];
    const shutdown = installShutdown({
      log: silentLog,
      timeoutMs: 1_000,
      signals: [],
      exit: (code) => exits.push(code),
      steps: [
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          calls.push('http');
        },
        async () => {
          calls.push('worker and pool');
        },
      ],
    });

    await shutdown('SIGTERM');

    expect(calls).toEqual(['http', 'worker and pool']);
    expect(exits).toEqual([0]);
  });

  it('runs only once even if the signal arrives twice', async () => {
    let runs = 0;
    const shutdown = installShutdown({
      log: silentLog,
      timeoutMs: 1_000,
      signals: [],
      exit: () => undefined,
      steps: [
        async () => {
          runs++;
        },
      ],
    });

    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);

    expect(runs).toBe(1);
  });

  it('exits 1 when a step fails', async () => {
    const exits: number[] = [];
    const shutdown = installShutdown({
      log: silentLog,
      timeoutMs: 1_000,
      signals: [],
      exit: (code) => exits.push(code),
      steps: [() => Promise.reject(new Error('pool already closed'))],
    });

    await shutdown('SIGTERM');

    expect(exits).toEqual([1]);
  });

  it('gives up after the timeout instead of hanging forever', async () => {
    const exits: number[] = [];
    void installShutdown({
      log: silentLog,
      timeoutMs: 50,
      signals: [],
      exit: (code) => exits.push(code),
      steps: [() => new Promise<void>(() => undefined)],
    })('SIGTERM');

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(exits).toEqual([1]);
  });
});

describe('Metrics', () => {
  it('counts attempts by channel and resulting status, and times them', async () => {
    const metrics = new Metrics();

    metrics.recordDelivery(
      {
        kind: 'attempted',
        delivery: aDelivery({ status: 'failed', attempts: 1 }),
        result: {
          outcome: { kind: 'response', status: 503 },
          responseSnippet: null,
          durationMs: 120,
        },
      },
      'webhook',
    );
    metrics.recordDelivery({ kind: 'skipped', reason: 'not due yet' }, 'webhook');

    const text = await metrics.registry.metrics();
    expect(text).toContain('deliveries_total{channel="webhook",status="failed"} 1');
    expect(text).toContain(
      'delivery_duration_seconds_count{channel="webhook",outcome="retryable"} 1',
    );
    expect(text).not.toContain('status="skipped"');
  });

  it('reads the queue depth on every scrape', async () => {
    let waiting = 3;
    const metrics = new Metrics(async () => ({ created: waiting }));

    expect(await metrics.registry.metrics()).toContain('queue_depth{state="created"} 3');
    waiting = 0;
    expect(await metrics.registry.metrics()).toContain('queue_depth{state="created"} 0');
  });
});

describe('bearerMatches', () => {
  it('accepts only the exact token', () => {
    expect(bearerMatches('Bearer metrics-token-123456', 'metrics-token-123456')).toBe(true);
    expect(bearerMatches('Bearer metrics-token-12345', 'metrics-token-123456')).toBe(false);
    expect(bearerMatches(undefined, 'metrics-token-123456')).toBe(false);
  });
});
