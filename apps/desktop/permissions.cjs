/** Only the selected game's top frame can capture the pointer. Chromium still requires its user gesture. */
function allowGamePointerLock(webContents, permission, details, gameWindow, gameOrigin, requestingOrigin) {
  if (permission !== 'pointerLock' || !webContents || !gameWindow || gameWindow.isDestroyed()
    || webContents !== gameWindow.webContents || details?.isMainFrame !== true || !gameOrigin) return false;
  try {
    const current = new URL(webContents.getURL()), request = new URL(details.requestingUrl || requestingOrigin || '');
    return ['http:', 'https:'].includes(current.protocol) && current.origin === gameOrigin && request.origin === gameOrigin;
  } catch { return false; }
}
module.exports = { allowGamePointerLock };
