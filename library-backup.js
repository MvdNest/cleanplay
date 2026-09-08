/* Text-only Listen Later portability. No storage, DOM, credentials, or network access. */
(function (root) {
  'use strict';

  const FORMAT = 'cleanplay-listen-later';
  const VERSION = 1;
  const MAX_ITEMS = 300;
  const MAX_BYTES = 1024 * 1024;
  const TYPES = new Set(['track', 'album', 'artist', 'playlist']);

  function fail(message) {
    throw new Error(message);
  }

  function clock(now) {
    if (now === undefined) return Date.now();
    if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000 - 60000) {
      fail('The backup date is invalid.');
    }
    return now;
  }

  function text(value, limit, field) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') fail('A saved item has invalid ' + field + '.');
    return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  function cleanItem(item, now) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !TYPES.has(item.type)) {
      fail('A saved item has an unsupported type.');
    }
    const match = typeof item.uri === 'string' && /^spotify:(track|album|artist|playlist):([A-Za-z0-9]{1,128})$/.exec(item.uri);
    if (!match || match[1] !== item.type || (item.id !== undefined && item.id !== match[2])) {
      fail('A saved item has an invalid Spotify address.');
    }
    if (typeof item.name !== 'string') fail('A saved item is missing its name.');
    if (!Number.isSafeInteger(item.savedAt) || item.savedAt < 0) {
      fail('A saved item has an invalid saved date.');
    }
    const duration = item.durationMs === undefined ? 0 : item.durationMs;
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0 || duration > 86400000) {
      fail('A saved item has an invalid duration.');
    }
    // Build a fresh allowlisted object: arbitrary imported properties never survive.
    return {
      type: item.type,
      uri: item.uri,
      name: text(item.name, 180, 'name') || 'Untitled',
      subtitle: text(item.subtitle, 220, 'subtitle'),
      meta: text(item.meta, 220, 'details'),
      durationMs: Math.floor(duration),
      savedAt: Math.min(now + 60000, item.savedAt)
    };
  }

  function cleanItems(items, now) {
    if (!Array.isArray(items) || items.length > MAX_ITEMS) {
      fail('A CleanPlay backup can contain at most ' + MAX_ITEMS + ' saved items.');
    }
    const entries = new Map();
    for (const raw of items) {
      const item = cleanItem(raw, now);
      const previous = entries.get(item.uri);
      if (!previous || item.savedAt > previous.savedAt) entries.set(item.uri, item);
    }
    return Array.from(entries.values());
  }

  function checkSize(value) {
    if (typeof value !== 'string') fail('Choose a CleanPlay Listen Later JSON backup.');
    if (value.length > MAX_BYTES) fail('This backup is too large (maximum 1 MB).');
    let bytes = 0;
    for (const character of value) {
      const point = character.codePointAt(0);
      bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
      if (bytes > MAX_BYTES) fail('This backup is too large (maximum 1 MB).');
    }
  }

  function serialize(items, now) {
    now = clock(now);
    const output = JSON.stringify({
      format: FORMAT,
      version: VERSION,
      exportedAt: new Date(now).toISOString(),
      items: cleanItems(items, now)
    }, null, 2);
    checkSize(output);
    return output;
  }

  function parse(jsonText, now) {
    now = clock(now);
    checkSize(jsonText);
    let parsed;
    try { parsed = JSON.parse(jsonText); }
    catch { fail('This file is not valid JSON. Choose a CleanPlay Listen Later backup.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        parsed.format !== FORMAT || parsed.version !== VERSION ||
        typeof parsed.exportedAt !== 'string' || !Number.isFinite(Date.parse(parsed.exportedAt))) {
      fail('This is not a supported CleanPlay Listen Later backup.');
    }
    return cleanItems(parsed.items, now);
  }

  function merge(existing, incoming, now) {
    now = clock(now);
    const items = cleanItems(existing, now);
    const imported = cleanItems(incoming, now);
    const positions = new Map(items.map(function (item, index) { return [item.uri, index]; }));
    let added = 0, updated = 0, unchanged = 0, omitted = 0;
    for (const item of imported) {
      const position = positions.get(item.uri);
      if (position !== undefined) {
        // Equal timestamps favor this device; repeated imports are idempotent.
        if (item.savedAt > items[position].savedAt) { items[position] = item; updated++; }
        else unchanged++;
      } else if (items.length < MAX_ITEMS) {
        positions.set(item.uri, items.length);
        items.push(item);
        added++;
      } else omitted++;
    }
    return { items: items, added: added, updated: updated, unchanged: unchanged, omitted: omitted };
  }

  root.CleanPlayBackup = Object.freeze({
    FORMAT: FORMAT, VERSION: VERSION, MAX_ITEMS: MAX_ITEMS, MAX_BYTES: MAX_BYTES,
    serialize: serialize, parse: parse, merge: merge
  });
})(globalThis);
