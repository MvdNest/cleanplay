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
  const player = {};
  const state = {
    preferredTarget: { kind: 'here' }, webPlayer: player, cleanplayDeviceId: 'ephemeral',
    sdkTransferEpoch: 4, sdkTransferPromise: Promise.resolve(true), playerCommandSequence: 7,
    fetchStateSequence: 9
  };
  const context = contextWith({ state, stopPolling: () => { pollingStopped += 1; } });
  loadFunctions(context, ['preserveLocalPlaybackOnSuspend']);
  assert.equal(context.preserveLocalPlaybackOnSuspend(), false);
  assert.equal(state.webPlayer, player);
  assert.equal(state.cleanplayDeviceId, 'ephemeral');
  assert.equal(state.sdkTransferEpoch, 5);
  assert.equal(state.sdkTransferPromise, null);
  assert.equal(state.playerCommandSequence, 8);
  assert.equal(state.fetchStateSequence, 10);
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

test('route confirmation is a generation-and-epoch lease', () => {
  const state = {
    sdkGeneration: 3, sdkReady: true, cleanplayDeviceId: 'temporary-device',
    sdkTransferGeneration: 3, sdkTransferEpoch: 8, sdkRouteLeaseEpoch: 8,
    sdkDeviceUnconfirmed: false, activeDeviceId: 'temporary-device'
  };
  const context = contextWith({ state });
  loadFunctions(context, ['localRouteLeaseIsCurrent', 'withPlaybackTarget']);
  assert.equal(context.localRouteLeaseIsCurrent(3), true);
  assert.equal(context.withPlaybackTarget('/me/player/play'), '/me/player/play');
  state.sdkTransferEpoch += 1;
  assert.equal(context.localRouteLeaseIsCurrent(3), false);
  assert.equal(context.withPlaybackTarget('/me/player/play'), '/me/player/play?device_id=temporary-device');
});

test('SDK audibility retries resume and only succeeds on non-paused state', async () => {
  const diagnostics = [];
  let resumes = 0;
  const states = [null, { paused: true }, { paused: false }];
  const player = {
    getCurrentState: async () => states.length ? states.shift() : { paused: false },
    resume: async () => { resumes += 1; }
  };
  const state = { webPlayer: player, sdkGeneration: 2, sdkPlaybackActive: false };
  const context = contextWith({
    state,
    sdkRouteDelay: async () => {},
    noteDiagnostic: (...args) => diagnostics.push(args),
    setConnectionHealth: () => {}
  });
  loadFunctions(context, ['ensureSdkPlaybackAudible']);
  assert.equal(await context.ensureSdkPlaybackAudible(2), true);
  assert.equal(resumes, 1);
  assert.equal(diagnostics.at(-1)[1], 'sdk_resume');
  assert.equal(diagnostics.at(-1)[2].outcome, 'ok');
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
  loadFunctions(context, ['executePlayerCommand']);
  const result = await context.executePlayerCommand('play_track', () => ({ path: '/me/player/play', method: 'PUT' }), 1);
  assert.equal(result, false);
  assert.equal(diagnostics.some(([, event]) => event === 'command_ok'), false);
  assert.equal(diagnostics.at(-1)[1], 'command_failed');
  assert.equal(diagnostics.at(-1)[2].reason, 'autoplay');
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

test('post-unlock transfer 404 falls back to one targeted play on the same tap', async () => {
  const requests = [];
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
    sdkRouteDelay: async () => {},
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
        options.failureSink.status = 404;
        options.failureSink.reason = 'device_missing';
        return null;
      }
      return {};
    }
  });
  loadFunctions(context, [
    'sdkTransferFailureReason', 'localRouteLeaseIsCurrent', 'ensureLocalPlaybackRoute',
    'withPlaybackTarget', 'isStartPlaybackCommand', 'executePlayerCommand'
  ]);
  const result = await context.executePlayerCommand(
    'play_track',
    () => ({ path: context.withPlaybackTarget('/me/player/play'), method: 'PUT', body: { uris: ['spotify:track:A'] } }),
    1
  );
  assert.equal(result, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].path, '/me/player');
  assert.equal(requests[1].path, '/me/player/play?device_id=fresh-device');
  assert.equal(state.sdkRouteLeaseEpoch, state.sdkTransferEpoch);
  assert.equal(state.sdkDeviceUnconfirmed, false);
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
    durationMs: 640, audible: true,
    token: 'must-not-survive', deviceId: 'must-not-survive', uri: 'must-not-survive', name: 'must-not-survive'
  });
  assert.equal(entry.duration, 'lt1s');
  assert.equal(entry.audible, 'yes');
  assert.equal(entry.command, 'play_track');
  assert.equal(entry.sdkGeneration, 5);
  const serialized = JSON.stringify(entry);
  assert.doesNotMatch(serialized, /must-not-survive|token|deviceId|uri|name/);
});
