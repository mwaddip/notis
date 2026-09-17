// The denomination module — a credits amount crosses the API in base units and
// reaches the face in $NOTIS (WEB_INTERFACE → The wallet). Base units are 10⁻⁸
// of a credit (TYPES_INTERFACE → Denomination); @dagsocial/types exports no name
// for the scale, so the module holds it here with that citation. One module
// serves every surface — the $NOTIS row, its confirm and flight lines, the
// extension's prompt — so a formatting change moves in one place.

/** 10⁻⁸ of a credit. TYPES_INTERFACE → Denomination states the scale;
 *  @dagsocial/types does not export a name for it. */
export const BASE_UNITS_PER_CREDIT = 10n ** 8n;

/** Base units → the face string. Up to eight decimals, trailing zeros dropped,
 *  0n → '0', no grouping. */
export function formatCredits(base: bigint): string {
  const neg = base < 0n;
  const abs = neg ? -base : base;
  const whole = abs / BASE_UNITS_PER_CREDIT;
  const frac = abs % BASE_UNITS_PER_CREDIT;
  const sign = neg ? '-' : '';
  if (frac === 0n) return sign + whole.toString();
  let fracStr = frac.toString().padStart(8, '0');
  // Trailing zeros dropped, but never every zero — the branch above answered '0'.
  while (fracStr.endsWith('0')) fracStr = fracStr.slice(0, -1);
  return sign + whole.toString() + '.' + fracStr;
}

/** The face string → base units, or null when the text does not parse. Digits,
 *  at most one point, at most eight decimals, nothing else. Whitespace inside
 *  refuses; the ends are trimmed. */
export function parseCredits(text: string): bigint | null {
  const s = text.trim();
  if (s === '') return null;
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const dot = s.indexOf('.');
  if (dot === -1) return BigInt(s) * BASE_UNITS_PER_CREDIT;
  const whole = s.slice(0, dot);
  const frac = s.slice(dot + 1);
  if (frac.length > 8) return null;
  const padded = (frac + '00000000').slice(0, 8);
  return BigInt(whole) * BASE_UNITS_PER_CREDIT + BigInt(padded);
}
