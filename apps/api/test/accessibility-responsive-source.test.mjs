import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(path) {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
}

test('beta accessibility styles preserve visible keyboard focus', () => {
  const baseCss = source('apps/web/src/styles.css');
  const accessibilityCss = source('apps/web/src/accessibility-responsive.css');
  const updateCss = source('apps/web/src/update.css');

  for (const selector of ['button:focus-visible', 'input:focus-visible', 'select:focus-visible']) {
    assert.match(baseCss, new RegExp(selector.replace(':', '\\:')));
  }
  for (const selector of ['textarea:focus-visible', 'a:focus-visible', 'summary:focus-visible', '.model-detail-tab:focus-visible']) {
    assert.ok(accessibilityCss.includes(selector), `missing accessibility selector ${selector}`);
  }
  assert.ok(updateCss.includes('.danger-button:focus-visible'));
});

test('beta responsive styles bound narrow layouts and long evidence', () => {
  const baseCss = source('apps/web/src/styles.css');
  const accessibilityCss = source('apps/web/src/accessibility-responsive.css');
  const updateCss = source('apps/web/src/update.css');

  assert.ok(baseCss.includes('@media (max-width: 560px)'));
  assert.ok(updateCss.includes('@media (max-width: 700px)'));
  assert.ok(accessibilityCss.includes('@media (max-width: 560px)'));
  for (const marker of ['.audit-pagination', '.models-surface-nav', '.model-table-wrap', 'overflow-wrap: anywhere', 'overflow: auto']) {
    assert.ok(accessibilityCss.includes(marker), `missing responsive marker ${marker}`);
  }
});
