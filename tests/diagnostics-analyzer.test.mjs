import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeDiagnostics } from '../tools/analyze-diagnostics.mjs';

test('diagnostic analyzer identifies silent playback and route registration failures', () => {
  const now = Date.now();
  const report = analyzeDiagnostics({
    version: 2,
    events: [
      { ts: now, session: 'aaaaaaaaaaaa', event: 'resume_start', outcome: 'retry', command: 'none' },
      { ts: now + 1, session: 'aaaaaaaaaaaa', event: 'sdk_transfer', reason: 'device_missing', outcome: 'degraded', command: 'none' },
      { ts: now + 2, session: 'aaaaaaaaaaaa', event: 'command_failed', reason: 'autoplay', audible: 'no', outcome: 'degraded', command: 'play_track' }
    ]
  });
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.eventCount, 3);
  assert.equal(report.sessionCount, 1);
  assert.ok(report.findings.some(finding => finding.code === 'silent_sdk'));
  assert.ok(report.findings.some(finding => finding.code === 'route_registration'));
  assert.equal(report.commands.play_track, 1);
});

test('diagnostic analyzer handles an empty export safely', () => {
  const report = analyzeDiagnostics({ version: 2, events: [] });
  assert.equal(report.eventCount, 0);
  assert.equal(report.findings[0].code, 'empty');
});
