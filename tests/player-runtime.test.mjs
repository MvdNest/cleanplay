import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const lines = source.split(/\r?\n/);

function extractFunction(name) {
  const declaration = new RegExp(`^\\s*(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const start = lines.findIndex(line => declaration.test(line));
  assert.notEqual(start, -1, `missing ${name}`);
  for (let end = start; end < lines.length; end += 1) {
    const candidate = lines.slice(start, end + 1).join('\n');
    try {
      new vm.Script(candidate);
      return candidate;
    } catch {
      // Continue until the complete declaration parses.
    }
  }
  throw new Error(`could not extract ${name}`);
}

function contextWith(values = {}) {
  const context = vm.createContext({
    Promise,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Set,
    RegExp,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
    ...values
  });
  context.globalThis = context;
  return context;
}

function loadFunctions(context, names) {
  const dependencies = names.includes('togglePlay') ? ['localPlaybackNeedsStart', 'playbackControlIsPlaying'] : [];
  if(names.includes('executePlayerCommand'))dependencies.push('isStartPlaybackCommand');
  new vm.Script([...new Set([...dependencies, ...names])].map(extractFunction).join('\n')).runInContext(context);
}

test('a hidden iPhone keeps its player but expires the route lease and stale work', () => {
  let pollingStopped = 0;
  let recoveryStaged = 0;
  const player = {};
  const pendingWrite = Promise.resolve(true);
  const state = {
    preferredTarget: { kind: 'here' }, webPlayer: player, cleanplayDeviceId: 'ephemeral',
    sdkTransferEpoch: 4, sdkTransferPromise: Promise.resolve(true), playerCommandSequence: 7,
    playerCommandTail: pendingWrite, fetchStateSequence: 9, suspendedAt: 0
  };
  const context = contextWith({
    state,
    isAppVisible: () => false,
    stageQueueRecoveryIfActive: () => { recoveryStaged += 1; },
    stopPolling: () => { pollingStopped += 1; }
  });
  loadFunctions(context, ['preserveLocalPlaybackOnSuspend']);
  assert.equal(context.preserveLocalPlaybackOnSuspend(), false);
  assert.equal(state.webPlayer, player);
  assert.equal(state.cleanplayDeviceId, 'ephemeral');
  assert.equal(state.sdkTransferEpoch, 5);
  assert.equal(state.sdkTransferPromise, null);
  assert.equal(state.playerCommandSequence, 8);
  assert.equal(state.playerCommandTail, pendingWrite);
  assert.equal(state.fetchStateSequence, 10);
  assert.ok(state.suspendedAt > 0);
  assert.equal(recoveryStaged, 1);
  assert.equal(pollingStopped, 1);
});

test('going offline expires the local route lease and cancels stale recovery work', () => {
  let resumeCancelled = 0;
  let health = null;
  const state = {
    preferredTarget: { kind: 'here' }, webPlayer: {}, cleanplayDeviceId: 'ephemeral',
    sdkTransferEpoch: 10, sdkTransferPromise: Promise.resolve(true), playerCommandSequence: 3,
    fetchStateSequence: 5
  };
  const context = contextWith({
    state,
    stopPolling: () => {},
    cancelResumeAttempt: () => { resumeCancelled += 1; },
    isAppVisible: () => true,
    stageQueueRecoveryIfActive: () => {},
    noteDiagnostic: () => {},
    setConnectionHealth: (...args) => { health = args; }
  });
  loadFunctions(context, ['preserveLocalPlaybackOnSuspend', 'handleOffline']);
  context.handleOffline();
  assert.equal(state.sdkTransferEpoch, 11);
  assert.equal(state.sdkTransferPromise, null);
  assert.equal(state.playerCommandSequence, 4);
  assert.equal(state.fetchStateSequence, 6);
  assert.equal(resumeCancelled, 1);
  assert.equal(health[0], 'offline');
});

test('a long iPhone suspension never retires a player based on elapsed time alone', () => {
  const player = {};
  const state = {
    preferredTarget: { kind: 'here' }, webPlayer: player, cleanplayDeviceId: 'ephemeral',
    suspendedAt: 1000, sdkDeviceUnconfirmed: false, sdkTransferGeneration: 2,
    sdkRouteLeaseEpoch: 5, lastSuspendDurationMs: 0, isPlaying: true,
    sdkPlaybackActive: true, needsPlaybackResume: false
  };
  const context = contextWith({
    state,
    Date: { now: () => 121000 },
    usesIosPlaybackLifecycle: () => true
  });
  loadFunctions(context, ['consumeLocalSuspend']);
  assert.equal(context.consumeLocalSuspend(), 120000);
  assert.equal(state.webPlayer, player);
  assert.equal(state.cleanplayDeviceId, 'ephemeral');
  assert.equal(state.sdkDeviceUnconfirmed, false);
  assert.equal(state.sdkPlaybackActive, true);
  assert.equal(state.needsPlaybackResume, false);
  assert.equal(state.sdkTransferGeneration, 2);
  assert.equal(state.sdkRouteLeaseEpoch, 5);
});

test('a desktop return after 36 minutes and two missing discovery rows preserves the SDK player', async () => {
  const player = {};
  const state = {
    preferredTarget: { kind: 'here' }, webPlayer: player, cleanplayDeviceId: 'desktop-id',
    sdkGeneration: 2, sdkReady: true, sdkActivated: true, needsSdkRecovery: false,
    suspendedAt: 1000, sdkDeviceUnconfirmed: false, sdkTransferGeneration: 2,
    sdkTransferEpoch: 2, sdkRouteLeaseEpoch: 1, resumeGeneration: 0
  };
  let discoveryCalls = 0;
  const context = contextWith({
    state, Date: { now: () => 2161000 },
    navigator: { userAgent: 'Windows NT 10.0 Edg/140', platform: 'Win32', onLine: true },
    window: { Spotify: { Player: function Player() {} } },
    LOCAL_PLAYER_STALE_AFTER_SUSPEND_MS: 60000,
    isAppVisible: () => true,
    ensureToken: async () => true, verifyIdentityFirst: async () => true,
    reconcileDevices: async () => { discoveryCalls += 1; return false; },
    fetchState: async () => true, startPolling: () => {},
    noteDiagnostic: () => {}, setConnectionHealth: () => {},
    setTimeout: (callback, delay) => delay === 450 ? setTimeout(callback, 0) : setTimeout(callback, delay)
  });
  loadFunctions(context, ['usesIosPlaybackLifecycle', 'consumeLocalSuspend', 'resumeSession']);
  assert.equal(context.consumeLocalSuspend(), 2160000);
  assert.equal(await context.resumeSession('visible'), true);
  assert.equal(discoveryCalls, 2);
  assert.equal(state.webPlayer, player);
  assert.equal(state.cleanplayDeviceId, 'desktop-id');
  assert.equal(state.sdkDeviceUnconfirmed, false);
  assert.equal(state.needsSdkRecovery, false);
});

test('iPad desktop user agent is still identified as an iOS browser', () => {
  const context = contextWith({ navigator: { userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 5 } });
  loadFunctions(context, ['usesIosPlaybackLifecycle']);
  assert.equal(context.usesIosPlaybackLifecycle(), true);
});

test('route confirmation is a generation-and-epoch lease', () => {
  const state = {
    sdkGeneration: 3, sdkReady: true, cleanplayDeviceId: 'temporary-device',
    sdkTransferGeneration: 3, sdkTransferEpoch: 8, sdkRouteLeaseEpoch: 8,
    sdkDeviceUnconfirmed: false, activeDeviceId: 'temporary-device'
  };
  const context = contextWith({ state });
  loadFunctions(context, ['localRouteLeaseIsCurrent', 'withPlaybackTarget']);
  assert.equal(context.localRouteLeaseIsCurrent(3), true);
  assert.equal(context.withPlaybackTarget('/me/player/play'), '/me/player/play?device_id=temporary-device');
  state.sdkTransferEpoch += 1;
  assert.equal(context.localRouteLeaseIsCurrent(3), false);
  assert.equal(context.withPlaybackTarget('/me/player/play'), '/me/player/play?device_id=temporary-device');
});

test('SDK audibility requires the expected URI to advance', async () => {
  const diagnostics = [];
  let resumes = 0;
  let consumed = null;
  const track = uri => ({ current_track: { uri } });
  const states = [
    null,
    { paused: true, position: 0, track_window: track('spotify:track:A') },
    { paused: false, position: 0, track_window: track('spotify:track:A') },
    { paused: false, position: 280, track_window: track('spotify:track:A') }
  ];
  const player = {
    getCurrentState: async () => states.length ? states.shift() : { paused: false },
    resume: async () => { resumes += 1; }
  };
  const state = { webPlayer: player, sdkGeneration: 2, sdkPlaybackActive: true, sdkProgressCheckSequence: 0 };
  const context = contextWith({
    state,
    sdkRouteDelay: async () => {},
    markSdkGenerationForRecovery: () => {},
    consumeQueueLedger: uri => { consumed = uri; },
    startPolling: () => {},
    noteDiagnostic: (...args) => diagnostics.push(args),
    setConnectionHealth: () => {}
  });
  loadFunctions(context, ['sdkCallWithin', 'ensureSdkPlaybackAudible']);
  assert.equal(await context.ensureSdkPlaybackAudible(2, null, 'spotify:track:A'), true);
  assert.equal(resumes, 1);
  assert.equal(consumed, 'spotify:track:A');
  assert.equal(diagnostics.at(-1)[1], 'sdk_resume');
  assert.equal(diagnostics.at(-1)[2].outcome, 'ok');
  assert.equal(diagnostics.at(-1)[2].progress, 'advanced');
});

test('cached playback flags and paused-false position zero are not audible proof', async () => {
  let marked = null;
  const player = {
    getCurrentState: async () => ({
      paused: false,
      position: 0,
      track_window: { current_track: { uri: 'spotify:track:A' } }
    }),
    resume: async () => {}
  };
  const state = { webPlayer: player, sdkGeneration: 2, sdkPlaybackActive: true, sdkProgressCheckSequence: 0 };
  const context = contextWith({
    state,
    sdkRouteDelay: async () => {},
    markSdkGenerationForRecovery: reason => { marked = reason; },
    consumeQueueLedger: () => {},
    startPolling: () => {},
    noteDiagnostic: () => {},
    setConnectionHealth: () => {}
  });
  loadFunctions(context, ['sdkCallWithin', 'ensureSdkPlaybackAudible']);
  assert.equal(await context.ensureSdkPlaybackAudible(2, null, 'spotify:track:A'), false);
  assert.equal(marked, 'position_stalled');
});

test('an old advancing context cannot confirm a new context command', async () => {
  let position = 0;
  let marked = null;
  const player = {
    getCurrentState: async () => ({
      paused: false,
      position: position += 300,
      context: { uri: 'spotify:album:OLD' },
      track_window: { current_track: { uri: 'spotify:track:OLD' } }
    }),
    resume: async () => {}
  };
  const state = { webPlayer: player, sdkGeneration: 2, sdkPlaybackActive: false, sdkProgressCheckSequence: 0 };
  const context = contextWith({
    state,
    sdkRouteDelay: async () => {},
    markSdkGenerationForRecovery: reason => { marked = reason; },
    consumeQueueLedger: () => {},
    startPolling: () => {},
    noteDiagnostic: () => {},
    setConnectionHealth: () => {}
  });
  loadFunctions(context, ['sdkCallWithin', 'ensureSdkPlaybackAudible']);
  assert.equal(await context.ensureSdkPlaybackAudible(2, null, null, 'spotify:album:NEW'), false);
  assert.equal(marked, 'position_stalled');
});

test('an explicit selection never resumes a null or mismatched old SDK state', async () => {
  let resumes = 0;
  const states = [
    null,
    { paused: true, position: 8000, track_window: { current_track: { uri: 'spotify:track:OLD' } } },
    { paused: false, position: 8400, track_window: { current_track: { uri: 'spotify:track:OLD' } } }
  ];
  const player = {
    getCurrentState: async () => states.length ? states.shift() : states.at(-1),
    resume: async () => { resumes += 1; }
  };
  const state = { webPlayer: player, sdkGeneration: 2, sdkPlaybackActive: false, sdkProgressCheckSequence: 0 };
  const context = contextWith({
    state,
    sdkRouteDelay: async () => {},
    markSdkGenerationForRecovery: () => {},
    consumeQueueLedger: () => {},
    startPolling: () => {},
    noteDiagnostic: () => {},
    setConnectionHealth: () => {}
  });
  loadFunctions(context, ['sdkCallWithin', 'ensureSdkPlaybackAudible']);
  assert.equal(await context.ensureSdkPlaybackAudible(2, null, 'spotify:track:NEW'), false);
  assert.equal(resumes, 0);
});

test('never-settling SDK state and pause calls are bounded during recovery', async () => {
  let marked = null;
  let timerId = 0;
  const never = new Promise(() => {});
  const player = {
    getCurrentState: () => never,
    pause: () => never,
    resume: () => never
  };
  const state = { webPlayer: player, sdkGeneration: 2, sdkPlaybackActive: false, sdkProgressCheckSequence: 0 };
  const context = contextWith({
    state,
    setTimeout: callback => { Promise.resolve().then(callback); return ++timerId; },
    clearTimeout: () => {},
    sdkRouteDelay: async () => {},
    markSdkGenerationForRecovery: reason => { marked = reason; },
    consumeQueueLedger: () => {},
    startPolling: () => {},
    noteDiagnostic: () => {},
    setConnectionHealth: () => {}
  });
  loadFunctions(context, ['sdkCallWithin', 'ensureSdkPlaybackAudible']);
  assert.equal(await context.ensureSdkPlaybackAudible(2, null, 'spotify:track:A'), false);
  assert.equal(marked, 'position_stalled');
});

test('a superseded final SDK sample cannot pause or invalidate a newer selection', async () => {
  let current = true;
  let samples = 0;
  let pauses = 0;
  let recoveries = 0;
  const player = {
    getCurrentState: async () => {
      samples += 1;
      if (samples === 6) current = false;
      return { paused: false, position: 0, track_window: { current_track: { uri: 'spotify:track:A' } } };
    },
    pause: async () => { pauses += 1; }
  };
  const state = { webPlayer: player, sdkGeneration: 2 };
  const context = contextWith({
    state,
    sdkRouteDelay: async () => {},
    markSdkGenerationForRecovery: () => { recoveries += 1; },
    noteDiagnostic: () => {}, setConnectionHealth: () => {}
  });
  loadFunctions(context, ['sdkCallWithin', 'ensureSdkPlaybackAudible']);
  assert.equal(await context.ensureSdkPlaybackAudible(2, () => current, 'spotify:track:A'), false);
  assert.equal(samples, 6);
  assert.equal(pauses, 0);
  assert.equal(recoveries, 0);
});

test('a superseded advancing SDK result cannot clear the new selection recovery plan', async () => {
  let current = true;
  let samples = 0;
  const recovery = { currentUri: 'spotify:track:NEW', uris: ['spotify:track:NEXT'] };
  const player = {
    getCurrentState: async () => {
      samples += 1;
      if (samples === 2) current = false;
      return { paused: false, position: samples * 300, track_window: { current_track: { uri: 'spotify:track:OLD' } } };
    }
  };
  const state = { webPlayer: player, sdkGeneration: 2, queueRecoveryPlan: recovery };
  const context = contextWith({
    state, sdkRouteDelay: async () => {},
    consumeQueueLedger: () => { throw new Error('stale sample must not consume the queue'); }
  });
  loadFunctions(context, ['sdkCallWithin', 'ensureSdkPlaybackAudible']);
  assert.equal(await context.ensureSdkPlaybackAudible(2, () => current, 'spotify:track:OLD'), false);
  assert.equal(state.queueRecoveryPlan, recovery);
});

test('Web API is_playing cannot consume a local queue before SDK progress proof', async () => {
  let consumed = 0;
  const state = {
    fetchStateSequence: 0, currentTrackUri: null, localDuration: 0, localProgress: 0,
    isPlaying: false, sdkPlaybackActive: false, cleanplayDeviceId: 'local',
    preferredTarget: { kind: 'here' }, webPlayer: {
      getCurrentState: async () => ({ paused: false, position: 0 })
    }, _sleepExpiredPending: false, _lastQueueTrackUri: null, _queueRefreshAt: 0
  };
  const context = contextWith({
    state,
    api: async () => ({
      is_playing: true, shuffle_state: false, repeat_state: 'off', progress_ms: 0,
      device: { id: 'local', name: 'CleanPlay', type: 'Computer', is_restricted: false },
      item: { id: 'A', uri: 'spotify:track:A', name: 'A', duration_ms: 180000, artists: [] },
      context: null
    }),
    setPreferredTarget: () => {},
    startPolling: () => {},
    consumeQueueLedger: () => { consumed += 1; },
    updateContextLine: async () => true,
    updateNowPlaying: () => {},
    updateControls: () => {},
    updateMediaSession: () => {},
    refreshUpNext: () => {},
    localStorage: { setItem: () => {} },
    noteDiagnostic: () => {},
    playbackTargetKind: () => 'here'
  });
  loadFunctions(context, ['sdkCallWithin', 'fetchState']);
  assert.equal(await context.fetchState(), true);
  assert.equal(state.sdkPlaybackActive, false);
  assert.equal(consumed, 0);
});

test('a lagging playback poll cannot steal the locally selected SDK target', async () => {
  const state = {
    fetchStateSequence: 0, currentTrackUri: null, localDuration: 0, localProgress: 0,
    isPlaying: false, sdkPlaybackActive: false, cleanplayDeviceId: 'fresh-local',
    activeDeviceId: 'fresh-local', activeDeviceName: 'CleanPlay - this device',
    activeDeviceType: 'Computer', preferredTarget: { kind: 'here' }, webPlayer: null,
    _sleepExpiredPending: false, _lastQueueTrackUri: null, _queueRefreshAt: 0
  };
  const context = contextWith({
    state,
    api: async () => ({
      is_playing: true, shuffle_state: false, repeat_state: 'off', progress_ms: 4000,
      device: { id: 'lagging-remote', name: 'Old device', type: 'Computer', is_restricted: false },
      item: { id: 'A', uri: 'spotify:track:A', name: 'A', duration_ms: 180000, artists: [] },
      context: null
    }),
    setPreferredTarget: () => {},
    startPolling: () => {},
    consumeQueueLedger: () => {},
    updateContextLine: async () => true,
    updateNowPlaying: () => {},
    updateControls: () => {},
    updateMediaSession: () => {},
    refreshUpNext: () => {},
    localStorage: { setItem: () => {} },
    noteDiagnostic: () => {},
    playbackTargetKind: () => 'here'
  });
  loadFunctions(context, ['sdkCallWithin', 'fetchState']);
  assert.equal(await context.fetchState(), true);
  assert.equal(state.activeDeviceId, 'fresh-local');
  assert.equal(state.activeDeviceName, 'CleanPlay - this device');
  assert.equal(state.currentTrackUri, null);
  assert.equal(state.isPlaying, false);
});

test('the first play tap after an unconfirmed local wake resumes instead of pausing', async () => {
  let command = null;
  const state = {
    preferredTarget: { kind: 'here' }, isPlaying: true, sdkPlaybackActive: false,
    needsSdkRecovery: false, sdkDeviceUnconfirmed: true, needsPlaybackResume: true,
    currentTrackUri: 'spotify:track:A', activeDeviceId: 'local', cleanplayDeviceId: 'local'
  };
  const context = contextWith({
    state,
    activeQueueRecoveryPlan: () => null,
    lastPlayedBody: () => null,
    playerCommand: async label => { command = label; return true; },
    preparePlaybackIntent: () => false,
    startPolling: () => {},
    updateControls: () => {},
    navigator: {}
  });
  loadFunctions(context, ['togglePlay']);
  assert.equal(await context.togglePlay(), true);
  assert.equal(command, 'play');
});

test('an explicit local pause stays serialized but never activates, rebuilds, or transfers', async () => {
  const requests = [];
  const state = {
    preferredTarget: { kind: 'here' }, isPlaying: true, sdkPlaybackActive: true,
    needsSdkRecovery: true, sdkDeviceUnconfirmed: true, needsPlaybackResume: true,
    currentTrackUri: 'spotify:track:A', activeDeviceId: 'old-local', cleanplayDeviceId: 'current-local',
    sdkGeneration: 3, playerCommandSequence: 0, sdkProgressCheckSequence: 2,
    playbackCommandEpoch: 4, pendingPlaybackIntent: { label: 'play_track' }, accessToken: 'present'
  };
  const context = contextWith({
    state, navigator: {}, activeQueueRecoveryPlan: () => null,
    preparePlaybackIntent: () => { throw new Error('pause must not prepare audio'); },
    ensureLocalPlaybackRoute: () => { throw new Error('pause must not transfer audio'); },
    api: async (path, method) => { requests.push([path, method]); return {}; },
    noteDiagnostic: () => {}, setConnectionHealth: () => {}, updateControls: () => {}
  });
  loadFunctions(context, [
    'togglePlay', 'playerCommand', 'executePlayerCommand', 'isStartPlaybackCommand',
    'commandSupersedesPlayback', 'withPlaybackTarget', 'playbackTargetKind'
  ]);
  assert.equal(await context.togglePlay(false), true);
  assert.deepEqual(requests, [['/me/player/pause?device_id=current-local', 'PUT']]);
  assert.equal(state.pendingPlaybackIntent, null);
  assert.equal(state.playerCommandSequence, 1);
  assert.equal(state.playbackCommandEpoch, 5);
  assert.equal(state.sdkProgressCheckSequence, 3);
  assert.equal(state.isPlaying, false);
});

test('the displayed Pause control pauses during a natural track transition', async () => {
  let command = null;
  const state = {
    preferredTarget: { kind: 'here' }, isPlaying: true, sdkPlaybackActive: false,
    needsSdkRecovery: false, sdkDeviceUnconfirmed: false, needsPlaybackResume: false,
    currentTrackUri: 'spotify:track:B', activeDeviceId: 'local', cleanplayDeviceId: 'local', webPlayer: {}
  };
  const context = contextWith({
    state, navigator: {}, activeQueueRecoveryPlan: () => null,
    preparePlaybackIntent: () => { throw new Error('the displayed Pause must not prepare a new start'); },
    playerCommand: async label => { command = label; return true; }, updateControls: () => {}
  });
  loadFunctions(context, ['togglePlay']);
  assert.equal(await context.togglePlay(), true);
  assert.equal(command, 'pause');
  assert.equal(state.isPlaying, false);
});

test('pause with no current local device leaves a different Spotify device untouched', async () => {
  const state = {
    preferredTarget: { kind: 'here' }, cleanplayDeviceId: null,
    activeDeviceId: 'unrelated-remote', playerCommandSequence: 1
  };
  const context = contextWith({
    state, noteDiagnostic: () => {}, setConnectionHealth: () => {},
    reconcileDevices: () => { throw new Error('pause must not pick a different device'); },
    api: () => { throw new Error('pause must not target a different device'); }
  });
  loadFunctions(context, ['executePlayerCommand']);
  assert.equal(await context.executePlayerCommand('pause', () => ({}), 1), false);
});

test('a cold local page starts its remembered selection instead of pausing an old reported device', async () => {
  let replay = null;
  const state = {
    preferredTarget: { kind: 'here' }, isPlaying: true, sdkPlaybackActive: false,
    webPlayer: null, cleanplayDeviceId: null, sdkGeneration: 0,
    needsSdkRecovery: false, sdkDeviceUnconfirmed: false, needsPlaybackResume: false,
    currentTrackUri: 'spotify:track:A', activeDeviceId: 'previous-session'
  };
  const context = contextWith({
    state, activeQueueRecoveryPlan: () => null,
    lastPlayedBody: () => ({ uris: ['spotify:track:A'] }),
    playBody: async (label, body) => { replay = { label, body }; return true; },
    playerCommand: () => { throw new Error('an absent local player cannot pause the old device'); }
  });
  loadFunctions(context, ['togglePlay']);
  assert.equal(context.playbackControlIsPlaying(), false);
  assert.equal(await context.togglePlay(), true);
  assert.equal(replay.label, 'resume_last');
  assert.deepEqual(Array.from(replay.body.uris), ['spotify:track:A']);
});

test('a cold local page without remembered metadata prepares a normal start', async () => {
  let prepared = null;
  const state = {
    preferredTarget: { kind: 'here' }, isPlaying: true, webPlayer: null,
    cleanplayDeviceId: null, currentTrackUri: 'spotify:track:A'
  };
  const context = contextWith({
    state, activeQueueRecoveryPlan: () => null, lastPlayedBody: () => null,
    preparePlaybackIntent: label => { prepared = label; return true; }
  });
  loadFunctions(context, ['togglePlay']);
  assert.equal(await context.togglePlay(), false);
  assert.equal(prepared, 'play');
});

test('remote playback still pauses without any local SDK player', async () => {
  let command = null;
  const state = {
    preferredTarget: { kind: 'remote' }, isPlaying: true, webPlayer: null,
    cleanplayDeviceId: null, activeDeviceId: 'remote', currentTrackUri: 'spotify:track:A'
  };
  const context = contextWith({
    state, navigator: {}, activeQueueRecoveryPlan: () => null,
    playerCommand: async label => { command = label; return true; }, updateControls() {},
    preparePlaybackIntent: () => { throw new Error('remote pause must not prepare a local player'); }
  });
  loadFunctions(context, ['togglePlay']);
  assert.equal(context.playbackControlIsPlaying(), true);
  assert.equal(await context.togglePlay(), true);
  assert.equal(command, 'pause');
});

test('a sleep pause supersedes a pending play and clears its deferred intent', async () => {
  const commands = [];
  const state = {
    playerCommandSequence: 0, playbackCommandEpoch: 5,
    pendingPlaybackIntent: { label: 'play_track' }, sdkProgressCheckSequence: 0
  };
  const context = contextWith({ state, executePlayerCommand: async command => { commands.push(command); return true; } });
  loadFunctions(context, ['playerCommand', 'commandSupersedesPlayback', 'isStartPlaybackCommand']);
  const play = context.playerCommand('play_track', () => ({}));
  const pause = context.playerCommand('sleep_pause', () => ({}));
  assert.deepEqual(await Promise.all([play, pause]), [false, true]);
  assert.deepEqual(commands, ['sleep_pause']);
  assert.equal(state.pendingPlaybackIntent, null);
  assert.equal(state.playbackCommandEpoch, 6);
});

test('resuming a healthy paused player ignores its obsolete pre-lock queue snapshot', async () => {
  let command = null;
  const state = {
    preferredTarget: { kind: 'here' }, isPlaying: false, sdkPlaybackActive: false,
    needsSdkRecovery: false, sdkDeviceUnconfirmed: false, needsPlaybackResume: false,
    currentTrackUri: 'spotify:track:B', activeDeviceId: 'local', cleanplayDeviceId: 'local', webPlayer: {}
  };
  const context = contextWith({
    state, navigator: {}, activeQueueRecoveryPlan: () => ({ currentUri: 'spotify:track:A', uris: ['spotify:track:B'] }),
    preparePlaybackIntent: () => false,
    playBody: () => { throw new Error('healthy resume must not restart the pre-lock track'); },
    playerCommand: async label => { command = label; return true; },
    startPolling: () => {}, updateControls: () => {}
  });
  loadFunctions(context, ['togglePlay']);
  assert.equal(await context.togglePlay(true), true);
  assert.equal(command, 'play');
});

test('healthy local next and previous keep Spotify skip semantics', async () => {
  const commands = [];
  let foregroundCancellations = 0;
  const state = {
    preferredTarget: { kind: 'here' }, isPlaying: true, sdkPlaybackActive: true,
    needsSdkRecovery: false, sdkDeviceUnconfirmed: false, needsPlaybackResume: false,
    localProgress: 0
  };
  const context = contextWith({
    state,
    playerCommand: async label => { commands.push(label); return true; },
    preparePlaybackIntent: () => { throw new Error('healthy skip must not register or activate a player'); },
    cancelForegroundResumeForGesture: () => { foregroundCancellations += 1; },
    stageQueueRecoveryIfActive: () => { throw new Error('healthy playback must not stage recovery'); },
    activeQueueRecoveryPlan: () => ({ currentUri: 'spotify:track:A', uris: ['spotify:track:B'] }),
    playBody: async () => { throw new Error('healthy skip must not replace context'); },
    setConnectionHealth: () => {},
    setTimeout: () => 1,
    fetchState: () => {}
  });
  loadFunctions(context, ['localRecoveryControlPlan', 'nextTrack', 'prevTrack']);
  assert.equal(await context.nextTrack(), true);
  assert.equal(await context.prevTrack(), true);
  assert.deepEqual(commands, ['next', 'previous']);
  assert.equal(foregroundCancellations, 2, 'direct transport gestures still supersede stale foreground reads');
});

test('seeking after backgrounding never transfers or pauses a healthy local player', async () => {
  const requests = [];
  const state = {
    preferredTarget: { kind: 'here' }, isPlaying: true, sdkPlaybackActive: true,
    webPlayer: {}, cleanplayDeviceId: 'local', activeDeviceId: 'local', sdkGeneration: 2,
    sdkReady: true, sdkActivated: true, sdkTransferGeneration: 2, sdkTransferEpoch: 8,
    sdkRouteLeaseEpoch: 8, playerCommandSequence: 0, localProgress: 12000, localDuration: 120000
  };
  const context = contextWith({
    state, isAppVisible: () => false, stageQueueRecoveryIfActive() {}, stopPolling() {},
    updateProgress() {}, noteDiagnostic() {}, setConnectionHealth() {},
    ensureLocalPlaybackRoute: () => { throw new Error('seeking must not transfer with play:false'); },
    api: async (path, method, body) => { requests.push({ path, method, body }); return {}; }
  });
  loadFunctions(context, ['preserveLocalPlaybackOnSuspend', 'seekTo', 'playerCommand', 'executePlayerCommand',
    'isStartPlaybackCommand', 'commandSupersedesPlayback', 'withPlaybackTarget', 'playbackTargetKind']);
  context.preserveLocalPlaybackOnSuspend();
  assert.notEqual(state.sdkRouteLeaseEpoch, state.sdkTransferEpoch);
  assert.equal(await context.seekTo(45000), true);
  assert.deepEqual(requests, [{ path: '/me/player/seek?position_ms=45000&device_id=local', method: 'PUT', body: null }]);
  assert.equal(state.localProgress, 45000);
  assert.equal(state.isPlaying, true);
  assert.equal(state.sdkPlaybackActive, true);
});

test('existing-session controls use only their exact local endpoint after a route lease expires', async () => {
  const controls = [
    ['next', '/me/player/next', 'POST'], ['previous', '/me/player/previous', 'POST'],
    ['queue', '/me/player/queue?uri=spotify%3Atrack%3AB', 'POST'],
    ['volume', '/me/player/volume?volume_percent=45', 'PUT'],
    ['shuffle', '/me/player/shuffle?state=true', 'PUT'], ['repeat', '/me/player/repeat?state=context', 'PUT']
  ];
  for(const [command, path, method] of controls) {
    const requests = [];
    const state = {
      preferredTarget: { kind: 'here' }, webPlayer: {}, cleanplayDeviceId: 'local', activeDeviceId: 'lagging-remote',
      sdkGeneration: 2, sdkTransferGeneration: 2, sdkRouteLeaseEpoch: 1, sdkTransferEpoch: 2,
      playerCommandSequence: 4, isPlaying: true
    };
    const context = contextWith({
      state, noteDiagnostic() {}, setConnectionHealth() {},
      ensureLocalPlaybackRoute: () => { throw new Error(`${command} must not transfer playback`); },
      api: async (requestPath, requestMethod) => { requests.push([requestPath, requestMethod]); return {}; }
    });
    loadFunctions(context, ['executePlayerCommand', 'withPlaybackTarget', 'playbackTargetKind']);
    assert.equal(await context.executePlayerCommand(command, () => ({ path: context.withPlaybackTarget(path), method }), 4), true);
    assert.deepEqual(requests, [[`${path}${path.includes('?') ? '&' : '?'}device_id=local`, method]]);
    assert.equal(state.isPlaying, true);
    assert.equal(state.sdkRouteLeaseEpoch, 1, 'an ordinary control must not falsely confirm the full start handshake');
  }
});

test('local controls with no current SDK ID never fall back to an old remote target', async () => {
  for(const command of ['seek', 'next', 'previous', 'queue', 'volume', 'shuffle', 'repeat', 'pause', 'sleep_pause']) {
    const state = {
      preferredTarget: { kind: 'here' }, cleanplayDeviceId: null, activeDeviceId: 'unrelated-remote',
      playerCommandSequence: 1
    };
    const context = contextWith({
      state, noteDiagnostic() {}, setConnectionHealth() {},
      reconcileDevices: () => { throw new Error(`${command} cannot choose a different target`); },
      api: () => { throw new Error(`${command} cannot change the unrelated device`); }
    });
    loadFunctions(context, ['executePlayerCommand']);
    assert.equal(await context.executePlayerCommand(command, () => ({}), 1), false);
  }
});

test('an existing-session local 404 fails once without replay, transfer, or remote reconciliation', async () => {
  const requests = []; let invalidations = 0;
  const state = {
    preferredTarget: { kind: 'here' }, cleanplayDeviceId: 'stale-local', activeDeviceId: 'stale-local',
    sdkGeneration: 3, playerCommandSequence: 1, accessToken: 'present'
  };
  const context = contextWith({
    state, noteDiagnostic() {}, setConnectionHealth() {}, stageQueueRecoveryIfActive() {},
    invalidateSdkDevice: () => { invalidations += 1; },
    ensureLocalPlaybackRoute: () => { throw new Error('seek must not transfer'); },
    recoverPlaybackTarget: () => { throw new Error('a local 404 cannot silently replay the control'); },
    api: async (path, method, body, options) => {
      requests.push(path); Object.assign(options.failureSink, { status: 404, reason: 'device_missing' }); return null;
    }
  });
  loadFunctions(context, ['executePlayerCommand', 'withPlaybackTarget']);
  assert.equal(await context.executePlayerCommand('seek', () => ({ path: context.withPlaybackTarget('/me/player/seek?position_ms=10000'), method: 'PUT' }), 1), false);
  assert.deepEqual(requests, ['/me/player/seek?position_ms=10000&device_id=stale-local']);
  assert.equal(invalidations, 1);
});

test('a late local control response cannot act on a newer SDK generation', async () => {
  const state = {
    preferredTarget: { kind: 'here' }, cleanplayDeviceId: 'old-local', activeDeviceId: 'old-local',
    sdkGeneration: 3, playerCommandSequence: 1
  };
  const context = contextWith({
    state, noteDiagnostic() {}, setConnectionHealth() {},
    api: async () => { state.sdkGeneration = 4; state.cleanplayDeviceId = 'new-local'; return {}; }
  });
  loadFunctions(context, ['executePlayerCommand', 'withPlaybackTarget']);
  assert.equal(await context.executePlayerCommand('volume', () => ({ path: context.withPlaybackTarget('/me/player/volume?volume_percent=45'), method: 'PUT' }), 1), false);
});

test('next and previous cancel older pending starts without preparing a new playback intent', async () => {
  for(const command of ['next', 'previous']) {
    const state = { pendingPlaybackIntent: { label: 'play_track' }, playerCommandSequence: 0, playbackCommandEpoch: 5, sdkProgressCheckSequence: 2 };
    const context = contextWith({ state, executePlayerCommand: async () => true });
    loadFunctions(context, ['playerCommand', 'commandSupersedesPlayback', 'isStartPlaybackCommand']);
    assert.equal(await context.playerCommand(command, () => ({})), true);
    assert.equal(state.pendingPlaybackIntent, null);
    assert.equal(state.playbackCommandEpoch, 6);
    assert.equal(state.sdkProgressCheckSequence, 3);
  }
});

test('an accepted Web API play remains failed when the SDK is silent', async () => {
  const diagnostics = [];
  const state = {
    playerCommandSequence: 1, activeDeviceId: 'local', cleanplayDeviceId: 'local',
    sdkGeneration: 5, sdkTransferEpoch: 3, sdkRouteLeaseEpoch: 3,
    sdkTransferGeneration: 5, sdkDeviceUnconfirmed: false, accessToken: 'present'
  };
  const context = contextWith({
    state,
    reconcileDevices: async () => true,
    ensureLocalPlaybackRoute: async () => true,
    isStartPlaybackCommand: () => true,
    api: async () => ({}),
    ensureSdkPlaybackAudible: async () => false,
    noteDiagnostic: (...args) => diagnostics.push(args),
    playbackTargetKind: () => 'here',
    setConnectionHealth: () => {},
    stageQueueRecoveryIfActive: () => {},
    invalidateSdkDevice: () => {},
    recoverPlaybackTarget: async () => false
  });
  loadFunctions(context, ['expectedPlaybackUri', 'expectedPlaybackContext', 'executePlayerCommand']);
  const result = await context.executePlayerCommand('play_track', () => ({ path: '/me/player/play', method: 'PUT' }), 1);
  assert.equal(result, false);
  assert.equal(diagnostics.some(([, event]) => event === 'command_ok'), false);
  assert.equal(diagnostics.at(-1)[1], 'command_failed');
  assert.equal(diagnostics.at(-1)[2].reason, 'position_stalled');
});

test('failed audible playback retains the latest pending selection', async () => {
  const pending = { id: 1, label: 'play_track', run: async () => false, createdAt: Date.now(), running: false, promise: null };
  const state = {
    pendingPlaybackIntent: pending, sdkGeneration: 4, sdkReady: true, sdkActivated: true,
    sdkActivationGeneration: 4, sdkActivationPromise: Promise.resolve(true)
  };
  const context = contextWith({
    state,
    PENDING_PLAYBACK_TTL_MS: 120000,
    ensureLocalPlaybackRoute: async () => true,
    setConnectionHealth: () => {}
  });
  loadFunctions(context, ['runPendingPlaybackIntent']);
  assert.equal(await context.runPendingPlaybackIntent(4), false);
  assert.equal(state.pendingPlaybackIntent, pending);
  assert.equal(pending.running, false);
});

test('a fresh connecting replacement is reused by an impatient second tap', () => {
  let rebuilds = 0;
  let activations = 0;
  const state = {
    preferredTarget: { kind: 'here' }, activeDeviceId: null, cleanplayDeviceId: null,
    webPlayer: {}, needsSdkRecovery: false, sdkDeviceUnconfirmed: false,
    sdkGeneration: 8, sdkReady: false, playbackIntentSequence: 0
  };
  const context = contextWith({
    state,
    window: { Spotify: { Player: function Player() {} } },
    cancelForegroundResumeForGesture: () => {},
    queuePendingPlaybackIntent: (label, run) => {
      state.pendingPlaybackIntent = { id: ++state.playbackIntentSequence, label, run };
    },
    rebuildWebPlayerForGesture: () => { rebuilds += 1; return {}; },
    activateSdkAudio: () => { activations += 1; return Promise.resolve(true); },
    runPendingPlaybackIntent: () => Promise.resolve(false),
    initWebPlayer: () => {},
    noteDiagnostic: () => {},
    setConnectionHealth: () => {},
    setPreferredTarget: () => {}
  });
  loadFunctions(context, ['preparePlaybackIntent']);
  assert.equal(context.preparePlaybackIntent('play_track', async () => true), true);
  assert.equal(context.preparePlaybackIntent('play_track', async () => true), true);
  assert.equal(rebuilds, 0);
  assert.equal(activations, 2);
  assert.equal(state.pendingPlaybackIntent.id, 2);
});

test('an initialization error immediately marks a fresh generation replaceable', async () => {
  const listeners = {};
  let readyResolved = null;
  const player = {
    addListener: (event, handler) => { listeners[event] = handler; },
    connect: async () => true,
    pause: async () => {},
    disconnect: () => {}
  };
  const Player = function Player() { return player; };
  const state = {
    accessToken: 'present', sdkGeneration: 3, needsSdkRecovery: true,
    sdkTransferEpoch: 0, sdkProgressCheckSequence: 0,
    preferredTarget: { kind: 'here' }, currentTrackUri: null
  };
  const context = contextWith({
    state,
    Spotify: { Player },
    window: { Spotify: { Player } },
    makeSdkReadyPromise: generation => { state.sdkReadyGeneration = generation; },
    ensureToken: async () => true,
    stageQueueRecoveryIfActive: () => {},
    resolveSdkReady: value => { readyResolved = value; },
    noteDiagnostic: () => {},
    setConnectionHealth: () => {}
  });
  loadFunctions(context, ['markSdkGenerationForRecovery', 'createWebPlayer']);
  assert.equal(context.createWebPlayer(), player);
  assert.equal(state.needsSdkRecovery, false);
  listeners.initialization_error();
  assert.equal(state.needsSdkRecovery, true);
  assert.equal(state.sdkDeviceUnconfirmed, true);
  assert.equal(readyResolved, false);
  await Promise.resolve();
});

test('an SDK ready event while iPhone is hidden preserves its fresh registration', async () => {
  const listeners = {};
  const player = {
    addListener: (event, handler) => { listeners[event] = handler; },
    connect: async () => true
  };
  const Player = function Player() { return player; };
  const state = {
    accessToken: 'present', sdkGeneration: 3, preferredTarget: { kind: 'here' },
    sdkDeviceUnconfirmed: true, sdkActivated: false
  };
  const context = contextWith({
    state, Spotify: { Player }, window: { Spotify: { Player } },
    usesIosPlaybackLifecycle: () => true, isAppVisible: () => false,
    makeSdkReadyPromise: () => {}, resolveSdkReady: () => {},
    runPendingPlaybackIntent: async () => false,
    noteDiagnostic: () => {}, setConnectionHealth: () => {}
  });
  loadFunctions(context, ['createWebPlayer']);
  context.createWebPlayer();
  listeners.ready({ device_id: 'fresh-hidden-player' });
  assert.equal(state.webPlayer, player);
  assert.equal(state.sdkGeneration, 4);
  assert.equal(state.cleanplayDeviceId, 'fresh-hidden-player');
  assert.equal(state.sdkReady, true);
  assert.equal(state.sdkDeviceUnconfirmed, false);
  assert.equal(state.needsSdkRecovery, false);
  assert.equal(state.sdkTransferGeneration, 0);
  await Promise.resolve();
});

test('a never-settling audio activation is bounded and marks the generation replaceable', async () => {
  let timerId = 0;
  const never = new Promise(() => {});
  const player = { activateElement: () => never };
  const state = {
    webPlayer: player, sdkGeneration: 7, sdkActivated: false,
    sdkTransferEpoch: 2, sdkPlaybackErrorCount: 0
  };
  const context = contextWith({
    state,
    setTimeout: callback => { Promise.resolve().then(callback); return ++timerId; },
    clearTimeout: () => {},
    noteDiagnostic: () => {},
    setConnectionHealth: () => {},
    runPendingPlaybackIntent: () => {}
  });
  loadFunctions(context, ['sdkCallWithin', 'activateSdkAudio']);
  assert.equal(await context.activateSdkAudio(), false);
  assert.equal(state.needsSdkRecovery, true);
  assert.equal(state.sdkDeviceUnconfirmed, true);
  assert.equal(state.sdkActivationPromise, null);
  assert.equal(state.sdkTransferEpoch, 3);
});

test('a new start command cancels delayed progress proof from the old track', async () => {
  let timer = null;
  let consumed = 0;
  const player = {
    getCurrentState: async () => ({
      paused: false, position: 2000,
      track_window: { current_track: { uri: 'spotify:track:A' } }
    })
  };
  const state = {
    webPlayer: player, sdkGeneration: 4, sdkProgressCheckSequence: 0,
    playerCommandSequence: 0, playerCommandTail: null
  };
  const context = contextWith({
    state,
    setTimeout: callback => { timer = callback; return 1; },
    consumeQueueLedger: () => { consumed += 1; },
    startPolling: () => {},
    executePlayerCommand: async () => true
  });
  loadFunctions(context, [
    'scheduleSdkProgressConfirmation', 'isStartPlaybackCommand',
    'commandSupersedesPlayback', 'playerCommand'
  ]);
  context.scheduleSdkProgressConfirmation(player, 4, 'spotify:track:A', 1000);
  assert.equal(state.sdkProgressCheckSequence, 0);
  await context.playerCommand('play_track', () => ({}));
  assert.equal(state.sdkProgressCheckSequence, 1);
  await timer();
  assert.equal(consumed, 0);
});

test('confirmed natural SDK advancement retires the pre-lock recovery snapshot', async () => {
  let timer = null;
  let consumed = null;
  const player = {
    getCurrentState: async () => ({
      paused: false, position: 2400,
      track_window: { current_track: { uri: 'spotify:track:B' } }
    })
  };
  const state = {
    webPlayer: player, sdkGeneration: 4, sdkProgressCheckSequence: 0,
    queueRecoveryPlan: { currentUri: 'spotify:track:A', uris: ['spotify:track:B', 'spotify:track:C'] }
  };
  const context = contextWith({
    state, setTimeout: callback => { timer = callback; return 1; },
    sdkCallWithin: callback => callback(),
    consumeQueueLedger: uri => { consumed = uri; }, startPolling: () => {}
  });
  loadFunctions(context, ['scheduleSdkProgressConfirmation']);
  context.scheduleSdkProgressConfirmation(player, 4, 'spotify:track:B', 1200);
  await timer();
  assert.equal(consumed, 'spotify:track:B');
  assert.equal(state.queueRecoveryPlan, null);
  assert.equal(state.sdkPlaybackActive, true);
  assert.equal(state.needsPlaybackResume, false);
});

test('rapid queued commands coalesce to the newest command before execution', async () => {
  const executed = [];
  const state = { playerCommandSequence: 0, playerCommandTail: null };
  const context = contextWith({
    state,
    executePlayerCommand: async command => { executed.push(command); return true; }
  });
  loadFunctions(context, ['isStartPlaybackCommand', 'commandSupersedesPlayback', 'playerCommand']);
  const results = await Promise.all([
    context.playerCommand('play_track', () => ({})),
    context.playerCommand('next', () => ({})),
    context.playerCommand('play_list', () => ({}))
  ]);
  assert.deepEqual(executed, ['play_list']);
  assert.deepEqual(results, [false, false, true]);
});

test('queue and volume writes serialize without cancelling audible confirmation', async () => {
  const executed = [];
  let releasePlay;
  const gate = new Promise(resolve => { releasePlay = resolve; });
  const state = { playerCommandSequence: 0, playerCommandTail: null };
  const context = contextWith({
    state,
    executePlayerCommand: async command => {
      executed.push(command);
      if (command === 'play_track') await gate;
      return true;
    }
  });
  loadFunctions(context, ['isStartPlaybackCommand', 'commandSupersedesPlayback', 'playerCommand']);
  const play = context.playerCommand('play_track', () => ({}));
  await Promise.resolve();
  const queue = context.playerCommand('queue', () => ({}));
  const volume = context.playerCommand('volume', () => ({}));
  assert.equal(state.playerCommandSequence, 1);
  releasePlay();
  assert.deepEqual(await Promise.all([play, queue, volume]), [true, true, true]);
  assert.deepEqual(executed, ['play_track', 'queue', 'volume']);
});

test('a selected song preserves the explicit remaining queue in order', () => {
  const context = contextWith({
    cleanQueueUris: uris => uris.filter(uri => /^spotify:track:[A-Za-z0-9]+$/.test(uri)),
    getRecentQueuedUris: () => new Set(['spotify:track:B', 'spotify:track:C']),
    knownRemainingQueue: () => ['spotify:track:B', 'spotify:track:C'],
    activeQueueRecoveryPlan: () => null,
    readQueueLedger: () => []
  });
  loadFunctions(context, ['queueAwarePlaybackBody']);
  const body = context.queueAwarePlaybackBody({ uris: ['spotify:track:A'] }, 'play_track');
  assert.deepEqual(Array.from(body.uris), ['spotify:track:A', 'spotify:track:B', 'spotify:track:C']);
});

test('a staged recovery plan never duplicates its current track', () => {
  const state = { currentTrackUri: 'spotify:track:B', localProgress: 12000, queueRecoveryPlan: null };
  let persisted = null;
  const context = contextWith({
    state,
    knownRemainingQueue: () => ['spotify:track:B', 'spotify:track:C'],
    writeQueueLedger: uris => { persisted = [...uris]; }
  });
  loadFunctions(context, ['stageQueueRecovery']);
  const plan = context.stageQueueRecovery();
  assert.equal(plan.currentUri, 'spotify:track:B');
  assert.deepEqual(Array.from(plan.uris), ['spotify:track:C']);
  assert.equal(plan.positionMs, 12000);
  assert.deepEqual(persisted, ['spotify:track:C']);
});

test('staging a current-only ledger clears it instead of replaying the song twice', () => {
  const state = { currentTrackUri: 'spotify:track:A', localProgress: 1000, queueRecoveryPlan: {} };
  let persisted = null;
  const context = contextWith({
    state,
    knownRemainingQueue: () => ['spotify:track:A'],
    writeQueueLedger: uris => { persisted = [...uris]; }
  });
  loadFunctions(context, ['stageQueueRecovery']);
  assert.equal(context.stageQueueRecovery(), null);
  assert.deepEqual(persisted, []);
  assert.equal(state.queueRecoveryPlan, null);
});

test('recovery stages the SDK-proven naturally advanced track before polling catches up', () => {
  const state = {
    currentTrackUri: 'spotify:track:A', localProgress: 178000,
    sdkPlaybackActive: true, _lastSdkPlayingUri: 'spotify:track:B',
    _lastSdkPlayingPosition: 4200, queueRecoveryPlan: null
  };
  const context = contextWith({
    state,
    knownRemainingQueue: () => ['spotify:track:C'],
    writeQueueLedger: () => {}
  });
  loadFunctions(context, ['stageQueueRecovery']);
  const plan = context.stageQueueRecovery();
  assert.equal(plan.currentUri, 'spotify:track:B');
  assert.equal(plan.positionMs, 4200);
  assert.deepEqual(Array.from(plan.uris), ['spotify:track:C']);
});

test('recovery uses current polled position once polling matches the proven track', () => {
  const state = {
    currentTrackUri: 'spotify:track:B', localProgress: 56000,
    sdkPlaybackActive: true, _lastSdkPlayingUri: 'spotify:track:B',
    _lastSdkPlayingPosition: 4200, queueRecoveryPlan: null
  };
  const context = contextWith({
    state,
    knownRemainingQueue: () => ['spotify:track:C'],
    writeQueueLedger: () => {}
  });
  loadFunctions(context, ['stageQueueRecovery']);
  assert.equal(context.stageQueueRecovery().positionMs, 56000);
});

test('post-unlock transfer 404 waits through one bounded registration window then targets play', async () => {
  const requests = [];
  const routeDelays = [];
  const state = {
    playerCommandSequence: 1, activeDeviceId: 'fresh-device', cleanplayDeviceId: 'fresh-device',
    sdkGeneration: 6, sdkReady: true, sdkActivated: true, webPlayer: {},
    sdkActivationGeneration: 6, sdkActivationPromise: Promise.resolve(true),
    sdkTransferGeneration: 6, sdkTransferEpoch: 12, sdkRouteLeaseEpoch: 11,
    sdkDeviceUnconfirmed: false, sdkTransferPromise: null, accessToken: 'present'
  };
  const context = contextWith({
    state,
    navigator: { onLine: true },
    isAppVisible: () => true,
    sdkRouteDelay: async delay => { routeDelays.push(delay); },
    noteDiagnostic: () => {},
    setConnectionHealth: () => {},
    playbackTargetKind: () => 'here',
    reconcileDevices: async () => true,
    ensureSdkPlaybackAudible: async () => true,
    stageQueueRecoveryIfActive: () => {},
    invalidateSdkDevice: () => {},
    recoverPlaybackTarget: async () => false,
    api: async (path, method, body, options) => {
      requests.push({ path, method, body });
      if (path === '/me/player' && body?.device_ids) {
        state.activeDeviceId = 'lagging-remote-device';
        options.failureSink.status = 404;
        options.failureSink.reason = 'device_missing';
        return null;
      }
      return {};
    }
  });
  loadFunctions(context, [
    'sdkTransferFailureReason', 'localRouteLeaseIsCurrent', 'ensureLocalPlaybackRoute',
    'withPlaybackTarget', 'isStartPlaybackCommand', 'expectedPlaybackUri', 'expectedPlaybackContext', 'executePlayerCommand'
  ]);
  const result = await context.executePlayerCommand(
    'play_track',
    () => ({ path: context.withPlaybackTarget('/me/player/play'), method: 'PUT', body: { uris: ['spotify:track:A'] } }),
    1
  );
  assert.equal(result, true);
  assert.equal(requests.length, 6);
  assert.equal(requests.filter(request => request.path === '/me/player').length, 5);
  assert.deepEqual(routeDelays, [500, 1000, 1800, 2800]);
  assert.equal(requests.at(-1).path, '/me/player/play?device_id=fresh-device');
  assert.equal(state.sdkRouteLeaseEpoch, state.sdkTransferEpoch);
  assert.equal(state.sdkDeviceUnconfirmed, false);
});

test('a local play 404 does not repeat the exhausted transfer/play chain', async () => {
  const requests = [];
  let invalidations = 0;
  const state = {
    playerCommandSequence: 1, activeDeviceId: 'stale-device', cleanplayDeviceId: 'stale-device',
    sdkGeneration: 6, sdkReady: true, sdkActivated: true, webPlayer: {},
    sdkActivationGeneration: 6, sdkActivationPromise: Promise.resolve(true),
    sdkTransferGeneration: 0, sdkTransferEpoch: 12, sdkRouteLeaseEpoch: -1,
    sdkDeviceUnconfirmed: true, sdkTransferPromise: null, accessToken: 'present'
  };
  const context = contextWith({
    state,
    navigator: { onLine: true },
    isAppVisible: () => true,
    sdkRouteDelay: async () => {},
    noteDiagnostic: () => {},
    setConnectionHealth: () => {},
    playbackTargetKind: () => 'here',
    reconcileDevices: async () => true,
    ensureSdkPlaybackAudible: async () => true,
    stageQueueRecoveryIfActive: () => {},
    invalidateSdkDevice: () => { invalidations += 1; },
    recoverPlaybackTarget: async () => false,
    api: async (path, method, body, options) => {
      requests.push({ path, method, body });
      options.failureSink.status = 404;
      options.failureSink.reason = 'device_missing';
      return null;
    }
  });
  loadFunctions(context, [
    'sdkTransferFailureReason', 'localRouteLeaseIsCurrent', 'ensureLocalPlaybackRoute',
    'withPlaybackTarget', 'isStartPlaybackCommand', 'expectedPlaybackUri', 'expectedPlaybackContext', 'executePlayerCommand'
  ]);
  const result = await context.executePlayerCommand(
    'play_track',
    () => ({ path: context.withPlaybackTarget('/me/player/play'), method: 'PUT', body: { uris: ['spotify:track:A'] } }),
    1
  );
  assert.equal(result, false);
  assert.equal(requests.length, 6);
  assert.equal(requests.filter(request => request.path === '/me/player').length, 5);
  assert.equal(requests.filter(request => request.path.includes('/me/player/play')).length, 1);
  assert.equal(invalidations, 1);
});

test('Here followed by two playback clicks shares one 404 window and plays only the latest selection', async () => {
  let releaseTransfer;
  let enteredTransfer;
  const transferGate = new Promise(resolve => { releaseTransfer = resolve; });
  const started = new Promise(resolve => { enteredTransfer = resolve; });
  const requests = [];
  const state = {
    playerCommandSequence: 0, playerCommandTail: null,
    preferredTarget: { kind: 'here' }, activeDeviceId: 'desktop-id', cleanplayDeviceId: 'desktop-id',
    sdkGeneration: 2, sdkReady: true, sdkActivated: true, webPlayer: {},
    sdkActivationGeneration: 2, sdkActivationPromise: Promise.resolve(true),
    sdkTransferGeneration: 0, sdkTransferEpoch: 2, sdkRouteLeaseEpoch: -1,
    sdkDeviceUnconfirmed: false, sdkTransferPromise: null, accessToken: 'present'
  };
  const context = contextWith({
    state, navigator: { onLine: true }, isAppVisible: () => true,
    sdkRouteDelay: async () => {}, noteDiagnostic: () => {}, setConnectionHealth: () => {},
    playbackTargetKind: () => 'here', ensureSdkPlaybackAudible: async () => true,
    api: async (path, method, body, options) => {
      requests.push({ path, body });
      if (path === '/me/player') {
        enteredTransfer();
        await transferGate;
        options.failureSink.status = 404;
        options.failureSink.reason = 'device_missing';
        return null;
      }
      return {};
    }
  });
  loadFunctions(context, [
    'sdkTransferFailureReason', 'localRouteLeaseIsCurrent', 'ensureLocalPlaybackRoute',
    'withPlaybackTarget', 'isStartPlaybackCommand', 'commandSupersedesPlayback',
    'expectedPlaybackUri', 'expectedPlaybackContext', 'executePlayerCommand', 'playerCommand'
  ]);
  const here = context.ensureLocalPlaybackRoute(2);
  await started;
  const older = context.playerCommand('play_track', () => ({ path: context.withPlaybackTarget('/me/player/play'), body: { uris: ['spotify:track:OLD'] } }));
  // Let the first command enter preflight before the second supersedes it.
  await Promise.resolve();
  await Promise.resolve();
  const newest = context.playerCommand('play_track', () => ({ path: context.withPlaybackTarget('/me/player/play'), body: { uris: ['spotify:track:NEW'] } }));
  releaseTransfer();
  assert.equal(await here, false);
  assert.equal(await older, false);
  assert.equal(await newest, true);
  assert.equal(requests.filter(request => request.path === '/me/player').length, 5);
  const plays = requests.filter(request => request.path.includes('/me/player/play'));
  assert.equal(plays.length, 1);
  assert.equal(plays[0].path, '/me/player/play?device_id=desktop-id');
  assert.equal(plays[0].body.uris[0], 'spotify:track:NEW');
  assert.equal(state.sdkRouteFailure, null);
  assert.equal(state.sdkDeviceUnconfirmed, false);
});

test('concurrent route callers do not retry a shared non-404 transfer failure', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let transfers = 0;
  const state = {
    sdkGeneration: 2, sdkReady: true, sdkActivated: true, webPlayer: {}, cleanplayDeviceId: 'desktop-id',
    sdkTransferEpoch: 2, sdkRouteLeaseEpoch: -1, sdkTransferGeneration: 0
  };
  const context = contextWith({
    state, navigator: { onLine: true }, isAppVisible: () => true,
    noteDiagnostic: () => {}, setConnectionHealth: () => {}, sdkRouteDelay: async () => {},
    api: async (path, method, body, options) => {
      transfers += 1;
      await gate;
      options.failureSink.status = 429;
      return null;
    }
  });
  loadFunctions(context, ['sdkTransferFailureReason', 'localRouteLeaseIsCurrent', 'ensureLocalPlaybackRoute']);
  const here = context.ensureLocalPlaybackRoute(2);
  const play = context.ensureLocalPlaybackRoute(2, { allowDirectPlay: true });
  release();
  assert.equal(await here, false);
  assert.equal(await play, false);
  assert.equal(transfers, 1);
});

test('concurrent token refresh callers share one request', async () => {
  let fetches = 0;
  let saves = 0;
  const state = {
    refreshToken: 'redacted', clientId: 'public-client', _refreshPromise: null,
    refreshStartedAt: 0, authRefreshGeneration: 0, _authEpoch: 0
  };
  const context = contextWith({
    state,
    navigator: { onLine: true },
    authDiagnostic: () => {},
    requireSpotifyReconnect: () => {},
    saveTokens: () => { saves += 1; },
    fetchWithTimeout: async () => {
      fetches += 1;
      await Promise.resolve();
      return { ok: true, status: 200, json: async () => ({ access_token: 'redacted-new' }) };
    },
    URLSearchParams
  });
  loadFunctions(context, ['refreshTokenFn']);
  const [first, second] = await Promise.all([
    context.refreshTokenFn('wake'),
    context.refreshTokenFn('wake')
  ]);
  assert.equal(first.status, 'success');
  assert.equal(second.status, 'success');
  assert.equal(fetches, 1);
  assert.equal(saves, 1);
});

test('a Web API 401 refreshes once and replays the request once', async () => {
  let fetches = 0;
  let refreshes = 0;
  const state = { accessToken: 'redacted', lastTokenResult: { status: 'success' } };
  const context = contextWith({
    state,
    ensureToken: async () => true,
    refreshTokenFn: async () => { refreshes += 1; return { status: 'success' }; },
    fetchWithTimeout: async () => {
      fetches += 1;
      return fetches === 1 ? { status: 401, ok: false } : { status: 204, ok: true };
    },
    logDiagnostic: () => {},
    toast: () => {},
    navigator: { onLine: true }
  });
  loadFunctions(context, ['api']);
  const result = await context.api('/me/player', 'GET', null, { silent: true });
  assert.equal(result && Object.keys(result).length, 0);
  assert.equal(fetches, 2);
  assert.equal(refreshes, 1);
});

test('a transient token failure is not mislabeled as an auth 401', async () => {
  const failure = {};
  const state = { accessToken: 'redacted', lastTokenResult: { status: 'transient', reason: 'network' } };
  const context = contextWith({
    state,
    ensureToken: async () => false,
    logDiagnostic: () => {},
    navigator: { onLine: true }
  });
  loadFunctions(context, ['api']);
  assert.equal(await context.api('/me/player', 'GET', null, { silent: true, failureSink: failure }), null);
  assert.equal(failure.status, 0);
  assert.equal(failure.reason, 'network');
});

test('visible, pageshow and focus signals coalesce into one foreground recovery', () => {
  const timers = new Map();
  let nextTimer = 0;
  const resumes = [];
  const state = { foregroundResumeTimer: null, foregroundResumeReason: null, resumePromise: null, resumeStartedAt: 0 };
  const context = contextWith({
    state,
    isAppVisible: () => true,
    resumeSession: reason => { resumes.push(reason); },
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id)
  });
  loadFunctions(context, ['scheduleForegroundResume']);
  context.scheduleForegroundResume('visible');
  context.scheduleForegroundResume('pageshow');
  context.scheduleForegroundResume('visible');
  assert.equal(timers.size, 1);
  [...timers.values()][0]();
  assert.deepEqual(resumes, ['visible']);
});

test('the Retry banner reactivates and replays a retained local selection', async () => {
  let activations = 0;
  let pendingRuns = 0;
  const state = {
    preferredTarget: { kind: 'here' }, pendingPlaybackIntent: { id: 1 },
    webPlayer: {}, needsSdkRecovery: false, sdkDeviceUnconfirmed: false,
    sdkGeneration: 3, sdkReady: true, cleanplayDeviceId: 'ephemeral'
  };
  const context = contextWith({
    state,
    window: { Spotify: { Player: function Player() {} } },
    cancelForegroundResumeForGesture: () => {},
    activateSdkAudio: () => { activations += 1; return Promise.resolve(true); },
    runPendingPlaybackIntent: async generation => { pendingRuns += 1; return generation === 3; },
    rebuildWebPlayerForGesture: () => {},
    initWebPlayer: () => {},
    playHere: () => false,
    resumeSession: () => false,
    setConnectionHealth: () => {}
  });
  loadFunctions(context, ['retryConnectionFromGesture']);
  assert.equal(await context.retryConnectionFromGesture(), true);
  assert.equal(activations, 1);
  assert.equal(pendingRuns, 1);
  assert.equal(state.activeDeviceId, 'ephemeral');
});

test('the Retry banner resumes staged playback when no pending intent exists', async () => {
  let replay = null;
  const state = {
    preferredTarget: { kind: 'here' }, pendingPlaybackIntent: null,
    needsPlaybackResume: true
  };
  const context = contextWith({
    state,
    cancelForegroundResumeForGesture: () => {},
    activeQueueRecoveryPlan: () => null,
    lastPlayedBody: () => ({ uris: ['spotify:track:A'] }),
    playBody: async (label, body) => { replay = { label, body }; return true; },
    resumeSession: () => false,
    playHere: () => false
  });
  loadFunctions(context, ['retryConnectionFromGesture']);
  assert.equal(await context.retryConnectionFromGesture(), true);
  assert.equal(replay.label, 'resume_last');
  assert.deepEqual(Array.from(replay.body.uris), ['spotify:track:A']);
});

test('Retry after a transfer-only 404 plays the retained selection without requiring a new search', async () => {
  let replay = null;
  let hereCalls = 0;
  const state = {
    preferredTarget: { kind: 'here' }, pendingPlaybackIntent: null, needsPlaybackResume: false,
    sdkGeneration: 2, sdkTransferEpoch: 3, sdkRouteFailure: { generation: 2, epoch: 3, status: 404 }
  };
  const context = contextWith({
    state, cancelForegroundResumeForGesture: () => {}, activeQueueRecoveryPlan: () => null,
    lastPlayedBody: () => ({ uris: ['spotify:track:A'] }),
    playBody: async (label, body) => { replay = { label, body }; return true; },
    playHere: () => { hereCalls += 1; return false; }
  });
  loadFunctions(context, ['retryConnectionFromGesture']);
  assert.equal(await context.retryConnectionFromGesture(), true);
  assert.equal(replay.label, 'resume_last');
  assert.deepEqual(Array.from(replay.body.uris), ['spotify:track:A']);
  assert.equal(hereCalls, 0);
  state.sdkTransferEpoch += 1;
  assert.equal(context.retryConnectionFromGesture(), false);
  assert.equal(hereCalls, 1, 'an old transfer failure must not trigger playback in another route epoch');
});

test('late seek completions never overwrite a newer player, track, or transport selection', async () => {
  for(const result of [true, false]) {
    for(const changedField of ['sdkGeneration', 'currentTrackUri', 'playerCommandSequence']) {
      let resolveRequest, renders = 0;
      const state = {
        sdkGeneration: 3, currentTrackUri: 'spotify:track:A', playerCommandSequence: 6,
        localProgress: 20000, localDuration: 120000
      };
      const context = contextWith({
        state, updateProgress: () => { renders += 1; },
        playerCommand: () => new Promise(resolve => { resolveRequest = resolve; })
      });
      loadFunctions(context, ['seekTo']);
      const pending = context.seekTo(80000);
      state[changedField] = changedField === 'currentTrackUri' ? 'spotify:track:B' : state[changedField] + 1;
      state.localProgress = 1500;
      resolveRequest(result);
      assert.equal(await pending, false);
      assert.equal(state.localProgress, 1500, `${changedField} must retain the newer position after ${result}`);
      assert.equal(renders, 0);
    }
  }
});

test('a failed seek retains progress received from the same live player while awaiting Spotify', async () => {
  let resolveRequest;
  const state = { sdkGeneration: 2, currentTrackUri: 'spotify:track:A', playerCommandSequence: 4, localProgress: 20000, localDuration: 120000 };
  const context = contextWith({
    state, updateProgress() {}, playerCommand: () => new Promise(resolve => { resolveRequest = resolve; })
  });
  loadFunctions(context, ['seekTo']);
  const pending = context.seekTo(80000);
  state.localProgress = 24000;
  resolveRequest(false);
  assert.equal(await pending, false);
  assert.equal(state.localProgress, 24000);
});

test('late volume responses cannot repaint a different SDK generation or playback target', async () => {
  for(const result of [true, false]) {
    for(const changedField of ['sdkGeneration', 'cleanplayDeviceId']) {
      let timer, resolveRequest;
      const slider = { value: 30 }, pct = { textContent: '30' };
      const state = { preferredTarget: { kind: 'here' }, sdkGeneration: 3, cleanplayDeviceId: 'local', confirmedVolume: 30 };
      const context = contextWith({
        state, setTimeout: callback => { timer = callback; return 1; }, clearTimeout() {},
        document: { getElementById: id => id === 'volume-slider' ? slider : pct },
        playerCommand: () => new Promise(resolve => { resolveRequest = resolve; })
      });
      loadFunctions(context, ['setVolume']);
      context.setVolume(80);
      const pending = timer();
      state[changedField] = changedField === 'sdkGeneration' ? 4 : 'new-local';
      state.confirmedVolume = 45; slider.value = 45; pct.textContent = '45';
      resolveRequest(result);
      await pending;
      assert.equal(state.confirmedVolume, 45);
      assert.equal(slider.value, 45);
      assert.equal(pct.textContent, '45');
    }
  }
});

test('newer volume input owns the UI while a previous request is still awaiting Spotify', async () => {
  let timer, resolveRequest;
  const slider = { value: 30 }, pct = { textContent: '30' };
  const state = { preferredTarget: { kind: 'remote' }, activeDeviceId: 'speaker', sdkGeneration: 0, confirmedVolume: 30 };
  const context = contextWith({
    state, setTimeout: callback => { timer = callback; return 1; }, clearTimeout() {},
    document: { getElementById: id => id === 'volume-slider' ? slider : pct },
    playerCommand: () => new Promise(resolve => { resolveRequest = resolve; })
  });
  loadFunctions(context, ['setVolume']);
  context.setVolume(80);
  const previous = timer();
  context.setVolume(45); slider.value = 45;
  resolveRequest(false);
  await previous;
  assert.equal(slider.value, 45, 'failed older request cannot roll back the newer input');
  const latest = timer(); resolveRequest(true); await latest;
  assert.equal(state.confirmedVolume, 45);
  assert.equal(pct.textContent, 45);
});

test('a volume input whose target changed during debounce sends no command to the replacement', async () => {
  let timer;
  const state = { preferredTarget: { kind: 'remote' }, activeDeviceId: 'old-speaker', sdkGeneration: 0 };
  const context = contextWith({
    state, setTimeout: callback => { timer = callback; return 1; }, clearTimeout() {},
    playerCommand: () => { throw new Error('old volume input cannot target the replacement speaker'); }
  });
  loadFunctions(context, ['setVolume']);
  context.setVolume(80);
  state.activeDeviceId = 'new-speaker';
  await timer();
});

test('diagnostics v2 keeps correlation fields and drops sensitive input', () => {
  const blockStart = lines.findIndex(line => line.includes("KEYS.diagnostics = 'cp_diag_v2'"));
  const sanitizerStart = lines.findIndex(line => /^function sanitizeDiagnosticEntry\(/.test(line));
  assert.ok(blockStart >= 0 && sanitizerStart > blockStart);
  const diagnosticPrelude = lines.slice(blockStart, sanitizerStart).join('\n');
  const context = contextWith({
    KEYS: {},
    crypto: { getRandomValues: bytes => { bytes.fill(7); return bytes; } },
    Uint8Array
  });
  new vm.Script(`${diagnosticPrelude}\n${extractFunction('sanitizeDiagnosticEntry')}`).runInContext(context);
  const entry = context.sanitizeDiagnosticEntry({
    ts: Date.now(), session: '070707070707', seq: 12, category: 'playback', event: 'command_ok',
    status: 204, attempt: 1, reason: 'gesture', target: 'here', outcome: 'ok',
    command: 'play_track', sdkGeneration: 5, resumeGeneration: 2, routeEpoch: 8,
    durationMs: 640, audible: true, progress: 'advanced', surface: 'standalone',
    token: 'must-not-survive', deviceId: 'must-not-survive', uri: 'must-not-survive', name: 'must-not-survive'
  });
  assert.equal(entry.duration, 'lt1s');
  assert.equal(entry.audible, 'yes');
  assert.equal(entry.progress, 'advanced');
  assert.equal(entry.surface, 'standalone');
  assert.equal(entry.command, 'play_track');
  assert.equal(entry.sdkGeneration, 5);
  assert.equal(context.sanitizeDiagnosticEntry({
    ts: Date.now(), category: 'lifecycle', event: 'visible', duration: 'gte10s'
  }).duration, 'gte10s');
  const serialized = JSON.stringify(entry);
  assert.doesNotMatch(serialized, /must-not-survive|token|deviceId|uri|name/);
});
