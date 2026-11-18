import { describe, expect, it } from "vitest";
import {
  isAllowedHostname,
  isPublicIp,
  selectPublicDnsAddress,
} from "./network.js";

describe("SSRF-resistant IP policy", () => {
  it.each([
    "0.0.0.0",
    "0.0.0.42",
    "10.1.2.3",
    "100.64.0.1",
    "100.100.100.200", // Alibaba cloud metadata address
    "127.0.0.1",
    "169.254.169.254", // AWS, Azure, GCP cloud metadata
    "172.16.0.1",
    "172.31.255.254",
    "192.0.0.1",
    "192.0.2.8",
    "192.88.99.1",
    "192.168.1.2",
    "198.18.0.1",
    "198.19.255.254",
    "198.51.100.2",
    "203.0.113.5",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:100.100.100.200",
    "fe80::1",
    "fc00::1",
    "fd00:ec2::254", // AWS IPv6 metadata
    "ff02::1",
    "2001:db8::1",
    "2001::1",
    "2002:c0a8:0101::1", // 6to4 containing private IPv4
    "3fff::10",
    "not-an-ip",
  ])("rejects non-public or special-use IP %s", (address) => {
    expect(isPublicIp(address)).toBe(false);
  });

  it.each([
    "1.1.1.1",
    "8.8.8.8",
    "9.9.9.9",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8",
  ])("allows ordinary public IP %s", (address) => {
    expect(isPublicIp(address)).toBe(true);
  });
});

describe("metadata and local hostname policy", () => {
  it.each([
    "localhost",
    "localhost.",
    "sub.localhost",
    "metadata",
    "instance-data",
    "metadata.google.internal",
    "metadata.aws.internal",
    "metadata.google",
    "printer",
    "intranet",
    "api.internal",
    "router.lan",
    "service.localdomain",
    "devices.local",
    "metadata.home.arpa",
    "127.0.0.1",
    "[::1]",
  ])("rejects local or cloud metadata host %s", (hostname) => {
    expect(isAllowedHostname(hostname)).toBe(false);
  });

  it.each([
    "example.com",
    "example.com.",
    "docs.example.com",
    "8.8.8.8",
    "2606:4700:4700::1111",
  ])("accepts ordinary public host %s", (hostname) => {
    expect(isAllowedHostname(hostname)).toBe(true);
  });
});

describe("DNS answer pinning", () => {
  it("returns a public address/family that can be pinned onto the socket", () => {
    expect(selectPublicDnsAddress([
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ])).toEqual({ address: "8.8.8.8", family: 4 });
  });

  it.each([
    [{ address: "127.0.0.1", family: 4 }],
    [{ address: "169.254.169.254", family: 4 }],
    [{ address: "::1", family: 6 }],
    [{ address: "100.64.0.5", family: 4 }],
    [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.3", family: 4 }],
    [{ address: "8.8.8.8", family: 4 }, { address: "fe80::1", family: 6 }],
    [{ address: "::ffff:127.0.0.1", family: 6 }],
    [{ address: "8.8.8.8", family: 6 }],
    [{ address: "bogus", family: 4 }],
  ])("rejects all DNS answer sets containing private or invalid addresses", (answers) => {
    expect(() => selectPublicDnsAddress(answers)).toThrow();
  });

  it("fails closed on empty or oversized DNS answers", () => {
    expect(() => selectPublicDnsAddress([])).toThrow();
    expect(() => selectPublicDnsAddress(
      Array.from({ length: 129 }, () => ({ address: "8.8.8.8", family: 4 })),
    )).toThrow();
  });
});
