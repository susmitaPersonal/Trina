/** UI tests: real React Native screens rendered with jest-expo + Testing Library. */
module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/ui-tests/**/*.test.tsx'],
  setupFiles: ['<rootDir>/ui-tests/setup.ts'],
  setupFilesAfterEnv: ['<rootDir>/ui-tests/setup-after-env.ts'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|react-native-svg|@noble/.*|@trina/.*|zustand))',
  ],
};
