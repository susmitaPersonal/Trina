import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { ProgressDto } from '@trina/contracts';
import { RANK_THRESHOLDS, RANKS, type MilestoneProgress, type Progression } from '@trina/engine';
import React, { useCallback, useState } from 'react';
import { Share } from 'react-native';
import { labelFor, type LocalMilestone } from '../core/milestones';
import type { RootParams } from '../app/navigation';
import { getServices } from '../app/services';
import { Meadow, ProgressBar, StatBars, tierIcon, VerificationBadge } from '../components/progress';
import { Banner, Btn, Card, Chip, Row, Screen, Stat, T } from '../components/ui';

const LABEL_EXPLAIN: Record<string, string> = {
  Measured: 'Measured by your phone (GPS, steps or the clock).',
  Evidenced: 'Counted from a photo bound to your session and checked by the server.',
  Confirmed: 'Confirmed by another player who was there, with a signed code.',
  'Self-reported': 'You said so. Self-reported milestones earn titles, not XP or rank, because nobody else can check them.',
  'Checked after sync': 'Needs other players’ sessions, so it is checked by the server after sync.',
};

/** Status: rank, XP, five stats and this week's meadow (design §7.7). Server numbers when known. */
export function StatusScreen() {
  const [server, setServer] = useState<ProgressDto | null>(null);
  const [prov, setProv] = useState<Progression | null>(null);
  useFocusEffect(
    useCallback(() => {
      (async () => {
        const s = await getServices();
        const ms = await s.milestones();
        const p = await ms.progress();
        setServer(p.server);
        setProv(p.provisional);
        try {
          const fresh = await s.api.myProgress();
          await ms.applyProgress(fresh);
          setServer(fresh);
        } catch {
          /* offline or in a quest: cached numbers */
        }
      })();
    }, []),
  );
  if (!prov) return <Screen title="Status" back><T muted>Loading…</T></Screen>;
  const rank = server?.rank ?? prov.rank;
  const xp = server?.xp ?? prov.xp;
  const rp = server?.rankPoints ?? prov.rankPoints;
  const next = RANKS[RANKS.indexOf(rank) + 1];
  const week = Object.values(prov.weeks).sort((a, b) => b.weekKey.localeCompare(a.weekKey))[0];
  const offlineThisWeek = server ? server.offlineQuestMinutes : prov.offlineQuestMinutes;
  const share = () =>
    Share.share({ message: `Rank ${rank} on Trina 🌱 ${xp} XP · ${server?.verifiedOutdoorMinutes ?? prov.verifiedOutdoorMinutes} minutes outside. Use the phone for two minutes, spend sixty outside.` });
  return (
    <Screen title="Status" back>
      <Card tone="ok">
        <Row style={{ justifyContent: 'space-between' }}>
          <T v="huge">{rank}</T>
          <Stat label="XP" value={String(xp)} big />
        </Row>
        {next ? (
          <>
            <ProgressBar value={rp} max={RANK_THRESHOLDS[next]} label={`Rank points towards ${next}`} />
            <T v="small" muted>{rp} / {RANK_THRESHOLDS[next]} rank points to {next}. Rank comes from time outside, offline quests and photo proof, and it never goes down.</T>
          </>
        ) : (
          <T>You reached the top rank. 🌱</T>
        )}
        {!server ? <T v="small" muted>Provisional: final numbers arrive after sync.</T> : null}
      </Card>
      <Card>
        <T v="small" muted>STATS</T>
        <StatBars xpByStat={(server?.xpByStat as Record<string, number>) ?? prov.xpByStat} />
      </Card>
      <Card>
        <T v="small" muted>YOUR MEADOW THIS WEEK</T>
        <Meadow offlineMinutes={week ? offlineThisWeek : 0} flowers={week?.offline90Days ?? 0} />
        <T v="small" muted>Today: {server?.todayXp ?? prov.todayXp} / {server?.dailyXpCap ?? 300} XP. That's plenty for one day.</T>
      </Card>
      <Btn title="Share my status" icon="📤" kind="secondary" onPress={share} />
    </Screen>
  );
}

/** History of unlocked milestones (final, provisional, revoked) with honest labels. */
export function MilestoneHistoryScreen() {
  const nav = useNavigation<any>();
  const [items, setItems] = useState<LocalMilestone[]>([]);
  const [filter, setFilter] = useState<'all' | 'Measured' | 'Evidenced' | 'Confirmed' | 'Self-reported'>('all');
  useFocusEffect(
    useCallback(() => {
      (async () => {
        const ms = await (await getServices()).milestones();
        setItems(await ms.all(['provisional', 'final', 'revoked']));
      })();
    }, []),
  );
  const shown = items.filter((m) => filter === 'all' || m.label === filter);
  const byDay = new Map<string, LocalMilestone[]>();
  for (const m of shown) byDay.set(m.dayKey, [...(byDay.get(m.dayKey) ?? []), m]);
  return (
    <Screen title="Milestones" back>
      <Row>
        {(['all', 'Measured', 'Evidenced', 'Confirmed', 'Self-reported'] as const).map((f) => (
          <Chip key={f} label={f === 'all' ? 'All' : f} selected={filter === f} onPress={() => setFilter(f)} />
        ))}
      </Row>
      {!shown.length ? <T muted>No milestones yet. They unlock right after a session, even offline.</T> : null}
      {[...byDay.entries()].map(([day, list]) => (
        <Card key={day}>
          <T v="small" muted>{day}</T>
          {list.map((m) => (
            <Row key={`${m.key}|${m.windowKey}|${m.tier}`} style={{ justifyContent: 'space-between' }}>
              <T style={{ flex: 1, textDecorationLine: m.status === 'revoked' ? 'line-through' : 'none' }} numberOfLines={2}>
                {tierIcon(m.tier)} {m.title}
              </T>
              <VerificationBadge label={m.status === 'revoked' ? 'Checked after sync' : m.label} />
              <Btn title="›" kind="ghost" onPress={() => nav.navigate('MilestoneDetail', { key: m.key, windowKey: m.windowKey })} />
            </Row>
          ))}
        </Card>
      ))}
    </Screen>
  );
}

/** Why a milestone unlocked: value, tiers, and how it was verified. */
export function MilestoneDetailScreen({ route }: NativeStackScreenProps<RootParams, 'MilestoneDetail'>) {
  const { key, windowKey } = route.params;
  const [p, setP] = useState<MilestoneProgress | null>(null);
  const [rows, setRows] = useState<LocalMilestone[]>([]);
  useFocusEffect(
    useCallback(() => {
      (async () => {
        const ms = await (await getServices()).milestones();
        setP((await ms.evaluate()).find((x) => x.key === key && x.windowKey === windowKey) ?? null);
        setRows((await ms.all()).filter((r) => r.key === key && r.windowKey === windowKey));
      })();
    }, [key, windowKey]),
  );
  const title = p?.title ?? rows[0]?.title ?? 'Milestone';
  const label = rows[0]?.label ?? (p ? labelFor(p.verification, p.pendingServer ? 'pending_server' : 'provisional') : 'Measured');
  const status = rows.find((r) => r.status === 'final') ? 'final' : rows.find((r) => r.status === 'revoked') ? 'revoked' : 'provisional';
  return (
    <Screen title={title} back>
      <VerificationBadge label={label} />
      <T>{LABEL_EXPLAIN[label]}</T>
      {status === 'revoked' ? <Banner tone="warn" text="We couldn't confirm this one, so it wasn't counted. Nothing for you to do." /> : null}
      {status === 'provisional' ? <Banner tone="info" text="Provisional: final check when you're back online." /> : null}
      <Card>
        <T v="small" muted>{windowKey.startsWith('s:') ? 'ONE SESSION' : windowKey === 'life' ? 'ALL TIME' : windowKey}</T>
        <T v="h2">{p ? Math.round(p.value) : rows[0]?.value ?? 0}</T>
        {rows.map((r) => (
          <T key={r.tier}>{tierIcon(r.tier)} {r.tier} · {new Date(r.unlockedAt).toLocaleString()}</T>
        ))}
        {p?.nextTier ? <T muted>Next: {p.nextTier.tier} at {p.nextTier.gte}</T> : null}
      </Card>
    </Screen>
  );
}
