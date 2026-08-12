import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { betaRcScenarios } from '../../../scripts/beta-rc-scenarios.mjs';

test('beta RC scenario manifest references existing tracked test files', () => {
  const root = process.cwd();
  const referenced = [];
  for (const scenario of betaRcScenarios) {
    for (const argument of scenario.args) {
      if (!argument.endsWith('.test.mjs') && !argument.endsWith('.test.ts') && !argument.endsWith('.test.tsx')) continue;
      const relative = argument.startsWith('src/') ? path.join('apps/web', argument) : argument;
      referenced.push(relative);
      assert.equal(fs.existsSync(path.join(root, relative)), true, `${scenario.id}: missing ${relative}`);
    }
  }
  assert.ok(referenced.length >= 20, 'release scenario manifest must remain broad enough to cover the amended beta path');
});
