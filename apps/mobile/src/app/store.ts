import NetInfo from '@react-native-community/netinfo';
import { create } from 'zustand';
import { syncPill, type SyncPill } from '../core/sync-status';
import type { SyncCounts, SyncReport } from '../core/sync-worker';
import { announceMilestones } from './milestone-notify';
import { onQuestConnectivity, toConnectivity } from './quest-runtime';
import { getServices, type Me } from './services';

type AppState = {
  ready: boolean;
  me: Me | null;
  online: boolean;
  syncing: boolean;
  counts: SyncCounts;
  lastReport: SyncReport | null;
  lastSyncAt: string | null;
  awaitingVerdict: number;
  activeSessionId: string | null;
  pill: SyncPill;
  set(p: Partial<AppState>): void;
};

const emptyCounts: SyncCounts = { pendingEvents: 0, pendingPhotos: 0, pendingOutbox: 0, failed: 0, waitingForWifi: 0 };

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  me: null,
  online: true,
  syncing: false,
  counts: emptyCounts,
  lastReport: null,
  lastSyncAt: null,
  awaitingVerdict: 0,
  activeSessionId: null,
  pill: syncPill({ online: true, syncing: false, counts: emptyCounts, lastReport: null, awaitingVerdict: 0 }),
  set: (p) => {
    set(p);
    const s = get();
    set({ pill: syncPill({ online: s.online, syncing: s.syncing, counts: s.counts, lastReport: s.lastReport, awaitingVerdict: s.awaitingVerdict }) });
  },
}));

export async function refreshSyncState() {
  const s = await getServices();
  const counts = await s.sync.counts();
  const awaiting = await s.db.get<{ n: number }>(`SELECT count(*) AS n FROM sessions WHERE status IN ('completed','abandoned') AND verdict IS NULL`);
  useApp.getState().set({ counts, awaitingVerdict: Number(awaiting?.n ?? 0), lastSyncAt: await s.store.getMeta('last_sync_at') });
}

let syncTimer: ReturnType<typeof setInterval> | null = null;

/** Runs a sync now (single-flight inside SyncWorker) and refreshes the pill. */
export async function syncNow(): Promise<SyncReport | null> {
  const s = await getServices();
  if (!(await s.me())) return null;
  if (s.quest.active) return null; // QuestGuard: quest data syncs AFTER the quest (design §5A.3)
  useApp.getState().set({ syncing: true });
  try {
    const report = await s.sync.runOnce();
    if (report.outcome === 'offline') useApp.getState().set({ online: false });
    useApp.getState().set({ lastReport: report });
    if (report.pulled > 0) await announceMilestones(await s.milestones(), { haptic: false }).catch(() => undefined);
    return report;
  } finally {
    useApp.getState().set({ syncing: false });
    await refreshSyncState();
  }
}

/** Connectivity + periodic sync (every 60 s while pending, on reconnect, on foreground). */
export async function startConnectivity() {
  const s = await getServices();
  NetInfo.addEventListener((state) => {
    const online = state.isConnected !== false && state.isInternetReachable !== false;
    const was = useApp.getState().online;
    s.network.online = online;
    s.network.wifi = state.type === 'wifi' || state.type === 'ethernet';
    useApp.getState().set({ online });
    void onQuestConnectivity(toConnectivity(state)).catch(() => undefined);
    if (online && !was) void syncNow();
  });
  syncTimer ??= setInterval(async () => {
    const st = useApp.getState();
    const pending = st.counts.pendingEvents + st.counts.pendingPhotos + st.counts.pendingOutbox;
    if (st.online && (pending > 0 || st.awaitingVerdict > 0)) await syncNow();
    else await refreshSyncState();
  }, 60_000);
}
