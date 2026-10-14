// Build a self-contained HTML snapshot of a dive: the title, an interactive
// Vega-Lite chart with the data inlined, and the data table. The DATA never
// leaves the file; the vega runtime loads from a pinned CDN, so the chart needs
// internet to render (the table works fully offline). A zero-dependency offline
// SVG snapshot is a planned follow-up. See docs/design/dives.md.

import type { Column } from '../pipeline-types';
import type { Dive } from './dive-types';

const VEGA = 'https://cdn.jsdelivr.net/npm/vega@6';
const VEGALITE = 'https://cdn.jsdelivr.net/npm/vega-lite@6';
const VEGAEMBED = 'https://cdn.jsdelivr.net/npm/vega-embed@7';
const MAX_TABLE_ROWS = 1000;

const ESCAPES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

function esc(v: unknown): string {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

export function buildDiveHtml(dive: Dive, columns: Column[], rows: Record<string, unknown>[]): string {
    const cols = columns.map((c) => c.name);
    const hasChart = !!dive.chart && Object.keys(dive.chart).length > 0;
    const spec = { ...dive.chart, data: { values: rows } };
    // Neutralize "</script>" / "<!--" inside string cells before embedding the
    // spec in a <script> block.
    const specJson = JSON.stringify(spec).replace(/</g, '\\u003c');

    const head = `<tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>`;
    const body = rows
        .slice(0, MAX_TABLE_ROWS)
        .map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c])}</td>`).join('')}</tr>`)
        .join('');
    const more = rows.length > MAX_TABLE_ROWS ? `<div class="more">${rows.length - MAX_TABLE_ROWS} more rows not shown</div>` : '';

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(dive.title)} - Otter ETL agent dive</title>
<style>
  body { font: 14px/1.5 system-ui, "Segoe UI", Arial, sans-serif; margin: 24px; color: #1b2030; background: #fff; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #6d7585; font-size: 12px; margin-bottom: 18px; }
  #chart { margin-bottom: 22px; }
  table { border-collapse: collapse; font-size: 12px; }
  th, td { border: 1px solid #e3e6ee; padding: 5px 9px; text-align: left; }
  th { background: #f5f6fa; }
  .more { color: #6d7585; font-size: 11px; margin-top: 6px; }
</style>
</head>
<body>
<h1>${esc(dive.title)}</h1>
<div class="sub">Otter ETL agent dive - snapshot of ${rows.length} rows</div>
${hasChart ? '<div id="chart"></div>' : ''}
<table><thead>${head}</thead><tbody>${body}</tbody></table>
${more}
${hasChart ? `<script src="${VEGA}"></script><script src="${VEGALITE}"></script><script src="${VEGAEMBED}"></script>
<script>vegaEmbed('#chart', ${specJson}, { actions: false }).catch(function (e) { document.getElementById('chart').textContent = 'Chart needs internet to render: ' + e; });</script>` : ''}
</body>
</html>`;
}
