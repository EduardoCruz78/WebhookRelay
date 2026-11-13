import { BlockList, isIP } from 'node:net';

/**
 * SSRF protection: a webhook service makes HTTP requests to URLs its users choose, so without
 * this list anyone could register http://169.254.169.254/ (cloud metadata, with credentials) or
 * http://10.0.0.5:5432 and use the relay to reach the internal network.
 *
 * Every range below is either private, local, reserved or not routable on the public internet.
 */
// Two lists on purpose: Node's BlockList also matches IPv4 addresses against IPv4-mapped IPv6
// rules, so a single list holding ::ffff:0:0/96 would block every IPv4 address.
const blockedV4 = new BlockList();
const blockedV6 = new BlockList();

const IPV4_RANGES: [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, includes cloud metadata 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes broadcast 255.255.255.255
];

const IPV6_RANGES: [string, number][] = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['::ffff:0:0', 96], // IPv4-mapped: would smuggle any IPv4 address past the IPv4 list
  ['64:ff9b::', 96], // NAT64: same problem
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local (private)
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
];

for (const [network, prefix] of IPV4_RANGES) blockedV4.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of IPV6_RANGES) blockedV6.addSubnet(network, prefix, 'ipv6');

/** True only for a syntactically valid IP address on the public internet. */
export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 0) return false;
  return version === 4 ? !blockedV4.check(address, 'ipv4') : !blockedV6.check(address, 'ipv6');
}

/** `[::1]` → `::1`; URL hostnames keep the brackets around IPv6 literals. */
export function unbracket(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}
