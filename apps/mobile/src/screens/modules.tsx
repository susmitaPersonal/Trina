import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { uuidv7, type ModuleDefinition, type ModuleDraftResponse, type ModuleVersionDto } from '@trina/contracts';
import { challengeFromModule, compileModuleOrThrow, taskLevel } from '@trina/engine';
import * as Location from 'expo-location';
import React, { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { ApiError, NetworkError } from '../core/api-client';
import { labelFor } from '../core/milestones';
import type { RootParams } from '../app/navigation';
import { getServices } from '../app/services';
import { VerificationBadge } from '../components/progress';
import { Banner, Btn, Card, Chip, Field, Row, Screen, StatusLine, T } from '../components/ui';

const EXAMPLES = ['kite flying with friends in the field on Sunday afternoon', 'badminton in the park after college', 'bird walk at the lake at dawn', 'frisbee with 6 friends'];

const NOTE_TEXT: Record<string, string> = {
  hard_ball_needs_guard: 'Use a guard with a hard ball',
  no_glass_coated_string: 'No glass-coated string',
  stay_off_rooftops: 'Stay off rooftops',
  away_from_power_lines: 'Keep away from power lines',
  stay_on_footpaths: 'Stay on footpaths',
  no_swimming: 'No swimming',
  keep_distance_from_animals: 'Keep your distance from animals',
  heat_take_breaks: 'Take breaks in the heat',
  daylight_only: 'Daylight only',
  respect_wildlife: 'Respect wildlife',
  no_road_racing: 'No racing on roads',
};

/** Read-only card for a module definition: what's measured, confirmed or self-reported, plus safety. */
export function ModuleCard({ def }: { def: ModuleDefinition }) {
  return (
    <Card>
      <T v="h2">{def.meta.displayName}</T>
      <T muted>{def.meta.description}</T>
      <T v="small" muted>{def.movement.replace(/_/g, ' ')} · {def.venue.replace(/_/g, ' ')} · {def.team.min}–{def.team.max} players</T>
      {def.counters.length ? <T v="small" muted>COUNTERS</T> : null}
      {def.counters.map((c) => (
        <Row key={c.id} style={{ justifyContent: 'space-between' }}>
          <T style={{ flex: 1 }}>➕ {c.label}</T>
          <VerificationBadge label={labelFor(c.verification === 'self_report' ? 'self_report' : 'peer')} />
        </Row>
      ))}
      {def.taskTypes.length ? <T v="small" muted>TASKS</T> : null}
      {def.taskTypes.map((t) => (
        <Row key={t.id} style={{ justifyContent: 'space-between' }}>
          <T style={{ flex: 1 }}>☑️ {t.displayName}</T>
          <VerificationBadge label={labelFor(taskLevel(t.completion))} />
        </Row>
      ))}
      {def.milestones.length ? <T v="small" muted>MILESTONES</T> : null}
      {def.milestones.map((m) => (
        <T key={m.id}>🏅 {m.title} <T v="small" muted>({m.window})</T></T>
      ))}
      {def.safety.notes.length ? (
        <Banner tone="warn" text={`Safety: ${def.safety.notes.map((n) => NOTE_TEXT[n] ?? n).join(' · ')}`} />
      ) : null}
      <T v="small" muted>Points and thresholds are set by Trina, never by the AI. Self-reported things earn titles, not points.</T>
    </Card>
  );
}

/**
 * AI Module Builder (design §5): one text box + chips → a structured, editable draft card.
 * Unsafe ideas are refused with a reason; non-English prompts get a friendly English-only message.
 */
export function ModuleBuilderScreen({ navigation }: NativeStackScreenProps<RootParams, 'ModuleBuilder'>) {
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<ModuleDraftResponse | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const go = async (text = prompt) => {
    if (text.trim().length < 3) return setError('Describe the activity in a few words.');
    setBusy(true);
    setError(null);
    setDraft(null);
    try {
      const s = await getServices();
      const d = await s.api.moduleDraft(text.trim());
      setDraft(d);
      setName((d.definition as ModuleDefinition | null)?.meta.displayName ?? '');
      await s.db.run(`INSERT INTO module_drafts (id, prompt, status, definition_json, risk_json, notes_json, provider, generation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        uuidv7(), text.trim(), d.status, d.definition ? JSON.stringify(d.definition) : null, JSON.stringify(d.risk), JSON.stringify(d.notes), d.provider.id, d.generationId, new Date().toISOString(),
      ]);
    } catch (e) {
      setError(e instanceof NetworkError ? 'Building a module needs the internet (playing never does). Try again when you are online.' : e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft?.definition) return;
    setBusy(true);
    try {
      const s = await getServices();
      const def = { ...(draft.definition as ModuleDefinition), meta: { ...(draft.definition as ModuleDefinition).meta, displayName: name.trim() || (draft.definition as ModuleDefinition).meta.displayName } };
      const m = await s.api.createModule(def, uuidv7(), draft.generationId);
      await s.store.saveModule({ id: m.id, version: m.version, definition: m.definition, definitionHash: m.definitionHash }, Date.now());
      navigation.replace('ModuleDetail', { id: m.id, version: m.version });
    } catch (e) {
      setError(e instanceof ApiError ? `${e.message}${(e.problem.errors ?? []).length ? `: ${(e.problem.errors ?? []).map((x) => x.message).join('; ')}` : ''}` : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const def = draft?.definition as ModuleDefinition | null;
  return (
    <Screen title="Build an activity" back>
      <T>Describe an outdoor activity Trina doesn't have yet. English for now.</T>
      <Field label="Your idea" value={prompt} onChangeText={setPrompt} placeholder="kite flying with friends in the field" multiline maxLength={500} />
      <Row>
        {EXAMPLES.map((e) => (
          <Chip key={e} label={e} onPress={() => { setPrompt(e); void go(e); }} />
        ))}
      </Row>
      <Btn title="Draft it" icon="✨" busy={busy} onPress={() => go()} />
      {error ? <Banner tone="warn" text={error} /> : null}
      {draft?.status === 'refused' ? <Banner tone="warn" text={`${draft.refusal ?? "This activity isn't safe."} Try something at ground level, in daylight.`} /> : null}
      {draft?.status === 'english_only' ? <Banner tone="info" text={draft.refusal ?? 'Please describe it in English for now.'} /> : null}
      {draft?.notes.map((n) => <Banner key={n} tone="info" text={n} />)}
      {def ? (
        <>
          {draft!.risk.level === 'private_only' ? <Banner tone="warn" text="You can play this with friends privately, but it can't be shared by link because of a safety concern." /> : null}
          <Field label="Name" value={name} onChangeText={setName} maxLength={40} />
          <ModuleCard def={def} />
          <Btn title="Save module" busy={busy} onPress={save} />
          <T v="small" muted>{draft!.usedFallback ? 'Started from a template (the AI was not available).' : `Drafted by ${draft!.provider.modelId}.`} You can edit it before sharing.</T>
        </>
      ) : null}
    </Screen>
  );
}

/** Module detail: publish (private / unlisted), play it, fork, report. */
export function ModuleDetailScreen({ route, navigation }: NativeStackScreenProps<RootParams, 'ModuleDetail'>) {
  const { id, version } = route.params;
  const [m, setM] = useState<ModuleVersionDto | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setM(await (await getServices()).api.moduleVersion(id, version));
    } catch (e) {
      setMsg(e instanceof NetworkError ? 'Module details load when you are online.' : (e as Error).message);
    }
  }, [id, version]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  if (!m) return <Screen title="Activity module" back>{msg ? <Banner tone="info" text={msg} /> : <T muted>Loading…</T>}</Screen>;
  const def = m.definition as ModuleDefinition;
  const play = () =>
    act('play', async () => {
      const s = await getServices();
      const l = await Location.getLastKnownPositionAsync().catch(() => null);
      if (!l) throw new Error('Waiting for your location: open the map once and try again.');
      const challenge = challengeFromModule(compileModuleOrThrow(def), { start: [l.coords.longitude, l.coords.latitude], durationMin: 60, difficulty: 'easy', team: false });
      const c = await s.api.createChallenge(challenge, uuidv7());
      await s.api.publish(c.id, 1);
      navigation.navigate('Details', { challengeId: c.id });
    });
  return (
    <Screen title={def.meta.displayName} back>
      <Row>
        <Chip label={m.status === 'active' ? `Published · ${m.visibility}` : m.status} selected />
        {!m.mine && m.owner ? <Chip label={`Community · by ${m.owner.displayName}`} /> : null}
        {m.forkedFrom ? <Chip label={`Fork of ${m.forkedFrom.id}`} /> : null}
      </Row>
      {msg ? <Banner tone="warn" text={msg} /> : null}
      <ModuleCard def={def} />
      {m.mine && m.status !== 'taken_down' ? (
        <>
          <Btn title="Publish privately" kind="secondary" busy={busy === 'private'} onPress={() => act('private', async () => { await (await getServices()).api.publishModule(id, version, 'private'); await load(); })} />
          <Btn
            title="Share by link (unlisted)"
            kind="secondary"
            disabled={m.risk.level === 'private_only'}
            busy={busy === 'unlisted'}
            onPress={() => act('unlisted', async () => { await (await getServices()).api.publishModule(id, version, 'unlisted'); await load(); })}
          />
          {m.risk.level === 'private_only' ? <StatusLine status="warn" label="Private only because of a safety concern" /> : null}
        </>
      ) : null}
      {m.status === 'active' ? <Btn title="Play this now" icon="▶" busy={busy === 'play'} onPress={play} /> : null}
      {!m.mine ? <Btn title="Make my own version" kind="secondary" busy={busy === 'fork'} onPress={() => act('fork', async () => { const f = await (await getServices()).api.forkModule(id, version); navigation.replace('ModuleDetail', { id: f.id, version: f.version }); })} /> : null}
      {!m.mine ? (
        <Btn
          title="Report"
          kind="ghost"
          onPress={() =>
            Alert.alert('Report this module', 'What is wrong?', [
              ...(['unsafe', 'offensive', 'impersonation', 'spam'] as const).map((r) => ({ text: r[0]!.toUpperCase() + r.slice(1), onPress: () => void act('report', async () => { await (await getServices()).api.reportModule(id, r); setMsg('Thanks. A person will look at it.'); }) })),
              { text: 'Cancel', style: 'cancel' as const },
            ])
          }
        />
      ) : null}
    </Screen>
  );
}
