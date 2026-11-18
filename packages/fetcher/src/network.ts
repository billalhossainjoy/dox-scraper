import { BlockList, isIP } from "node:net";
import ipaddr from "ipaddr.js";

/**
 * Conservative special-purpose ranges. These entries follow the IANA IPv4
 * and IPv6 special-purpose registries, supplemented with unrouted and
 * transition address ranges. A false positive is preferable to SSRF.
 */
const IPV4_BLOCKED: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],       // This network, includes 0.0.0.0
  ["10.0.0.0", 8],      // RFC 1918
  ["100.64.0.0", 10],   // Carrier-grade NAT / shared address space
  ["127.0.0.0", 8],     // Loopback
  ["169.254.0.0", 16],  // Link local / cloud metadata
  ["172.16.0.0", 12],   // RFC 1918
  ["192.0.0.0", 24],    // IETF protocol assignments
  ["192.0.2.0", 24],    // TEST-NET-1
  ["192.88.99.0", 24], // Deprecated 6to4 anycast
  ["192.168.0.0", 16],  // RFC 1918
  ["198.18.0.0", 15],   // Benchmarking networks
  ["198.51.100.0", 24],// TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4],     // Multicast
  ["240.0.0.0", 4],     // Reserved / broadcast
];

const IPV6_BLOCKED: ReadonlyArray<readonly [string, number]> = [
  ["2001::", 23],      // IETF protocol assignments / Teredo
  ["2001:db8::", 32],  // Documentation
  ["2002::", 16],      // 6to4 transition addresses
  ["3fff::", 20],      // Documentation
];

const blockedV4 = new BlockList();
for (const [network, bits] of IPV4_BLOCKED) blockedV4.addSubnet(network, bits, "ipv4");

const blockedV6 = new BlockList();
for (const [network, bits] of IPV6_BLOCKED) blockedV6.addSubnet(network, bits, "ipv6");

const allocatedV6 = new BlockList();
allocatedV6.addSubnet("2000::", 3, "ipv6");

const BLOCKED_NAMES = new Set([
  "localhost",
  "metadata",
  "instance-data",
  "metadata.google",
  "metadata.google.internal",
  "metadata.aws.internal",
  "metadata.azure.internal",
]);

const BLOCKED_SUFFIXES = [
  ".localhost", ".local", ".localdomain", ".internal", ".lan",
  ".home.arpa",
];

/** IPv4-mapped IPv6 addresses are assessed as their embedded IPv4 address. */
export function isPublicIp(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    if (parsed.range() !== "unicast") return false;
    const normalized = parsed.toString();
    if (parsed.kind() === "ipv4") return !blockedV4.check(normalized, "ipv4");
    return allocatedV6.check(normalized, "ipv6") && !blockedV6.check(normalized, "ipv6");
  } catch {
    return false;
  }
}

/** Reject local DNS suffixes, cloud metadata hostnames and single-label hosts. */
export function isAllowedHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host) return false;
  if (isIP(host)) return isPublicIp(host);
  if (!host.includes(".") || BLOCKED_NAMES.has(host)) return false;
  return !BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * DNS rebinding defense: validate *all* A/AAAA results and return the first
 * public answer to pin onto the socket. Never perform a separate unchecked
 * DNS resolution after this function.
 */
export function selectPublicDnsAddress(
  addresses: ReadonlyArray<{ address: string; family: number }>,
): ResolvedAddress {
  if (addresses.length === 0 || addresses.length > 128) {
    throw new Error("DNS answer is empty or exceeds the address limit");
  }
  for (const answer of addresses) {
    if ((answer.family !== 4 && answer.family !== 6) ||
        isIP(answer.address) !== answer.family ||
        !isPublicIp(answer.address)) {
      throw new Error("DNS response contains a non-public or invalid IP address");
    }
  }
  const first = addresses[0]!;
  return { address: first.address, family: first.family as 4 | 6 };
}
