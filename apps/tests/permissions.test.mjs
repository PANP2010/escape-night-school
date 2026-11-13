import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { allowGamePointerLock } = createRequire(import.meta.url)('../desktop/permissions.cjs');

test('pointer capture is limited to the selected game window and its main origin', () => {
  for (const origin of ['http://127.0.0.1:4100', 'http://192.168.1.10:52123', 'https://school.example']) {
    const wc = { getURL: () => origin + '/' }, win = { webContents: wc, isDestroyed: () => false };
    const frame = { isMainFrame: true, requestingUrl: origin + '/?steady' };
    assert.equal(allowGamePointerLock(wc, 'pointerLock', frame, win, origin), true);
    assert.equal(allowGamePointerLock(wc, 'pointerLock', { isMainFrame: true }, win, origin, origin), true);
    for (const permission of ['media', 'geolocation', 'notifications', 'openExternal', 'fullscreen', 'clipboard-read'])
      assert.equal(allowGamePointerLock(wc, permission, frame, win, origin), false);
    assert.equal(allowGamePointerLock({ getURL: wc.getURL }, 'pointerLock', frame, win, origin), false);
    assert.equal(allowGamePointerLock(wc, 'pointerLock', { ...frame, isMainFrame: false }, win, origin), false);
    assert.equal(allowGamePointerLock(wc, 'pointerLock', { ...frame, requestingUrl: 'https://other.example/' }, win, origin), false);
    assert.equal(allowGamePointerLock(wc, 'pointerLock', frame, { ...win, isDestroyed: () => true }, origin), false);
    assert.equal(allowGamePointerLock(wc, 'pointerLock', frame, undefined, origin), false);
    assert.equal(allowGamePointerLock(null, 'pointerLock', frame, win, origin), false);
  }
});

test('launcher file pages and missing request identity never capture the pointer', () => {
  const wc = { getURL: () => 'file:///app/launcher.html' }, win = { webContents: wc, isDestroyed: () => false };
  assert.equal(allowGamePointerLock(wc, 'pointerLock', { isMainFrame: true, requestingUrl: wc.getURL() }, win, 'null'), false);
  assert.equal(allowGamePointerLock(wc, 'pointerLock', undefined, win, 'http://127.0.0.1:4100'), false);
});
