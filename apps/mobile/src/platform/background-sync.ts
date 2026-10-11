import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

export const SYNC_TASK = 'trina-sync';

/** Opportunistic background sync (Android WorkManager / iOS BGTask). Never relied upon: foreground sync is primary. */
TaskManager.defineTask(SYNC_TASK, async () => {
  try {
    const { getServices } = await import('../app/services');
    const s = await getServices();
    if (!(await s.me())) return BackgroundTask.BackgroundTaskResult.Success;
    await s.sync.runOnce();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function registerBackgroundSync() {
  try {
    await BackgroundTask.registerTaskAsync(SYNC_TASK, { minimumInterval: 15 });
  } catch {
    /* not available (e.g. Expo Go): foreground sync still works */
  }
}
