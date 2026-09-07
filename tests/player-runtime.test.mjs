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
  new vm.Script(names.map(extractFunction).join('\n')).runInContext(context);
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

test('a meaningful suspension keeps the player until a tap but marks its route unconfirmed', () => {
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
    LOCAL_PLAYER_STALE_AFTER_SUSPEND_MS: 60000
  });
  loadFunctions(context, ['consumeLocalSuspend']);
  assert.equal(context.consumeLocalSuspend(), 120000);
  assert.equal(state.webPlayer, player);
  assert.equal(state.cleanplayDeviceId, 'ephemeral');
  assert.equal(state.sdkDeviceUnconfirmed, true);
  assert.equal(state.sdkPlaybackActive, false);
  assert.equal(state.needsPlaybackResume, true);
  assert.equal(state.sdkTransferGeneration, 0);
  assert.equal(state.sdkRouteLeaseEpoch, -1);
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

test('healthy local next and previous keep Spotify skip semantics', async () => {
  const commands = [];
  const state = {
    preferredTarget: { kind: 'here' }, isPlaying: true, sdkPlaybackActive: true,
    needsSdkRecovery: false, sdkDeviceUnconfirmed: false, needsPlaybackResume: false,
    localProgress: 0
  };
  const context = contextWith({
    state,
    playerCommand: async label => { commands.push(label); return true; },
    preparePlaybackIntent: () => false,
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
