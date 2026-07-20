# CleanPlay - Project Knowledge

> Personal, text-only Spotify control. The app never renders album art or artist imagery.

This document describes the v3 architecture and the constraints future changes must preserve.

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

1. **Remote-first (recommended on iPhone):** control Spotify on a phone, speaker, computer, car, or another Connect device. This survives iPhone lock/background cycles most reliably.
2. **Play here:** use Spotify's Web Playback SDK to make the browser a device. It is useful on desktop and for foreground iPhone sessions, but iOS may suspend the PWA and invalidate its SDK device while locked.

If exactly one unrestricted Connect device is available, it may be selected even while inactive. If no Connect device exists, an intentional Play tap may prepare the local SDK target. Never send a playback-start request with neither an explicit target nor a currently active Spotify session.

Spotify SDK device IDs are ephemeral session identifiers, not durable preferences. The app must recover clearly instead of routing controls to a remembered device that no longer exists.

## Artwork boundary

- Never render Spotify album covers, artist images, playlist images, or show artwork in CleanPlay.
- Do not add `MediaMetadata.artwork`.
- PWA icons are CleanPlay branding, not media artwork.
- Text such as title, artist, album, owner, and duration is allowed.

When Spotify's native app or embedded SDK owns audio, iOS controls the lock-screen/Control Center card and may show Spotify-provided album art. The SDK runs in Spotify's cross-origin context, so CleanPlay cannot reliably override that system metadata. This limitation affects iOS system UI, not the CleanPlay interface.

## Files and runtime

```text
index.html             App markup, CSS, and JavaScript
manifest.webmanifest   PWA identity, display mode, theme, and icons
sw.js                  Versioned app-shell service worker
icons/                 CleanPlay SVG and PNG install icons
README.md              Public overview and setup
PROJECT.md             Maintenance reference
```

There is no build step, application backend, or remote CleanPlay database. The browser talks directly to Spotify Accounts, the Spotify Web API, the Web Playback SDK, and LRCLIB for text lyrics.

## iPhone PWA and cache policy

The manifest supplies a scoped start URL, standalone display, dark theme colors, and SVG/180/192/512 pixel icons. The page links the manifest and iOS touch icon, supports safe-area insets, and registers `sw.js`.

The service worker provides an offline **shell**, not offline Spotify:

- Install precaches only the exact same-origin allowlist: root/index, manifest, and CleanPlay icons.
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

v3 recovery follows these rules:

1. Serialize foreground/network recovery so several lifecycle signals cannot race.
2. Refresh authorization first when necessary; do not sign out for a transient failure.
3. Check the SDK instance. When the browser device emitted `not_ready`, clear stale active/device IDs and reconnect or recreate it. A null `player_state_changed` payload can simply mean the new device has no playback context and must not trigger a rebuild loop.
4. Treat the next SDK `ready` ID as authoritative. Never persist an SDK device ID in local storage.
5. Refresh Spotify device and playback state before routing new controls. Ignore restricted devices; prefer the active device, an in-memory selection, or the sole unrestricted candidate.
6. When a targeted request reports a missing device, clear that target and retry once only when the operation is safe to repeat. Do not fall through to a targetless request.
7. Restart ordinary polling after recovery settles.

Keep recovery idempotent and visible in diagnostics. iOS still requires `player.activateElement()` during a real tap before in-browser audio starts; automated wake logic cannot manufacture that gesture.

Routing invariants:

- SDK IDs are valid only between `ready` and `not_ready`/disconnect.
- Prefer Spotify's currently reported Connect device for remote control.
- Use the current CleanPlay SDK ID only while it is ready and selected.
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

CleanPlay v3 **does not call the generic writes**. Listen Later is local under `cp_saved_v1`. `/me/library` is a possible future opt-in path for Spotify-library sync, with different privacy and scope implications.

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

## Local diagnostics

`cp_diag_v1` is a bounded local audit log for intermittent wake/reconnect failures. Useful events include lifecycle/online state, refresh outcomes, redacted API status classes, SDK ready/not-ready/reconnect, device routing, and service-worker state.

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
| `cp_last_played` | Local resume metadata |
| `cp_search_history` | Recent local searches |
| `cp_saved_v1` | Versioned Listen Later collection |
| `cp_diag_v1` | Versioned, redacted diagnostic log |

Treat OAuth values as sensitive. SDK device IDs must remain session-only. Signing out clears auth; clearing preferences or Listen Later should be a separate explicit action.

## Views and iPhone interaction

The responsive UI uses bottom navigation on iPhone and a sidebar on wide screens:

- **Now Playing** - metadata, progress, controls, device state, lyrics, upcoming tracks
- **Search** - tracks, artists, albums, playlists
- **Listen Later / Library** - local saved items and Spotify library content
- **Queue** - current and upcoming tracks
- **Detail** - album, artist, or playlist playback and Listen Later actions
- **Settings** - device, timer, account, reliability status, and diagnostics

Keep 44px-class tap targets, safe-area insets, visible keyboard focus, and reduced-motion support. Avoid hover-only actions.

## Troubleshooting

| Symptom | Meaning | Recovery |
|---|---|---|
| `401` after wake | Access token expired/revoked while suspended | Let recovery refresh; reauthorize only on `invalid_grant` |
| `404`, `NO_ACTIVE_DEVICE`, or device not found | Old SDK device vanished or no Connect device is active | Wait for reconnect, choose a live device, or open Spotify and control it remotely |
| Sign-in required after about six months | Fixed refresh-token lifetime reached | Complete PKCE authorization again |
| Play here is silent on iPhone | User gesture missing or SDK suspended | Tap a playback action; otherwise use Spotify as playback device |
| Shell opens but controls fail offline | Only static shell is cached | Reconnect |
| Old UI after deploy | Previous service-worker shell remains | Close/reopen or hard-refresh; verify cache version bump |
| Intermittent failure vanished | Evidence was lost during recovery | Copy redacted diagnostics before clearing/signing out |

## Deployment verification

1. Edit repository files and bump `CACHE_VERSION` for shell changes.
2. Test through HTTP/HTTPS, not a `file:` URL.
3. Inspect the diff, commit, and push `main`.
4. Wait for a successful Pages build, then hard-refresh desktop.
5. Test installed iPhone PWA: launch, auth callback, remote playback, Play here gesture, lock/unlock, offline shell, Listen Later persistence, diagnostics copy/clear, and update pickup.

Do not commit personal contact details, Client Secrets, tokens, or copied diagnostics to this public repository.

## Limitations and future directions

- iOS can suspend the PWA/SDK; a service worker or silent audio cannot guarantee background playback.
- Offline shell support is not offline music.
- Web Playback SDK and the Development Mode app owner require Premium under current rules.
- Third-party lyrics may be missing or inaccurate; opening Lyrics sends the current track metadata to LRCLIB.
- GitHub Pages project sites share the mvdnest.github.io origin. A dedicated custom domain would isolate CleanPlay's browser storage from other projects on that origin.
- Listen Later is local-only and can be lost with site data.
- Spotify/iOS may show artwork in system-owned media UI.

If lock-screen-resilient in-app playback becomes essential, change architecture instead of adding PWA keep-alive tricks: stay remote-first, investigate a supported native iOS client, or add a minimal backend only for needs such as cross-device Listen Later, HttpOnly refresh-token custody, or centralized diagnostics. A backend alone cannot stop iOS suspending browser audio.

## History

1. **v1** - basic text-only remote control with implicit OAuth.
2. **v2** - PKCE, Web Playback SDK, responsive redesign, lyrics, queue, sleep timer, and quality-of-life controls.
3. **v3** - iPhone PWA shell, remote-first reliability, resilient wake/auth/device recovery, local Listen Later, redacted diagnostics, and 2026 Spotify API migration.
