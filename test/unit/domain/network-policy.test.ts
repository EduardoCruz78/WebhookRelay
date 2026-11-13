import { describe, expect, it } from 'vitest';

import { isPublicAddress, unbracket } from '../../../src/domain/network-policy.js';

describe('isPublicAddress', () => {
  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.15.255.255',
    '172.32.0.1',
    '192.169.0.1',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
  ])('allows the public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback range'],
    ['10.0.0.5', 'private 10/8'],
    ['172.16.0.1', 'private 172.16/12'],
    ['172.31.255.255', 'private 172.16/12 upper end'],
    ['192.168.1.1', 'private 192.168/16'],
    ['169.254.169.254', 'cloud metadata (link-local)'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['0.0.0.0', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['::1', 'IPv6 loopback'],
    ['::', 'IPv6 unspecified'],
    ['fd12:3456::1', 'IPv6 unique local'],
    ['fe80::1', 'IPv6 link-local'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:a9fe:a9fe', 'IPv4-mapped metadata in hex form'],
    ['64:ff9b::7f00:1', 'NAT64 loopback'],
  ])('blocks %s (%s)', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['localhost', 'example.com', '', '999.1.1.1', '1.2.3'])(
    'rejects the non-address %j',
    (value) => {
      expect(isPublicAddress(value)).toBe(false);
    },
  );
});

describe('unbracket', () => {
  it('removes the brackets URL hostnames put around IPv6 literals', () => {
    expect(unbracket('[::1]')).toBe('::1');
    expect(unbracket('example.com')).toBe('example.com');
  });
});
