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

test('diagnostic analyzer catches a false audible result followed by playback error', () => {
  const now = Date.now();
  const report = analyzeDiagnostics({
    version: 2,
    events: [
      { ts: now, session: 'bbbbbbbbbbbb', event: 'sdk_resume', audible: 'yes', outcome: 'ok' },
      { ts: now + 5, session: 'bbbbbbbbbbbb', event: 'command_ok', command: 'play_track', audible: 'yes', outcome: 'ok' },
      { ts: now + 49, session: 'bbbbbbbbbbbb', event: 'sdk_playback_error', reason: 'unknown', outcome: 'failed' }
    ]
  });
  assert.ok(report.findings.some(finding => finding.code === 'false_audible'));
});

test('diagnostic analyzer does not call proven progress a false audible result', () => {
  const now = Date.now();
  const report = analyzeDiagnostics({
    version: 2,
    events: [
      { ts: now, session: 'dddddddddddd', event: 'sdk_resume', audible: 'yes', progress: 'advanced', outcome: 'ok' },
      { ts: now + 5, session: 'dddddddddddd', event: 'command_ok', command: 'play_track', audible: 'yes', outcome: 'ok' },
      { ts: now + 49, session: 'dddddddddddd', event: 'sdk_playback_error', reason: 'unknown', outcome: 'failed' }
    ]
  });
  assert.equal(report.findings.some(finding => finding.code === 'false_audible'), false);
});

test('progress proof for one command cannot mask a later false audible command', () => {
  const now = Date.now();
  const report = analyzeDiagnostics({
    version: 2,
    events: [
      { ts: now, session: 'eeeeeeeeeeee', event: 'sdk_resume', audible: 'yes', progress: 'advanced', outcome: 'ok' },
      { ts: now + 5, session: 'eeeeeeeeeeee', event: 'command_ok', command: 'play_track', audible: 'yes', outcome: 'ok' },
      { ts: now + 20, session: 'eeeeeeeeeeee', event: 'command_ok', command: 'play_track', audible: 'yes', outcome: 'ok' },
      { ts: now + 49, session: 'eeeeeeeeeeee', event: 'sdk_playback_error', reason: 'unknown', outcome: 'failed' }
    ]
  });
  assert.ok(report.findings.some(finding => finding.code === 'false_audible'));
});

test('a resume interrupted by another hide is not reported as a wake failure', () => {
  const now = Date.now();
  const report = analyzeDiagnostics({
    version: 2,
    events: [
      { ts: now, session: 'cccccccccccc', event: 'resume_start', visibility: 'visible', outcome: 'retry' },
      { ts: now + 10, session: 'cccccccccccc', event: 'hidden', visibility: 'hidden', outcome: 'degraded' }
    ]
  });
  assert.equal(report.findings.some(finding => finding.code === 'wake_recovery'), false);
});
