type CidrRule = { network: number; mask: number };

function parseIpv4ToUint32(ip: string): number | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  let out = 0;
  for (const part of parts) {
    if (part.length === 0) return undefined;
    if (!/^\d+$/.test(part)) return undefined;
    // Avoid accepting octets outside 0..255.
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
    out = (out << 8) | n;
  }
  // Ensure unsigned
  return out >>> 0;
}

function parseIpv4Cidr(entry: string): CidrRule | undefined {
  const idx = entry.indexOf('/');
  if (idx === -1) return undefined;
  const ipPart = entry.slice(0, idx).trim();
  const prefixPart = entry.slice(idx + 1).trim();
  if (ipPart.length === 0 || prefixPart.length === 0) return undefined;
  if (!/^\d+$/.test(prefixPart)) return undefined;
  const prefix = Number(prefixPart);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return undefined;
  const ip = parseIpv4ToUint32(ipPart);
  if (ip == null) return undefined;
  const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
  const network = (ip & mask) >>> 0;
  return { network, mask };
}

/**
 * Compile an IP allowlist matcher from a comma-separated string.
 * Supports exact IPv4 entries (e.g. "1.2.3.4") and IPv4 CIDR entries (e.g. "10.0.0.0/24").
 *
 * Invalid entries are ignored.
 */
export function compileIpAllowlist(raw: string | undefined): (ip: string | undefined) => boolean {
  const cleaned = (raw ?? '').trim();
  if (!cleaned) return () => false;

  const exact = new Set<number>();
  const cidrs: CidrRule[] = [];

  for (const piece of cleaned.split(',')) {
    const entry = piece.trim();
    if (!entry) continue;

    if (entry.includes('/')) {
      const rule = parseIpv4Cidr(entry);
      if (rule) cidrs.push(rule);
      continue;
    }

    const ip = parseIpv4ToUint32(entry);
    if (ip != null) exact.add(ip);
  }

  if (exact.size === 0 && cidrs.length === 0) return () => false;

  return (ip: string | undefined) => {
    const val = (ip ?? '').trim();
    if (!val) return false;
    const parsed = parseIpv4ToUint32(val);
    if (parsed == null) return false;
    if (exact.has(parsed)) return true;
    for (const rule of cidrs) {
      if (((parsed & rule.mask) >>> 0) === rule.network) return true;
    }
    return false;
  };
}

