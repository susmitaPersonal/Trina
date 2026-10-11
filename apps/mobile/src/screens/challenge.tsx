import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { ChallengeDefinition, ChallengeDetail, LeaderboardDto } from '@trina/contracts';
import { compileOrThrow, renderRules } from '@trina/engine';
import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { ApiError, NetworkError } from '../core/api-client';
import type { RootParams } from '../app/navigation';
import { getServices } from '../app/services';
import { refreshSyncState, syncNow, useApp } from '../app/store';
import { RouteMap } from '../components/RouteMap';
import { Banner, Btn, Card, Chip, Field, Row, Screen, T } from '../components/ui';
import { space } from '../components/theme';
import { moduleIcons } from './home';

type Loaded = { def: ChallengeDefinition; detail: ChallengeDetail | null; downloadedVersion: number | null; offline: boolean };

async function loadChallenge(id: string): Promise<Loaded | null> {
  const s = await getServices();
  const local = await s.store.getChallenge(id);
  try {
    const detail = await s.api.getChallenge(id);
    return { def: detail.definition, detail, downloadedVersion: local?.version ?? null, offline: false };
  } catch (e) {
    if (local) return { def: local.bundle.definition, detail: null, downloadedVersion: local.version, offline: true };
    throw e;
  }
}

export async function downloadBundle(challengeId: string, version: number) {
  const s = await getServices();
  const bundle = await s.api.bundle(challengeId, version);
  return s.store.saveBundle(bundle, Date.now());
}

export function DetailsScreen({ route, navigation }: NativeStackScreenProps<RootParams, 'Details'>) {
  const { challengeId } = route.params;
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [explain, setExplain] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await loadChallenge(challengeId));
    } catch (e) {
      setError(e instanceof NetworkError ? "You're offline and this challenge isn't downloaded yet." : (e as Error).message);
    }
  }, [challengeId]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!data) return <Screen title="Challenge" back>{error ? <Banner tone="offline" text={error} /> : <T muted>Loading…</T>}</Screen>;
  const { def, detail } = data;
  const compiled = compileOrThrow(def);
  const rules = renderRules(compiled);
  const joined = detail?.myParticipation?.status === 'joined' || (data.offline && data.downloadedVersion !== null);
  const version = detail?.myParticipation?.joinedVersion ?? data.downloadedVersion ?? detail?.challenge.currentVersion ?? 1;
  const needsUpdate = !!detail && data.downloadedVersion !== null && detail.challenge.currentVersion > data.downloadedVersion && detail.challenge.status === 'published';

  const download = async (v = version) => {
    setBusy(true);
    try {
      await downloadBundle(challengeId, v);
      await load();
    } catch (e) {
      setError(e instanceof NetworkError ? 'Download needs internet.' : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const askAi = async () => {
    try {
      const s = await getServices();
      setExplain((await s.api.aiExplain(challengeId, 'Explain the rules simply')).text);
    } catch {
      setExplain(rules.join(' '));
    }
  };

  return (
    <Screen title={def.meta.title} back>
      {data.offline ? <Banner tone="offline" text="Offline: showing the downloaded copy." /> : null}
      <T v="big">{moduleIcons(def.modules.map((m) => m.id))}</T>
      <Row>
        <Chip label={`⏱ ${def.timing.durationMin} min`} />
        <Chip label={`💪 ${def.meta.difficulty}`} />
        <Chip label={`🏁 ${compiled.maxScore} pts max`} />
        <Chip label={def.mode === 'team' ? '👥 Teams' : '🙂 Solo'} />
      </Row>
      {def.meta.description ? <T>{def.meta.description}</T> : null}
      <RouteMap def={def} />
      <Card>
        <T v="big">Rules</T>
        {rules.map((r, i) => (
          <T key={i}>• {r}</T>
        ))}
        <Btn title="Explain simply (AI)" kind="ghost" icon="💬" onPress={askAi} />
        {explain ? <Card tone="info"><T>{explain}</T><T v="small" muted>The official rules above always win.</T></Card> : null}
      </Card>
      {detail ? (
        <T muted>
          {detail.challenge.participants}/{detail.challenge.maxParticipants} joined · by {detail.challenge.creatorName}
          {detail.teams.length ? ` · ${detail.teams.length} teams` : ''}
        </T>
      ) : null}
      {error ? <Banner tone="warn" text={error} /> : null}
      {needsUpdate ? <Banner tone="info" text="The organiser updated this challenge. Download the new version before you start." /> : null}
      {!joined ? (
        <Btn title="Join challenge" onPress={() => navigation.navigate('Join', { challengeId })} disabled={detail?.challenge.status !== 'published'} />
      ) : data.downloadedVersion === null || needsUpdate ? (
        <Btn title="Download for offline" icon="⬇️" busy={busy} onPress={() => download(needsUpdate ? detail!.challenge.currentVersion : version)} />
      ) : (
        <>
          <Banner tone="ok" text="✅ Ready offline. You can start without internet." />
          <Btn title="Prepare to start" onPress={() => navigation.navigate('Preflight', { challengeId, version: data.downloadedVersion! })} />
        </>
      )}
      <Btn title="Leaderboard" kind="secondary" icon="🏆" onPress={() => navigation.navigate('Leaderboard', { challengeId, title: def.meta.title })} />
      {detail?.isCreator && detail.challenge.status === 'draft' ? (
        <Btn
          title="Publish"
          kind="secondary"
          onPress={async () => {
            const s = await getServices();
            await s.api.publish(challengeId, detail.challenge.currentVersion);
            await load();
          }}
        />
      ) : null}
    </Screen>
  );
}

export function JoinScreen({ route, navigation }: NativeStackScreenProps<RootParams, 'Join'>) {
  const { challengeId } = route.params;
  const [detail, setDetail] = useState<ChallengeDetail | null>(null);
  const [team, setTeam] = useState<string | null>(null);
  const [newTeam, setNewTeam] = useState('');
  const [ackRules, setAckRules] = useState(false);
  const [ackSafety, setAckSafety] = useState(false);
  const [autoDownload, setAutoDownload] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      void getServices().then((s) => s.api.getChallenge(challengeId).then(setDetail).catch(() => setMsg('Joining needs internet, or we can queue it for later.')));
    }, [challengeId]),
  );
  const teamMode = detail?.definition.mode === 'team';

  const join = async () => {
    setBusy(true);
    setMsg(null);
    const s = await getServices();
    const body = teamMode ? (team ? { teamId: team } : { newTeamName: newTeam.trim() || undefined }) : {};
    try {
      const r = await s.api.join(challengeId, body);
      if (autoDownload) await downloadBundle(challengeId, r.joinedVersion);
      navigation.goBack();
    } catch (e) {
      if (e instanceof NetworkError) {
        await s.sync.enqueue('join', 'POST', `/v1/challenges/${challengeId}/join`, body);
        await refreshSyncState();
        setMsg("You're offline. We'll join for you as soon as you're back online.");
      } else if (e instanceof ApiError) {
        setMsg(e.code === 'CHALLENGE_FULL' ? 'This challenge (or team) is full.' : e.code === 'WINDOW_CLOSED' ? 'This challenge has closed.' : e.message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Join challenge" pill={false} back>
      <T v="big">{detail?.definition.meta.title ?? ''}</T>
      {teamMode ? (
        <Card>
          <T v="big">Choose a team</T>
          <Row>
            {detail!.teams.map((t) => (
              <Chip key={t.id} label={`${t.name} (${t.members})`} selected={team === t.id} onPress={() => setTeam(team === t.id ? null : t.id)} />
            ))}
          </Row>
          {!team ? <Field label="…or create a new team" value={newTeam} onChangeText={setNewTeam} placeholder="Green Pedallers" /> : null}
        </Card>
      ) : null}
      <Btn kind="secondary" title={`${ackRules ? '☑' : '☐'} I've read the rules`} onPress={() => setAckRules(!ackRules)} />
      <Btn kind="secondary" title={`${ackSafety ? '☑' : '☐'} I'll stay safe: no phone while moving on roads`} onPress={() => setAckSafety(!ackSafety)} />
      <Btn kind="secondary" title={`${autoDownload ? '☑' : '☐'} Download for offline now`} onPress={() => setAutoDownload(!autoDownload)} />
      {msg ? <Banner tone="info" text={msg} /> : null}
      <Btn title="Join" onPress={join} busy={busy} disabled={!ackRules || !ackSafety} />
    </Screen>
  );
}

export function LeaderboardScreen({ route }: NativeStackScreenProps<RootParams, 'Leaderboard'>) {
  const { challengeId, title } = route.params;
  const me = useApp((s) => s.me);
  const [scope, setScope] = useState<'individual' | 'team'>('individual');
  const [data, setData] = useState<{ lb: LeaderboardDto; cachedAt?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const s = await getServices();
    try {
      void syncNow();
      const lb = await s.api.leaderboard(challengeId, scope);
      await s.store.cacheLeaderboard(challengeId, scope, lb);
      setData({ lb });
      setError(null);
    } catch {
      const cached = await s.store.cachedLeaderboard<LeaderboardDto>(challengeId, scope);
      if (cached) setData({ lb: cached.data, cachedAt: cached.fetchedAt });
      setError('Offline: showing the last saved leaderboard.');
    }
  }, [challengeId, scope]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <Screen title={`🏆 ${title ?? 'Leaderboard'}`} back>
      <Row>
        <Chip label="Individual" selected={scope === 'individual'} onPress={() => setScope('individual')} />
        <Chip label="Teams" selected={scope === 'team'} onPress={() => setScope('team')} />
      </Row>
      {error ? <Banner tone="offline" text={`${error}${data?.cachedAt ? ` (${new Date(data.cachedAt).toLocaleString()})` : ''}`} /> : null}
      {data?.lb.entries.map((e) => (
        <Card key={e.subjectId} tone={e.subjectId === me?.userId ? 'ok' : undefined}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.m }}>
            <T v="h2">{e.rank === 1 ? '🥇' : e.rank === 2 ? '🥈' : e.rank === 3 ? '🥉' : `#${e.rank}`}</T>
            <View style={{ flex: 1 }}>
              <T v="big">{e.name}</T>
              <T v="small" muted>{e.verification === 'verified' ? '✅ Verified by automated checks' : '✅ Verified with notes'}{e.timeS ? ` · ${Math.round(e.timeS / 60)} min` : ''}</T>
            </View>
            <T v="h2">{e.points}</T>
          </View>
        </Card>
      ))}
      {data && !data.lb.entries.length ? <T muted center>No verified results yet. Be the first! 🌱</T> : null}
      {data?.lb.pending ? <T muted>🔍 {data.lb.pending} result{data.lb.pending === 1 ? '' : 's'} pending review</T> : null}
    </Screen>
  );
}
