import { describe, expect, it } from 'vitest';
import { HELP_MODULES, HELP_WORKFLOWS, helpModule } from './help-content.js';

describe('module help content', () => {
  it('keeps module ids unique and resolvable', () => {
    const ids = HELP_MODULES.map((module) => module.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(helpModule(id).id).toBe(id);
  });

  it('keeps all cross-module links valid', () => {
    const known = new Set(HELP_MODULES.map((module) => module.id));
    for (const module of HELP_MODULES) {
      for (const next of module.next) expect(known.has(next)).toBe(true);
    }
    for (const workflow of HELP_WORKFLOWS) {
      expect(workflow.modules.length).toBeGreaterThan(0);
      for (const id of workflow.modules) expect(known.has(id)).toBe(true);
    }
  });

  it('provides decision support for every module', () => {
    for (const module of HELP_MODULES) {
      expect(module.summary.length).toBeGreaterThan(20);
      expect(module.useWhen.length).toBeGreaterThan(0);
      expect(module.requires.length).toBeGreaterThan(0);
      expect(module.actions.length).toBeGreaterThan(0);
      expect(module.limits.length).toBeGreaterThan(0);
    }
  });
});
