import { PartySpec } from '@trina/contracts';
import { evaluatePartyGoal, partyProgress, type SessionSummary } from '@trina/engine';
import { Router } from 'express';
import { currentUser, requireAuth } from '../../platform/auth';
import type { AppContext } from '../../platform/context';
import { notFound } from '../../platform/errors';
import { uuidParam } from '../../platform/http';

/**
 * Offline parties (ADR-033). Parties are created by sync; this only reads one. Members only (anyone
 * else gets 404, so party ids reveal nothing). The goal counts VERIFIED sessions only; phones show
 * their own provisional view from gossip until then. No locations are returned.
 */
export function partiesRouter(ctx: AppContext): Router {
  const r = Router();
  r.use('/parties', requireAuth(ctx));

  r.get('/parties/:id', async (req, res) => {
    const me = currentUser(req);
    const id = uuidParam(req, 'id');
    const party = await ctx.db.one<{ id: string; spec: unknown; host_user_id: string }>('SELECT id, spec, host_user_id FROM parties WHERE id = $1', [id]);
    const mine = party && (await ctx.db.one('SELECT 1 FROM party_members WHERE party_id = $1 AND user_id = $2', [id, me.id]));
    if (!party || !mine) throw notFound('Party');
    const spec = PartySpec.parse(party.spec);
    const rows = await ctx.db.query<{ session_id: string; user_id: string; role: string; display_name: string; verdict: string | null; summary: SessionSummary | null; verified: boolean | null }>(
      `SELECT pm.session_id, pm.user_id, pm.role, u.display_name, sc.verdict, ss.summary, ss.verified
       FROM party_members pm JOIN users u ON u.id = pm.user_id
       LEFT JOIN scores sc ON sc.session_id = pm.session_id
       LEFT JOIN session_summaries ss ON ss.session_id = pm.session_id
       WHERE pm.party_id = $1 ORDER BY pm.role DESC, u.display_name`,
      [id],
    );
    const members = rows.map((m) => {
      const verified = m.verified === true && !!m.summary;
      const progress = verified ? partyProgress(spec, m.summary!.facts) : null;
      return { userId: m.user_id, displayName: m.display_name, role: m.role, verdict: m.verdict ?? 'pending', verified, goalValue: progress?.goalValue ?? null, done: progress?.done ?? false };
    });
    const counted = members.filter((m) => m.verified).map((m) => ({ userId: m.userId, name: m.displayName, goalValue: m.goalValue ?? 0, done: m.done }));
    const goal = evaluatePartyGoal(spec, counted);
    res.json({ partyId: party.id, spec, hostUserId: party.host_user_id, members, goal: { ...goal, perMember: undefined, pending: members.length - counted.length } });
  });

  return r;
}
