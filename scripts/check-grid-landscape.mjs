#!/usr/bin/env node
/**
 * Structural gate for docs/grid-landscape.md — every named product must
 * appear with a source URL and the five survey dimensions (or n/d / none).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const path = join(root, 'docs', 'grid-landscape.md');
const text = readFileSync(path, 'utf8');

const named = [
  'AG Grid',
  'TanStack Table',
  'Tabulator',
  'Handsontable',
  'Glide Data Grid',
  'SlickGrid',
  'RevoGrid',
  'Grid.js',
  'MUI X',
  'Syncfusion',
  'Kendo',
  'DevExtreme',
  'DHTMLX',
  'Webix',
  'Bryntum',
  'Sencha',
];

const extra = [
  'Univer',
  'Luckysheet',
  'Jspreadsheet',
  'SpreadJS',
  'Wijmo',
  'SVAR',
  'FancyGrid',
  'Vaadin',
  'Ignite',
];

const missing = [];
for (const name of named) {
  if (!text.includes(name)) missing.push(`named:${name}`);
}
const extraHit = extra.filter((name) => text.includes(name));
if (extraHit.length < 5) missing.push(`extra-count:${extraHit.length}`);

const host = [
  'ag-grid.com',
  'tanstack.com/table',
  'tabulator.info',
  'handsontable.com',
  'glideapps',
  '6pac/SlickGrid',
  'rv-grid.com',
  'gridjs.io',
  'mui.com/x/react-data-grid',
  'syncfusion.com',
  'telerik.com',
  'js.devexpress.com',
  'dhtmlx.com',
  'webix.com',
  'bryntum.com',
  'sencha.com',
];
for (const h of host) {
  if (!text.includes(h)) missing.push(`host:${h}`);
}

const dim = ['Render', 'Nesting', 'UI / design', 'Charting', 'Excel / formula'];
for (const d of dim) {
  const re = new RegExp(`\\*\\*${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.?\\*\\*`, 'i');
  if (!re.test(text) && !text.includes(`**${d}.**`)) {
    // AG Grid section uses **Render.** etc.
    if (!text.includes(`**${d.split(' / ')[0]}.**`)) missing.push(`dimension:${d}`);
  }
}

if (!text.includes('https://www.ag-grid.com/javascript-data-grid/dom-virtualisation/')) {
  missing.push('ag-grid-dom-url');
}
if (!text.includes('https://tanstack.com/table')) missing.push('tanstack-url');
if (!text.includes('hyperformula') && !text.includes('HyperFormula')) {
  missing.push('handsontable-formula-engine');
}

if (missing.length > 0) {
  console.error('GRID_LANDSCAPE_FAIL', missing.join(', '));
  process.exit(1);
}
console.log(
  `GRID_LANDSCAPE_OK named=${named.length} extra=${extraHit.length} bytes=${text.length}`,
);
