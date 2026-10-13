import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { Fix } from '@trina/contracts';
import type { MilestoneProgress } from '@trina/engine';
import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import React, { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { labelFor } from '../core/milestones';
import type { RootParams } from '../app/navigation';
import { currentConnectivity, GO_OFFLINE_COPY, openInternetSettings, setQuestActive } from '../app/quest-runtime';
import { getServices } from '../app/services';
import { syncNow, useApp } from '../app/store';
import { startRuntime } from '../platform/session-runtime';
import { ProgressBar, tierIcon, VerificationBadge } from '../components/progress';
import { Banner, Btn, Card, Chip, Row, Screen, StatusLine, T } from '../components/ui';

type Quests = Awaited<ReturnType<Awaited<ReturnType<Awaited<ReturnType<typeof import('../app/services').getServices>>['milestones']>>['dailyQuests']>>;

const fmtValue = (key: string, v: number) => (/zone_dwell|offline|outside|minutes/.test(key) ? `${Math.floor(v / 60)} min` : String(Math.round(v)));

/** Today (design §3.7): 3 Daily Quests, milestones in progress, and the weekly offline bonus. Works offline. */
export function TodayScreen() {
  const nav = useNavigation<any>();
  const [quests, setQuests] = useState<Quests | null>(null);
  const [current, setCurrent] = useState<MilestoneProgress[]>([]);
  const [week, setWeek] = useState<{ offline90Days: number; forceStopDays: number; bonus: number } | null>(null);

  useFocusEffect(
    useCallback(() => {
      (async () => {
        const s = await getServices();
        const ms = await s.milestones();
        setQuests(await ms.dailyQuests());
        setCurrent((await ms.current()).filter((p) => !p.key.startsWith('*@1:q_')));
        const { server, provisional } = await ms.progress();
        const wk = Object.values(provisional.weeks).sort((a, b) => b.weekKey.localeCompare(a.weekKey))[0];
        setWeek(server ? server.week : wk ? { offline90Days: wk.offline90Days, forceStopDays: wk.forceStopDays, bonus: wk.bonus } : null);
      })();
    }, []),
  );

  const done = quests?.quests.filter((q) => q.done).length ?? 0;
  return (
    <Screen title="Today">
      <Card tone="ok">
        <T v="small" muted>DAILY QUESTS · {done}/{quests?.quests.length ?? 3} done</T>
        {(quests?.quests ?? []).map((q) => (
          <Row key={q.key} style={{ justifyContent: 'space-between' }}>
            <T style={{ flex: 1 }}>{q.done ? '✅' : '○'} {q.title}</T>
            <T muted v="small">{q.done ? (q.status === 'final' ? 'confirmed' : 'provisional') : `${fmtValue(q.key, q.value)} / ${fmtValue(q.key, q.target)}`}</T>
          </Row>
        ))}
        <Btn title={`Start a ${quests?.targetMinutes ?? 30}-min offline quest`} icon="🌱" onPress={() => nav.navigate('QuestStart', { targetMinutes: quests?.targetMinutes ?? 30, maxMinutes: quests?.maxMinutes })} />
        {quests?.targetReason ? <T v="small" muted>{ADAPT_COPY[quests.targetReason]}</T> : null}
        <Btn title="Offline party with friends" icon="🎉" kind="secondary" onPress={() => nav.navigate('Party')} />
        <T v="small" muted>Resets at 4 am. Rest days are part of it.</T>
      </Card>
      <Card>
        <T v="small" muted>THIS WEEK</T>
        <T>Offline 3 × 90: {week?.offline90Days ?? 0}/3 days {week && week.bonus > 0 ? '· +15 bonus earned 🎉' : ''}</T>
        <ProgressBar value={week?.offline90Days ?? 0} max={3} label="Days with 90 offline minutes" />
        {week && week.forceStopDays > 0 ? <T v="small" muted>Stopped quests this week: {week.forceStopDays} day{week.forceStopDays > 1 ? 's' : ''} (3 or more costs 10 XP; safety stops never count).</T> : null}
      </Card>
      {current.length ? <T v="big">Milestones in progress</T> : <T muted>Play a quest or a challenge and your milestones show up here.</T>}
      {current.slice(0, 12).map((p) => (
        <Card key={`${p.key}|${p.windowKey}`} onPress={() => nav.navigate('MilestoneDetail', { key: p.key, windowKey: p.windowKey })}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T v="big" style={{ flex: 1 }}>{tierIcon(p.tier)} {p.title}</T>
            <VerificationBadge label={labelFor(p.verification, p.pendingServer ? 'pending_server' : 'provisional')} />
          </Row>
          {p.nextTier ? (
            <>
              <ProgressBar value={p.value} max={p.nextTier.gte} label={`${p.title} progress`} />
              <T v="small" muted>{fmtValue(p.key, p.value)} of {fmtValue(p.key, p.nextTier.gte)} for {p.nextTier.tier}</T>
            </>
          ) : (
            <T v="small" muted>Top tier reached</T>
          )}
        </Card>
      ))}
      <Row>
        <Btn title="Milestone history" kind="secondary" onPress={() => nav.navigate('MilestoneHistory')} style={{ flex: 1 }} />
        <Btn title="My status" kind="secondary" onPress={() => nav.navigate('Status')} style={{ flex: 1 }} />
      </Row>
    </Screen>
  );
}

const LENGTHS = [30, 45, 60, 90] as const;

/** Why today's suggested length (adaptive ladder, ADR-032). Never shaming. */
export const ADAPT_COPY: Record<string, string> = {
  start: 'Start small: 30 minutes.',
  welcome_back: 'Welcome back! An easy 30 minutes to start again.',
  step_up: 'Three quests done at this length. Ready for a bit more?',
  step_down: 'A shorter quest this time. Every minute outside counts.',
  stay: 'Same length as last time.',
  rank_cap: "You're at the longest quest for your rank. Longer ones unlock as you grow.",
};

/**
 * Quest start (design §5A.3): sync own data first, then ask the player to go offline (mobile data AND
 * Wi-Fi; calls keep working), get a GPS fix, start. The Start button stays locked while online.
 */
export function QuestStartScreen({ route, navigation }: NativeStackScreenProps<RootParams, 'QuestStart'>) {
  const me = useApp((s) => s.me);
  const [target, setTarget] = useState<(typeof LENGTHS)[number]>((LENGTHS as readonly number[]).includes(route.params?.targetMinutes ?? 30) ? (route.params!.targetMinutes as (typeof LENGTHS)[number]) : 30);
  const [presync, setPresync] = useState<'pending' | 'done' | 'skipped'>('pending');
  const [online, setOnline] = useState<boolean | null>(null);
  const [fix, setFix] = useState<Location.LocationObject | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const c = await currentConnectivity();
      if (c.online) {
        await syncNow(); // own data syncs BEFORE going offline
        setPresync('done');
        await Notifications.scheduleNotificationAsync({ content: { title: GO_OFFLINE_COPY.title, body: GO_OFFLINE_COPY.body }, trigger: null }).catch(() => undefined);
      } else setPresync('skipped');
      setOnline(c.online);
    })();
    const poll = setInterval(async () => setOnline((await currentConnectivity()).online), 2000);
    let sub: Location.LocationSubscription | null = null;
    void Location.getForegroundPermissionsAsync().then(async (p) => {
      if (!p.granted) return;
      // GPS works offline; getting a fix before going offline avoids a slow first fix without assisted GPS.
      sub = await Location.watchPositionAsync({ accuracy: Location.Accuracy.BestForNavigation, timeInterval: 2000, distanceInterval: 0 }, setFix);
    });
    return () => {
      clearInterval(poll);
      sub?.remove();
    };
  }, []);

  const start = async () => {
    if (!fix) return setError('Waiting for GPS…');
    setBusy(true);
    setError(null);
    try {
      const s = await getServices();
      const sm = await s.sessions();
      const startFix: Fix = { lat: fix.coords.latitude, lng: fix.coords.longitude, acc: fix.coords.accuracy ?? 999, ts: new Date(fix.timestamp).toISOString(), mocked: fix.mocked === true };
      // Difficulty is the player's level tier (from rank, design §5A.2), not the chosen length. Works offline.
      const level = await (await s.milestones())
        .dailyQuests()
        .then((d) => d.levelTier as 'easy' | 'medium' | 'hard')
        .catch(() => 'easy' as const);
      const sessionId = await sm.startQuest({ spec: { templateId: 'outside_v1', targetMinutes: target, levelTier: level }, startFix, online: !!online });
      await setQuestActive(sessionId);
      await startRuntime(sessionId);
      useApp.getState().set({ activeSessionId: sessionId });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      navigation.replace('Live', { sessionId });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Go offline" back pill={false}>
      <Card tone="ok">
        <T v="h2">🌱 {target}-minute offline quest</T>
        <T>Internet off, phone in pocket, go outside. Your time outside counts when you finish.</T>
        <Row>
          {LENGTHS.filter((m) => m <= (route.params?.maxMinutes ?? 90)).map((m) => (
            <Chip key={m} label={`${m} min`} selected={target === m} onPress={() => setTarget(m)} />
          ))}
        </Row>
      </Card>
      <StatusLine status={presync === 'pending' ? 'pending' : 'pass'} label={presync === 'done' ? 'Your data is synced' : presync === 'skipped' ? 'Already offline: your data will sync after the quest' : 'Syncing your data first…'} />
      <StatusLine status={online === false ? 'pass' : online === null ? 'pending' : 'fail'} label={online === false ? 'Offline: ready' : GO_OFFLINE_COPY.title} detail={online ? (Platform.OS === 'ios' ? GO_OFFLINE_COPY.ios : GO_OFFLINE_COPY.body) : undefined} />
      <StatusLine status={fix ? 'pass' : 'pending'} label={fix ? 'GPS ready' : 'Getting a GPS fix…'} detail={fix ? `±${Math.round(fix.coords.accuracy ?? 0)} m` : 'Do this before turning the internet off'} />
      {online ? <Btn title="Open internet settings" kind="secondary" onPress={openInternetSettings} /> : null}
      {error ? <Banner tone="warn" text={error} /> : null}
      <Btn title={online ? 'Turn the internet off to start' : 'Start quest'} icon={online ? '📴' : '▶'} disabled={online !== false || !fix || !me} busy={busy} onPress={start} />
      <T v="small" muted>Stopping for safety never costs points. Take care of yourself first.</T>
    </Screen>
  );
}
