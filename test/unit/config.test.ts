import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../../src/config.js';

const DATABASE_URL = 'postgres://user:pass@localhost:5434/webhook_relay';

describe('loadConfig', () => {
  it('applies defaults when optional variables are absent', () => {
    expect(loadConfig({ DATABASE_URL })).toEqual({
      NODE_ENV: 'development',
      HOST: '0.0.0.0',
      PORT: 3000,
      LOG_LEVEL: 'info',
      DATABASE_URL,
      DATABASE_POOL_SIZE: 10,
      MIGRATE_ON_START: false,
      RUN_WORKER: false,
      DELIVERY_TIMEOUT_MS: 10_000,
      WORKER_CONCURRENCY: 5,
      ALLOW_PRIVATE_TARGETS: false,
      ALLOW_HTTP_TARGETS: false,
      EMAIL_FROM: 'WebhookRelay <relay@localhost>',
      TELEGRAM_API_URL: 'https://api.telegram.org',
      WORKER_METRICS_PORT: 9091,
    });
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('accepts both postgres:// and postgresql:// URLs (Neon uses the latter)', () => {
    const neon = 'postgresql://user:pass@ep-x.us-east-1.aws.neon.tech/db?sslmode=require';
    expect(loadConfig({ DATABASE_URL: neon }).DATABASE_URL).toBe(neon);
  });

  it('rejects a non-PostgreSQL URL', () => {
    expect(() => loadConfig({ DATABASE_URL: 'mysql://localhost/db' })).toThrow(/DATABASE_URL/);
  });

  it('coerces PORT from a string', () => {
    expect(loadConfig({ DATABASE_URL, PORT: '8080' }).PORT).toBe(8080);
  });

  it('rejects an invalid PORT with a readable message', () => {
    expect(() => loadConfig({ DATABASE_URL, PORT: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ DATABASE_URL, PORT: '70000' })).toThrow(/PORT/);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => loadConfig({ DATABASE_URL, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('leaves the e-mail and Telegram channels off unless configured', () => {
    const config = loadConfig({ DATABASE_URL });

    expect(config.SMTP_URL).toBeUndefined();
    expect(config.TELEGRAM_BOT_TOKEN).toBeUndefined();
  });

  it('validates the channel settings', () => {
    expect(loadConfig({ DATABASE_URL, SMTP_URL: 'smtp://mailpit:1025' }).SMTP_URL).toBe(
      'smtp://mailpit:1025',
    );
    expect(() => loadConfig({ DATABASE_URL, SMTP_URL: 'http://mailpit' })).toThrow(/SMTP_URL/);
    expect(() => loadConfig({ DATABASE_URL, TELEGRAM_BOT_TOKEN: 'abc' })).toThrow(
      /TELEGRAM_BOT_TOKEN/,
    );
  });

  it('parses MIGRATE_ON_START strictly', () => {
    expect(loadConfig({ DATABASE_URL, MIGRATE_ON_START: 'true' }).MIGRATE_ON_START).toBe(true);
    expect(() => loadConfig({ DATABASE_URL, MIGRATE_ON_START: 'yes' })).toThrow(/MIGRATE_ON_START/);
  });
});
