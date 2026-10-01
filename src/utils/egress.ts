import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ValidationError } from "../core/errors.js";

export interface EgressValidateOptions {
  /** Override for EGRESS_ALLOW_HTTP (default reads env). */
  allowHttp?: boolean;
  /** Override for EGRESS_MEDIA_ALLOWLIST (default reads env). */
  allowlist?: string[];
  /** DNS resolver hook for tests (default uses node:dns/promises). */
  resolve?: (hostname: string) => Promise<string[]>;
}

export interface FetchUserMediaOptions {
  timeoutMs?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
}

const MAX_REDIRECTS = 2;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function getTimeoutDefault(): number {
  const raw = Number(process.env.EGRESS_FETCH_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TIMEOUT_MS;
}

function getMaxBytesDefault(): number {
  const raw = Number(process.env.EGRESS_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_BYTES;
}

function getAllowHttpDefault(): boolean {
  return process.env.EGRESS_ALLOW_HTTP === "true";
}

function getAllowlistDefault(): string[] {
  return (process.env.EGRESS_MEDIA_ALLOWLIST ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true });
  return records.map((r) => r.address);
}

function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1).split("%")[0]
    : host;
}

/** inet_aton-style numeric host (e.g. 2130706433, 0x7f.0.0.1) -> dotted quad. */
function dottedFromNumericHost(host: string): string | null {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!p) return null;
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]*$/.test(p) && p.length > 1) n = parseInt(p, 8);
    else if (!/^\d+$/.test(p)) return null;
    else n = parseInt(p, 10);
    if (!Number.isSafeInteger(n) || n < 0) return null;
    nums.push(n);
  }
  let dotted: number[] | null = null;
  if (nums.length === 1) {
    const [n] = nums;
    if (n > 0xffffffff) return null;
    dotted = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  } else if (nums.length === 2) {
    const [a, b] = nums;
    if (a > 255 || b > 0xffffff) return null;
    dotted = [a, (b >>> 16) & 255, (b >>> 8) & 255, b & 255];
  } else if (nums.length === 3) {
    const [a, b, c] = nums;
    if (a > 255 || b > 255 || c > 0xffff) return null;
    dotted = [a, b, (c >>> 8) & 255, c & 255];
  } else {
    if (nums.some((n) => n > 255)) return null;
    dotted = nums;
  }
  return dotted.join(".");
}

function isBlockedIPv4(dotted: string): boolean {
  const octets = dotted.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return false;
  }
  const [a, b] = octets;
  if (a === 10) return true; // 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local
  if (a === 0) return true; // 0.0.0.0/8 reserved
  return false;
}

function expandIPv6(ip: string): number[] | null {
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  // Embedded IPv4 tail (e.g. ::ffff:127.0.0.1) expands to 2 hextets.
  const expandTail = (groups: string[]): string[] => {
    const out: string[] = [];
    for (const g of groups) {
      if (g.includes(".")) {
        const oct = g.split(".").map(Number);
        if (oct.length !== 4 || oct.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
          return [];
        }
        out.push(`${((oct[0] << 8) | oct[1]).toString(16)}`);
        out.push(`${((oct[2] << 8) | oct[3]).toString(16)}`);
      } else {
        out.push(g);
      }
    }
    return out;
  };
  const headGroups = expandTail(head);
  const tailGroups = expandTail(tail);
  if (halves.length === 1) {
    if (headGroups.length !== 8) return null;
    return headGroups.map((g) => parseInt(g, 16));
  }
  const zeros = 8 - (headGroups.length + tailGroups.length);
  if (zeros < 1) return null;
  const full = [...headGroups, ...Array(zeros).fill("0"), ...tailGroups];
  if (full.length !== 8) return null;
  const nums = full.map((g) => parseInt(g, 16));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
  return nums;
}

function isBlockedIPv6(ip: string): boolean {
  const clean = stripBrackets(ip).split("%")[0].toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d): judge by the embedded IPv4.
  const mapped = clean.match(/^(?:::ffff:)(.+)$/);
  if (mapped) {
    const v4 = mapped[1];
    const dotted = isIP(v4) === 4 ? v4 : dottedFromNumericHost(v4);
    if (dotted) return isBlockedIPv4(dotted);
  }
  const groups = expandIPv6(clean);
  if (!groups) return true; // fail closed on unparseable literal
  if (groups.every((g) => g === 0)) return true; // :: unspecified
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

/** True when the literal IP (v4/v6/numeric-bypass form) is blocked. */
export function isBlockedIpLiteral(host: string): boolean {
  const clean = stripBrackets(host);
  if (isIP(clean) === 4) return isBlockedIPv4(clean);
  if (isIP(clean) === 6) return isBlockedIPv6(clean);
  const dotted = dottedFromNumericHost(clean);
  if (dotted) return isBlockedIPv4(dotted);
  return false;
}

/**
 * Pure-per-hop validation + DNS pinning. Throws ValidationError (400) whose
 * message always contains the offending host. Pass `opts.resolve` in tests to
 * avoid real DNS; IP literals never touch DNS.
 */
export async function validateEgressUrl(
  rawUrl: string,
  opts: EgressValidateOptions = {},
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ValidationError(`SSRF guard: invalid URL "${rawUrl}"`);
  }
  const host = normalizeHost(stripBrackets(parsed.hostname));
  const allowHttp = opts.allowHttp ?? getAllowHttpDefault();
  if (parsed.protocol === "http:") {
    if (!allowHttp) {
      throw new ValidationError(
        `SSRF guard: only https: URLs allowed for host "${parsed.hostname}"`,
      );
    }
  } else if (parsed.protocol !== "https:") {
    throw new ValidationError(
      `SSRF guard: unsupported scheme "${parsed.protocol}" for host "${parsed.hostname || rawUrl}"`,
    );
  }

  const allowlist = opts.allowlist ?? getAllowlistDefault();
  if (allowlist.length > 0 && !allowlist.includes(host)) {
    throw new ValidationError(
      `SSRF guard: host "${parsed.hostname}" is not in EGRESS_MEDIA_ALLOWLIST`,
    );
  }

  if (isBlockedIpLiteral(parsed.hostname)) {
    throw new ValidationError(
      `SSRF guard: blocked private/reserved IP for host "${parsed.hostname}"`,
    );
  }

  const resolve = opts.resolve ?? defaultResolve;
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new ValidationError(
      `SSRF guard: DNS resolution failed for host "${parsed.hostname}"`,
    );
  }
  for (const addr of addresses) {
    if (isBlockedIpLiteral(addr)) {
      throw new ValidationError(
        `SSRF guard: host "${parsed.hostname}" resolves to blocked IP ${addr}`,
      );
    }
  }
  return parsed;
}

/**
 * Fetch a user-supplied media URL with SSRF pinning: https-only (unless
 * EGRESS_ALLOW_HTTP=true), DNS re-validation on every redirect hop (max 2),
 * AbortSignal.timeout, upfront content-length check and streamed byte cap.
 */
export async function fetchUserMedia(
  url: string,
  opts: FetchUserMediaOptions = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? getTimeoutDefault();
  const maxBytes = opts.maxBytes ?? getMaxBytesDefault();
  const headers = opts.headers;
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = await validateEgressUrl(current);
    let response: Response;
    try {
      response = await fetch(parsed.toString(), {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        ...(headers ? { headers } : {}),
      });
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError(
        `SSRF guard: fetch failed for host "${parsed.hostname}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) {
        throw new ValidationError(
          `SSRF guard: redirect without location for host "${parsed.hostname}"`,
        );
      }
      if (hop === MAX_REDIRECTS) {
        throw new ValidationError(
          `SSRF guard: redirect limit exceeded for host "${parsed.hostname}"`,
        );
      }
      try {
        current = new URL(location, parsed.toString()).toString();
      } catch {
        throw new ValidationError(
          `SSRF guard: invalid redirect target for host "${parsed.hostname}"`,
        );
      }
      continue;
    }

    const declared = response.headers.get("content-length");
    if (declared !== null) {
      const length = Number(declared);
      if (Number.isFinite(length) && length > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new ValidationError(
          `SSRF guard: content-length ${length} exceeds limit for host "${parsed.hostname}"`,
        );
      }
    }

    if (!response.body) {
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.length > maxBytes) {
        throw new ValidationError(
          `SSRF guard: body ${buf.length} exceeds limit for host "${parsed.hostname}"`,
        );
      }
      return new Response(buf, { status: response.status, headers: response.headers });
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ValidationError(
          `SSRF guard: body exceeds ${maxBytes} bytes for host "${parsed.hostname}"`,
        );
      }
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    return new Response(buf, { status: response.status, headers: response.headers });
  }

  throw new ValidationError(`SSRF guard: redirect limit exceeded for "${url}"`);
}
