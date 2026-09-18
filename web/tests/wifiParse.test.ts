/**
 * The Wi-Fi transport's parsing half.
 *
 * `parsePing` is the check that decides whether an address is a board, and it
 * is deliberately strict: the failure it exists to prevent is sending 600 KB
 * of firmware at someone else's web server because its front page happened to
 * return HTTP 200.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { baseUrl, parsePing, splitHostPort } from '../src/transport/wifiParse';

test('a real /ping answer is accepted and its identity kept', () => {
  const body = JSON.stringify({
    ok: true,
    project: 'ble_ota_c3',
    version: '1.0.7',
    idf: 'v6.0',
  });
  const ping = parsePing(200, body);
  assert.ok(ping);
  assert.equal(ping.project, 'ble_ota_c3');
  assert.equal(ping.version, '1.0.7');
});

test("a single-page app answering 200 with HTML is not a board", () => {
  // The exact trap the desktop's version was written against: "ok" appears in
  // the markup, the status is 200, and it is still not a board.
  const spa = '<!doctype html><title>ok</title><body>everything is ok</body>';
  assert.equal(parsePing(200, spa), null);
});

test('anything but a JSON object with ok === true is refused', () => {
  assert.equal(parsePing(200, 'null'), null);
  assert.equal(parsePing(200, '[]'), null, 'an array is not an object here');
  assert.equal(parsePing(200, '[{"ok":true}]'), null);
  assert.equal(parsePing(200, '"ok"'), null);
  assert.equal(parsePing(200, '{"ok":"true"}'), null, 'the string "true" is not true');
  assert.equal(parsePing(200, '{"ok":1}'), null);
  assert.equal(parsePing(200, '{}'), null);
  assert.equal(parsePing(200, ''), null);
});

test('a non-200 status is refused whatever the body says', () => {
  const good = JSON.stringify({ ok: true, project: 'ble_ota_c3' });
  assert.equal(parsePing(404, good), null);
  assert.equal(parsePing(500, good), null);
  assert.equal(parsePing(301, good), null);
});

test('baseUrl builds plain http and leaves an explicit port alone', () => {
  assert.equal(baseUrl('192.168.0.127'), 'http://192.168.0.127');
  assert.equal(baseUrl('192.168.0.127', 80), 'http://192.168.0.127');
  assert.equal(baseUrl('192.168.0.127', 8080), 'http://192.168.0.127:8080');
  // A port typed into the host wins over the argument, because it is the more
  // specific thing the user said.
  assert.equal(baseUrl('192.168.0.127:8080', 80), 'http://192.168.0.127:8080');
});

test('baseUrl tolerates what people actually paste', () => {
  assert.equal(baseUrl('  192.168.0.127  '), 'http://192.168.0.127');
  assert.equal(baseUrl('http://192.168.0.127/'), 'http://192.168.0.127');
  // https is stripped rather than honoured: the board has no certificate, and
  // pretending otherwise would fail later and less clearly.
  assert.equal(baseUrl('https://192.168.0.127'), 'http://192.168.0.127');
  assert.equal(baseUrl('board.local'), 'http://board.local');
});

test('splitHostPort separates what was typed, with a fallback port', () => {
  assert.deepEqual(splitHostPort('192.168.0.127'), { host: '192.168.0.127', port: 80 });
  assert.deepEqual(splitHostPort('192.168.0.127:8080'), {
    host: '192.168.0.127',
    port: 8080,
  });
  assert.deepEqual(splitHostPort('board.local', 8080), {
    host: 'board.local',
    port: 8080,
  });
  assert.deepEqual(splitHostPort('http://192.168.0.127:8080/'), {
    host: '192.168.0.127',
    port: 8080,
  });
  assert.deepEqual(splitHostPort(''), { host: '', port: 80 });
});
