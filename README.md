# CleanPlay

CleanPlay is a private, text-only Spotify controller designed for iPhone and desktop. The interface never renders album artwork or artist images. Version 4.0 focuses on simpler listening, a substantially revised responsive interface, and evidence-based recovery.

## Highlights

- In-browser playback through Spotify's Web Playback SDK (Premium required); the Spotify phone app is not required
- Optional remote control for another Spotify Connect device
- Automatic playback targeting: use an active/sole Connect device, otherwise prepare this browser from the user's Play tap
- Search, Now Playing, queue, opt-in lyrics, device selection, and a sleep timer
- Persistent mini-player when browsing away from Now Playing
- Local, text-only **Listen Later** for tracks, albums, artists, and playlists, with JSON export/import between browsers
- Spotify library content loads only when its section is opened
- Responsive desktop sidebar and iPhone bottom navigation, modest icons, accessible controls, and native scrolling
- Safari shortcut guidance, plus an optional standalone PWA and an offline app shell
- Wake/reconnect handling for expired access tokens and short-lived Spotify SDK device IDs
- Preserve healthy players through backgrounding; replace a player only when playback/device evidence requires it
- Existing-player controls do not transfer or pause audio behind the scenes; cold local sessions show Play until this browser has a player
- Local, redacted diagnostics that can be copied for troubleshooting

CleanPlay does not download music and cannot play while offline. The service worker caches only the app shell.

## Best way to use it on iPhone

Use CleanPlay in **Safari** for longer listening. In the user's September 7, 2026 comparison, Safari advanced to the next song while the phone was locked; the standalone home-screen app waited until unlock. This is evidence for that device/session, not a guarantee for every iOS version or background condition.

You can keep one-tap home-screen access on iOS 26:

1. Open CleanPlay in Safari and choose **Share > Add to Home Screen**.
2. Turn **Open as Web App off**, then add the shortcut. Use Safari as your default browser.
3. Open the shortcut and start playback with a real tap.

Apple documents this switch as creating a browser bookmark even when the website supports standalone mode. Changing the manifest alone does not override the user's choice. [WebKit's iOS 26 guidance](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/#every-site-can-be-a-web-app-on-ios-and-ipados)

Keep the old icon until you have exported its Listen Later list. Safari and the standalone app may use separate storage, so Safari may need its own sign-in and saved-list import. Settings contains the shortcut instructions and a safe Copy CleanPlay link action.

The standalone option remains available, but CleanPlay cannot promise uninterrupted locked-screen playback there. It leaves Spotify's player in charge of natural track transitions and does not add fake audio, background polling, or automatic rebuild loops. A long hidden period alone no longer retires an otherwise healthy player; pauses never activate or transfer the local player. Other Spotify Connect devices remain optional, not a requirement.

## Setup

1. Create or open an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. Add CleanPlay's exact HTTPS address as a redirect URI. The trailing slash matters for the GitHub Pages deployment.
3. In Development Mode, add any permitted listener under the app's User Management settings. Spotify currently limits Development Mode apps and requires the app owner to have Premium.
4. Open CleanPlay and enter the app's Client ID. A Client ID is public by design; never put a Spotify Client Secret into this browser-only app.
5. Leave the optional account field blank to lock CleanPlay to the first account that connects, or enter a known Spotify Web API account/user ID. This local guardrail is not a second password and does not replace Spotify authorization or Development Mode access control. Once a browser is locked, deliberately changing the account requires clearing that site's data.

Spotify's Web Playback SDK requires the `streaming`, `user-read-private`, and `user-read-email` authorization scopes. CleanPlay requests all three for SDK compatibility but never accesses, displays, persists, or logs the email address.

The deployed app's setup screen walks through the same process.

## Listen Later and diagnostics

Listen Later is stored only in this browser under `cp_saved_v1`. It is intentionally separate from the Spotify library: there is no automatic account sync, and clearing site data removes that browser's list.

Use **Export list** before changing browsers or clearing site data, then **Import list** in the destination browser. The JSON file contains saved music names and Spotify addresses, but no account credentials or artwork. Keep it private if you consider your listening list private. Imports accept only the CleanPlay backup format, enforce a 1 MiB file limit and 300-item list limit, validate Spotify addresses, and merge without deleting existing entries. Newer saved entries win; equal timestamps preserve the destination's entry. Items that cannot fit are reported. Export/import does not transfer sign-in, diagnostics, the playback queue, or audio files.

Diagnostics are stored locally under `cp_diag_v2`. Entries are bounded and redacted: they record operational events, command classes, route generations, suspension/latency buckets, browser-versus-standalone mode, playback-progress outcomes, and status codes—not access tokens, refresh tokens, authorization codes, device IDs, Spotify URIs, searches, music names, or personal account data. Nothing is uploaded automatically. Use the Settings controls to copy or clear the log when troubleshooting. Lyrics are also opt-in: only opening the Lyrics panel sends the current title, artist, album, and duration to LRCLIB.

## Album-art boundary

CleanPlay itself never renders Spotify artwork. Brand icons used to install the PWA are not album art. When playback runs through Spotify's native app or embedded SDK, iOS owns the lock-screen media card and may show Spotify-provided album art; a web PWA cannot reliably suppress that metadata. This does not cause artwork to appear inside CleanPlay.

## Project layout

- `index.html` - application markup and client-side playback/UI logic
- `app.css` - responsive interface styles
- `library-backup.js` - pure, bounded text-only Listen Later export/import helpers
- `manifest.webmanifest` - install metadata and icon declarations
- `sw.js` - tightly scoped app-shell caching
- `icons/` - CleanPlay brand icons
- `PROJECT.md` - architecture, API notes, and maintenance guide
- `tests/` and `package.json` - dependency-free deterministic regression checks (`npm test`)
- `tools/analyze-diagnostics.mjs` - offline summary of a copied diagnostic export (`npm run analyze:diagnostics -- <file>`)

There is no build step. GitHub Pages serves the repository as static files.

## Current platform notes

Spotify changed Development Mode APIs in 2026. New generic library endpoints (`/me/library`) replace the old content-specific save/follow writes, and playlist item endpoints use `/items` instead of `/tracks`. CleanPlay does not write to the Spotify library; its Listen Later feature remains local. See [PROJECT.md](PROJECT.md) for compatibility details and official migration links.

Spotify access tokens last about one hour. Refresh tokens now expire six months after the original authorization, including existing apps from July 20, 2026. CleanPlay retries temporary refresh failures without destroying the local session, but an `invalid_grant` response requires signing in again.

## Design approach

Question the implementation requirement before adding machinery: the goal is reliable, one-tap, artwork-free listening, not standalone mode at any cost. Prefer the user's demonstrated Safari path, remove time-based player retirement and unnecessary library requests, keep one playback owner, and verify small recovery changes independently from visual changes. A native wrapper or backend is not assumed to solve browser suspension; Spotify's supported native iOS SDK requires the Spotify app.
