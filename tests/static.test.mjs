import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../app.css', import.meta.url), 'utf8');
const serviceWorker = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../manifest.webmanifest', import.meta.url), 'utf8'));

test('every inline application script parses', () => {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length >= 2);
  scripts.forEach((match, index) => assert.doesNotThrow(
    () => new vm.Script(match[1], { filename: `inline-${index + 1}.js` })
  ));
});

test('global function declarations are unique', () => {
  const names = [...html.matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map(match => match[1]);
  const duplicates = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
  assert.deepEqual(duplicates, []);
});

test('one Spotify SDK loader owns the script', () => {
  const sdkSources = html.match(/https:\/\/sdk\.scdn\.co\/spotify-player\.js/g) || [];
  assert.equal(sdkSources.length, 2, 'one executable src plus one retry assignment is expected');
  assert.equal((html.match(/id="cleanplay-spotify-sdk"/g) || []).length, 1);
  assert.doesNotMatch(html, /querySelector\(['"]script\[data-cleanplay-sdk\]/);
});

test('polling cannot issue synthetic queue advancement', () => {
  assert.doesNotMatch(html, /forceNextIfStuck|auto_next|auto_play|auto_queue/);
});

test('no album or artist artwork can render', () => {
  assert.doesNotMatch(html, /<img\b/i);
  assert.doesNotMatch(html, /\bartwork\s*:/i);
  assert.doesNotMatch(html, /\.images\b/);
});

test('PWA remains standalone and the service worker ignores Spotify traffic', () => {
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.ok(manifest.icons.some(icon => icon.sizes === '180x180'));
  assert.ok(manifest.icons.some(icon => icon.sizes === '512x512'));
  assert.match(serviceWorker, /url\.origin !== self\.location\.origin/);
  assert.doesNotMatch(serviceWorker, /skipWaiting\(\).*install/s);
});

test('the document owns page scrolling without a body scroll-chain trap', () => {
  assert.match(css, /html\{overflow-x:hidden;overflow-y:auto;overscroll-behavior-y:none;/);
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (rule[1].split(',').some(selector => selector.trim() === 'body')) {
      assert.doesNotMatch(rule[2], /(?:overflow|overscroll-behavior)(?:-[xy])?\s*:/);
    }
  }
  assert.match(css, /\.ctrl,\.tab,\.device-bar button,\.detail-back,\.up-next-link\{touch-action:manipulation\}/);
  assert.match(css, /env\(safe-area-inset-bottom,0px\)/);
  assert.doesNotMatch(html, /addEventListener\(['"](?:wheel|mousewheel|touchmove)['"]/);
});

test('redesign assets are included in the offline shell', () => {
  for (const asset of ['app.css', 'library-backup.js']) {
    assert.ok(html.includes('./' + asset));
    assert.ok(serviceWorker.includes("new URL('" + asset + "', SCOPE_URL)"));
  }
});
