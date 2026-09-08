import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../library-backup.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context);
const backup = context.CleanPlayBackup;
const now = 1788854400000;
const plain = value => JSON.parse(JSON.stringify(value));
const item = (id = 'A123', overrides = {}) => ({
  type: 'track', uri: 'spotify:track:' + id, name: 'Song', subtitle: 'Artist',
  meta: 'Album', durationMs: 180000, savedAt: now - 1000, ...overrides
});
const envelope = items => JSON.stringify({
  format: backup.FORMAT, version: 1, exportedAt: new Date(now).toISOString(), items
});

test('backup round-trips every supported Listen Later type without DOM or storage', () => {
  const items = ['track', 'album', 'artist', 'playlist'].map(type => item(type, {
    type, uri: 'spotify:' + type + ':' + type
  }));
  const exported = backup.serialize(items, now);
  assert.deepEqual(plain(backup.parse(exported, now)), items);
  assert.equal(JSON.parse(exported).format, 'cleanplay-listen-later');
  assert.equal(Object.isFrozen(backup), true);
  assert.deepEqual(plain(backup.parse(backup.serialize([], now), now)), []);
});

test('export and import discard credentials, artwork, arbitrary properties, and separate IDs', () => {
  const raw = item('A123', {
    id: 'A123', access_token: 'SECRET', refresh_token: 'REFRESH', images: ['PRIVATE'],
    artwork: { src: 'https://example.test/cover' }, unknown: 'PRIVATE'
  });
  const exported = backup.serialize([raw], now);
  assert.doesNotMatch(exported, /SECRET|REFRESH|PRIVATE|access_token|refresh_token|images|artwork|unknown|"id"/);
  const imported = backup.parse(envelope([raw]), now)[0];
  assert.deepEqual(Object.keys(imported).sort(), ['type', 'uri', 'name', 'subtitle', 'meta', 'durationMs', 'savedAt'].sort());
  assert.deepEqual(plain(imported), item());
});

test('backup rejects foreign formats, unsupported versions, malformed JSON and records', () => {
  for (const value of ['null', '[]', '{}', '{', JSON.stringify({ version: 1, items: [item()] }),
    envelope([item()]).replace('"version":1', '"version":2')]) {
    assert.throws(() => backup.parse(value, now));
  }
  for (const invalid of [null, [], {}, item('A', { type: 'episode' }), item('A', { name: {} }),
    item('A', { subtitle: {} }), item('A', { savedAt: '100' }), item('A', { savedAt: -1 }),
    item('A', { savedAt: 1.5 }), item('A', { durationMs: -1 }), item('A', { durationMs: 86400001 })]) {
    assert.throws(() => backup.parse(envelope([invalid]), now));
  }
  assert.throws(() => backup.parse(envelope([item()]).replace(new Date(now).toISOString(), 'not-a-date'), now));
});

test('backup enforces Spotify URI type and optional ID consistency without accepting URLs or markup', () => {
  for (const invalid of [item('A', { uri: 'spotify:album:A' }), item('A', { id: 'B' }),
    item('A', { uri: 'https://open.spotify.com/track/A' }), item('A', { uri: 'spotify:track:A\n' }),
    item('A', { uri: 'spotify:track:A?token=x' }), item('A', { uri: 'spotify:track:<script>' }),
    item('A', { uri: 'spotify:track:' + 'A'.repeat(129) })]) {
    assert.throws(() => backup.parse(envelope([invalid]), now));
  }
});

test('metadata is plain bounded text and future timestamps cannot dominate permanently', () => {
  const raw = item('A', {
    name: '\u0000 Song\n\t name ' + 'X'.repeat(300), subtitle: 'S'.repeat(500),
    meta: 'M'.repeat(500), durationMs: 12.8, savedAt: now + 864000000
  });
  const result = backup.parse(envelope([raw]), now)[0];
  assert.equal(result.name.length, 180);
  assert.ok(result.name.startsWith('Song name '));
  assert.equal(result.subtitle.length, 220);
  assert.equal(result.meta.length, 220);
  assert.equal(result.durationMs, 12);
  assert.equal(result.savedAt, now + 60000);
});

test('file size bounds count UTF-8 bytes, not only JavaScript characters', () => {
  assert.throws(() => backup.parse(' '.repeat(backup.MAX_BYTES + 1), now), /too large/);
  const oversized = envelope([item('A', { name: '🎵'.repeat(270000) })]);
  assert.ok(oversized.length < backup.MAX_BYTES);
  assert.throws(() => backup.parse(oversized, now), /too large/);
});

test('both backup paths enforce item limits and dedupe by newest saved date', () => {
  const excessive = Array.from({ length: 301 }, (_, i) => item('A' + i));
  assert.throws(() => backup.serialize(excessive, now), /at most 300/);
  assert.throws(() => backup.parse(envelope(excessive), now), /at most 300/);
  const duplicate = [item('A'), item('A', { name: 'New', savedAt: now }), item('A', { name: 'Old', savedAt: now - 5000 })];
  assert.deepEqual(plain(backup.parse(backup.serialize(duplicate, now), now)), [duplicate[1]]);
});

test('merge keeps newer local entries, accepts newer imports, and preserves equal-timestamp local edits', () => {
  const existing = [item('A', { name: 'Local A', savedAt: now }), item('B'), item('C')];
  const incoming = [item('A', { name: 'Old A' }), item('B', { name: 'New B', savedAt: now }),
    item('C', { name: 'Same date C' }), item('D')];
  const originals = JSON.stringify({ existing, incoming });
  const result = backup.merge(existing, incoming, now);
  assert.deepEqual(plain(result), {
    items: [existing[0], incoming[1], existing[2], incoming[3]], added: 1, updated: 1, unchanged: 2, omitted: 0
  });
  assert.equal(JSON.stringify({ existing, incoming }), originals, 'inputs stay unchanged');
  const repeated = backup.merge(result.items, incoming, now);
  assert.deepEqual(plain(repeated.items), plain(result.items));
  assert.equal(repeated.added, 0);
  assert.equal(repeated.updated, 0);
});

test('merge at capacity never drops existing saved entries and reports omitted imports', () => {
  const existing = Array.from({ length: 300 }, (_, i) => item('A' + i));
  const incoming = [item('New'), item('A0', { name: 'Updated', savedAt: now })];
  const result = backup.merge(existing, incoming, now);
  assert.equal(result.items.length, 300);
  assert.equal(result.items[0].name, 'Updated');
  assert.equal(result.updated, 1);
  assert.equal(result.omitted, 1);
  assert.equal(result.added, 0);
  assert.deepEqual(plain(result.items.map(value => value.uri)), existing.map(value => value.uri));
});

test('import does not retain prototype-shaped unknown fields', () => {
  const hostile = envelope([item()]).replace('"name":"Song"', '"__proto__":{"polluted":true},"constructor":{"x":1},"name":"Song"');
  const imported = backup.parse(hostile, now);
  assert.equal(Object.hasOwn(imported[0], '__proto__'), false);
  assert.equal(Object.hasOwn(imported[0], 'constructor'), false);
  assert.equal(imported[0].polluted, undefined);
});
