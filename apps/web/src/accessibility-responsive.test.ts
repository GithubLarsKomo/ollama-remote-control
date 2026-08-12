import { describe, expect, it } from 'vitest';
import accessibilityCss from './accessibility-responsive.css?inline';
import baseCss from './styles.css?inline';
import updateCss from './update.css?inline';

describe('bounded beta accessibility and responsive styles', () => {
  it('keeps keyboard focus visible across native and custom controls', () => {
    expect(baseCss).toContain('button:focus-visible');
    expect(baseCss).toContain('input:focus-visible');
    expect(baseCss).toContain('select:focus-visible');
    expect(accessibilityCss).toContain('textarea:focus-visible');
    expect(accessibilityCss).toContain('a:focus-visible');
    expect(accessibilityCss).toContain('summary:focus-visible');
    expect(accessibilityCss).toContain('.model-detail-tab:focus-visible');
    expect(updateCss).toContain('.danger-button:focus-visible');
  });

  it('keeps narrow layouts and long evidence bounded', () => {
    expect(baseCss).toContain('@media (max-width: 560px)');
    expect(updateCss).toContain('@media (max-width: 700px)');
    expect(accessibilityCss).toContain('@media (max-width: 560px)');
    expect(accessibilityCss).toContain('.audit-pagination');
    expect(accessibilityCss).toContain('.models-surface-nav');
    expect(accessibilityCss).toContain('.model-table-wrap');
    expect(accessibilityCss).toContain('overflow-wrap: anywhere');
    expect(accessibilityCss).toContain('overflow: auto');
  });
});
