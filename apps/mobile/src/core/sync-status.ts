import type { SyncCounts, SyncReport } from './sync-worker';

export type SyncPillState = 'synced' | 'ready' | 'offline' | 'syncing' | 'partial' | 'wifi' | 'auth' | 'validating';

export type SyncPill = { state: SyncPillState; icon: string; text: string; tone: 'ok' | 'info' | 'warn' | 'offline' };

/** Copy from docs/product/ux-screens.md#offline-and-sync-states-copy. Never colour-only: icon + text. */
export function syncPill(args: {
  online: boolean;
  syncing: boolean;
  counts: SyncCounts;
  lastReport: SyncReport | null;
  awaitingVerdict: number;
}): SyncPill {
  const { counts } = args;
  const pending = counts.pendingEvents + counts.pendingPhotos + counts.pendingOutbox;
  if (args.lastReport?.outcome === 'auth_required') return { state: 'auth', icon: '🔑', text: 'Sign in to sync. Your data is safe on this device.', tone: 'warn' };
  if (!args.online) return { state: 'offline', icon: '📴', text: "You're offline. Your progress is safe on this device.", tone: 'offline' };
  if (args.syncing) {
    const what = counts.pendingEvents ? `Syncing ${counts.pendingEvents} activities…` : counts.pendingPhotos ? `Uploading ${counts.pendingPhotos} photos…` : 'Syncing…';
    return { state: 'syncing', icon: '🔄', text: what, tone: 'info' };
  }
  if (counts.failed > 0) return { state: 'partial', icon: '⚠️', text: `${counts.failed} item${counts.failed === 1 ? '' : 's'} couldn't sync. We'll retry automatically.`, tone: 'warn' };
  if (counts.waitingForWifi > 0 && counts.pendingEvents === 0) return { state: 'wifi', icon: '📶', text: `${counts.waitingForWifi} photo${counts.waitingForWifi === 1 ? '' : 's'} waiting for Wi-Fi.`, tone: 'info' };
  if (pending > 0) return { state: 'ready', icon: '⬆️', text: 'Ready to sync', tone: 'info' };
  if (args.awaitingVerdict > 0) return { state: 'validating', icon: '🔍', text: 'Synced. Verifying your results…', tone: 'info' };
  return { state: 'synced', icon: '✅', text: 'Everything is synced.', tone: 'ok' };
}

export function relativeTime(iso: string | null, nowMs: number): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}
