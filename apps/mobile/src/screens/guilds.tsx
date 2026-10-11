import { useFocusEffect } from '@react-navigation/native';
import type { GuildBoardDto } from '@trina/contracts';
import React, { useCallback, useState } from 'react';
import { NetworkError } from '../core/api-client';
import { getServices } from '../app/services';
import { ProgressBar } from '../components/progress';
import { Banner, Btn, Card, Field, Row, Screen, T } from '../components/ui';

type MyGuild = { id: string; name: string; icon: string; role: string; members: number };

/** Guilds (ADR-031, demo cut): my guilds, create, join by code, weekly board + Guild Quest. Cached offline. */
export function GuildsScreen() {
  const [guilds, setGuilds] = useState<MyGuild[]>([]);
  const [boards, setBoards] = useState<Record<string, GuildBoardDto>>({});
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [invite, setInvite] = useState<{ id: string; code: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);

  const load = useCallback(async () => {
    const s = await getServices();
    try {
      const mine = (await s.api.myGuilds()).items;
      setGuilds(mine);
      const b: Record<string, GuildBoardDto> = {};
      for (const g of mine) {
        b[g.id] = await s.api.guildBoard(g.id);
        await s.db.run(`INSERT INTO cache_guilds (id, json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`, [g.id, JSON.stringify({ guild: g, board: b[g.id] }), new Date().toISOString()]);
      }
      setBoards(b);
      setOffline(false);
    } catch (e) {
      if (!(e instanceof NetworkError)) return setMsg((e as Error).message);
      setOffline(true);
      const rows = await s.db.all<{ json: string }>('SELECT json FROM cache_guilds');
      const cached = rows.map((r) => JSON.parse(r.json) as { guild: MyGuild; board: GuildBoardDto });
      setGuilds(cached.map((c) => c.guild));
      setBoards(Object.fromEntries(cached.map((c) => [c.guild.id, c.board])));
    }
  }, []);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const run = async (fn: () => Promise<void>) => {
    setMsg(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <Screen title="Guilds" back>
      {offline ? <Banner tone="offline" text="Offline: showing your last saved boards." /> : null}
      {msg ? <Banner tone="warn" text={msg} /> : null}
      {guilds.map((g) => {
        const b = boards[g.id];
        return (
          <Card key={g.id}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T v="h2">{g.name}</T>
              <T muted>{g.members} members · {g.role}</T>
            </Row>
            {b ? (
              <>
                <T v="small" muted>GUILD QUEST · {b.weekKey}</T>
                <T>{b.guildQuest.title}</T>
                <ProgressBar value={b.guildQuest.value} max={b.guildQuest.target} label="Guild Quest progress" />
                <T v="small" muted>{b.guildQuest.value} / {b.guildQuest.target} offline minutes</T>
                <T v="small" muted>THIS WEEK</T>
                {b.entries.map((e, i) => (
                  <Row key={e.userId} style={{ justifyContent: 'space-between' }}>
                    <T>{i + 1}. {e.displayName}</T>
                    <T muted>{e.xp} XP · {e.offlineMinutes} offline min</T>
                  </Row>
                ))}
              </>
            ) : null}
            {g.role !== 'member' && !offline ? (
              <Btn title={invite?.id === g.id ? `Invite code: ${invite.code}` : 'Invite friends'} kind="secondary" onPress={() => run(async () => { const r = await (await getServices()).api.guildInvite(g.id); setInvite({ id: g.id, code: r.code }); })} />
            ) : null}
          </Card>
        );
      })}
      {!guilds.length ? <T muted>Play together: make a guild for your friends, club or class.</T> : null}
      <Card>
        <Field label="Join with a code" value={code} onChangeText={(v) => setCode(v.toUpperCase())} autoCapitalize="characters" maxLength={8} placeholder="ABCD2345" />
        <Btn title="Join" kind="secondary" disabled={code.length !== 8 || offline} onPress={() => run(async () => { await (await getServices()).api.joinGuild(code); setCode(''); })} />
      </Card>
      <Card>
        <Field label="New guild name" value={name} onChangeText={setName} maxLength={40} placeholder="Lake Walkers" />
        <Btn title="Create guild" disabled={name.trim().length < 3 || offline} onPress={() => run(async () => { await (await getServices()).api.createGuild(name.trim()); setName(''); })} />
      </Card>
    </Screen>
  );
}
