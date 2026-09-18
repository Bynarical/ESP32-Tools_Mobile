/**
 * What the web app says it can do, for every address it might be opened at.
 *
 * This is the module most likely to be quietly wrong in a way nobody notices
 * until a user is standing in front of a board: the three rules it encodes
 * (secure context, mixed content, CORS) are independent, and getting one
 * backwards produces an app that offers a button which cannot work.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assess, assessBle, assessWifi, isLocalHost, type PageEnv } from '../src/capabilities';

const env = (over: Partial<PageEnv> = {}): PageEnv => ({
  protocol: 'http:',
  hostname: 'localhost',
  secureContext: true,
  hasWebBluetooth: true,
  ...over,
});

test('localhost over http is the one address where both transports work', () => {
  const caps = assess(env());
  assert.equal(caps.ble.grade, 'full');
  assert.notEqual(caps.wifi.grade, 'unusable');
  assert.match(caps.headline, /both/i);
});

test('https offers Bluetooth and refuses Wi-Fi, naming mixed content', () => {
  const caps = assess(env({ protocol: 'https:', hostname: 'ota.example.com' }));
  assert.equal(caps.ble.grade, 'full');
  assert.equal(caps.wifi.grade, 'unusable');
  assert.match(caps.wifi.summary, /mixed content/i);
  // The user must not be sent looking for a fix on the board - there isn't one.
  assert.match(caps.wifi.detail, /No header or setting on the board changes this/);
  assert.match(caps.headline, /Bluetooth only/i);
});

test('plain http on a LAN address offers Wi-Fi and refuses Bluetooth', () => {
  // Not a secure context, so the browser withholds Web Bluetooth even though
  // the API exists.
  const caps = assess(env({ hostname: '192.168.0.50', secureContext: false }));
  assert.equal(caps.ble.grade, 'unusable');
  assert.match(caps.ble.summary, /https or localhost/i);
  assert.equal(caps.wifi.grade, 'degraded');
  assert.match(caps.headline, /Wi-Fi only/i);
  // The headline must not blame the browser here: Chrome on a LAN address has
  // Web Bluetooth, it is the origin that withholds it.
  assert.match(caps.headline, /https or localhost/i);
  assert.ok(!/no Bluetooth/i.test(caps.headline));
});

test('a browser without Web Bluetooth is told whose decision that was', () => {
  const ble = assessBle(env({ hasWebBluetooth: false }));
  assert.equal(ble.grade, 'unusable');
  // iOS is the case that actually sends people here, and the reason is not
  // something they can change in settings.
  assert.match(ble.detail, /iOS/);
  assert.match(ble.detail, /WebKit/);
  assert.match(ble.detail, /Wi-Fi instead/);
});

test('an insecure origin is named before a missing API, because it hides one', () => {
  // Chrome deletes navigator.bluetooth outright on an insecure origin, so
  // "this browser has no Web Bluetooth" is indistinguishable from Safari -
  // and telling somebody on Chrome-over-http that their browser cannot do it
  // is both wrong and a dead end. The secure-context reason is actionable, so
  // it wins whenever both apply. Caught by running the app on a LAN address.
  const ble = assessBle(env({ hasWebBluetooth: false, secureContext: false }));
  assert.match(ble.summary, /https or localhost/i);
  assert.ok(!/Safari has never shipped/.test(ble.detail));
  // It must still not promise an iPhone something https cannot deliver.
  assert.match(ble.detail, /iPhone/);

  // On a secure origin the absence is real, and then it is named.
  const truly = assessBle(env({ hasWebBluetooth: false, secureContext: true }));
  assert.match(truly.summary, /Not available in this browser/);
});

test('a page served by the board itself is the full-strength Wi-Fi case', () => {
  const caps = assess(env({ hostname: '192.168.0.127', boardHost: '192.168.0.127', secureContext: false }));
  assert.equal(caps.wifi.grade, 'full');
  assert.equal(caps.sameOriginWithBoard, true);
  assert.match(caps.wifi.detail, /read back/);
});

test('a different board address is cross-origin, and says the verdict is inferred', () => {
  const caps = assess(env({ hostname: '192.168.0.50', boardHost: '192.168.0.127', secureContext: false }));
  assert.equal(caps.wifi.grade, 'degraded');
  assert.equal(caps.sameOriginWithBoard, false);
  assert.match(caps.wifi.detail, /CORS/);
  assert.match(caps.wifi.detail, /inferred/);
});

test('same-origin is decided case-insensitively, and only over http', () => {
  const lower = assess(env({ hostname: 'Board.local', boardHost: 'board.LOCAL', secureContext: false }));
  assert.equal(lower.sameOriginWithBoard, true);
  // Over https the address matching is irrelevant: nothing can be sent at all.
  const secure = assess(env({ protocol: 'https:', hostname: 'board.local', boardHost: 'board.local' }));
  assert.equal(secure.sameOriginWithBoard, false);
  assert.equal(secure.wifi.grade, 'unusable');
});

test('a file:// page is refused with the remedy, not just the rule', () => {
  const wifi = assessWifi(env({ protocol: 'file:', hostname: '' }));
  assert.equal(wifi.grade, 'unusable');
  assert.match(wifi.detail, /null/);
  assert.match(wifi.detail, /serve:web/);
});

test('neither transport available still produces a headline, not an empty string', () => {
  const caps = assess(env({ protocol: 'file:', hostname: '', hasWebBluetooth: false }));
  assert.equal(caps.ble.grade, 'unusable');
  assert.equal(caps.wifi.grade, 'unusable');
  assert.match(caps.headline, /Neither/);
});

test('isLocalHost knows the loopback spellings', () => {
  for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', '::1', '[::1]']) {
    assert.equal(isLocalHost(h), true, `${h} should be loopback`);
  }
  assert.equal(isLocalHost('192.168.0.127'), false);
  assert.equal(isLocalHost('localhost.evil.com'), false);
});
