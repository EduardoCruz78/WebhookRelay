import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  it('applies defaults when variables are absent', () => {
    const config = loadConfig({});

    expect(config).toEqual({
      NODE_ENV: 'development',
      HOST: '0.0.0.0',
      PORT: 3000,
      LOG_LEVEL: 'info',
    });
  });

  it('coerces PORT from a string', () => {
    expect(loadConfig({ PORT: '8080' }).PORT).toBe(8080);
  });

  it('rejects an invalid PORT with a readable message', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/PORT/);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });
});
