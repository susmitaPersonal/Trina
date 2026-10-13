import { uuidv7 } from '@trina/contracts';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { ApiClient } from '../core/api-client';
import { ConfirmationService } from '../core/confirmations';
import { MilestoneService } from '../core/milestones';
import { systemClock } from '../core/clock';
import { migrateLocal } from '../core/migrations';
import { OfflineStore } from '../core/offline-store';
import { PartyService } from '../core/party';
import { SessionManager } from '../core/session-manager';
import type { SqlDb } from '../core/sql';
import { SyncWorker } from '../core/sync-worker';
import { openDeviceDb } from '../platform/expo-db';
import { expoUploader } from '../platform/files';
import { secureDeviceKeys, secureTokens } from '../platform/secure';

export const APP_VERSION = '0.1.0';

export function apiBaseUrl(): string {
  return process.env.EXPO_PUBLIC_API_URL ?? (Constants.expoConfig?.extra?.apiUrl as string | undefined) ?? 'http://10.0.2.2:3000';
}

export type Me = { userId: string; email: string; displayName: string; role: string; shareWellbeing: boolean };

export type Services = {
  db: SqlDb;
  store: OfflineStore;
  api: ApiClient;
  sync: SyncWorker;
  deviceId: string;
  me(): Promise<Me | null>;
  setMe(me: Me | null): Promise<void>;
  sessions(): Promise<SessionManager>;
  photosOnCellular: { value: boolean };
  network: { online: boolean; wifi: boolean };
  /** QuestGuard: while true the ApiClient makes no network calls at all (design §5A.3). */
  quest: { active: boolean; sessionId: string | null };
  milestones(): Promise<MilestoneService>;
  confirmations(): Promise<ConfirmationService>;
  /** Offline Party Mode (ADR-033): invites, QR meetings and progress gossip. */
  party(): Promise<PartyService>;
  /** Creates the device key once and registers its public key with the server (when online). */
  ensureDeviceKey(): Promise<void>;
};

let services: Promise<Services> | null = null;

/** Lazily wires all singletons. Safe to call from UI and from background tasks. */
export function getServices(): Promise<Services> {
  services ??= (async () => {
    const db = await openDeviceDb();
    await migrateLocal(db);
    const store = new OfflineStore(db);
    let deviceId = await store.getMeta('device_id');
    if (!deviceId) {
      deviceId = uuidv7();
      await store.setMeta('device_id', deviceId);
    }
    const network = { online: true, wifi: true };
    const quest = { active: false, sessionId: null as string | null };
    const photosOnCellular = { value: (await store.getMeta('photos_on_cellular')) !== '0' };
    const api = new ApiClient({
      baseUrl: apiBaseUrl(),
      tokens: secureTokens,
      device: {
        id: deviceId,
        platform: Platform.OS === 'ios' ? 'ios' : 'android',
        appVersion: APP_VERSION,
        osVersion: String(Device.osVersion ?? '').slice(0, 32) || undefined,
      },
      uploader: expoUploader,
      blocked: () => quest.active,
    });
    let milestoneService: MilestoneService | null = null;
    let milestoneUser: string | null = null;
    let signedInUser = (await db.get<{ user_id: string }>('SELECT user_id FROM me LIMIT 1'))?.user_id ?? null;
    const sync = new SyncWorker({
      db, api, store, deviceId,
      userId: () => signedInUser,
      photosAllowed: () => network.wifi || photosOnCellular.value,
      get milestones() {
        return milestoneService ?? undefined;
      },
    });
    let manager: SessionManager | null = null;
    let managerUser: string | null = null;
    let confirmService: ConfirmationService | null = null;
    let partyService: PartyService | null = null;

    const me = async (): Promise<Me | null> => {
      const r = await db.get<any>('SELECT * FROM me LIMIT 1');
      return r ? { userId: r.user_id, email: r.email, displayName: r.display_name, role: r.role, shareWellbeing: Number(r.share_wellbeing) === 1 } : null;
    };

    const svc: Services = {
      db,
      store,
      api,
      sync,
      deviceId,
      network,
      photosOnCellular,
      quest,
      me,
      async milestones() {
        const m = await me();
        if (!m) throw new Error('Not signed in');
        if (!milestoneService || milestoneUser !== m.userId) {
          milestoneService = new MilestoneService(db, store, { userId: m.userId });
          milestoneUser = m.userId;
        }
        return milestoneService;
      },
      async confirmations() {
        const m = await me();
        if (!m) throw new Error('Not signed in');
        const sm = await svc.sessions();
        confirmService ??= new ConfirmationService(db, sm, secureDeviceKeys, { userId: m.userId, deviceId: deviceId!, displayName: m.displayName });
        return confirmService;
      },
      async party() {
        const m = await me();
        if (!m) throw new Error('Not signed in');
        const sm = await svc.sessions();
        partyService ??= new PartyService(db, sm, secureDeviceKeys, { userId: m.userId, deviceId: deviceId!, displayName: m.displayName });
        return partyService;
      },
      async ensureDeviceKey() {
        if ((await store.getMeta('device_key_registered')) === '1') return;
        const c = await svc.confirmations();
        const k = await c.ensureKeys();
        try {
          await api.registerDeviceKey(k.publicKeyHex);
          await store.setMeta('device_key_registered', '1');
        } catch {
          /* offline or not yet signed in: retried on the next start */
        }
      },
      async setMe(m) {
        await db.run('DELETE FROM me');
        signedInUser = m?.userId ?? null;
        if (m) await store.onSignIn(m.userId);
        if (m) {
          await db.run('INSERT INTO me (user_id, email, display_name, role, share_wellbeing, cached_at) VALUES (?, ?, ?, ?, ?, ?)', [
            m.userId, m.email, m.displayName, m.role, m.shareWellbeing ? 1 : 0, new Date().toISOString(),
          ]);
        }
      },
      async sessions() {
        const m = await me();
        if (!m) throw new Error('Not signed in');
        if (!manager || managerUser !== m.userId) {
          manager = new SessionManager(db, store, systemClock, { userId: m.userId, deviceId: deviceId! }, { milestones: await svc.milestones() });
          managerUser = m.userId;
          confirmService = null;
          partyService = null;
        }
        return manager;
      },
    };
    return svc;
  })();
  return services;
}
