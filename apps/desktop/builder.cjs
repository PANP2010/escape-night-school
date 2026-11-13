const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const releaseFile = join(__dirname, 'release.json');
const release = existsSync(releaseFile) ? JSON.parse(readFileSync(releaseFile, 'utf8')) : undefined;
module.exports = {
  appId: 'game.escapenightschool.desktop',
  productName: '逃离夜校',
  executableName: 'EscapeNightSchool',
  artifactName: 'Escape-Night-School-${version}-${os}-${arch}.${ext}',
  directories: { output: 'output/desktop', buildResources: 'desktop/assets' },
  files: ['desktop/**', 'package.json', '!desktop/assets/icon.svg'],
  extraResources: [{ from: 'stage/runtime', to: 'game' }],
  asar: true,
  npmRebuild: false,
  ...(release ? { extraMetadata: { version: release.id } } : {}),
  mac: {
    category: 'public.app-category.adventure-games',
    icon: 'desktop/assets/icon.icns',
    identity: '-',
    hardenedRuntime: false,
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    extendInfo: { NSHumanReadableCopyright: '逃离夜校', NSHighResolutionCapable: true },
  },
  dmg: { title: '逃离夜校', window: { width: 600, height: 410 }, iconSize: 100, contents: [
    { x: 160, y: 180, type: 'file' },
    { x: 440, y: 180, type: 'link', path: '/Applications' },
  ] },
  win: {
    icon: 'desktop/assets/icon.ico',
    signExecutable: false,
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }],
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: '逃离夜校',
    uninstallDisplayName: '逃离夜校',
    installerLanguages: ['zh_CN', 'en_US'],
    language: '2052',
    displayLanguageSelector: false,
    differentialPackage: false,
  },
};
