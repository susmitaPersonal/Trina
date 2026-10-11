// Expo's default config already understands pnpm/yarn workspaces (SDK 52+).
// Workspace packages (@trina/*) ship TypeScript source, which Metro transpiles.
const { getDefaultConfig } = require('expo/metro-config');

module.exports = getDefaultConfig(__dirname);
