# CleanPlay

CleanPlay is a private, text-only Spotify controller designed for iPhone and desktop. The interface never renders album artwork or artist images.

## Highlights

- Remote control for an existing Spotify Connect device
- Optional in-browser playback through Spotify's Web Playback SDK (Premium required)
- Automatic playback targeting: use an active/sole Connect device, otherwise prepare this browser from the user's Play tap
- Search, Now Playing, queue, lyrics, device selection, and a sleep timer
- Local, text-only **Listen Later** for tracks, albums, artists, and playlists
- Installable iPhone PWA with a standalone layout, safe-area support, and an offline app shell
- Wake/reconnect handling for expired access tokens and short-lived Spotify SDK device IDs
- One-tap iPhone playback recovery after screen lock, with bounded foreground reconnect attempts
- Local, redacted diagnostics that can be copied for troubleshooting

CleanPlay does not download music and cannot play while offline. The service worker caches only the app shell.

## Best way to use it on iPhone

For the most reliable lock/unlock experience, keep playback on the Spotify app, a speaker, a computer, or another Spotify Connect device and use CleanPlay as the remote. iOS can suspend a Home Screen web app and its embedded Spotify player while the phone is locked, so **Play here** is convenient but inherently less reliable after a long background period.

Open the site in Safari, use **Share > Add to Home Screen**, then launch CleanPlay from its icon. If no Spotify Connect device is available, a Play tap prepares CleanPlay itself as the target instead of sending a targetless request. If iOS has suspended in-browser playback, reopen the app and tap a playback action; CleanPlay will refresh authorization, discard stale device IDs, and reconnect the embedded player.

## Setup

1. Create or open an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. Add CleanPlay's exact HTTPS address as a redirect URI. The trailing slash matters for the GitHub Pages deployment.
3. In Development Mode, add any permitted listener under the app's User Management settings. Spotify currently limits Development Mode apps and requires the app owner to have Premium.
4. Open CleanPlay and enter the app's Client ID. A Client ID is public by design; never put a Spotify Client Secret into this browser-only app.
5. Leave the optional account field blank to lock CleanPlay to the first account that connects, or enter a known Spotify Web API account/user ID. This local guardrail is not a second password and does not replace Spotify authorization or Development Mode access control. Once a browser is locked, deliberately changing the account requires clearing that site's data.

Spotify's Web Playback SDK requires the `streaming`, `user-read-private`, and `user-read-email` authorization scopes. CleanPlay requests all three for SDK compatibility but never accesses, displays, persists, or logs the email address.

The deployed app's setup screen walks through the same process.

## Listen Later and diagnostics

Listen Later is stored only in this browser under `cp_saved_v1`. It is intentionally separate from the Spotify library: there is no account sync, and clearing site data or using another browser removes or hides that browser's list.

Diagnostics are stored locally under `cp_diag_v1`. Entries are bounded and redacted: they record operational events and status codes, not access tokens, refresh tokens, authorization codes, Spotify URIs, searches, music names, or personal account data. Nothing is uploaded automatically. Use the Settings controls to copy or clear the log when troubleshooting. Lyrics are also opt-in: only opening the Lyrics panel sends the current title, artist, album, and duration to LRCLIB.

## Album-art boundary

CleanPlay itself never renders Spotify artwork. Brand icons used to install the PWA are not album art. When playback runs through Spotify's native app or embedded SDK, iOS owns the lock-screen media card and may show Spotify-provided album art; a web PWA cannot reliably suppress that metadata. This does not cause artwork to appear inside CleanPlay.

## Project layout

- `index.html` - application, styles, and client-side logic
- `manifest.webmanifest` - install metadata and icon declarations
- `sw.js` - tightly scoped app-shell caching
- `icons/` - CleanPlay brand icons
- `PROJECT.md` - architecture, API notes, and maintenance guide

There is no build step. GitHub Pages serves the repository as static files.

## Current platform notes

Spotify changed Development Mode APIs in 2026. New generic library endpoints (`/me/library`) replace the old content-specific save/follow writes, and playlist item endpoints use `/items` instead of `/tracks`. CleanPlay v3 does not write to the Spotify library; its Listen Later feature remains local. See [PROJECT.md](PROJECT.md) for compatibility details and official migration links.

Spotify access tokens last about one hour. Refresh tokens now expire six months after the original authorization, including existing apps from July 20, 2026. CleanPlay retries temporary refresh failures without destroying the local session, but an `invalid_grant` response requires signing in again.
