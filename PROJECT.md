# CleanPlay - Project Knowledge

> Personal, text-only Spotify control. The app never renders album art or artist imagery.

This document describes the v4.0 architecture and the constraints future changes must preserve.

## Deployment

| Item | Value |
|---|---|
| Live app | <https://mvdnest.github.io/cleanplay/> |
| Repository | <https://github.com/MvdNest/cleanplay> |
| Hosting | GitHub Pages, static files from `main` |
| Build step | None |

Allow roughly 60-120 seconds after a push for Pages to rebuild. A service worker can keep an older shell open, so close/reopen the iPhone PWA or hard-refresh desktop when validating a release.

## Product direction

CleanPlay provides a calm Spotify interface with text metadata and no artwork. It has two playback patterns:

1. **Play here:** use Spotify's Web Playback SDK to make CleanPlay itself the playback device. On iPhone without the Spotify app, ordinary Safari is the currently user-verified route for locked-screen track transitions. Let an active SDK queue continue while iOS keeps it alive, preserve the remaining queue locally, and reuse a healthy player after suspension. Require a fresh user-activated registration only when actual playback/device evidence warrants a replacement.
2. **Remote:** optionally control a speaker, computer, car, or another Spotify Connect device.

If exactly one unrestricted Connect device is available, it may be selected even while inactive. If no Connect device exists, an intentional Play tap may prepare the local SDK target. Never send a playback-start request with neither an explicit target nor a currently active Spotify session.

Spotify SDK device IDs are ephemeral session identifiers, not durable preferences. The app must recover clearly instead of routing controls to a remembered device that no longer exists.

### First-principles decisions

The actual requirements are one-tap access, dependable playback, a useful saved list, and no album art. Standalone mode, automatic rebuilding, extra background work, and a native rewrite are implementation choices, not goals. v4.0 questions those choices first: retain Safari's demonstrated working path, delete time-based/hidden-only player retirement, defer optional Spotify library requests, separate presentation from playback, and keep one owner of natural track advancement. Simplify before adding automation; verify recovery behavior rather than promising it from a new UI.

## Artwork boundary

- Never render Spotify album covers, artist images, playlist images, or show artwork in CleanPlay.
- Do not add `MediaMetadata.artwork`.
- PWA icons are CleanPlay branding, not media artwork.
- Text such as title, artist, album, owner, and duration is allowed.

When Spotify's native app or embedded SDK owns audio, iOS controls the lock-screen/Control Center card and may show Spotify-provided album art. The SDK runs in Spotify's cross-origin context, so CleanPlay cannot reliably override that system metadata. This limitation affects iOS system UI, not the CleanPlay interface.

## Files and runtime

```text
index.html             App markup and client-side playback/UI JavaScript
app.css                Responsive presentation and interaction styles
library-backup.js      Pure, bounded text-only Listen Later portability helpers
manifest.webmanifest   PWA identity, display mode, theme, and icons
sw.js                  Versioned app-shell service worker
icons/                 CleanPlay SVG and PNG install icons
README.md              Public overview and setup
PROJECT.md             Maintenance reference
```

There is no build step, application backend, or remote CleanPlay database. The browser talks directly to Spotify Accounts, the Spotify Web API, the Web Playback SDK, and LRCLIB for text lyrics.

## iPhone PWA and cache policy

The manifest supplies a scoped start URL, standalone display, dark theme colors, and SVG/180/192/512 pixel icons. The page links the manifest and iOS touch icon, supports safe-area insets, and registers `sw.js`.

On September 7, 2026 the user confirmed that the same locked-screen listening flow advanced automatically in Safari, while the installed home-screen app waited until unlock. Logs showed the standalone surface without corresponding `401`/`404` failures. This narrows the observed problem to the standalone/background path; it does not prove a specific WebKit defect or universal Safari reliability.

Recommend Safari for longer listening. On iOS 26, **Share > Add to Home Screen > Open as Web App off** creates a browser bookmark; with Safari as default, this retains a home-screen icon while opening the working browser path. A manifest change alone cannot override this user-controlled choice. Show targeted standalone guidance and copy only the canonical, query-free app URL. Do not claim that an ordinary same-origin link necessarily escapes standalone into Safari. Keep the old installation until its saved list has been exported; browser storage and sign-in can differ.

References:

- [WebKit iOS 26 home-screen behavior](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/#every-site-can-be-a-web-app-on-ios-and-ipados)
- [WebKit bug 261858](https://bugs.webkit.org/show_bug.cgi?id=261858) describes a closely matching standalone-versus-Safari transition failure on iOS 16-17; it is precedent, not proof of the user's current iOS cause.
- [Spotify Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk) documents mobile support and iOS autoplay limitations, not a background lifetime guarantee.

The service worker provides an offline **shell**, not offline Spotify:

- Install precaches only the exact same-origin shell allowlist: root/index, `app.css`, `library-backup.js`, manifest, and CleanPlay icons.
- Navigations are network-first and fall back to canonical cached `index.html`.
- Listed static shell assets are cache-first.
- Cross-origin Spotify/SDK/LRCLIB traffic is never intercepted or cached.
- OAuth/token-like paths and private query keys bypass the cache, so callback URLs and tokens are not persisted there.
- Other same-origin files are not cached unless explicitly allowlisted.
- Activation removes only older CleanPlay shell caches.

Bump `CACHE_VERSION` in `sw.js` whenever the shell changes. The shell may open offline, but auth, search, lyrics, metadata, controls, and audio still need a network.

## Authentication and account lock

CleanPlay uses Authorization Code with PKCE. It stores the public Client ID and temporary verifier locally, exchanges Spotify's callback code for tokens, then calls `GET /me`.

A Client ID is public by design. Never embed a Client Secret in the app, settings, or diagnostics.

Spotify Development Mode is the real access boundary: only the owner and accounts allowed in User Management can authorize, subject to Spotify's current limits. The Development Mode app owner must maintain Premium under the 2026 rules.

The Web Playback SDK requires `streaming`, `user-read-private`, and `user-read-email`. The last scope is requested only because Spotify requires it for SDK authorization; CleanPlay must not access, display, persist, or log the email field. If an older grant lacks an SDK scope, refresh cannot add it: require one complete PKCE reconnection.

If setup's account field is blank, CleanPlay locks itself to the first account that connects successfully. An advanced user can enter a known API account/user ID. This is a local wrong-account guardrail, not a password, encryption layer, or substitute for Spotify authorization. A profile display name and the friendly username on spotify.com are not the API identifier.

Spotify added stable `account_id` in May 2026 and recommends it instead of `id` for account linking. Compatibility logic should accept `account_id` and legacy `id`; new automatic locks should prefer `account_id` when available.

## Token lifecycle (effective July 20, 2026)

- Access tokens last about one hour. Refresh shortly before expiry and retry an API request after successful refresh.
- Deduplicate concurrent refresh calls.
- Network errors, timeouts, and server or other transient responses do **not** invalidate a refresh token. Preserve the session and retry later.
- `400 invalid_grant` means the refresh token is expired, revoked, or invalid. Clear unusable auth tokens and start PKCE authorization again; do not retry that refresh token.
- Refresh tokens expire six months after the original authorization. Access-token refreshes do not extend that lifetime. Enforcement applies to existing apps from **July 20, 2026**.

Official references:

- [Refresh token expiration announcement](https://developer.spotify.com/blog/2026-06-18-refresh-token-expiration)
- [Refreshing tokens](https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens)
- [PKCE flow](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow)

## Wake and device recovery

The original iPhone failure was a PWA waking with an access token or SDK device ID that had stopped being valid during lock. Player calls then returned `401`, `404`, `NO_ACTIVE_DEVICE`, or "device not found."

v4.0 recovery follows these rules:

1. Serialize foreground/network recovery so several lifecycle signals cannot race. A foreground or manual retry supersedes work that was suspended while hidden, and every network/recovery attempt is bounded.
2. Refresh authorization first when necessary; do not sign out for a transient failure.
3. Preserve an already-playing SDK queue and player while hidden, but expire its Player API route lease on `hidden`/`pagehide`, persist a recovery plan, and stop hidden polling. Do not disconnect while hidden. On all platforms, elapsed background time, a ready event delivered while hidden, or missing discovery rows alone must not retire the player. Actual `not_ready`, authoritative route failure, or stalled-audio evidence can require a fresh player gesture.
4. Foreground recovery may verify identity, refresh state, and warm the SDK script, but it must not construct an unactivated replacement player. Only a direct user action can do that safely on iOS.
5. On a deliberate local start/resume or Play here gesture, call `activateElement()` synchronously and await its Promise. Rebuild the player in that same gesture if playback/device evidence has made its route unconfirmed or an authoritative loss occurred. Pause is not an activation gesture.
6. Treat the current SDK generation's `ready` event as the source of its device ID. `/devices` is advisory and may lag or retain a retired iPhone registration; two misses are degraded, never synthetic success. After activation, explicitly transfer with `PUT /me/player` and `play:false`, allow one bounded registration window on the same fresh ID, and keep playback commands pinned to that exact ID.
7. Maintain `cp_queue_ledger_v1`, an ordered local ledger of CleanPlay-queued URIs. Use one `/play` URI sequence to restore an explicitly resumed interrupted session or the current item and remaining sequence after an unavoidable replacement.
8. A deliberate selection is a generation-scoped pending intent. The newest selection owns exactly one `/play` command and never inherits a stale recovery plan.
9. A local generation gets one bounded registration window per route epoch. Here and superseding Play clicks share that work, including an exhausted transfer `404` result. Transfer failure alone does not retire the player: a Play caller may probe that exact ID once. If targeted Start Playback still returns `404`, preserve the intent and replace that generation on the next physical tap. Remote targets may retry once after device reconciliation.
10. Treat a Player API success and `paused:false` as accepted/loading, not audible. Retain the latest pending selection until two samples for the expected item show monotonically advancing SDK position; a position-zero or wrong-item SDK must never be labelled Connected.
11. Classify SDK playback errors into redacted categories. Pause on the first error so a failed media load cannot silently burn through the remaining queue.
12. Restart ordinary polling after recovery settles. Polling is read-only: a null/204 state, null `player_state_changed` payload, or paused-at-zero transition is never permission to synthesize `/next` or `/play`.
13. Pause and sleep-timer pause cancel pending start intent and send only the targeted stop. They must not activate audio, construct a new local player, or transfer playback. If the selected local player has no ID, fail safely without stopping an unrelated remote device.
14. Once advancing SDK position proves that the same player continued, clear its old pre-lock recovery snapshot. A later resume must not rewind to the snapshot's previous song or replay its stale remaining queue.
15. Existing-session controls (seek, next/previous, queue, volume, shuffle, repeat, pause) send only their exact targeted request. An expired route lease alone must not trigger a transfer with `play:false`: the September 8 live Edge test confirmed that doing so silently paused healthy audio when seeking after a background return. No current local ID means fail safely, never fall back to a remembered remote target. Only Start Playback or an explicit device transfer runs the registration/transfer handshake. Skip commands supersede older pending starts; stale generation responses cannot invalidate a newer player.
16. A fresh page can receive still-playing metadata from its previous Spotify session before creating a local SDK player. Keep that metadata available, but main and mini controls must both show/dispatch Play, not a Pause against a missing device. Share the effective transport-state decision; retain Pause during healthy natural track transitions.
17. A durable queue written before audible proof can still begin with the remembered current song after an autoplay failure/reload. Cold Resume without an in-memory recovery plan removes exactly one such matching leading entry before prepending the current song. Preserve later repeats, tail order, and authoritative in-memory plans; do not globally deduplicate the user's queue.

Keep recovery idempotent and visible in diagnostics. iOS still requires `player.activateElement()` during a real tap before in-browser audio starts; automated wake logic cannot manufacture that gesture.

Routing invariants:

- SDK IDs belong to one player generation and are never persisted; `ready` alone does not prove Player API routability.
- Track desired target, SDK readiness, audio activation, and successful transfer as separate states.
- Prefer Spotify's currently reported Connect device for remote control.
- Local starts use the current activated SDK generation and bounded explicit transfer, with the documented exact-ID direct-play fallback after transfer-only `404`; `/devices` discovery is never an authoritative gate. Targeted pauses do not run that start handshake.
- `204` playback state means idle, not necessarily failure.
- Player `404` can mean a vanished device or no active session; it is not an auth failure.

## Spotify Web API compatibility (2026)

Spotify changed Development Mode APIs in February/March 2026. Do not restore the obsolete claims or endpoints from older notes.

### Generic library endpoints

The claim that Development Mode cannot save albums or tracks is stale. URI-based generic endpoints replaced old content-specific save/follow operations:

- `PUT /me/library?uris=...` - save/follow supported URIs
- `DELETE /me/library?uris=...` - remove/unfollow supported URIs
- `GET /me/library/contains?uris=...` - check saved state

Appropriate modification scopes still apply. Read endpoints such as `GET /me/tracks` and `GET /me/albums` remain available.

CleanPlay **does not call the generic writes**. Listen Later is local under `cp_saved_v1`. `/me/library` is a possible future opt-in path for Spotify-library sync, with different privacy and scope implications.

### Playlist and response changes

- Use `/playlists/{id}/items`; Development Mode removed the former item-management `/tracks` paths.
- Create playlists with `POST /me/playlists`, not `/users/{id}/playlists`.
- Use `/me/library` to follow/unfollow/check playlists; legacy `/playlists/{id}/followers` is obsolete for Development Mode.
- Playlist response fields changed from `tracks` to `items`, and entry `track` to `item`.
- Development Mode exposes item contents only for playlists the user owns or collaborates on. Other playlists may provide metadata/context but no enumerable list.
- Search defaults to 5 and allows at most 10 results per request; paginate with `offset`.
- Artist top tracks, several bulk/browse/public-user endpoints, and some response fields were removed or restricted.
- Optional email/product/popularity/follower fields may be absent. Handle them safely and honor `429 Retry-After`.

Official references:

- [February 2026 migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)
- [February 2026 changelog](https://developer.spotify.com/documentation/web-api/references/changes/february-2026)
- [May 2026 account ID change](https://developer.spotify.com/documentation/web-api/references/changes/may-2026)

## Listen Later

Listen Later is a versioned, text-only collection in `cp_saved_v1`:

- Supports tracks, albums, artists, and playlists.
- Stores text metadata and a Spotify URI needed to reopen/play an item; never artwork.
- Relevant rows, Now Playing, and detail views can add or remove entries; Library shows them with type filters.
- Does not change the Spotify library or require a Spotify modification scope.
- Does not sync across devices or isolated browser storage and is lost when its site data is cleared.

Parsing and migration must tolerate malformed or older entries without breaking startup.

### Portable saved-list backups

`library-backup.js` exposes a pure `CleanPlayBackup` API: `serialize(items)` returns JSON, `parse(text)` validates and returns clean items, and `merge(existing, incoming)` returns `{items, added, updated, unchanged, omitted}`. It has no DOM, storage, credentials, or network access. The UI explicitly downloads a file or imports a user-selected file; it writes the saved library only after validation succeeds.

- Envelope: `format: "cleanplay-listen-later"`, `version: 1`, `exportedAt`, `items`.
- Item allowlist: `type`, `uri`, `name`, `subtitle`, `meta`, `durationMs`, `savedAt`; no artwork, credential fields, or arbitrary imported properties.
- Maximum file size is 1 MiB (UTF-8); maximum list size is 300 items. Name/subtitle/meta are bounded to 180/220/220 characters; type and Spotify URI must agree. An optional imported ID must match the URI and is not retained.
- Malformed JSON, foreign formats, unsupported versions, invalid items, and oversized inputs are rejected before writes.
- Merge deduplicates by URI, uses the newer saved timestamp, and preserves the destination entry on ties. Existing entries are not removed to make space; excess new entries are counted in `omitted` and surfaced to the user.
- Exports contain music names and addresses, so they are user data even though they exclude authentication. They transfer neither sign-in nor diagnostics, playback queues, audio, or automatic cross-device sync.

This is the supported way to carry Listen Later from the standalone app into Safari without moving account credentials or deleting the old installation first.

## Local diagnostics

`cp_diag_v2` is a bounded local audit log for intermittent wake/reconnect failures. Useful events include lifecycle/online state, refresh outcomes, redacted API status classes, SDK ready/not-ready/reconnect, route generations, command classes, richer suspension/latency buckets, standalone-versus-browser mode, and whether local playback made real position progress. Older `cp_diag_v1` entries are read for migration until diagnostics are cleared.

Privacy requirements:

- Never log OAuth tokens, codes/verifiers, auth headers, Client Secrets, or callback URLs.
- Do not log search text, Spotify URIs/full IDs, music names, email/display names, or the account-lock value.
- Bound the log and tolerate corrupt storage.
- Nothing is uploaded automatically.
- Settings must provide explicit copy and clear actions; copied output remains redacted.

## Local storage

| Key | Purpose |
|---|---|
| `cp_client_id` | Public Spotify application Client ID |
| `cp_expected_user_id` | Local account-lock identifier |
| `cp_access_token` | Short-lived OAuth access token |
| `cp_refresh_token` | OAuth refresh token; six-month lifetime |
| `cp_token_expires` | Access-token refresh threshold |
| `cp_code_verifier` | Temporary PKCE verifier |
| `cp_recent_queued` | Short-lived recently-queued badges |
| `cp_queue_ledger_v1` | Ordered, short-lived queue used only for local transition/recovery |
| `cp_last_played` | Local resume metadata |
| `cp_search_history` | Recent local searches |
| `cp_saved_v1` | Versioned Listen Later collection |
| `cp_diag_v2` | Versioned, redacted diagnostic log with session-local correlation fields |

Treat OAuth values as sensitive. SDK device IDs must remain session-only. Signing out clears auth; clearing preferences or Listen Later should be a separate explicit action.

## Views and iPhone interaction

The responsive UI uses bottom navigation on iPhone and a sidebar on wide screens:

- **Now Playing** - metadata, progress, controls, device state, lyrics, upcoming tracks
- **Search** - tracks, artists, albums, playlists
- **Listen Later / Library** - local saved items and Spotify library content
- **Queue** - current and upcoming tracks
- **Detail** - album, artist, or playlist playback and Listen Later actions
- **Settings** - device, timer, account, reliability status, and diagnostics

v4.0 separates presentation into `app.css`, with a calmer text-led player layout, desktop sidebar, compact mobile navigation, and a mini-player on other views. Listen Later is immediately local; recently played, liked songs, and Spotify playlists load only when the user opens the optional Spotify-library section. Concurrent library loads share one request group.

Keep 44px-class tap targets, safe-area insets, visible keyboard focus, and reduced-motion support. Avoid hover-only actions. Use real buttons for result and device actions, retain accessible action names and current-navigation state, and keep the seek slider keyboard-operable. Modal dialogs trap focus, isolate the background, close with Escape, and restore focus to the opener. Global shortcuts must not hijack inputs, buttons, links, sliders, composing text, or modal interaction. Search responses belong to their request sequence so an older result cannot overwrite a newer search.

The document root owns vertical page scrolling. Keep horizontal clipping and overscroll suppression on `html`, not `body`: clipping on both elements makes the body an extra scroll container, and body overscroll suppression can trap wheel/touch scrolling before it reaches the document. Retain native scrolling inside lyrics, diagnostics, and modals; do not add wheel/touch interception.

## Troubleshooting

| Symptom | Meaning | Recovery |
|---|---|---|
| `401` after wake | Access token expired/revoked while suspended | Let recovery refresh; reauthorize only on `invalid_grant` |
| `404`, `NO_ACTIVE_DEVICE`, or device not found | A fresh SDK ID is still propagating, or the old device vanished | CleanPlay retries the same local ID once; if it still fails, tap playback again to activate a replacement. For remote playback, choose a live device |
| Sign-in required after about six months | Fixed refresh-token lifetime reached | Complete PKCE authorization again |
| Play here is silent on iPhone | User gesture missing or SDK was genuinely retired | Tap a playback action once to activate the browser player |
| `sdk_activation` with reason `autoplay` at a track boundary | The SDK reports browser autoplay blocking; this does not prove the player was replaced or the token expired | Tap Play; if repeated on desktop, inspect the site's media-autoplay permission. Do not silently change global browser permissions or promise this fixes iOS suspension |
| Next song waits until iPhone unlock, but works in ordinary Safari | Observed standalone/background limitation, not necessarily auth/device loss | Use Safari; on iOS 26 add a browser shortcut with Open as Web App off. Export/import Listen Later before retiring the old icon |
| Shell opens but controls fail offline | Only static shell is cached | Reconnect |
| Old UI after deploy | Previous service-worker shell remains | Close/reopen or hard-refresh; verify cache version bump |
| Intermittent failure vanished | Evidence was lost during recovery | Copy redacted diagnostics before clearing/signing out |

## Deployment verification

1. Edit repository files and bump `CACHE_VERSION` for shell changes.
2. Test through HTTP/HTTPS, not a `file:` URL.
3. Inspect the diff, commit, and push `main`.
4. Wait for a successful Pages build, then hard-refresh desktop.
5. Test desktop and narrow layouts: native wheel/touch scrolling, keyboard navigation and dialogs, overlapping searches, mini-player controls, deferred library loading, Listen Later export/import, and shell update pickup.
6. Test actual iPhone Safari and installed standalone separately: launch, auth callback, Play here gesture, multiple locked-screen track transitions, pause after unlock, remote playback, offline shell, Listen Later persistence, and diagnostics copy/clear. Desktop mobile emulation does not verify iOS background audio.

Do not commit personal contact details, Client Secrets, tokens, or copied diagnostics to this public repository.

## Limitations and future directions

- iOS can suspend the PWA/SDK; a service worker or silent audio cannot guarantee background playback.
- Offline shell support is not offline music.
- Web Playback SDK and the Development Mode app owner require Premium under current rules.
- Third-party lyrics may be missing or inaccurate; opening Lyrics sends the current track metadata to LRCLIB.
- GitHub Pages project sites share the mvdnest.github.io origin. A dedicated custom domain would isolate CleanPlay's browser storage from other projects on that origin.
- Listen Later is local-only and can be lost with site data.
- Spotify/iOS may show artwork in system-owned media UI.

A generic iOS wrapper around this web player has no demonstrated guarantee against its background problem, while [Spotify's native iOS App Remote SDK](https://developer.spotify.com/documentation/ios/getting-started) requires the Spotify app being installed. Under the no-Spotify-app requirement, ordinary Safari is the currently user-verified local playback direction, with standalone remaining optional and unproven for continuous lock-screen use. A minimal backend could add automatic cross-device Listen Later, HttpOnly refresh-token custody, or centralized opt-in diagnostics, but it cannot stop iOS suspending browser audio. Do not add competing audio elements or rapid rebuild loops. The AudioSession API controls audio focus/category; it is not a background keepalive guarantee for Spotify's embedded player.

## History

1. **v1** - basic text-only remote control with implicit OAuth.
2. **v2** - PKCE, Web Playback SDK, responsive redesign, lyrics, queue, sleep timer, and quality-of-life controls.
3. **v3** - iPhone PWA shell, remote-first reliability, resilient wake/auth/device recovery, local Listen Later, redacted diagnostics, and 2026 Spotify API migration.
4. **v3.3** - preserved iPhone SDK sessions through screen lock, restored continuous queued playback, and added an ordered local queue recovery ledger.
5. **v3.4** - restored single-media-session iPhone playback, serialized deliberate starts, and added a same-device retry for transient fresh-player `404`s.
6. **v3.4.1** - stopped treating iPhone's transient paused-at-zero SDK states as ended tracks, serialized recovery, and reactivated the existing audio element on every deliberate playback tap after wake.
7. **v3.5** - replaced stale-ID retries with a user-activation, exact-device discovery, explicit-transfer, then-play handshake; retained the latest intent and stopped SDK error skip storms after the first failure.
8. **v3.5.1** - added a short transfer-settle barrier for Spotify's unordered Player API operations and clears the reconnect banner as soon as the pending selection succeeds.
9. **v3.5.2** - removed the eventually-consistent `/devices` gate after SDK readiness and directly retries the authoritative transfer on a fresh activated generation.
10. **v3.6.0** - adds direct Start Playback fallback for fresh iPhone SDK devices, an SDK-native resume check, synchronous gesture activation, single-flight playback guards, queued-track preservation, and non-disruptive service-worker activation.
11. **v3.6.1** - keeps a proven SDK device route after a track/audio `playback_error`; only `not_ready` or an explicit Player API 404 can invalidate the iPhone player, preventing healthy-player rebuild loops.
12. **v3.6.2** - preserves a proven SDK route across ordinary iPhone suspension so the first post-unlock tap reuses the registered player instead of replacing it with an unregistered device ID.
13. **v3.7.0** - removes duplicate legacy implementations and polling-driven skip commands, serializes playback writes, expires only the route lease on lock, retains silent playback intents, verifies SDK audibility, unifies SDK loading, and adds deterministic regression tests plus redacted diagnostics v2.
14. **v3.8.0** - treats long-suspended SDK registrations as unconfirmed, keeps local commands pinned to an explicit device, waits through bounded fresh-device registration, requires real SDK position progress before declaring audio audible, preserves recovery queues across longer locks, and records standalone/progress evidence in diagnostics.
15. **v3.8.1** - confines time-based player replacement to iOS, preserves desktop players after backgrounding, and shares exhausted registration results across Here/Retry/new-song clicks to prevent duplicate transfer loops. Retry can directly play the remembered selection after a transfer-only 404.
16. **v3.8.2** - restores native wheel scrolling in Edge by removing the body scroll-chain trap. Keeps iPhone safe-area spacing, touch controls, bottom navigation, and all playback JavaScript unchanged.
17. **v4.0** - separates and substantially revises the responsive UI, adds a cross-view mini-player and safe Listen Later file portability, defers optional Spotify-library requests, improves keyboard/modal/search behavior, documents the user-confirmed Safari shortcut direction, removes time-based/hidden-only SDK retirement, keeps pause free of activation/transfer, and discards stale recovery snapshots once real continued playback is confirmed. Physical iPhone background behavior remains a separate verification requirement.
