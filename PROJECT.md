# CleanPlay — Project Knowledge

> Single-file, text-only Spotify controller. No album art, no images, ever.
> Built for Marnus van der Nest (BVSA) on iPhone Safari + Edge desktop.

---

## Live Deployment

| Item | Value |
|---|---|
| **Live URL** | https://mvdnest.github.io/cleanplay/ |
| **GitHub Repo** | https://github.com/MvdNest/cleanplay |
| **Hosting** | GitHub Pages (free, static) |
| **Local working dir** | `C:\Claude\cleanplay\` |
| **GitHub username** | MvdNest |
| **Email** | marnus@bvsa.co.za |

---

## What it does

A single static HTML file that replaces the Spotify app/web client with a pure-text interface. Built because Spotify's normal UI shows album art that often contains content the user wants to avoid.

**Three modes of operation:**
1. **Remote control** — controls Spotify playback on any other Spotify Connect device (phone, computer, speaker, car).
2. **In-browser playback** — uses Spotify Web Playback SDK to make CleanPlay itself an audio device. Music plays directly through the browser.
3. **Hybrid** — switch between devices as needed.

---

## Architecture

**Single HTML file** (`index.html`, ~62KB) containing:
- HTML markup
- Inline CSS (no external stylesheet)
- Inline JavaScript (no external bundle)
- Embedded SVG icons (data URIs)
- One external CDN load: Google Fonts + Spotify Web Playback SDK

**Why single-file:** zero build step, easy to host anywhere, easy to edit, no dependencies to manage.

---

## Authentication flow (PKCE)

Uses Spotify's **PKCE (Proof Key for Code Exchange)** OAuth flow — modern and more secure than the older Implicit flow.

1. User pastes Spotify Client ID into setup screen
2. App generates a `code_verifier` (random 64-char string) stored in localStorage
3. App generates a `code_challenge` = base64url(sha256(verifier))
4. Redirect to `accounts.spotify.com/authorize` with challenge
5. Spotify redirects back with `?code=…`
6. App POSTs to `accounts.spotify.com/api/token` with code + verifier
7. Receives `access_token` + `refresh_token` + `expires_in`
8. Tokens stored in localStorage; refresh happens automatically when within 60s of expiry

**Required scopes** (only what dev-mode lets us actually use):
```
user-read-playback-state
user-modify-playback-state
user-read-currently-playing
user-read-recently-played
user-library-read           ← /me/tracks, /me/playlists, /me/recently-played
playlist-read-private
playlist-read-collaborative
playlist-modify-private     ← needed for PUT/DELETE /playlists/{id}/followers (save playlist)
user-read-email
user-read-private
streaming                   ← required by Web Playback SDK
```

Removed scopes (their endpoints are blocked in dev mode regardless): `user-library-modify` (track like / album save), `user-follow-read` + `user-follow-modify` (artist follow), `playlist-modify-public` (we follow privately).

`streaming` is essential for the Web Playback SDK to work.

---

## Two security layers

> The local password/PIN gate (formerly "Layer 2") was removed — the app now goes straight
> to Spotify auth. It caused re-prompt issues on iOS wake and added little real security.

**Layer 1 — Spotify Development Mode**
- The Spotify Developer App stays in Development Mode
- Only Spotify accounts explicitly added under Settings → User Management can authenticate
- Configured at: https://developer.spotify.com/dashboard
- Even with the public Client ID, no random user can auth

**Layer 2 — Spotify user ID lock**
- After successful OAuth, app calls `/me` endpoint
- Compares returned `user.id` against configured expected user ID
- If mismatch: tokens cleared and user is rejected with explicit error

**Important quirk:** the modern Spotify "Username" shown at spotify.com/account is NOT the API user ID. The API returns a long random string (e.g. `317gob37iku26e5zrab5nvtyvqhi`). That string is what the user ID lock should use, not the friendly username. (The lock comparison is case-insensitive.)

---

## Web Playback SDK (in-browser audio)

Uses `https://sdk.scdn.co/spotify-player.js`. Requires:
- Spotify Premium account (REQUIRED)
- HTTPS connection (✓ GitHub Pages provides this)
- Modern browser with EME/DRM support
- The `streaming` OAuth scope

**Critical iOS detail:** On iPhone Safari, the SDK's `player.activateElement()` MUST be called synchronously inside a user gesture (click/tap handler). Without this, the device registers but no audio ever plays. The codebase calls `activateSdkAudio()` from:
- The `▶ Here` button (`playHere()`)
- Track taps (`playUri()`)
- Artist taps (`playArtist()`)
- Play/pause button (`togglePlay()`)

Once activated in a session, `state.sdkActivated` is set to true and further calls are no-ops.

**Key SDK quirk:** the standard transfer endpoint (`PUT /me/player`) returns 500 Internal Server Error when transferring playback to a freshly-registered Web Playback SDK device. Workaround: skip the transfer entirely; instead append `?device_id=...` directly to play calls. This is what `playUri()` and `playArtist()` do via `state.activeDeviceId`.

---

## Spotify Web API quirks discovered

| Quirk | Resolution |
|---|---|
| Dev Mode `/search` rejects `limit > 10` with 400 "Invalid limit"; with no `limit`, default is 5 (not 20 as historically) | Send `limit=10` — the maximum dev-mode allows, double the default |
| `PUT /me/player` (transfer) returns 500 for fresh SDK devices | Skip transfer; use `?device_id=` query param on play |
| Spotify Username ≠ API user ID | Use the random string from `/me` response |
| Web Playback SDK silent on iOS without `activateElement()` | Call it inside any user click handler |
| `/me/player` returns 204 (not 404) when no playback active | Treat as idle, not error |
| `/me/player` returns `progress_ms: 0` for tracks playing on Web Playback SDK devices | When active device is the cleanplay SDK, read position from `webPlayer.getCurrentState().position` instead |
| `/artists/{id}/top-tracks` returns 403 Forbidden in dev mode (no extended quota) | Don't enumerate; render an empty-state message and have ▶ Play all fall back to playing the artist URI as a context (Spotify generates radio) |
| `/playlists/{id}/tracks` returns no items for non-owned public playlists in dev mode | Show a graceful "track list restricted" message; ▶ Play all still works because we have the playlist context URI |
| `POST /me/player/queue?uri=` returns 200 but the subsequent `GET /me/player/queue` repeats the current track 10× when playing a single-URI (non-context) track on an SDK device | Trust the POST status; the GET endpoint is unreliable for SDK-driven sessions and is more accurate when playback is context-driven (album/playlist) |
| `POST /me/player/next` and `/previous` return 404 NO_ACTIVE_DEVICE when called without `?device_id=` for SDK-driven sessions | Always include `?device_id={state.activeDeviceId}` on every player control endpoint (handled by `devQS()` helper) |
| iOS lock screen / Control Center shows the Spotify SDK's own metadata (with album art) — **not** CleanPlay's `navigator.mediaSession` data — when ▶ Here is the active playback device | This is a known Spotify Web Playback SDK limitation: the SDK plays audio inside a cross-origin iframe (`sdk.scdn.co`) that we cannot reach to override. Open feature request since 2020 ([spotify/web-playback-sdk #105](https://github.com/spotify/web-playback-sdk/issues/105)). The Media Session code we wired (`setupMediaSession` + `updateMediaSession`) is kept because it **does** work on desktop Chrome / Android Chrome where the iframe quirk doesn't apply. **Decision: live with the iOS lock-screen showing Spotify's player + album art when using ▶ Here. Do not retry — there is no clean fix without abandoning the SDK.** |
| `/me/tracks` (like) and `/me/albums` (save) — both reads `/contains` and writes `PUT/DELETE` — return **403 Forbidden** in dev mode regardless of scope | UI was retired. Liking tracks and saving albums simply do not work in dev mode |
| Playlist follow/unfollow (`PUT/DELETE /playlists/{id}/followers`) **works** in dev mode with `playlist-modify-private` scope, but `GET /playlists/{id}/followers/contains` is **403** | Maintain a local `followedPlaylistSet` populated from `/me/playlists` (which works); invalidate on every save toggle |
| Playlist creation (`POST /users/{id}/playlists`) is **403** | No "create playlist" UI — users create in Spotify proper |
| Artist follow (`PUT/DELETE /me/following?type=artist`) is **403** regardless of scope | UI was retired |
| Spotify silently auto-redirects PKCE re-auth using the previously-granted scope set, ignoring the new scope list in the URL — even with `show_dialog=true` | If scopes need to change, the user must revoke at `spotify.com/account/apps` to force a fresh consent screen |

---

## File structure

```
C:\Claude\cleanplay\
├── index.html          # The whole app (HTML + CSS + JS in one file)
├── README.md           # Repo readme
├── PROJECT.md          # This file — comprehensive project knowledge
└── .git\               # Standard git folder
```

**On GitHub:**
- Branch: `main`
- Pages source: `main` branch, root folder
- All files public (Pages requires public repo on free tier)

---

## Common operations

### Make code changes and deploy
```powershell
cd C:\Claude\cleanplay
# Edit index.html
git add index.html
git commit -m "Description of change"
git push
# Wait ~60s for Pages to rebuild, then hard-refresh browser
```

### Verify deployment
```powershell
gh api /repos/MvdNest/cleanplay/pages | ConvertFrom-Json | Select-Object status
# status should be "built"
```

### Check live page contains expected change
```powershell
$r = Invoke-RestMethod -Uri "https://mvdnest.github.io/cleanplay/"
if($r -match 'YOUR_SEARCH_STRING'){"✓ live"} else {"✗ stale"}
```

### Hard refresh in browser
- Edge/Chrome desktop: `Ctrl+Shift+R`
- Safari iPhone: force close (swipe up from multitask), reopen
- PWA on iPhone: same — close from app switcher, reopen

---

## Visual design tokens

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0d0d0e` | Main background, near-black warm |
| `--bg-warm` | `#131312` | Slightly lifted surface |
| `--surface` | `#18181b` | Cards, inputs |
| `--surface-2` | `#1f1f23` | Hover states |
| `--text` | `#f4f4ec` | Warm white primary text |
| `--text-soft` | `#c4c4bc` | Secondary text |
| `--muted` | `#6f6f76` | Tertiary text |
| `--accent` | `#d4a449` | Warm gold (audiophile aesthetic) |
| `--accent-bright` | `#e8b659` | Hover state for accent |
| `--success` | `#6fb88c` | Green for live status |
| `--danger` | `#d96666` | Red for errors |

**Fonts (Google Fonts):**
- `Fraunces` (variable serif, italic) — display headings, brand, track titles
- `Inter Tight` — body text, UI controls
- `JetBrains Mono` — labels, technical info, monospace

---

## Views (6 total)

1. **Now Playing** — main view: track info, context line, lyrics (LRCLIB), progress, controls, volume, device picker, "Coming up" preview
2. **Search** — track/artist/album/playlist search with filter pills
3. **Library** — Recently Played + Liked Songs + User Playlists
4. **Queue** — current playing + upcoming tracks (deduped, "queued" badges)
5. **Detail** — drill-down for album / playlist / artist (▶ Play all, playlist save)
6. **Settings** — sleep timer, device selector, account info, sign-out

**Layout responsiveness:**
- Mobile (<1024px): single column, bottom tab bar
- Desktop (≥1024px): sidebar nav left, main content right

---

## State management

Single `state` object at module top:

```javascript
state = {
  accessToken, refreshToken, tokenExpires,    // Auth
  clientId, user,                             // App config + identity
  isPlaying, shuffleState, repeatState,       // Playback state
  localProgress, localDuration,               // Progress tracking
  searchFilter,                               // UI state
  sleepTimerEnd, sleepTimerInterval,          // Sleep timer
  pollTimer, progressTimer,                   // Intervals
  webPlayer, cleanplayDeviceId, sdkReady,     // Web Playback SDK
  activeDeviceId, sdkActivated                // Device routing + iOS audio
}
```

`localStorage` keys (all prefixed `cp_`):
- `cp_client_id` — Spotify Dev App Client ID
- `cp_expected_user_id` — for the user ID lock
- `cp_access_token`, `cp_refresh_token`, `cp_token_expires` — OAuth tokens
- `cp_code_verifier` — temporary, deleted after token exchange
- `cp_recent_queued` — URIs the user queued via + (6h TTL), used to badge "queued" rows
- `cp_last_played` — last playing track/context, powers the idle screen "jump back in" resume card
- `cp_search_history` — last 8 search queries, shown as chips under the search box

---

## Polling and timers

- **`pollTimer`** — runs every 5 seconds, calls `/me/player` to refresh now-playing state
- **`progressTimer`** — runs every 1 second, increments `localProgress` for smooth progress bar
- **`sleepTimerInterval`** — runs every 30 seconds when active, updates "X min remaining" label

---

## Keyboard shortcuts (desktop)

- `Space` — play/pause
- `Shift + →` — next track
- `Shift + ←` — previous track (restarts current track if >3s in)
- `↑` / `↓` — volume ±5
- `s` — toggle shuffle
- `r` — cycle repeat (off → context → track)
- `/` — focus search input
- `Esc` — close any open modal

Modifier combos (Ctrl/Cmd/Alt) are ignored so browser shortcuts still work.

---

## Known limitations

- Cannot work on Spotify Free (Web Playback SDK requires Premium)
- iOS Safari requires user gesture to activate audio (handled via `activateElement()`)
- No offline mode (would need Service Worker — not implemented)
- No queue editing (Spotify API limitation for non-extended-quota apps)
- Single user — no shared playlists or social features
- 5-second polling may briefly desync UI from actual playback

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Search failed" with 400 | Spotify limit param rejected | Already fixed; no `limit` param sent |
| 404 on play | No active device | Open Spotify on something, or use `▶ Here` |
| "Premium required" toast | Free account using SDK | Cannot fix; need Premium |
| SDK device shows but won't play (iOS) | Audio not activated | Tap `▶ Here` first, then a track |
| Token expired errors | Refresh failed | Sign out + sign in again |
| Page shows old code after deploy | Browser cache | Hard refresh / force close |
| Pages build stuck "building" | GitHub Pages slow | Usually resolves in 60-120s |

---

## Future ideas (not implemented)

- Add a Service Worker for offline shell
- Lyrics view (text only, via third-party API like genius.com)
- Crossfade settings
- Audio output device selector (when SDK supports it)
- Dark/light theme toggle (currently dark only by design)
- Custom playlists view with track management
- Recently played → "Resume" quick action

---

## Project history (key milestones)

1. **v1** — Basic remote control, Implicit auth flow, no in-browser playback
2. **v2 (current)** — PKCE auth, three security layers, full UI redesign with serif/mono pairing
3. Added Spotify Web Playback SDK — in-browser playback works on Edge desktop
4. Fixed Spotify API quirks: search limit, transfer 500, market parameter
5. Fixed iOS Safari audio with `player.activateElement()` — works on iPhone now
6. **v2.2** — Quality-of-life pass: "jump back in" resume card on idle screen, sleep-timer 30s fade-out, drag-to-seek progress bar (touch + mouse), search history chips, ⇄ shuffle for Liked Songs, tappable artist/album on Now Playing, smart previous (restart >3s), ↑/↓ volume keys, equalizer animation, focus-visible + reduced-motion support

---

## How to make future changes with Claude

1. Open this project in claude.ai
2. Tell Claude to read `PROJECT.md` and the live `index.html` from GitHub
3. Describe the change you want
4. Claude has access to:
   - Desktop Commander to edit `C:\Claude\cleanplay\index.html`
   - PowerShell to commit + push
   - GitHub CLI (`gh`) to verify deployment

Standard workflow: edit → commit → push → wait 60s → hard refresh → test.
</content>
