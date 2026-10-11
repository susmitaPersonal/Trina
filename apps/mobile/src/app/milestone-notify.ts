import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { LocalMilestone, MilestoneService } from '../core/milestones';

/**
 * Milestone notifications (design §7.4). Never during an active session; at most ONE grouped
 * notification per session end and one per sync. Each unlock is announced exactly once (row flag),
 * and its later "Confirmed" notice exactly once too. Works the same on Android and iOS: Android gets
 * its own low-importance channel; iOS uses the permission asked for in the Permissions screen.
 */
export const MILESTONE_CHANNEL = 'milestones';

const TIER_ICON: Record<string, string> = { unlock: '🌱', bronze: '🥉', silver: '🥈', gold: '🥇' };
const MODULE_ICON: Record<string, string> = { cricket: '🏏', football: '⚽', tree_care: '🌳', cleanup: '🧹', walking: '🚶', cycling: '🚲', mindful: '🧘' };

export async function setupNotificationChannels() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(MILESTONE_CHANNEL, {
    name: 'Milestones',
    importance: Notifications.AndroidImportance.DEFAULT,
    vibrationPattern: [0, 120],
    showBadge: false,
  }).catch(() => undefined);
}

function icon(m: LocalMilestone) {
  return MODULE_ICON[m.key.split('@')[0] ?? ''] ?? TIER_ICON[m.tier] ?? '🌱';
}

/** Copy used for the notification and the in-app banner (shared, tested). */
export function unlockText(items: LocalMilestone[], kind: 'unlocked' | 'confirmed'): { title: string; body: string } | null {
  if (!items.length) return null;
  const first = items[0]!;
  const more = items.length > 1 ? ` (+${items.length - 1} more)` : '';
  if (kind === 'confirmed') return { title: `Confirmed: ${first.title} ${icon(first)}${more}`, body: 'Checked by the server. It counts.' };
  const how = first.label === 'Self-reported' ? 'Self-reported' : first.label === 'Confirmed' ? 'Confirmed by another player' : first.label;
  return { title: `Milestone unlocked: ${first.title} ${icon(first)}${more}`, body: `${how} · Final check when you're back online` };
}

async function send(title: string, body: string) {
  try {
    await Notifications.scheduleNotificationAsync({ content: { title, body, sound: false }, trigger: Platform.OS === 'android' ? { channelId: MILESTONE_CHANNEL } : null });
  } catch {
    /* notifications not permitted: the in-app card still shows it */
  }
}

/** Announces new provisional unlocks and newly confirmed ones. Returns what was announced. */
export async function announceMilestones(ms: MilestoneService, opts: { haptic?: boolean } = {}) {
  const fresh = await ms.evaluateLocal();
  const fin = await ms.newlyFinal();
  const confirmed = fin.filter((m) => fresh.every((f) => f.key !== m.key || f.windowKey !== m.windowKey));
  const unlocked = unlockText(fresh, 'unlocked');
  if (unlocked) {
    await send(unlocked.title, unlocked.body);
    if (opts.haptic !== false) await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
  }
  const conf = unlockText(confirmed, 'confirmed');
  if (conf) await send(conf.title, conf.body);
  await ms.markNotified(fresh);
  await ms.markFinalNotified(fin);
  return { unlocked: fresh, confirmed };
}
