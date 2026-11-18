import { timingSafeEqual } from "node:crypto";

export function tokenMatches(presented: string, expected: string): boolean {
  const actual = Buffer.from(presented, "utf8");
  const secret = Buffer.from(expected, "utf8");
  return actual.length === secret.length && timingSafeEqual(actual, secret);
}
