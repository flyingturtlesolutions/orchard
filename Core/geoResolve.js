// Core/geoResolve.js — v2.74.2063: the pure GEO resolver table (DESIGN_resolve.md §10.5 item 3).
//
// The VALIDATE family's PLACE-NAME half. `parseCityStateZip` (writeMap.js) hard-required a 2-letter state, so a
// user-typed "Georgia" resolved to {} and the whole address — street included — dropped silently. This is the pure
// name→code lookup that half leans on: a US state NAME → its 2-letter code, and a country NAME → its ISO-3166-1
// alpha-2 code. NO imports, no Logger, no I/O — a table and two idempotent readers, reusable by the other §10.5
// resolvers (relative-date etc.) without dragging writeMap's write-path concerns along.
//
// Both readers are IDEMPOTENT: an already-correct code rides through unchanged and UPPERCASED ('GA'→'GA', 'ga'→'GA',
// 'US'→'US'), so a caller can run them over mixed name/code data without double-mapping. A miss returns '' (never the
// input) — the caller decides whether an unresolvable place is fatal (drop-with-report) or fine.

const _norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// name (proper-case, human) → 2-letter USPS code. 50 states + DC + the five populated US territories.
const _STATE_RAW = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA',
  Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', Florida: 'FL', Georgia: 'GA',
  Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA',
  Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD',
  Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO',
  Montana: 'MT', Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ',
  'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH',
  Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
  'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT',
  Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
  'District of Columbia': 'DC',
  'Puerto Rico': 'PR', 'Virgin Islands': 'VI', 'U.S. Virgin Islands': 'VI', Guam: 'GU',
  'American Samoa': 'AS', 'Northern Mariana Islands': 'MP',
};

/** Normalized-key state table: `parseCityStateZip('… georgia 30040')` and any §10.5 resolver read through this. */
export const STATE_NAME_TO_CODE = Object.freeze(
  Object.fromEntries(Object.entries(_STATE_RAW).map(([k, v]) => [_norm(k), v])),
);
const _STATE_CODES = new Set(Object.values(_STATE_RAW));

// country name (+ common aliases) → ISO-3166-1 alpha-2. Not exhaustive; the readers stay idempotent on any code in
// the value set, so an unlisted-but-correct code ('FR' etc.) rides through only if it appears here as a value.
const _COUNTRY_RAW = {
  'United States': 'US', 'United States of America': 'US', USA: 'US', 'U.S.': 'US', 'U.S.A.': 'US', America: 'US',
  Canada: 'CA', Mexico: 'MX', 'United Kingdom': 'GB', 'Great Britain': 'GB', Britain: 'GB', UK: 'GB', England: 'GB',
  Ireland: 'IE', France: 'FR', Germany: 'DE', Spain: 'ES', Italy: 'IT', Portugal: 'PT', Netherlands: 'NL',
  Belgium: 'BE', Switzerland: 'CH', Austria: 'AT', Sweden: 'SE', Norway: 'NO', Denmark: 'DK', Finland: 'FI',
  Poland: 'PL', Greece: 'GR', 'Czech Republic': 'CZ', Czechia: 'CZ', Hungary: 'HU', Romania: 'RO',
  Australia: 'AU', 'New Zealand': 'NZ', Japan: 'JP', China: 'CN', India: 'IN', 'South Korea': 'KR', Korea: 'KR',
  Singapore: 'SG', 'Hong Kong': 'HK', Taiwan: 'TW', Thailand: 'TH', Vietnam: 'VN', Philippines: 'PH',
  Indonesia: 'ID', Malaysia: 'MY', Brazil: 'BR', Argentina: 'AR', Chile: 'CL', Colombia: 'CO', Peru: 'PE',
  'South Africa': 'ZA', Nigeria: 'NG', Kenya: 'KE', Egypt: 'EG', 'Saudi Arabia': 'SA',
  'United Arab Emirates': 'AE', UAE: 'AE', Israel: 'IL', Turkey: 'TR', Russia: 'RU', Ukraine: 'UA',
};

/** Normalized-key country table. */
export const COUNTRY_TO_ISO = Object.freeze(
  Object.fromEntries(Object.entries(_COUNTRY_RAW).map(([k, v]) => [_norm(k), v])),
);
const _ISO_CODES = new Set(Object.values(_COUNTRY_RAW));

/**
 * US state NAME → 2-letter USPS code (uppercase). '' on miss. IDEMPOTENT: an already-2-letter code returns itself
 * uppercased ('ga'→'GA'). PURE. Handles multi-word names ('North Carolina'→'NC') via the normalized table.
 */
export function stateToCode(name) {
  const n = _norm(name);
  if (!n) return '';
  if (STATE_NAME_TO_CODE[n]) return STATE_NAME_TO_CODE[n];
  const up = n.toUpperCase();
  if (up.length === 2 && _STATE_CODES.has(up)) return up;   // idempotency: a code in already
  return '';
}

/**
 * Country NAME (or alias) → ISO-3166-1 alpha-2 (uppercase). '' on miss. IDEMPOTENT ('us'→'US'). PURE.
 * Spaces are stripped for the code check so 'U.S.' (→ 'u s' → 'US') resolves without a dedicated alias row.
 */
export function countryToISO(name) {
  const n = _norm(name);
  if (!n) return '';
  if (COUNTRY_TO_ISO[n]) return COUNTRY_TO_ISO[n];
  const up = n.replace(/\s+/g, '').toUpperCase();
  if (up.length === 2 && _ISO_CODES.has(up)) return up;     // idempotency: a code in already
  return '';
}
