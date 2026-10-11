import type {
  DailyQuestDto,
  GuildBoardDto,
  GuildDto,
  MilestoneCatalogItemDto,
  ModuleDraftResponse,
  ModuleSummaryDto,
  ModuleVersionDto,
  ProgressDto,
  AiDraftRequest,
  AiDraftResponse,
  AuthResponse,
  BundleDto,
  ChallengeDetail,
  ChallengeSummary,
  DeviceInfo,
  LeaderboardDto,
  ProblemDetails,
  PullResponse,
  PushRequest,
  PushResponse,
  SessionDto,
  UserDto,
} from '@trina/contracts';

/** AbortSignal.timeout is missing on some JS engines (Hermes); this works everywhere. */
export function timeoutSignal(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

/** Network failure (offline, DNS, timeout). Always retryable. */
export class NetworkError extends Error {
  constructor(message = 'Network unavailable') {
    super(message);
    this.name = 'NetworkError';
  }
}

/** Server answered with an error (problem+json). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Partial<ProblemDetails>,
  ) {
    super(problem.detail ?? problem.title ?? `HTTP ${status}`);
    this.name = 'ApiError';
  }
  get code() {
    return this.problem.code ?? 'INTERNAL';
  }
  get retryable() {
    return this.status === 429 || this.status >= 500;
  }
}

/** Offline Quest Mode (design §5A.3): the app makes NO network calls while a quest runs. */
export class QuestBlockedError extends NetworkError {
  constructor() {
    super('Offline quest in progress');
    this.name = 'QuestBlockedError';
  }
}

/** The refresh token is gone/expired: the user must sign in again (local data stays safe). */
export class AuthRequiredError extends Error {
  constructor() {
    super('Sign in to sync');
    this.name = 'AuthRequiredError';
  }
}

export interface TokenStore {
  get(): Promise<{ accessToken: string | null; refreshToken: string | null }>;
  set(tokens: { accessToken: string; refreshToken: string } | null): Promise<void>;
}

/** Uploads a local file as the raw request body (expo-file-system on device, fs in tests). */
export type BinaryUploader = (args: { url: string; fileUri: string; headers: Record<string, string> }) => Promise<{ status: number; body: string }>;

export type ApiClientOptions = {
  baseUrl: string;
  tokens: TokenStore;
  device: DeviceInfo;
  fetchImpl?: typeof fetch;
  uploader?: BinaryUploader;
  timeoutMs?: number;
  onAuthLost?: () => void;
  /** QuestGuard: when it returns true every request fails fast without touching the network. */
  blocked?: () => boolean;
};

export class ApiClient {
  private readonly fetch: typeof fetch;
  private refreshing: Promise<string> | null = null;

  constructor(readonly opts: ApiClientOptions) {
    this.fetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  get baseUrl() {
    return this.opts.baseUrl;
  }

  private async raw(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, token?: string | null): Promise<Response> {
    if (this.opts.blocked?.()) throw new QuestBlockedError();
    try {
      return await this.fetch(`${this.opts.baseUrl}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: timeoutSignal(this.opts.timeoutMs ?? 20_000),
      });
    } catch (e) {
      throw new NetworkError((e as Error).message);
    }
  }

  private async parse<T>(res: Response): Promise<T> {
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: unknown = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = { detail: text };
    }
    if (!res.ok) throw new ApiError(res.status, (data as Partial<ProblemDetails>) ?? {});
    return data as T;
  }

  /** Single-flight token refresh. */
  private async refresh(): Promise<string> {
    this.refreshing ??= (async () => {
      const { refreshToken } = await this.opts.tokens.get();
      if (!refreshToken) throw new AuthRequiredError();
      const res = await this.raw('POST', '/v1/auth/refresh', { refreshToken, deviceId: this.opts.device.id });
      if (res.status === 401) {
        await this.opts.tokens.set(null);
        this.opts.onAuthLost?.();
        throw new AuthRequiredError();
      }
      const auth = await this.parse<AuthResponse>(res);
      await this.opts.tokens.set({ accessToken: auth.accessToken, refreshToken: auth.refreshToken });
      return auth.accessToken;
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async accessToken(): Promise<string> {
    const { accessToken } = await this.opts.tokens.get();
    return accessToken ?? this.refresh();
  }

  /** Authenticated request with one transparent refresh on 401. */
  async request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    let token = await this.accessToken();
    let res = await this.raw(method, path, body, headers, token);
    if (res.status === 401) {
      token = await this.refresh();
      res = await this.raw(method, path, body, headers, token);
    }
    return this.parse<T>(res);
  }

  /* ------------------------------- Auth -------------------------------- */
  async register(input: { email: string; password: string; displayName: string }) {
    const res = await this.raw('POST', '/v1/auth/register', { ...input, ageConfirmed: true, device: this.opts.device });
    const auth = await this.parse<AuthResponse>(res);
    await this.opts.tokens.set({ accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    return auth;
  }
  async login(input: { email: string; password: string }) {
    const res = await this.raw('POST', '/v1/auth/login', { ...input, device: this.opts.device });
    const auth = await this.parse<AuthResponse>(res);
    await this.opts.tokens.set({ accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    return auth;
  }
  async logout() {
    const { refreshToken } = await this.opts.tokens.get();
    if (refreshToken) await this.request('POST', '/v1/auth/logout', { refreshToken }).catch(() => undefined);
    await this.opts.tokens.set(null);
  }
  me = () => this.request<{ user: UserDto; stats: { sessions: number; points: number } }>('GET', '/v1/me');
  patchMe = (body: { displayName?: string; shareWellbeing?: boolean }) => this.request<{ user: UserDto }>('PATCH', '/v1/me', body);
  serverTime = async () => this.parse<{ serverTime: string }>(await this.raw('GET', '/v1/time'));
  health = async () => this.parse<{ ok: boolean }>(await this.raw('GET', '/v1/health'));

  /* ----------------------------- Challenges ---------------------------- */
  listChallenges(q: { near?: [number, number]; mine?: 'created' | 'joined'; module?: string; maxDuration?: number } = {}) {
    const p = new URLSearchParams();
    // Coarse location only: rounded to ~1 km before leaving the device.
    if (q.near) p.set('near', `${q.near[1].toFixed(2)},${q.near[0].toFixed(2)}`);
    if (q.mine) p.set('mine', q.mine);
    if (q.module) p.set('module', q.module);
    if (q.maxDuration) p.set('maxDuration', String(q.maxDuration));
    return this.request<{ items: ChallengeSummary[]; nextCursor: string | null }>('GET', `/v1/challenges?${p}`);
  }
  getChallenge = (id: string) => this.request<ChallengeDetail>('GET', `/v1/challenges/${id}`);
  createChallenge = (definition: unknown, idempotencyKey: string, aiGenerationId?: string) =>
    this.request<{ id: string; version: number; maxScore: number }>('POST', '/v1/challenges', { definition, ...(aiGenerationId ? { aiGenerationId } : {}) }, { 'Idempotency-Key': idempotencyKey });
  publish = (id: string, version: number) => this.request('POST', `/v1/challenges/${id}/publish`, { version });
  join = (id: string, body: { teamId?: string; newTeamName?: string } = {}, idempotencyKey?: string) =>
    this.request<{ participation: { teamId: string | null }; joinedVersion: number }>('POST', `/v1/challenges/${id}/join`, body, idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {});
  bundle = (id: string, version: number) => this.request<BundleDto>('GET', `/v1/challenges/${id}/versions/${version}/bundle`);
  leaderboard = (id: string, scope: 'individual' | 'team' = 'individual') => this.request<LeaderboardDto>('GET', `/v1/challenges/${id}/leaderboard?scope=${scope}`);
  templates = () => this.request<{ items: { id: string; title: string; description: string; moduleIds: string[]; definition: unknown }[] }>('GET', '/v1/templates');

  /* -------------------------------- Sync ------------------------------- */
  push = (body: PushRequest) => this.request<PushResponse>('POST', '/v1/sync/push', body);
  pull = (cursor: string) => this.request<PullResponse>('GET', `/v1/sync/pull?cursor=${encodeURIComponent(cursor)}`);
  session = (id: string) => this.request<SessionDto>('GET', `/v1/sessions/${id}`);
  mySessions = () => this.request<{ items: SessionDto[] }>('GET', '/v1/me/sessions');
  wellness = (period: 'week' | 'month' | 'all' = 'week') => this.request<{ totals: Record<string, number> }>('GET', `/v1/me/wellness?period=${period}`);

  async uploadEvidence(args: { evidenceId: string; fileUri: string; sha256: string; sessionId: string }): Promise<'uploaded' | 'conflict'> {
    if (!this.opts.uploader) throw new Error('No binary uploader configured');
    const send = async (token: string) => {
      try {
        return await this.opts.uploader!({
          url: `${this.opts.baseUrl}/v1/evidence/${args.evidenceId}/content`,
          fileUri: args.fileUri,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'image/jpeg', 'x-content-sha256': args.sha256, 'x-session-id': args.sessionId },
        });
      } catch (e) {
        throw new NetworkError((e as Error).message);
      }
    };
    if (this.opts.blocked?.()) throw new QuestBlockedError();
    let res = await send(await this.accessToken());
    if (res.status === 401) res = await send(await this.refresh());
    if (res.status === 200 || res.status === 201) return 'uploaded';
    if (res.status === 409) return 'conflict';
    let problem: Partial<ProblemDetails> = {};
    try {
      problem = JSON.parse(res.body);
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, problem);
  }

  /* --------------------------------- AI -------------------------------- */
  aiDraft = (body: AiDraftRequest) => this.request<AiDraftResponse>('POST', '/v1/ai/challenge-drafts', body);
  aiRecap = (sessionId: string) => this.request<{ text: string; provider: string }>('POST', '/v1/ai/recaps', { sessionId });
  aiExplain = (challengeId: string, question: string) => this.request<{ text: string; provider: string; officialRules: string[] }>('POST', '/v1/ai/explain', { challengeId, question });

  /* --------------------------- Modules & milestones -------------------------- */
  moduleDraft = (prompt: string) => this.request<ModuleDraftResponse>('POST', '/v1/ai/module-drafts', { prompt });
  modules = () => this.request<ModuleSummaryDto[]>('GET', '/v1/modules');
  moduleVersion = (id: string, version: number) => this.request<ModuleVersionDto>('GET', `/v1/modules/${id}/versions/${version}`);
  createModule = (definition: unknown, idempotencyKey: string, aiGenerationId?: string) =>
    this.request<{ id: string; version: number; status: string; definition: unknown; definitionHash: string; risk: ModuleDraftResponse['risk'] }>('POST', '/v1/modules', { definition, ...(aiGenerationId ? { aiGenerationId } : {}) }, { 'Idempotency-Key': idempotencyKey });
  patchModule = (id: string, definition: unknown, baseVersion: number) => this.request<{ id: string; version: number; definition: unknown; definitionHash: string }>('PATCH', `/v1/modules/${id}`, { definition, baseVersion });
  publishModule = (id: string, version: number, visibility: 'private' | 'unlisted') => this.request<{ status: string; visibility: string }>('POST', `/v1/modules/${id}/publish`, { version, visibility });
  forkModule = (id: string, fromVersion: number) => this.request<{ id: string; version: number; definition: unknown; definitionHash: string }>('POST', `/v1/modules/${id}/fork`, { fromVersion });
  reportModule = (id: string, reason: 'unsafe' | 'offensive' | 'impersonation' | 'spam' | 'other', note?: string) => this.request('POST', `/v1/modules/${id}/report`, { reason, ...(note ? { note } : {}) });
  milestoneCatalog = (moduleId?: string) => this.request<MilestoneCatalogItemDto[]>('GET', `/v1/milestones${moduleId ? `?moduleId=${encodeURIComponent(moduleId)}` : ''}`);
  myMilestones = (window: 'day' | 'week' | 'month' | 'lifetime' | 'all' = 'all') =>
    this.request<{ windowKey: string | null; items: Array<{ key: string; windowKey: string; tier: string; title: string; value: number; verification: string; label: string; stat: string; dayKey: string; unlockedAt: string | null }> }>('GET', `/v1/me/milestones?window=${window}`);
  myProgress = () => this.request<ProgressDto>('GET', '/v1/me/progress');
  myQuests = () => this.request<DailyQuestDto>('GET', '/v1/me/quests');
  registerDeviceKey = (publicKey: string) => this.request<void>('PUT', '/v1/me/devices/current/key', { publicKey });

  /* --------------------------------- Guilds -------------------------------- */
  myGuilds = () => this.request<{ items: Array<{ id: string; name: string; icon: string; role: string; members: number }> }>('GET', '/v1/me/guilds');
  createGuild = (name: string, description = '') => this.request<{ id: string; name: string }>('POST', '/v1/guilds', { name, description });
  guild = (id: string) => this.request<GuildDto>('GET', `/v1/guilds/${id}`);
  guildInvite = (id: string) => this.request<{ code: string; expiresAt: string }>('POST', `/v1/guilds/${id}/invites`, { maxUses: 10 });
  joinGuild = (code: string) => this.request<{ guildId: string }>('POST', '/v1/guilds/join', { code });
  guildBoard = (id: string) => this.request<GuildBoardDto>('GET', `/v1/guilds/${id}/board`);
}
