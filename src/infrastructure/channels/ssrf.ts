import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { promises as dns } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { isIP } from 'node:net';

import { Agent } from 'undici';

import { isPublicAddress, unbracket } from '../../domain/network-policy.js';

export const BLOCKED_ADDRESS_CODE = 'EBLOCKEDADDRESS';

export class BlockedAddressError extends Error {
  override readonly name = 'BlockedAddressError';
  readonly code = BLOCKED_ADDRESS_CODE;

  constructor(
    readonly hostname: string,
    readonly address: string,
  ) {
    super(`${hostname} resolves to ${address}, which is not a public address`);
  }
}

/**
 * A DNS lookup that refuses non-public addresses. Plugged into the HTTP agent, it runs on every
 * new connection, so the address actually connected to is the one checked. Checking only when
 * the subscription is saved would miss DNS rebinding: a domain that resolved to a public IP at
 * registration and to 127.0.0.1 a minute later.
 */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) {
      callback(error, '', 0);
      return;
    }
    const blocked = addresses.find((entry) => !isPublicAddress(entry.address));
    if (blocked) {
      callback(new BlockedAddressError(hostname, blocked.address), '', 0);
      return;
    }
    if (options.all) {
      // Node's typings model only the single-address callback form.
      (callback as unknown as (err: null, addresses: LookupAddress[]) => void)(null, addresses);
      return;
    }
    const [first] = addresses;
    if (!first) {
      callback(
        Object.assign(new Error(`No address for ${hostname}`), { code: 'ENOTFOUND' }),
        '',
        0,
      );
      return;
    }
    callback(null, first.address, first.family);
  });
};

/** The undici agent used for deliveries when private targets are not allowed. */
export function createPublicOnlyAgent(): Agent {
  return new Agent({ connect: { lookup: publicOnlyLookup } });
}

/** IP literals never go through DNS, so the lookup above does not see them: check them directly. */
export function blockedLiteral(url: URL): string | undefined {
  const host = unbracket(url.hostname);
  return isIP(host) !== 0 && !isPublicAddress(host) ? host : undefined;
}

export type HostCheck = 'public' | 'not_public' | 'unresolvable';

/** Registration-time check: every address the name resolves to must be public. */
export async function checkHost(hostname: string): Promise<HostCheck> {
  const host = unbracket(hostname);
  if (isIP(host) !== 0) return isPublicAddress(host) ? 'public' : 'not_public';
  try {
    const addresses = await dns.lookup(host, { all: true, order: 'verbatim' });
    if (addresses.length === 0) return 'unresolvable';
    return addresses.every((entry) => isPublicAddress(entry.address)) ? 'public' : 'not_public';
  } catch {
    return 'unresolvable';
  }
}
