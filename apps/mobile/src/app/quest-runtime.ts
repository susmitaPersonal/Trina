import NetInfo from '@react-native-community/netinfo';
import * as Notifications from 'expo-notifications';
import { Linking, Platform } from 'react-native';
import { getServices } from './services';

/**
 * Offline Quest Mode runtime (design §5A). Apps can't switch the internet off (Android 10+ / iOS),
 * so we ASK, then record and react:
 *  - the Start button needs the phone offline (mobile data AND Wi-Fi off; calls keep working),
 *  - every connectivity change during a quest becomes a ConnectivityChanged event,
 *  - if the internet comes back, the player gets 60 s to turn it off before the quest pauses,
 *  - the QuestGuard (services.quest.active) blocks every request Trina would make.
 */
export const QUEST_GRACE_MS = 60_000;

export type Connectivity = { online: boolean; transport: 'wifi' | 'cellular' | 'other' | 'none' };

export function toConnectivity(state: { isConnected: boolean | null; isInternetReachable?: boolean | null; type?: string }): Connectivity {
  const online = state.isConnected === true && state.isInternetReachable !== false;
  const t = state.type === 'wifi' ? 'wifi' : state.type === 'cellular' ? 'cellular' : online ? 'other' : 'none';
  return { online, transport: online ? t : 'none' };
}

export async function currentConnectivity(): Promise<Connectivity> {
  try {
    return toConnectivity(await NetInfo.fetch());
  } catch {
    return { online: false, transport: 'none' };
  }
}

/** One tap to the system internet panel (Android) or Settings (iOS: then Control Centre). */
export async function openInternetSettings() {
  if (Platform.OS === 'android') {
    try {
      await Linking.sendIntent('android.settings.panel.action.INTERNET_CONNECTIVITY');
      return;
    } catch {
      /* older Android: fall through */
    }
  }
  await Linking.openSettings().catch(() => undefined);
}

export const GO_OFFLINE_COPY = {
  title: 'Turn off mobile data and Wi-Fi',
  body: 'Keep calls on for safety. Your quest starts as soon as the phone is offline.',
  ios: 'Swipe down for Control Centre and turn off Wi-Fi and Mobile Data.',
};

let graceTimer: ReturnType<typeof setTimeout> | null = null;
let pausedByGuard = false;

/** Called on every NetInfo change. Pure bookkeeping when no quest runs. */
export async function onQuestConnectivity(c: Connectivity): Promise<'none' | 'recorded' | 'grace' | 'paused' | 'resumed'> {
  const s = await getServices();
  if (!s.quest.active || !s.quest.sessionId) return 'none';
  const sm = await s.sessions();
  const sessionId = s.quest.sessionId;
  const changed = await sm.setConnectivity(sessionId, c.online, c.transport);
  if (!changed) return 'none';
  if (c.online) {
    await Notifications.scheduleNotificationAsync({
      content: { title: "You're online", body: 'Turn the internet off within 60 seconds to keep your quest going.' },
      trigger: null,
    }).catch(() => undefined);
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = setTimeout(async () => {
      graceTimer = null;
      const now = await currentConnectivity();
      if (now.online && s.quest.active) {
        await sm.append(sessionId, 'SessionPaused', {});
        pausedByGuard = true;
      }
    }, QUEST_GRACE_MS);
    return 'grace';
  }
  if (graceTimer) {
    clearTimeout(graceTimer);
    graceTimer = null;
  }
  if (pausedByGuard) {
    pausedByGuard = false;
    await sm.append(sessionId, 'SessionResumed', {});
    return 'resumed';
  }
  return 'recorded';
}

/** Arms or disarms the guard (on start, finish, stop and app resume). */
export async function setQuestActive(sessionId: string | null) {
  const s = await getServices();
  s.quest.active = sessionId !== null;
  s.quest.sessionId = sessionId;
  if (!sessionId && graceTimer) {
    clearTimeout(graceTimer);
    graceTimer = null;
  }
  pausedByGuard = false;
}

/** On app start: re-arm the guard if a quest was running when the app was killed. */
export async function resumeQuestGuard() {
  const s = await getServices();
  if (!(await s.me())) return;
  const sm = await s.sessions();
  await setQuestActive(await sm.activeQuestId());
}
