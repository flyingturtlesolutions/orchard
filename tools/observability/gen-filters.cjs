#!/usr/bin/env node
// tools/observability/gen-filters.cjs — CW-3a (DESIGN_cloud_logs.md ruling 8): generate the CloudWatch
// metric-filter artifact from Core/decisionMarkers.js. The backend repo consumes metric-filters.json when
// building the orchard-observability module; regenerate here whenever the manifest changes.
//
//   node tools/observability/gen-filters.cjs           # (re)write metric-filters.json
//   node tools/observability/gen-filters.cjs --check   # CI staleness gate: exit 1 if the artifact drifted
//
// Local toolchain only — never the shipped extension bundle.

const fs = require('fs');
const path = require('path');

(async () => {
  const { metricMarkers } = await import('../../Core/decisionMarkers.js');
  const artifact = {
    _generated: 'by tools/observability/gen-filters.cjs from Core/decisionMarkers.js — DO NOT EDIT BY HAND',
    logGroup: '/orchard/{env}/client',
    namespace: 'Orchard/Client',
    filters: [
      // level-based (not a marker): the client ERROR rate the §4 alarm keys on
      { key: 'client-error', pattern: '{ $.lvl = "ERROR" }', metricName: 'ClientErrors' },
      ...metricMarkers().map((m) => ({
        key: m.key,
        // events land as JSON lines (spec §3); markers match on msg via *-wildcards, ||-composed —
        // CloudWatch JSON filter syntax (regex/%-delimiters are invalid there: the v1906 fix)
        pattern: '{ ' + m.patterns.map((p) => `$.msg = "*${p}*"`).join(' || ') + ' }',
        metricName: 'Marker_' + m.key.replace(/-([a-z])/g, (_, c) => c.toUpperCase()).replace(/^([a-z])/, (_, c) => c.toUpperCase()),
      })),
    ],
  };
  const out = JSON.stringify(artifact, null, 2) + '\n';
  const dest = path.join(__dirname, 'metric-filters.json');
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
    if (cur !== out) { console.error('[gen-filters] STALE: metric-filters.json does not match Core/decisionMarkers.js — regenerate'); process.exit(1); }
    console.log('[gen-filters] artifact is current');
    return;
  }
  fs.writeFileSync(dest, out);
  console.log(`[gen-filters] wrote ${artifact.filters.length} filters → ${path.relative(process.cwd(), dest)}`);
})().catch((e) => { console.error('[gen-filters]', e.message); process.exit(1); });
