import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { Fix } from '@trina/contracts';
import { compileOrThrow } from '@trina/engine';
import * as Battery from 'expo-battery';
import { Camera } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { Pedometer } from 'expo-sensors';
import React, { useEffect, useRef, useState } from 'react';
import { Linking, Platform, Pressable, Text, View } from 'react-native';
import { evaluatePreflight, type PreflightInput } from '../core/preflight';
import type { StoredChallenge } from '../core/offline-store';
import type { RootParams } from '../app/navigation';
import { getServices } from '../app/services';
import { useApp } from '../app/store';
import { freeBytes } from '../platform/files';
import { startRuntime } from '../platform/session-runtime';
import { font, radius, TOUCH, useTheme } from '../components/theme';
import { Banner, Btn, Card, MoodPicker, Screen, StatusLine, T } from '../components/ui';

type Perm = 'granted' | 'denied' | 'undetermined';
const perm = (p: { granted: boolean; canAskAgain?: boolean; status?: string }): Perm => (p.granted ? 'granted' : p.status === 'undetermined' ? 'undetermined' : 'denied');

export function PreflightScreen({ route, navigation }: NativeStackScreenProps<RootParams, 'Preflight'>) {
  const { challengeId, version } = route.params;
  const me = useApp((s) => s.me);
  const [challenge, setChallenge] = useState<StoredChallenge | null>(null);
  const [input, setInput] = useState<Omit<PreflightInput, 'compiled' | 'engineMinVersion'> | null>(null);
  const [fix, setFix] = useState<{ lat: number; lng: number; acc: number } | null>(null);
  const startedAt = useRef(Date.now());
  const [tick, setTick] = useState(0);

  const refreshPerms = async () => {
    const s = await getServices();
    const c = await s.store.getChallenge(challengeId, version);
    setChallenge(c);
    const [loc, notif, cam, steps] = await Promise.all([
      Location.getForegroundPermissionsAsync(),
      Notifications.getPermissionsAsync(),
      Camera.getCameraPermissionsAsync(),
      Pedometer.isAvailableAsync().then((ok) => (ok ? Pedometer.getPermissionsAsync() : null)).catch(() => null),
    ]);
    let skew: number | null = null;
    try {
      const t0 = Date.now();
      const st = await s.api.serverTime();
      skew = Date.now() - (Date.parse(st.serverTime) + (Date.now() - t0) / 2);
      await s.store.setMeta('clock_skew_ms', String(Math.round(skew)));
    } catch {
      const saved = await s.store.getMeta('clock_skew_ms');
      skew = saved ? Number(saved) : null;
    }
    setInput({
      signedInBefore: !!me,
      participationJoined: !!c,
      locationPermission: perm(loc),
      notificationPermission: Platform.OS === 'android' ? perm(notif) : 'not_required',
      cameraPermission: perm(cam),
      activityPermission: steps ? perm(steps) : 'unavailable',
      fix: null,
      fixWaitedMs: 0,
      freeBytes: await freeBytes(),
      batteryLevel: await Battery.getBatteryLevelAsync().catch(() => null),
      serverNowMs: Date.now() + (c?.clockOffsetMs ?? 0),
      clockSkewMs: skew,
      hasMapPack: !!c?.bundle.mapPack,
    });
  };

  useEffect(() => {
    void refreshPerms();
    let sub: Location.LocationSubscription | null = null;
    (async () => {
      const p = await Location.getForegroundPermissionsAsync();
      if (!p.granted) return;
      sub = await Location.watchPositionAsync({ accuracy: Location.Accuracy.BestForNavigation, timeInterval: 2000, distanceInterval: 0 }, (l) =>
        setFix({ lat: l.coords.latitude, lng: l.coords.longitude, acc: l.coords.accuracy ?? 999 }),
      );
    })();
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => {
      sub?.remove();
      clearInterval(t);
    };
  }, []);

  if (!input || !challenge) return <Screen title="Pre-flight check" back><T muted>Checking…</T></Screen>;
  const compiled = (() => {
    try {
      return compileOrThrow(challenge.bundle.definition);
    } catch {
      return null;
    }
  })();
  const result = evaluatePreflight({ ...input, compiled, engineMinVersion: challenge.engineMinVersion, fix, fixWaitedMs: Date.now() - startedAt.current });
  void tick;

  const fixFor = (id: string) => {
    if (['location_permission', 'camera', 'notifications', 'activity_permission'].includes(id)) {
      return () => navigation.navigate('Permissions', { next: 'Preflight', challengeId, version });
    }
    if (id === 'downloaded' || id === 'route') return () => navigation.navigate('Details', { challengeId });
    return undefined;
  };

  return (
    <Screen title="Pre-flight check" back>
      <T v="big">{challenge.title}</T>
      {result.checks.map((c) => (
        <Pressable key={c.id} onPress={c.status !== 'pass' ? fixFor(c.id) : undefined}>
          <StatusLine status={c.status} label={c.label} detail={[c.detail, c.status !== 'pass' && c.fix ? `→ ${c.fix}` : undefined].filter(Boolean).join(' ')} />
        </Pressable>
      ))}
      {result.distanceToStartM !== null && result.checks.find((c) => c.id === 'start_zone')?.status === 'fail' ? (
        <Banner tone="info" text={`The start zone is ${result.distanceToStartM} m away. Walk there and the check turns green.`} />
      ) : null}
      <Btn title="Re-check permissions" kind="ghost" onPress={refreshPerms} />
      <Btn title={result.canStart ? "I'm ready" : 'Not ready yet'} disabled={!result.canStart} onPress={() => navigation.navigate('Start', { challengeId, version })} />
    </Screen>
  );
}

const PERMISSIONS = [
  { id: 'location', icon: '📍', title: 'Location while using Trina', why: 'To check checkpoints during a challenge. Tracking starts only at the public start zone, never at home. We never ask for "Always".' },
  { id: 'notifications', icon: '🔔', title: 'Notifications', why: 'Your lock screen shows progress, and we buzz at checkpoints so you can keep the phone in your pocket.' },
  { id: 'camera', icon: '📷', title: 'Camera', why: 'Evidence photos for tasks are taken inside Trina. Photos stay private.' },
  { id: 'activity', icon: '👣', title: 'Physical activity (optional)', why: 'Counts your steps for the wellness card. Not required to play.' },
] as const;

export function PermissionsScreen({ route, navigation }: NativeStackScreenProps<RootParams, 'Permissions'>) {
  const [status, setStatus] = useState<Record<string, Perm>>({});
  const load = async () => {
    const [l, n, c, a] = await Promise.all([
      Location.getForegroundPermissionsAsync(),
      Notifications.getPermissionsAsync(),
      Camera.getCameraPermissionsAsync(),
      Pedometer.getPermissionsAsync().catch(() => ({ granted: false, status: 'denied' })),
    ]);
    setStatus({ location: perm(l), notifications: perm(n), camera: perm(c), activity: perm(a as never) });
  };
  useEffect(() => {
    void load();
  }, []);
  const ask = async (id: string) => {
    if (status[id] === 'denied') return Linking.openSettings();
    if (id === 'location') await Location.requestForegroundPermissionsAsync();
    if (id === 'notifications') await Notifications.requestPermissionsAsync();
    if (id === 'camera') await Camera.requestCameraPermissionsAsync();
    if (id === 'activity') await Pedometer.requestPermissionsAsync().catch(() => undefined);
    await load();
  };
  return (
    <Screen title="Permissions" back pill={false}>
      {PERMISSIONS.map((p) => (
        <Card key={p.id}>
          <T v="big">{p.icon} {p.title}</T>
          <T muted>{p.why}</T>
          {status[p.id] === 'granted' ? (
            <StatusLine status="pass" label="Allowed" />
          ) : (
            <Btn title={status[p.id] === 'denied' ? 'Open settings' : 'Allow'} kind="secondary" onPress={() => ask(p.id)} />
          )}
        </Card>
      ))}
      <Btn title="Done" onPress={() => (route.params.next && route.params.challengeId ? navigation.navigate('Preflight', { challengeId: route.params.challengeId, version: route.params.version ?? 1 }) : navigation.goBack())} />
    </Screen>
  );
}

export function StartScreen({ route, navigation }: NativeStackScreenProps<RootParams, 'Start'>) {
  const { challengeId, version } = route.params;
  const t = useTheme();
  const [mood, setMood] = useState<number | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fix, setFix] = useState<Location.LocationObject | null>(null);

  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;
    void Location.watchPositionAsync({ accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 }, setFix).then((s) => (sub = s));
    return () => sub?.remove();
  }, []);

  const begin = async () => {
    if (!fix) return setError('Waiting for GPS…');
    for (const n of [3, 2, 1]) {
      setCount(n);
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 800));
    }
    setCount(0);
    try {
      const s = await getServices();
      const sm = await s.sessions();
      const startFix: Fix = { lat: fix.coords.latitude, lng: fix.coords.longitude, acc: fix.coords.accuracy ?? 999, ts: new Date(fix.timestamp).toISOString(), mocked: fix.mocked === true };
      const sessionId = await sm.start({ challengeId, version, startFix, bootId: String(Math.floor(Date.now() / 1000 - (globalThis.performance?.now?.() ?? 0) / 1000)) });
      if (mood) await sm.setMood(sessionId, 'before', mood);
      const mode = await startRuntime(sessionId);
      useApp.getState().set({ activeSessionId: sessionId });
      navigation.replace('Live', { sessionId, ...(mode === 'foreground_only' ? { foregroundOnly: true } : {}) } as never);
    } catch (e) {
      setCount(null);
      setError((e as Error).message);
    }
  };

  if (count !== null) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.primary }}>
        <Text style={{ fontSize: 120, fontWeight: '900', color: t.primaryText }}>{count || 'GO'}</Text>
      </View>
    );
  }
  return (
    <Screen title="Ready?" pill={false} back>
      <Card tone="ok">
        <T v="big">✅ You're in the start zone</T>
        <T muted>{fix ? `GPS ±${Math.round(fix.coords.accuracy ?? 0)} m` : 'Waiting for GPS…'}</T>
      </Card>
      <MoodPicker label="How do you feel right now?" value={mood} onChange={setMood} />
      <Card tone="warn">
        <T>⚠️ Stay safe: don't look at your phone while walking or cycling near roads. We'll buzz you at checkpoints.</T>
      </Card>
      {error ? <Banner tone="warn" text={error} /> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Hold to start the challenge"
        delayLongPress={900}
        onLongPress={begin}
        style={({ pressed }) => ({ minHeight: TOUCH + 16, borderRadius: radius.l, backgroundColor: pressed ? t.ok : t.primary, alignItems: 'center', justifyContent: 'center' })}
      >
        <Text style={{ color: t.primaryText, fontSize: font.big, fontWeight: '800' }}>Hold to start ▶</Text>
      </Pressable>
    </Screen>
  );
}
