import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const lines = readFileSync(new URL('../index.html', import.meta.url), 'utf8').split(/\r?\n/);
function extractFunction(name) {
  const start = lines.findIndex(line => new RegExp(`^\\s*(?:async\\s+)?function\\s+${name}\\s*\\(`).test(line));
  assert.notEqual(start, -1, `missing ${name}`);
  for (let end = start; end < lines.length; end += 1) {
    const candidate = lines.slice(start, end + 1).join('\n');
    try { new vm.Script(candidate); return candidate; } catch { /* Read the full function. */ }
  }
  throw new Error(`could not extract ${name}`);
}
function runtime(names, values) {
  const context = vm.createContext({ Promise, Array, Object, String, encodeURIComponent, ...values });
  new vm.Script(names.map(extractFunction).join('\n')).runInContext(context);
  return context;
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function searchRuntime() {
  const state = { searchFilter: 'track' }, input = { value: 'first' }, results = { innerHTML: '' }, requests = [];
  const context = runtime(['doSearch'], {
    state, document: { getElementById: id => id === 'search-input' ? input : results },
    saveSearchTerm() {}, api(path) { const pending = deferred(); requests.push({ path, ...pending }); return pending.promise; },
    renderTrackItem: item => `track:${item.name}`, renderAlbumItem: item => `album:${item.name}`,
    renderArtistItem: item => `artist:${item.name}`, renderPlaylistItem: item => `playlist:${item.name}`
  });
  return { context, state, input, results, requests };
}

test('latest query and captured filter own search results even if an older response arrives last', async () => {
  const { context, state, input, results, requests } = searchRuntime();
  const oldSearch = context.doSearch();
  state.searchFilter = 'album'; input.value = 'new album';
  const latestSearch = context.doSearch();
  assert.match(requests[0].path, /type=track/);
  assert.match(requests[1].path, /type=album/);
  requests[1].resolve({ albums: { items: [{ name: 'Newest' }] } });
  await latestSearch;
  assert.equal(results.innerHTML, 'album:Newest');
  requests[0].resolve({ tracks: { items: [{ name: 'Stale' }] } });
  await oldSearch;
  assert.equal(results.innerHTML, 'album:Newest');
});

test('an empty submitted query supersedes a pending search without another API call', async () => {
  const { context, input, results, requests } = searchRuntime();
  const oldSearch = context.doSearch(); input.value = '   ';
  await context.doSearch();
  const emptyMessage = results.innerHTML;
  requests[0].resolve(null); await oldSearch;
  assert.equal(requests.length, 1);
  assert.equal(results.innerHTML, emptyMessage);
  assert.doesNotMatch(results.innerHTML, /failed|Stale/);
});

for (const loader of ['loadAlbumDetail', 'loadPlaylistDetail', 'loadArtistDetail']) {
  test(`${loader} ignores a late response after Back or another detail selection`, async () => {
    for (const replacement of [null, { uri: 'spotify:album:Newest', tracks: [] }]) {
      const original = { uri: 'old', tracks: [] }, state = { detail: original };
      const pending = deferred(); let writes = 0;
      const context = runtime([loader], {
        state, api: () => pending.promise,
        document: { getElementById() { writes += 1; return {}; } }, updateDetailSaveBtn() {}
      });
      const work = context[loader]('Old'); state.detail = replacement;
      pending.resolve({ uri: 'spotify:album:Old', artists: [], items: [], tracks: [] });
      await work;
      assert.equal(state.detail, replacement);
      assert.equal(original.uri, 'old');
      assert.equal(writes, 0, 'stale responses must not render or replace current metadata');
    }
  });
}

test('opening a detail from detail preserves the original Back destination', async () => {
  const state = { prevView: 'search' }, visits = [];
  const context = runtime(['openDetail', 'closeDetail'], {
    state, document: { querySelector: () => ({ id: 'view-detail' }), getElementById: () => ({}) },
    switchView: view => visits.push(view), updateDetailSaveBtn() {}, loadAlbumDetail: async () => {}
  });
  await context.openDetail('album', 'A', 'Album', 'spotify:album:A');
  context.closeDetail();
  assert.equal(state.detail, null);
  assert.deepEqual(visits, ['detail', 'search']);
});

function keyboardEvent(key, target, extra = {}) {
  return { key, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
}
function keyboardRuntime() {
  const calls = [], app = { classList: { contains: () => true } };
  const context = runtime(['handleAppKeydown'], {
    state: {}, document: { getElementById: () => app },
    togglePlay: () => calls.push('play'), nextTrack: () => calls.push('next'), prevTrack: () => calls.push('previous'),
    toggleShuffle: () => calls.push('shuffle'), toggleRepeat: () => calls.push('repeat'), nudgeVolume: () => calls.push('volume')
  });
  return { context, calls };
}

test('Space on a focused control remains native and never toggles playback', () => {
  const { context, calls } = keyboardRuntime();
  for (const control of ['button', 'input', 'select', 'a', '[role="slider"]']) {
    const event = keyboardEvent(' ', { closest: selector => selector.includes(control) ? {} : null });
    context.handleAppKeydown(event);
    assert.equal(event.defaultPrevented, false);
  }
  assert.deepEqual(calls, []);
});

test('plain arrows preserve native page scrolling and repeated shortcuts cannot spam playback', () => {
  const { context, calls } = keyboardRuntime(), target = { closest: () => null };
  for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
    const event = keyboardEvent(key, target); context.handleAppKeydown(event);
    assert.equal(event.defaultPrevented, false);
  }
  context.handleAppKeydown(keyboardEvent(' ', target, { repeat: true }));
  context.handleAppKeydown(keyboardEvent('s', target, { ctrlKey: true }));
  assert.deepEqual(calls, []);
  context.handleAppKeydown(keyboardEvent(' ', target));
  assert.deepEqual(calls, ['play']);
});

test('Space on a details summary stays available for native expansion without music shortcuts', () => {
  const { context, calls } = keyboardRuntime();
  const summary = { closest: selector => selector.split(',').includes('summary') ? {} : null };
  for (const key of [' ', 's', 'r']) {
    const event = keyboardEvent(key, summary);
    context.handleAppKeydown(event);
    assert.equal(event.defaultPrevented, false);
  }
  assert.deepEqual(calls, []);
});

function modalRuntime() {
  let active;
  function element(id) {
    const classes = new Set();
    return { id, isConnected: true, disabled: false, inert: false, getClientRects: () => [{}], closest: () => null,
      focus() { active = this; }, setAttribute() {}, classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) } };
  }
  const app = element('app'), trigger = element('trigger'), first = element('close'), last = element('last'), modal = element('modal-devices');
  modal.querySelectorAll = () => [first, last];
  active = trigger;
  const document = { get activeElement() { return active; }, getElementById: id => id === 'app' ? app : id === modal.id ? modal : null, querySelectorAll: () => [modal] };
  const state = {}, context = runtime(['modalFocusableElements', 'openModal', 'closeModal', 'handleAppKeydown'], {
    state, document, loadDevices() {}, togglePlay() { throw new Error('modal must not trigger playback'); }
  });
  return { context, state, document, app, trigger, first, last, modal };
}

test('modal focus is contained and returns to the trigger after Escape, including from inputs', () => {
  const { context, document, app, trigger, first, last, modal } = modalRuntime();
  context.openModal('devices');
  assert.equal(document.activeElement, first); assert.equal(app.inert, true);
  assert.equal(modal.classList.contains('active'), true);
  last.focus();
  const tab = keyboardEvent('Tab', last); context.handleAppKeydown(tab);
  assert.equal(document.activeElement, first); assert.equal(tab.defaultPrevented, true);
  const reverse = keyboardEvent('Tab', first, { shiftKey: true }); context.handleAppKeydown(reverse);
  assert.equal(document.activeElement, last); assert.equal(reverse.defaultPrevented, true);
  const escape = keyboardEvent('Escape', { closest: () => ({ tagName: 'INPUT' }) }); context.handleAppKeydown(escape);
  assert.equal(escape.defaultPrevented, true); assert.equal(app.inert, false);
  assert.equal(document.activeElement, trigger); assert.equal(modal.classList.contains('active'), false);
});

test('Listen Later is local-first and does not request Spotify data until expanded', async () => {
  const panel = { open: false }; let savesRendered = 0, spotifyLoaded = 0;
  const context = runtime(['loadLibrary'], {
    document: { getElementById: () => panel }, renderSavedLibrary() { savesRendered += 1; },
    loadSpotifyLibrary() { spotifyLoaded += 1; }
  });
  await context.loadLibrary();
  assert.equal(savesRendered, 1); assert.equal(spotifyLoaded, 0);
  panel.open = true; await context.loadLibrary();
  assert.equal(savesRendered, 2); assert.equal(spotifyLoaded, 1);
});

test('simultaneous remote library opens share one fetch and tolerate unavailable tracks', async () => {
  const requests = [], host = { innerHTML: '' };
  const context = runtime(['loadSpotifyLibrary'], {
    state: {}, _likedUris: [], document: { getElementById: () => host },
    api(path) { const pending = deferred(); requests.push({ path, ...pending }); return pending.promise; },
    renderTrackItem: track => `track:${track.name}`, renderPlaylistItem: playlist => `playlist:${playlist.name}`
  });
  const first = context.loadSpotifyLibrary(), second = context.loadSpotifyLibrary();
  assert.equal(requests.length, 3);
  requests[0].resolve({ items: [null, { track: null }, { track: { name: 'Recent' } }] });
  requests[1].resolve({ items: [{ track: null }, { track: { name: 'Liked', uri: 'spotify:track:A' } }] });
  requests[2].resolve({ items: [] });
  await Promise.all([first, second]);
  assert.match(host.innerHTML, /track:Recent/); assert.match(host.innerHTML, /track:Liked/);
  assert.deepEqual(Array.from(context._likedUris), ['spotify:track:A']);
  assert.equal(context.state.spotifyLibraryPromise, null);
});

function assertNativeSiblingActions(markup) {
  assert.match(markup, /<div class="item"><button class="item-main" type="button"/);
  assert.doesNotMatch(markup, /<div class="item"[^>]*onclick=/);
  const primary = markup.match(/<button class="item-main"[\s\S]*?<\/button>/)[0];
  assert.doesNotMatch(primary, /<div\b/, 'button contents use phrasing spans');
  assert.match(markup, /<\/button><div class="item-actions">/);
  let depth = 0;
  for (const tag of markup.matchAll(/<\/?button\b[^>]*>/g)) {
    depth += tag[0].startsWith('</') ? -1 : 1;
    assert.ok(depth === 0 || depth === 1, 'interactive buttons must not nest');
  }
  assert.equal(depth, 0);
}

test('search and queue rows expose native primary buttons with separate save and queue actions', () => {
  const context = runtime(['renderTrackItem', 'renderArtistItem', 'renderAlbumItem', 'renderPlaylistItem', 'escapeHtml', 'escapeAttr'], {
    formatTime: () => '3:20', savedItemFromEntity: entity => entity, registerSavedCandidate() {},
    savedActionButton: () => '<button type="button" aria-label="Save">+</button>',
    trackActionsHtml: () => '<div class="item-actions"><button type="button" aria-label="Queue">Queue</button><button type="button" aria-label="Save">+</button></div>'
  });
  const name = 'A < B & "C"', artists = [{ name: 'Artist' }];
  const track = { name, uri: 'spotify:track:A', artists, album: { name: 'Album' }, explicit: true };
  const row = context.renderTrackItem(track, 0, null, '<span class="queue-badge">queued</span>', 'playQueueFrom(2)');
  assertNativeSiblingActions(row);
  assert.match(row, /onclick="playQueueFrom\(2\)"/);
  assert.match(row, /aria-label="Play A &lt; B &amp; &quot;C&quot;"/);
  assert.match(row, /class="np-explicit"/); assert.match(row, /class="queue-badge"/);
  for (const [type, renderer] of [['artist', 'renderArtistItem'], ['album', 'renderAlbumItem'], ['playlist', 'renderPlaylistItem']]) {
    const markup = context[renderer]({ name, id: 'A', uri: `spotify:${type}:A`, artists }, 1);
    assertNativeSiblingActions(markup);
    assert.match(markup, new RegExp(`aria-label="Open ${type} A &lt; B`));
    assert.doesNotMatch(markup, /<img\b|< B/);
  }
  assert.equal(context.renderTrackItem(null, 0), '');
});

test('detail row handlers preserve quoted metadata without executable interpolation', () => {
  const name = 'Artist\'s "quoted" <name> & \\ newline\nfinish';
  let called;
  const context = runtime(['renderArtistItem', 'escapeHtml', 'escapeAttr'], {
    savedItemFromEntity: entity => entity, registerSavedCandidate() {}, savedActionButton: () => '',
    openDetail: (...args) => { called = args; }
  });
  const markup = context.renderArtistItem({ name, id: 'ABC', uri: 'spotify:artist:ABC' }, 0);
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
  const handler = markup.match(/onclick="([^"]*)"/)[1].replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => entities[entity]);
  new vm.Script(handler).runInContext(context);
  assert.deepEqual(called, ['artist', 'ABC', name, 'spotify:artist:ABC']);
});

test('saved collection rows separate opening from named play and remove actions', () => {
  const host = { innerHTML: '' }, saved = [{ type: 'album', uri: 'spotify:album:A', name: 'Favourite', subtitle: 'Artist', meta: '2026' }];
  const context = runtime(['renderSavedLibrary', 'escapeHtml'], {
    state: { savedFilter: 'all' }, document: { getElementById: () => host },
    readSavedLibrary: () => saved, registerSavedCandidate() {}
  });
  context.renderSavedLibrary();
  const row = host.innerHTML.slice(host.innerHTML.indexOf('<div class="item">'));
  assertNativeSiblingActions(row);
  assert.match(row, /aria-label="Open album Favourite"/);
  assert.match(row, /aria-label="Play Favourite"/);
  assert.match(row, /aria-label="Remove Favourite from Listen Later"/);
});

test('device choices are native buttons and restricted targets cannot be selected', async () => {
  const host = { innerHTML: '' };
  const context = runtime(['loadDevices', 'escapeHtml', 'escapeAttr'], {
    document: { getElementById: () => host }, api: async () => ({ devices: [
      { id: 'A', name: 'Desk', type: 'Computer', volume_percent: 0, is_active: true },
      { id: 'B', name: 'Restricted', type: 'Speaker', is_restricted: true }
    ] })
  });
  await context.loadDevices();
  assert.equal((host.innerHTML.match(/<button type="button" class="device-item/g) || []).length, 2);
  assert.match(host.innerHTML, /aria-pressed="true"/);
  assert.match(host.innerHTML, /vol 0%/);
  assert.match(host.innerHTML, /onclick="transferTo\('B'\)" disabled/);
  assert.match(host.innerHTML, /unavailable for control/);
  assert.doesNotMatch(host.innerHTML, /<div class="device-item/);
});

test('a full Listen Later list rejects new saves without losing older entries but still permits removal', () => {
  const saved = [{ type: 'track', uri: 'spotify:track:A' }, { type: 'track', uri: 'spotify:track:B' }];
  const original = JSON.stringify(saved), writes = [], messages = [];
  const context = runtime(['toggleSavedItem'], {
    state: {}, SAVED_LIMIT: 2, sanitizeSavedItem: item => item,
    readSavedLibrary: () => saved.map(item => ({ ...item })),
    writeSavedLibrary(items) { writes.push(items); return true; },
    toast: (message, kind) => messages.push({ message, kind }),
    renderSavedLibrary() {}, syncSavedActionButtons() {}, updateNowPlayingSave() {}, updateContextSaveBtn() {}
  });
  assert.equal(context.toggleSavedItem({ type: 'track', uri: 'spotify:track:C' }), false);
  assert.equal(writes.length, 0, 'saving at capacity must never write a truncated list');
  assert.equal(JSON.stringify(saved), original);
  assert.equal(messages[0].kind, 'error');
  assert.match(messages[0].message, /full \(2 items\).*Remove an item/);
  assert.equal(context.toggleSavedItem(saved[0]), true);
  assert.equal(writes.length, 1);
  assert.deepEqual(Array.from(writes[0], item => item.uri), ['spotify:track:B']);
});

test('idle playback clears metadata and hides the mini-player immediately on another view', () => {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      hidden: false, style: {}, textContent: '', classList: { remove() {}, contains: () => true }
    });
    return elements.get(id);
  }
  const state = { activeView: 'search', currentTrack: { name: 'Old track' }, currentTrackUri: 'spotify:track:A', currentTrackId: 'A' };
  const navigator = { mediaSession: { metadata: { title: 'Old track' }, playbackState: 'playing' } };
  const context = runtime(['showIdle', 'updateMiniPlayer'], {
    state, navigator, lyricsCurrentTrackId: 'A', document: { getElementById: element }, renderResume() {}
  });
  assert.equal(element('mini-player').hidden, false);
  context.showIdle();
  assert.equal(state.currentTrack, null);
  assert.equal(state.currentTrackUri, null);
  assert.equal(element('mini-player').hidden, true);
  assert.equal(navigator.mediaSession.metadata, null);
});

test('main and mini controls agree with local readiness without hiding a healthy transition Pause', () => {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      hidden: false, style: {}, attributes: {}, innerHTML: '',
      classList: { toggle() {}, contains: () => true },
      setAttribute(name, value) { this.attributes[name] = value; }
    });
    return elements.get(id);
  }
  const state = {
    activeView: 'search', preferredTarget: { kind: 'here' }, isPlaying: true,
    currentTrack: { name: 'Old track', artists: [] }, currentTrackUri: 'spotify:track:A',
    webPlayer: null, cleanplayDeviceId: null, sdkPlaybackActive: false, repeatState: 'off'
  };
  const context = runtime(['localPlaybackNeedsStart', 'playbackControlIsPlaying', 'updateControls', 'updateMiniPlayer'], {
    state, document: { getElementById: element }
  });
  context.updateControls();
  assert.equal(element('btn-play').attributes['aria-label'], 'Play');
  assert.equal(element('mini-play').attributes['aria-label'], 'Play');
  assert.equal(element('np-eq').style.display, 'none');
  assert.equal(element('play-icon').innerHTML, element('mini-play-icon').innerHTML);

  state.webPlayer = {}; state.cleanplayDeviceId = 'current-local';
  context.updateControls();
  assert.equal(state.sdkPlaybackActive, false, 'natural transitions need not have position proof yet');
  assert.equal(element('btn-play').attributes['aria-label'], 'Pause');
  assert.equal(element('mini-play').attributes['aria-label'], 'Pause');
  assert.equal(element('np-eq').style.display, 'inline-flex');

  state.needsSdkRecovery = true;
  context.updateControls();
  assert.equal(element('btn-play').attributes['aria-label'], 'Play');
  assert.equal(element('mini-play').attributes['aria-label'], 'Play');
});
