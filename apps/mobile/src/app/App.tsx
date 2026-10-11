import { DarkTheme, DefaultTheme, NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Loading } from '../components/ui';
import { registerBackgroundSync } from '../platform/background-sync';
import { resumeRuntimeIfNeeded } from '../platform/session-runtime';
import { setupNotificationChannels } from './milestone-notify';
import { RootNavigator, type RootParams } from './navigation';
import { resumeQuestGuard } from './quest-runtime';
import { getServices } from './services';
import { refreshSyncState, startConnectivity, syncNow, useApp } from './store';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldPlaySound: true, shouldSetBadge: false, shouldShowBanner: true, shouldShowList: true }),
});

export const navRef = createNavigationContainerRef<RootParams>();

/** Splash: open DB + migrate, read cached user, resume an active session. Never blocks on the network. */
export default function App() {
  const scheme = useColorScheme();
  const [booted, setBooted] = useState(false);
  const [resumeSession, setResumeSession] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const s = await getServices();
      const me = await s.me();
      useApp.getState().set({ me, ready: true });
      await setupNotificationChannels();
      await resumeQuestGuard();
      await startConnectivity();
      await refreshSyncState();
      if (me) {
        setResumeSession(await resumeRuntimeIfNeeded());
        void syncNow();
        void registerBackgroundSync();
        void s.ensureDeviceKey();
      }
      setBooted(true);
    })();
  }, []);

  if (!booted) return <Loading text="Trina 🌱" />;
  return (
    <SafeAreaProvider>
      <NavigationContainer ref={navRef} theme={scheme === 'dark' ? DarkTheme : DefaultTheme}>
        <StatusBar style="auto" />
        <RootNavigator resumeSessionId={resumeSession} />
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
