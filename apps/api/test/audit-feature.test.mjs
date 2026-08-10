import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyMigrations,
  openDatabase,
} from '@orc/db';
import {
  auditEventsToCsv,
  parseStoredAuditParameters,
} from '../dist/audit-read.js';
import { registerAuditFeature } from '../dist/audit-feature.js';
import { buildServer } from '../dist/server.js';

const NOW = new Date('2026-08-10T12:00:00.000Z');
const CUTOFF = '2026-05-12T12:00:00.000Z';

function tempDb() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-audit-feature-'));
  return path.join(directory, 'audit.sqlite');
}

function insertAudit(database, event) {
  database.prepare(`
    INSERT INTO audit_events(
      id, timestamp, actor_user_id, host_id, target_id, action,
      parameters_redacted_json, result, exit_code, error_class, job_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id,
    event.timestamp,
    event.actorUserId,
    event.hostId ?? null,
    event.targetId ?? null,
    event.action,
    event.parametersRedactedJson ?? '{}',
    event.result,
    event.exitCode ?? null,
    event.errorClass ?? null,
    event.jobId ?? null,
  );
}

function seed(databasePath) {
  const database = openDatabase(databasePath);
  try {
    applyMigrations(database);
    insertAudit(database, {
      id: 'expired', timestamp: '2026-05-12T11:59:59.999Z', actorUserId: 'user-old', action: 'expired', result: 'ok',
    });
    insertAudit(database, {
      id: 'cutoff', timestamp: CUTOFF, actorUserId: 'user-cutoff', action: 'retained.at-cutoff', result: 'ok',
    });
    insertAudit(database, {
      id: 'malformed', timestamp: '2026-08-10T09:00:00.000Z', actorUserId: 'user-1', hostId: 'host-1', targetId: 'target-1',
      action: 'malformed.parameters', parametersRedactedJson: '{not-json', result: 'failed', errorClass: 'BAD_JSON',
    });
    insertAudit(database, {
      id: 'secret', timestamp: '2026-08-10T10:00:00.000Z', actorUserId: 'user-1', hostId: 'host-1', targetId: 'target-1',
      action: 'safe.parameters', parametersRedactedJson: JSON.stringify({ privateKey: 'RAW-PRIVATE-KEY', safe: 'container-1' }), result: 'succeeded',
    });
    insertAudit(database, {
      id: 'formula', timestamp: '2026-08-10T11:00:00.000Z', actorUserId: '=2+2', hostId: '+host', targetId: '@target',
      action: '+SUM(1,1)', parametersRedactedJson: '{}', result: '@result', errorClass: '-DANGER', jobId: '=job',
    });
  } finally {
    database.close();
  }
}

function cookiesFrom(response) {
  const header = response.headers['set-cookie'];
  const values = Array.isArray(header) ? header : header ? [header] : [];
  const cookies = {};
  for (const value of values) {
    const [pair] = value.split(';');
    const separator = pair.indexOf('=');
    cookies[pair.slice(0, separator)] = decodeURIComponent(pair.slice(separator + 1));
  }
  return cookies;
}

function cookieHeader(cookies) {
  return Object.entries(cookies).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ');
}

async function login(app) {
  await app.inject({
    method: 'POST',
    url: '/api/v1/setup/admin',
    payload: { username: 'admin', password: 'audit-feature-password!' },
  });
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/session',
    payload: { username: 'admin', password: 'audit-feature-password!' },
  });
  assert.equal(response.statusCode, 200);
  return cookieHeader(cookiesFrom(response));
}

test('audit feature enforces auth, bounded filters, safe parameters, exports and exact 90-day retention', async () => {
  const databasePath = tempDb();
  seed(databasePath);
  const app = buildServer({ databasePath, now: () => NOW });
  registerAuditFeature(app, { databasePath, now: () => NOW });

  try {
    const unauthenticated = await app.inject({ method: 'GET', url: '/api/v1/audit' });
    assert.equal(unauthenticated.statusCode, 401);

    const inspection = openDatabase(databasePath);
    try {
      assert.equal(inspection.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE id = ?').get('expired').count, 0);
      assert.equal(inspection.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE id = ?').get('cutoff').count, 1);
    } finally {
      inspection.close();
    }

    const cookie = await login(app);
    const history = await app.inject({
      method: 'GET',
      url: '/api/v1/audit?limit=3&offset=0',
      headers: { cookie },
    });
    assert.equal(history.statusCode, 200);
    const body = history.json();
    assert.equal(body.redacted, true);
    assert.deepEqual(body.events.map((event) => event.id), ['formula', 'secret', 'malformed']);
    assert.equal(body.page.limit, 3);
    assert.equal(body.page.offset, 0);
    assert.equal(body.page.hasMore, true);
    assert.equal(body.events[1].parameters.privateKey, '[REDACTED]');
    assert.equal(JSON.stringify(body).includes('RAW-PRIVATE-KEY'), false);
    assert.deepEqual(body.events[2].parameters, {
      _redacted: true,
      _status: 'unavailable',
      _reason: 'malformed_json',
    });

    const exactFilter = await app.inject({
      method: 'GET',
      url: `/api/v1/audit?action=${encodeURIComponent("x' OR 1=1 --")}`,
      headers: { cookie },
    });
    assert.equal(exactFilter.statusCode, 200);
    assert.deepEqual(exactFilter.json().events, []);

    const invalidLimit = await app.inject({ method: 'GET', url: '/api/v1/audit?limit=101', headers: { cookie } });
    assert.equal(invalidLimit.statusCode, 400);
    assert.equal(invalidLimit.json().error.code, 'AUDIT_QUERY_INVALID');

    const invalidWindow = await app.inject({
      method: 'GET',
      url: '/api/v1/audit?from=2026-08-10T12%3A00%3A00Z&to=2026-08-10T11%3A00%3A00Z',
      headers: { cookie },
    });
    assert.equal(invalidWindow.statusCode, 400);

    const jsonExport = await app.inject({ method: 'GET', url: '/api/v1/audit/export.json?targetId=target-1', headers: { cookie } });
    assert.equal(jsonExport.statusCode, 200);
    assert.match(jsonExport.headers['content-disposition'], /ollama-remote-control-audit\.json/u);
    assert.equal(jsonExport.body.includes('RAW-PRIVATE-KEY'), false);
    const exportedJson = JSON.parse(jsonExport.body);
    assert.deepEqual(exportedJson.events.map((event) => event.id), ['secret', 'malformed']);

    const csvExport = await app.inject({ method: 'GET', url: '/api/v1/audit/export.csv', headers: { cookie } });
    assert.equal(csvExport.statusCode, 200);
    assert.match(csvExport.headers['content-type'], /^text\/csv/u);
    assert.equal(csvExport.body.includes('RAW-PRIVATE-KEY'), false);
    for (const dangerous of ["'=2+2", "'+host", "'@target", "'+SUM(1,1)", "'@result", "'-DANGER", "'=job"]) {
      assert.equal(csvExport.body.includes(dangerous), true, `expected formula-safe CSV value ${dangerous}`);
    }
  } finally {
    await app.close();
  }
});

test('audit parameter and CSV helpers fail safely without executing spreadsheet formulas', () => {
  assert.deepEqual(parseStoredAuditParameters('[]'), {
    _redacted: true,
    _status: 'unavailable',
    _reason: 'invalid_shape',
  });
  const csv = auditEventsToCsv([{
    id: 'event-1',
    timestamp: '2026-08-10T12:00:00.000Z',
    actorUserId: '=cmd',
    hostId: null,
    targetId: null,
    action: '+action',
    parameters: { safe: true },
    result: '@result',
    exitCode: null,
    errorClass: '-error',
    jobId: '=job',
  }]);
  for (const value of ["'=cmd", "'+action", "'@result", "'-error", "'=job"]) assert.equal(csv.includes(value), true);
});
