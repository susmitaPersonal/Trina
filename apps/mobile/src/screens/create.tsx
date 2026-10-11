import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { uuidv7, type ChallengeDefinitionInput, type CompileIssue, type LngLat } from '@trina/contracts';
import { compile } from '@trina/engine';
import * as Location from 'expo-location';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, NetworkError } from '../core/api-client';
import { adjustDraft, draftChallenge, placeDraft, releaseDeviceModel, type DraftView } from '../app/ai-service';
import type { RootParams } from '../app/navigation';
import { getServices } from '../app/services';
import { RouteMap } from '../components/RouteMap';
import { Banner, Btn, Card, Chip, Field, Row, Screen, StatusLine, T } from '../components/ui';
import { moduleIcons } from './home';

const EXAMPLES = [
  'Create a 60-minute challenge for 5 friends involving cycling and cleaning our neighborhood',
  '90 minutes for 4 people: cycle, collect garbage and water two trees',
  'Easy 30 minute mindful walk with my mom',
  'বন্ধুদের সাথে ১ ঘন্টা হাঁটা আর গাছে জল দেওয়া',
];

type Template = { id: string; title: string; description: string; moduleIds: string[]; definition: unknown };

export function CreateScreen() {
  const nav = useNavigation<any>();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [drafts, setDrafts] = useState<{ id: string; prompt: string; created_at: string }[]>([]);
  const [modules, setModules] = useState<{ id: string; version: number; displayName: string; status: string; visibility: string }[]>([]);
  useFocusEffect(
    useCallback(() => {
      (async () => {
        const s = await getServices();
        setDrafts(await s.db.all('SELECT id, prompt, created_at FROM ai_drafts ORDER BY created_at DESC LIMIT 5'));
        try {
          setTemplates((await s.api.templates()).items);
          setModules((await s.api.modules()).filter((m) => m.mine));
        } catch {
          /* offline */
        }
      })();
    }, []),
  );
  return (
    <Screen title="Create">
      <Card onPress={() => nav.navigate('AIBuilder')} tone="ok">
        <T v="h2">✨ Describe it</T>
        <T>Say it in one sentence, in English, বাংলা or हिंदी. A local open-weight AI drafts the challenge, and you review it.</T>
      </Card>
      <Card onPress={() => nav.navigate('ModuleBuilder')}>
        <T v="h2">🧩 Build a new activity</T>
        <T>Kite flying, badminton, bird walks… Tell us about it and the AI drafts a module: tasks, counters and milestones. Trina sets the points and checks it's safe.</T>
      </Card>
      {modules.length ? <T v="big">Your activities</T> : null}
      {modules.map((m) => (
        <Card key={m.id} onPress={() => nav.navigate('ModuleDetail', { id: m.id, version: m.version })}>
          <T v="big">🧩 {m.displayName}</T>
          <T v="small" muted>{m.status === 'active' ? `Published · ${m.visibility}` : m.status}</T>
        </Card>
      ))}
      <T v="big">Or start from a template</T>
      {templates.map((t) => (
        <Card key={t.id} onPress={() => nav.navigate('Customize', { templateId: t.id })}>
          <T v="big">{moduleIcons(t.moduleIds)}  {t.title}</T>
          <T muted>{t.description}</T>
        </Card>
      ))}
      {!templates.length ? <T muted>Templates load when you're online.</T> : null}
      {drafts.length ? <T v="big">Your drafts</T> : null}
      {drafts.map((d) => (
        <Card key={d.id} onPress={() => nav.navigate('Customize', { draftId: d.id })}>
          <T numberOfLines={2}>“{d.prompt}”</T>
          <T v="small" muted>{new Date(d.created_at).toLocaleString()}</T>
        </Card>
      ))}
    </Screen>
  );
}

async function currentPoint(): Promise<LngLat | null> {
  const perm = await Location.requestForegroundPermissionsAsync();
  if (!perm.granted) return null;
  const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  return [Math.round(p.coords.longitude * 1e6) / 1e6, Math.round(p.coords.latitude * 1e6) / 1e6];
}

export function AIBuilderScreen({ navigation }: NativeStackScreenProps<RootParams, 'AIBuilder'>) {
  const [prompt, setPrompt] = useState('');
  const [start, setStart] = useState<LngLat | null>(null);
  const [draft, setDraft] = useState<DraftView | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => () => void releaseDeviceModel(), []);

  const run = async () => {
    setBusy(true);
    try {
      const st = start ?? (await currentPoint());
      if (st) setStart(st);
      setDraft(await draftChallenge(prompt, st ?? undefined));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    const s = await getServices();
    const id = uuidv7();
    await s.db.run('INSERT INTO ai_drafts (id, prompt, intent_json, definition_json, provider, model_id, generation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      id, prompt, JSON.stringify(draft.intent), draft.definition ? JSON.stringify(draft.definition) : null, draft.where, draft.modelLabel, draft.generationId ?? null, new Date().toISOString(),
    ]);
    navigation.navigate('Customize', { draftId: id });
  };

  const i = draft?.intent;
  return (
    <Screen title="✨ AI Challenge Builder" back>
      <Field label="Describe your outdoor challenge" multiline value={prompt} onChangeText={setPrompt} placeholder={EXAMPLES[0]} />
      <Row>
        {EXAMPLES.map((e) => (
          <Chip key={e} label={e.length > 34 ? `${e.slice(0, 34)}…` : e} onPress={() => setPrompt(e)} />
        ))}
      </Row>
      <Btn title={draft ? 'Try again' : 'Build my challenge'} onPress={run} busy={busy} disabled={prompt.trim().length < 3} />
      {draft && i ? (
        <>
          <Card tone={draft.where === 'rules' ? 'warn' : 'info'}>
            <T v="small">🤖 {draft.modelLabel}</T>
          </Card>
          <Card>
            <T v="h2">{i.titleHint ?? (draft.definition?.meta?.title as string | undefined) ?? 'Your challenge'}</T>
            <T v="big">{moduleIcons([...i.activities.map((a) => a.module), ...i.tasks.map((t) => t.module)])}</T>
            <T>⏱ {i.durationMin} min · 👥 {i.participants.count} ({i.participants.mode}) · 💪 {i.difficulty}</T>
            <T>📍 {i.checkpoints.count} checkpoints · {i.checkpoints.layout.replace('_', ' ')}</T>
            {i.tasks.map((t, k) => (
              <T key={k}>• {t.module.replace('_', ' ')}: {t.type.replace('_', ' ')}{t.quantity ? ` × ${t.quantity}` : ''}</T>
            ))}
            {i.mindful ? <T>• 🧘 mindful pauses</T> : null}
          </Card>
          {draft.definition ? <RouteMap def={draft.definition as never} height={240} /> : null}
          {draft.notes.map((n, k) => (
            <Banner key={k} tone="info" text={n} />
          ))}
          <Row>
            <Btn title="Easier" kind="secondary" onPress={() => setDraft(adjustDraft(draft, 'easier', start ?? undefined))} style={{ flex: 1 }} />
            <Btn title="Harder" kind="secondary" onPress={() => setDraft(adjustDraft(draft, 'harder', start ?? undefined))} style={{ flex: 1 }} />
          </Row>
          {!start ? (
            <Btn
              title="Use my location as the start"
              kind="secondary"
              icon="📍"
              onPress={async () => {
                const st = await currentPoint();
                if (st) {
                  setStart(st);
                  setDraft(placeDraft(draft, st));
                }
              }}
            />
          ) : null}
          <T v="small" muted>Pick a PUBLIC start point (park gate, school ground), never a home address. AI never chooses coordinates; you do.</T>
          <Btn title="Use this draft" onPress={save} disabled={!draft.definition} />
        </>
      ) : null}
    </Screen>
  );
}

function moveStart(def: ChallengeDefinitionInput, to: LngLat): ChallengeDefinitionInput {
  const d = JSON.parse(JSON.stringify(def)) as any;
  d.area.startZone.center = to;
  if (d.area.endZone) d.area.endZone.center = to;
  if (d.area.boundary?.type === 'circle') d.area.boundary.center = to;
  return d;
}

export function CustomizeScreen({ route, navigation }: NativeStackScreenProps<RootParams, 'Customize'>) {
  const [def, setDef] = useState<ChallengeDefinitionInput | null>(null);
  const [genId, setGenId] = useState<string | undefined>();
  const [editing, setEditing] = useState<'start' | string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const s = await getServices();
      if (route.params.draftId) {
        const r = await s.db.get<{ definition_json: string | null; generation_id: string | null }>('SELECT definition_json, generation_id FROM ai_drafts WHERE id = ?', [route.params.draftId]);
        if (r?.definition_json) setDef(JSON.parse(r.definition_json));
        setGenId(r?.generation_id ?? undefined);
      } else if (route.params.templateId) {
        const t = (await s.api.templates()).items.find((x) => x.id === route.params.templateId);
        if (t) {
          let d = t.definition as ChallengeDefinitionInput;
          const here = await currentPoint();
          if (here) d = shiftTo(d, here);
          setDef(d);
        }
      }
    })();
  }, [route.params]);

  const result = useMemo(() => (def ? compile(def) : null), [def]);
  const issues: CompileIssue[] = result?.issues ?? [];
  if (!def) return <Screen title="Customize" back><T muted>Loading…</T></Screen>;

  const update = (fn: (d: any) => void) => {
    const d = JSON.parse(JSON.stringify(def));
    fn(d);
    setDef(d);
  };

  const publish = async () => {
    if (!result?.ok) return;
    setBusy(true);
    setMsg(null);
    try {
      const s = await getServices();
      const created = await s.api.createChallenge(def, uuidv7(), genId);
      await s.api.publish(created.id, created.version);
      navigation.replace('Details', { challengeId: created.id });
    } catch (e) {
      setMsg(e instanceof NetworkError ? 'Publishing needs internet. Your draft is saved on this phone.' : e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Customize" back>
      <Field label="Title" value={def.meta.title} onChangeText={(v) => update((d) => (d.meta.title = v))} />
      <Field label="Duration (minutes)" keyboardType="number-pad" value={String(def.timing.durationMin)} onChangeText={(v) => update((d) => (d.timing.durationMin = Math.max(5, Math.min(480, Number(v) || 5))))} />
      <Row>
        {(['public', 'unlisted', 'private'] as const).map((v) => (
          <Chip key={v} label={v} selected={(def.meta.visibility ?? 'public') === v} onPress={() => update((d) => (d.meta.visibility = v))} />
        ))}
      </Row>
      <T v="big">Map: tap to place</T>
      <Row>
        <Chip label="📍 Move start" selected={editing === 'start'} onPress={() => setEditing(editing === 'start' ? null : 'start')} />
        {(def.checkpoints ?? []).map((c) => (
          <Chip key={c.id} label={`Move ${c.name}`} selected={editing === c.id} onPress={() => setEditing(editing === c.id ? null : c.id)} />
        ))}
      </Row>
      <RouteMap
        def={def as never}
        editable={!!editing}
        onPressPoint={(p) => {
          if (editing === 'start') setDef(moveStart(def, p));
          else if (editing) update((d) => (d.checkpoints.find((c: any) => c.id === editing).geometry.center = p));
        }}
      />
      <T v="big">Tasks</T>
      {(def.tasks ?? []).map((t) => (
        <Card key={t.id}>
          <T>{t.title ?? t.type}</T>
          <T v="small" muted>{t.location?.kind === 'checkpoint' ? `at ${def.checkpoints?.find((c) => c.id === t.location?.ref)?.name}` : 'anywhere in the area'} · {t.evidence?.length ? '📷 photo' : 'self-report'}</T>
          <Btn
            title="Remove"
            kind="ghost"
            onPress={() =>
              update((d) => {
                d.tasks = d.tasks.filter((x: any) => x.id !== t.id);
                d.scoring.rules = d.scoring.rules.filter((r: any) => r.task !== t.id);
              })
            }
          />
        </Card>
      ))}
      <Card>
        <T v="big">Validator</T>
        {issues.length === 0 ? <StatusLine status="pass" label="Looks good" detail={result?.ok ? `Max score ${result.maxScore}` : undefined} /> : null}
        {issues.map((i, k) => (
          <StatusLine key={k} status={i.severity === 'error' ? 'fail' : 'warn'} label={i.message} detail={i.path} />
        ))}
      </Card>
      {msg ? <Banner tone="warn" text={msg} /> : null}
      <Btn title="Publish" onPress={publish} busy={busy} disabled={!result?.ok} />
    </Screen>
  );
}

/** Translates a template's geometry so its start sits at `to` (keeps shape and distances). */
function shiftTo(def: ChallengeDefinitionInput, to: LngLat): ChallengeDefinitionInput {
  const d = JSON.parse(JSON.stringify(def)) as any;
  const [ox, oy] = d.area.startZone.center;
  const dx = to[0] - ox;
  const dy = to[1] - oy;
  const mv = (p: LngLat): LngLat => [Math.round((p[0] + dx) * 1e6) / 1e6, Math.round((p[1] + dy) * 1e6) / 1e6];
  d.area.startZone.center = mv(d.area.startZone.center);
  if (d.area.endZone) d.area.endZone.center = mv(d.area.endZone.center);
  if (d.area.boundary?.type === 'circle') d.area.boundary.center = mv(d.area.boundary.center);
  if (d.area.boundary?.type === 'polygon') d.area.boundary.coordinates = [d.area.boundary.coordinates[0].map(mv)];
  for (const c of d.checkpoints ?? []) c.geometry.center = mv(c.geometry.center);
  return d;
}
