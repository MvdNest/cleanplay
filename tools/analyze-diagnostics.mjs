import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function countBy(items, key) {
  const counts = {};
  for (const item of items) {
    const value = String(item?.[key] || 'unknown');
    counts[value] = (counts[value] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
}

export function analyzeDiagnostics(input) {
  const events = Array.isArray(input?.events) ? input.events.filter(event => event && typeof event === 'object') : [];
  const ordered = [...events].sort((left, right) => Number(left.ts || 0) - Number(right.ts || 0));
  const failed = events.filter(event => event.outcome === 'failed' || event.outcome === 'degraded');
  const findings = [];
  const has = predicate => events.some(predicate);
  const count = predicate => events.filter(predicate).length;

  const falseAudible = ordered.some((event, index) => {
    if (event.event !== 'sdk_playback_error') return false;
    let commandIndex = -1;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const prior = ordered[cursor];
      if (prior.session !== event.session) continue;
      if (Number(event.ts) - Number(prior.ts) > 2000) break;
      if (prior.event === 'command_ok' && prior.audible === 'yes') {
        commandIndex = cursor;
        break;
      }
    }
    if (commandIndex < 0) return false;
    for (let cursor = commandIndex - 1; cursor >= 0; cursor -= 1) {
      const prior = ordered[cursor];
      if (prior.session !== event.session) continue;
      if (Number(event.ts) - Number(prior.ts) > 2000) break;
      // Each local Start Playback writes sdk_resume immediately before its own
      // command_ok. Do not let proof from an earlier rapid command mask this one.
      if (prior.event === 'command_ok' || prior.event === 'command_failed') break;
      if (prior.event === 'sdk_resume' && prior.progress === 'advanced') return false;
    }
    return true;
  });
  if (falseAudible) {
    findings.push({ code: 'false_audible', severity: 'high', summary: 'A command labelled audible was followed almost immediately by an SDK playback error; paused=false was not valid proof of sound.' });
  }
  if (has(event => (event.event === 'command_failed' && event.audible === 'no') || event.event === 'sdk_stalled' || event.reason === 'position_stalled')) {
    findings.push({ code: 'silent_sdk', severity: 'high', summary: 'Spotify accepted playback but the local SDK made no confirmed position progress; retain the selection for a fresh user-activated generation.' });
  }
  if (has(event => event.event === 'sdk_transfer' && event.reason === 'device_missing')) {
    findings.push({ code: 'route_registration', severity: 'high', summary: 'Spotify had not registered the current SDK route when transfer was attempted.' });
  }
  if (has(event => event.event === 'api_error' && event.status === 401)) {
    findings.push({ code: 'authorization', severity: 'high', summary: 'Spotify rejected an access token; inspect the adjacent refresh events.' });
  }
  const incompleteVisibleResumes = ordered.filter((event, index) => {
    if (event.event !== 'resume_start') return false;
    for (let cursor = index + 1; cursor < ordered.length; cursor += 1) {
      const later = ordered[cursor];
      if (later.session !== event.session) continue;
      if (later.event === 'resume_ok') return false;
      if (later.event === 'hidden' || later.event === 'resume_start') return later.visibility !== 'hidden';
    }
    return event.visibility !== 'hidden';
  }).length;
  if (incompleteVisibleResumes) {
    findings.push({ code: 'wake_recovery', severity: 'medium', summary: `${incompleteVisibleResumes} foreground recovery attempt${incompleteVisibleResumes === 1 ? '' : 's'} ended while the app was still visible.` });
  }
  if (has(event => event.event === 'sdk_not_ready')) {
    findings.push({ code: 'sdk_retired', severity: 'medium', summary: 'The SDK explicitly reported not_ready; a new user-activated player generation was required.' });
  }
  if (!findings.length && failed.length) {
    findings.push({ code: 'degraded_unknown', severity: 'low', summary: 'Degraded events exist, but this export has no recognized high-confidence failure signature.' });
  }
  if (!events.length) {
    findings.push({ code: 'empty', severity: 'low', summary: 'The export contains no usable diagnostic events.' });
  }

  const timestamps = events.map(event => Number(event.ts)).filter(Number.isFinite).sort((a, b) => a - b);
  return {
    schemaVersion: Number(input?.version) || 0,
    eventCount: events.length,
    sessionCount: new Set(events.map(event => event.session).filter(Boolean)).size,
    range: timestamps.length ? { from: new Date(timestamps[0]).toISOString(), to: new Date(timestamps.at(-1)).toISOString() } : null,
    events: countBy(events, 'event'),
    outcomes: countBy(events, 'outcome'),
    commands: countBy(events.filter(event => event.command && event.command !== 'none'), 'command'),
    findings
  };
}

function formatReport(report) {
  const lines = [
    `CleanPlay diagnostics v${report.schemaVersion}`,
    `Events: ${report.eventCount} | Sessions: ${report.sessionCount}`,
    report.range ? `Range: ${report.range.from} -> ${report.range.to}` : 'Range: none',
    '',
    'Findings:'
  ];
  report.findings.forEach(finding => lines.push(`- [${finding.severity}] ${finding.code}: ${finding.summary}`));
  lines.push('', `Event counts: ${JSON.stringify(report.events)}`, `Outcome counts: ${JSON.stringify(report.outcomes)}`, `Command counts: ${JSON.stringify(report.commands)}`);
  return lines.join('\n');
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: npm run analyze:diagnostics -- <cleanplay-diagnostics.json>');
    process.exitCode = 1;
  } else {
    try {
      const parsed = JSON.parse(readFileSync(resolve(file), 'utf8'));
      console.log(formatReport(analyzeDiagnostics(parsed)));
    } catch (error) {
      console.error(`Could not analyze diagnostics: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
