import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { SessionDto } from '@trina/contracts';
import React, { useCallback, useState } from 'react';
import { relativeTime } from '../core/sync-status';
import type { LiveSnapshot } from '../core/session-manager';
import { json } from '../core/sql';
import { recapFor } from '../app/ai-service';
import type { RootParams } from '../app/navigation';
import { getServices } from '../app/services';
import { refreshSyncState, syncNow, useApp } from '../app/store';
import { getWeightKg } from '../platform/secure';
import { RouteMap } from '../components/RouteMap';
import { Banner, Btn, Card, fmtKm, Row, Screen, Stat, StatusLine, T } from '../components/ui';
import { breakdownLines } from './activity';
import { verdictLabel } from './home';

export function ResultsScreen({ route, navigation }: NativeStackScreenProps<RootParams, 'Results'>) {
  const { sessionId } = route.params;
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const [server, setServer] = useState<SessionDto | null>(null);
  const [recap, setRecap] = useState<string | null>(null);
  const [local, setLocal] = useState<{ verdict: string | null; final: any }>({ verdict: null, final: null });

  useFocusEffect(
    useCallback(() => {
      (async () => {
        const s = await getServices();
        const sm = await s.sessions();
        const sn = await sm.snapshot(sessionId, { weightKg: await getWeightKg() });
        setSnap(sn);
        const row = await s.db.get<{ verdict: string | null; final_score_json: string | null }>('SELECT verdict, final_score_json FROM sessions WHERE id = ?', [sessionId]);
        setLocal({ verdict: row?.verdict ?? null, final: json(row?.final_score_json ?? null, null) });
        await syncNow();
        try {
          const dto = await s.api.session(sessionId);
          setServer(dto);
          if (dto.score) {
            setRecap(
              await recapFor(sessionId, {
                title: dto.challengeTitle,
                points: dto.score.totalPoints,
                distanceKm: Math.round(dto.score.distanceM / 100) / 10,
                minutes: Math.round(dto.score.durationS / 60),
                ...(dto.wellness ?? {}),
              }),
            );
          }
        } catch {
          /* offline: local view */
        }
      })();
    }, [sessionId]),
  );

  if (!snap) return <Screen title="Results" back><T muted>Loading…</T></Screen>;
  const verdict = server?.verdict ?? local.verdict;
  const final = server?.score ?? (local.final ? { totalPoints: local.final.totalPoints, breakdown: local.final.breakdown } : null);
  const breakdown = (final?.breakdown as never) ?? snap.score.breakdown;
  const w = server?.wellness ?? snap.wellness;
  const flags = server?.flags ?? (local.final?.flags as SessionDto['flags'] | undefined) ?? [];
  const reached = Object.fromEntries(Object.entries(snap.state.checkpoints).map(([k, v]) => [k, v.reached]));

  return (
    <Screen title={snap.challenge.title} back>
      <Card tone={verdict === 'verified' || verdict === 'verified_with_notes' ? 'ok' : verdict === 'needs_review' ? 'warn' : 'info'}>
        <T v="h1" center>{final ? final.totalPoints : snap.score.total} pts</T>
        <T center>{final ? verdictLabel(verdict) : '⏳ Provisional: will verify when synced'}</T>
      </Card>
      {flags.length ? (
        <Card>
          <T v="big">Notes from verification</T>
          {flags.map((f, i) => (
            <StatusLine key={i} status={f.severity === 'critical' ? 'fail' : f.severity === 'warn' ? 'warn' : 'pass'} label={f.message} />
          ))}
          <T v="small" muted>Verified by automated checks; anything unusual goes to a person, not a ban.</T>
        </Card>
      ) : null}
      {recap ? <Banner tone="ok" text={`🌱 ${recap}`} /> : null}
      <Card>
        <T v="big">Score breakdown</T>
        {breakdownLines(breakdown).map((l, i) => (
          <T key={i}>{l}</T>
        ))}
      </Card>
      <Card>
        <T v="small" muted>WELLNESS (estimates, not medical advice)</T>
        <Row>
          <Stat label="steps" value={w.steps !== null && w.steps !== undefined ? String(w.steps) : '–'} />
          <Stat label="kcal (est.)" value={w.kcalEstimate ? `~${w.kcalEstimate}` : '–'} />
          <Stat label="active min" value={String(w.activeMinutes)} />
          <Stat label="phone-free min" value={String(w.phoneFreeMinutes)} />
        </Row>
        {w.moodBefore && w.moodAfter ? <T>Mood: {['😞', '🙁', '😐', '🙂', '😄'][w.moodBefore - 1]} → {['😞', '🙁', '😐', '🙂', '😄'][w.moodAfter - 1]}</T> : null}
      </Card>
      <RouteMap def={snap.compiled.definition} reached={reached} track={snap.state.track.map((p) => [p.lng, p.lat])} height={260} />
      <T muted>Distance {fmtKm(snap.state.distanceM)}</T>
      <Btn title="Leaderboard" icon="🏆" onPress={() => navigation.navigate('Leaderboard', { challengeId: snap.challenge.id, title: snap.challenge.title })} />
      <Btn
        title="Delete my route from the server"
        kind="ghost"
        onPress={async () => {
          const s = await getServices();
          await s.api.request('DELETE', `/v1/sessions/${sessionId}/track`).catch(() => s.sync.enqueue('delete_track', 'DELETE', `/v1/sessions/${sessionId}/track`));
        }}
      />
    </Screen>
  );
}

export function HistoryScreen() {
  const nav = useNavigation<any>();
  const [items, setItems] = useState<Awaited<ReturnType<Awaited<ReturnType<Awaited<ReturnType<typeof getServices>>['sessions']>>['history']>>>([]);
  useFocusEffect(
    useCallback(() => {
      void getServices().then(async (s) => setItems(await (await s.sessions()).history()));
    }, []),
  );
  return (
    <Screen title="Challenge history" back>
      {items.map((h) => (
        <Card key={h.id} onPress={() => nav.navigate(h.status === 'active' ? 'Live' : 'Results', { sessionId: h.id })}>
          <T v="big">{h.title}</T>
          <T muted>{new Date(h.startedAt).toLocaleString()}</T>
          <T>
            {h.status === 'active' ? '▶ In progress' : h.final !== null ? `${h.final} pts · ${verdictLabel(h.verdict)}` : h.provisional !== null ? `${h.provisional} pts · ${verdictLabel(null)}` : h.status}
            {h.pending ? ` · ⬆️ ${h.pending} to sync` : ''}
          </T>
        </Card>
      ))}
      {!items.length ? <T muted center>No challenges yet. Go touch some grass 🌱</T> : null}
    </Screen>
  );
}

export function SyncStatusScreen() {
  const st = useApp();
  const [failed, setFailed] = useState<{ kind: string; detail: string }[]>([]);
  const [wifiOnly, setWifiOnly] = useState(false);
  const load = useCallback(async () => {
    const s = await getServices();
    await refreshSyncState();
    setWifiOnly(!s.photosOnCellular.value);
    const ev = await s.db.all<{ type: string; last_error: string }>(`SELECT type, last_error FROM events WHERE sync_state = 'rejected' LIMIT 20`);
    const ph = await s.db.all<{ task_id: string; last_error: string }>(`SELECT task_id, last_error FROM evidence WHERE upload_state = 'failed' LIMIT 20`);
    const ob = await s.db.all<{ kind: string; last_error: string }>(`SELECT kind, last_error FROM outbox WHERE state = 'rejected' LIMIT 20`);
    setFailed([
      ...ev.map((e) => ({ kind: `Activity (${e.type})`, detail: e.last_error })),
      ...ph.map((p) => ({ kind: `Photo (${p.task_id})`, detail: p.last_error })),
      ...ob.map((o) => ({ kind: o.kind, detail: o.last_error })),
    ]);
  }, []);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  return (
    <Screen title="Sync status" back>
      <T muted>Last synced {relativeTime(st.lastSyncAt, Date.now())}</T>
      <Card>
        <StatusLine status={st.counts.pendingEvents ? 'warn' : 'pass'} label="Activity data" detail={st.counts.pendingEvents ? `${st.counts.pendingEvents} waiting` : 'All sent'} />
        <StatusLine status={st.counts.pendingPhotos ? 'warn' : 'pass'} label="Photos" detail={st.counts.pendingPhotos ? `${st.counts.pendingPhotos} waiting${st.counts.waitingForWifi ? ' for Wi-Fi' : ''}` : 'All uploaded'} />
        <StatusLine status={st.counts.pendingOutbox ? 'warn' : 'pass'} label="Other changes" detail={st.counts.pendingOutbox ? `${st.counts.pendingOutbox} waiting` : 'All sent'} />
        <StatusLine status={st.awaitingVerdict ? 'pending' : 'pass'} label="Results" detail={st.awaitingVerdict ? `${st.awaitingVerdict} being verified` : 'Up to date'} />
      </Card>
      {failed.length ? (
        <Card tone="warn">
          <T v="big">Couldn't sync</T>
          {failed.map((f, i) => (
            <StatusLine key={i} status="fail" label={f.kind} detail={f.detail} />
          ))}
          <Btn
            title="Retry failed items"
            kind="secondary"
            onPress={async () => {
              await (await getServices()).sync.retryFailed();
              await syncNow();
              await load();
            }}
          />
        </Card>
      ) : null}
      <Btn title="Sync now" icon="🔄" busy={st.syncing} onPress={async () => { await syncNow(); await load(); }} />
      <Btn
        title={wifiOnly ? '☑ Upload photos on Wi-Fi only' : '☐ Upload photos on Wi-Fi only'}
        kind="secondary"
        onPress={async () => {
          const s = await getServices();
          s.photosOnCellular.value = wifiOnly;
          await s.store.setMeta('photos_on_cellular', wifiOnly ? '1' : '0');
          setWifiOnly(!wifiOnly);
          await refreshSyncState();
        }}
      />
      <Btn
        title="Copy diagnostics"
        kind="ghost"
        onPress={async () => {
          const s = await getServices();
          const log = await s.db.all('SELECT * FROM sync_log ORDER BY id DESC LIMIT 5');
          const { Share } = await import('react-native');
          await Share.share({ message: JSON.stringify({ deviceId: s.deviceId, counts: st.counts, log }, null, 2) });
        }}
      />
    </Screen>
  );
}
