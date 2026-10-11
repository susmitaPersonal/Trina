import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { ChallengeSummary } from '@trina/contracts';
import * as Location from 'expo-location';
import React, { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import type { StoredChallenge } from '../core/offline-store';
import { getServices } from '../app/services';
import { useApp } from '../app/store';
import { Banner, Btn, Card, Chip, Row, Screen, Stat, T } from '../components/ui';
import { Meadow, QuoteCarousel, quotesForDay } from '../components/progress';
import { space } from '../components/theme';

const MODULE_ICON: Record<string, string> = { walking: '🚶', running: '🏃', cycling: '🚲', cleanup: '🧹', tree_care: '🌳', mindful: '🧘', scavenger: '🔎', fitness: '💪', cricket: '🏏', football: '⚽' };
export const moduleIcons = (ids: string[]) => ids.map((m) => MODULE_ICON[m] ?? '•').join(' ');

export function HomeScreen() {
  const nav = useNavigation<any>();
  const me = useApp((s) => s.me);
  const [downloaded, setDownloaded] = useState<StoredChallenge[]>([]);
  const [history, setHistory] = useState<Awaited<ReturnType<Awaited<ReturnType<Awaited<ReturnType<typeof getServices>>['sessions']>>['history']>>>([]);
  const [active, setActive] = useState<string | null>(null);
  const [impact, setImpact] = useState({ sessions: 0, trees: 0, litter: 0, distanceM: 0, steps: 0 });
  const [today, setToday] = useState<{ dayKey: string; done: number; total: number; target: number; personal: string[]; offlineWeek: number; flowers: number } | null>(null);

  useFocusEffect(
    useCallback(() => {
      (async () => {
        const s = await getServices();
        const sm = await s.sessions();
        setDownloaded(await s.store.listDownloaded());
        const h = await sm.history();
        setHistory(h);
        setActive(await sm.activeSessionId());
        setImpact(await sm.impact());
        try {
          const ms = await s.milestones();
          const dq = await ms.dailyQuests();
          const { server, provisional } = await ms.progress();
          const wk = Object.values(provisional.weeks).sort((a, b) => b.weekKey.localeCompare(a.weekKey))[0];
          const done = dq.quests.filter((q) => q.done).length;
          const personal = [
            `Today's quests: ${done}/${dq.quests.length} done`,
            ...(wk && wk.offline90Days > 0 && wk.offline90Days < 3 ? [`${3 - wk.offline90Days} more 90-min days for the +15 weekly bonus`] : []),
            ...((await ms.all(['final'])).slice(0, 1).map((m) => `Latest: ${m.title} 🏅`)),
          ];
          setToday({ dayKey: dq.dayKey, done, total: dq.quests.length, target: dq.targetMinutes, personal, offlineWeek: server?.offlineQuestMinutes ?? provisional.offlineQuestMinutes, flowers: wk?.offline90Days ?? 0 });
        } catch {
          /* milestones are optional on Home */
        }
      })();
    }, []),
  );

  const next = downloaded[0];
  const unsynced = history.find((h) => h.pending > 0 && h.status !== 'active');
  return (
    <Screen title={`Hi ${me?.displayName.split(' ')[0] ?? ''} 🌱`}>
      {today ? (
        <QuoteCarousel
          cards={[
            ...today.personal.map((t, i) => ({ key: `p${i}`, text: t, tone: 'personal' as const })),
            ...quotesForDay(today.dayKey, 6).map((q, i) => ({ key: `q${i}`, text: q })),
          ]}
        />
      ) : null}
      {today && !active ? (
        <Card tone="ok" onPress={() => nav.navigate('Today')}>
          <T v="small" muted>DAILY QUESTS · {today.done}/{today.total}</T>
          <T v="big">Go offline for {today.target} minutes 🌱</T>
          <Meadow offlineMinutes={today.offlineWeek} flowers={today.flowers} height={60} />
          <Btn title="Start Daily Quest" onPress={() => nav.navigate('QuestStart', { targetMinutes: today.target })} />
        </Card>
      ) : null}
      {active ? (
        <Card tone="ok" onPress={() => nav.navigate('Live', { sessionId: active })}>
          <T v="big">▶ Challenge in progress</T>
          <T muted>Tap to return. Your progress is saved on this phone.</T>
        </Card>
      ) : null}
      {next ? (
        <Card onPress={() => nav.navigate('Details', { challengeId: next.id })}>
          <T v="small" muted>NEXT UP · ✅ Ready offline</T>
          <T v="h2">{next.title}</T>
          <T muted>{next.bundle.definition.timing.durationMin} min · {moduleIcons(next.bundle.definition.modules.map((m) => m.id))}</T>
          <Btn title="Prepare to start" onPress={() => nav.navigate('Preflight', { challengeId: next.id, version: next.version })} />
        </Card>
      ) : (
        <Card>
          <T v="big">Find something to do outside</T>
          <T muted>Join a nearby challenge or create one with AI in a sentence.</T>
          <Row>
            <Btn title="Discover" onPress={() => nav.navigate('Discover')} style={{ flex: 1 }} />
            <Btn title="Create" kind="secondary" onPress={() => nav.navigate('Create')} style={{ flex: 1 }} />
          </Row>
        </Card>
      )}
      {unsynced ? (
        <Card tone="info" onPress={() => nav.navigate('SyncStatus')}>
          <T v="big">⬆️ {unsynced.title}</T>
          <T muted>{unsynced.pending} activities waiting to sync. We'll send them automatically.</T>
        </Card>
      ) : null}
      <Card>
        <T v="small" muted>YOUR IMPACT</T>
        <Row>
          <Stat label="challenges" value={String(impact.sessions)} />
          <Stat label="trees watered" value={String(impact.trees)} />
          <Stat label="litter picked" value={String(impact.litter)} />
          <Stat label="km outside" value={(impact.distanceM / 1000).toFixed(1)} />
        </Row>
      </Card>
      {history.length ? (
        <View style={{ gap: space.s }}>
          <T v="big">Recent</T>
          {history.slice(0, 3).map((h) => (
            <Card key={h.id} onPress={() => nav.navigate('Results', { sessionId: h.id })}>
              <T v="big">{h.title}</T>
              <T muted>
                {h.final !== null ? `${h.final} pts · ${verdictLabel(h.verdict)}` : h.provisional !== null ? `${h.provisional} pts (provisional)` : h.status}
              </T>
            </Card>
          ))}
        </View>
      ) : null}
    </Screen>
  );
}

export function verdictLabel(v: string | null): string {
  return v === 'verified' ? '✅ Verified' : v === 'verified_with_notes' ? '✅ Verified with notes' : v === 'needs_review' ? '🔍 Under review' : v === 'rejected' ? '⛔ Not verified' : '⏳ Waiting to verify';
}

export function DiscoverScreen() {
  const nav = useNavigation<any>();
  const online = useApp((s) => s.online);
  const [items, setItems] = useState<ChallengeSummary[]>([]);
  const [filter, setFilter] = useState<{ module?: string; maxDuration?: number; nearby: boolean }>({ nearby: true });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await getServices();
      let near: [number, number] | undefined;
      if (filter.nearby) {
        const perm = await Location.getForegroundPermissionsAsync();
        if (perm.granted) {
          const p = (await Location.getLastKnownPositionAsync()) ?? (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low }));
          if (p) near = [p.coords.longitude, p.coords.latitude];
        }
      }
      const r = await s.api.listChallenges({ near, module: filter.module, maxDuration: filter.maxDuration });
      setItems(r.items);
    } catch {
      setError('Discover needs internet. Your joined challenges are still available offline on Home.');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <Screen title="Discover">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.s }}>
        <Chip label="📍 Nearby" selected={filter.nearby} onPress={() => setFilter({ ...filter, nearby: !filter.nearby })} />
        <Chip label="≤ 45 min" selected={filter.maxDuration === 45} onPress={() => setFilter({ ...filter, maxDuration: filter.maxDuration ? undefined : 45 })} />
        {['walking', 'cycling', 'cleanup', 'tree_care', 'mindful'].map((m) => (
          <Chip key={m} label={`${MODULE_ICON[m]} ${m.replace('_', ' ')}`} selected={filter.module === m} onPress={() => setFilter({ ...filter, module: filter.module === m ? undefined : m })} />
        ))}
      </ScrollView>
      {!online || error ? <Banner tone="offline" text={error ?? 'Discover needs internet.'} /> : null}
      <RefreshControl refreshing={loading} onRefresh={load} />
      {items.map((c) => (
        <Card key={c.id} onPress={() => nav.navigate('Details', { challengeId: c.id })}>
          <T v="big">{moduleIcons(c.moduleIds)}  {c.title}</T>
          <T muted>
            {c.durationMin} min · {c.difficulty} · {c.participants}/{c.maxParticipants} joined{c.distanceKm !== null ? ` · ${c.distanceKm} km away` : ''}
          </T>
          <T v="small" muted>by {c.creatorName}</T>
        </Card>
      ))}
      {!loading && !items.length && !error ? <T muted center>No challenges here yet. Create the first one! ✨</T> : null}
      <Btn title="Refresh" kind="ghost" onPress={load} busy={loading} />
    </Screen>
  );
}
