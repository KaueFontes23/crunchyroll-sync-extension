import { initializeApp, type FirebaseApp } from '@firebase/app';
import {
  indexedDBLocalPersistence,
  initializeAuth,
  signInAnonymously,
  type Auth,
  type User
} from '@firebase/auth';
import {
  get,
  getDatabase,
  onDisconnect,
  onValue,
  ref,
  remove,
  set,
  type Database,
  type Unsubscribe
} from '@firebase/database';
import { classifyRemoteCommand, episodeUrlFromId, extractEpisodeId, isValidRoomCode, normalizeMediaKey, shouldFollowEpisode } from './sync';
import type { EpisodePointer, PageContext, PresenceRecord, RoomCommand, RoomMemberView, RoomSession, VideoState } from './types';

const ROOM_LIFETIME_MS = 12 * 60 * 60 * 1000;
const SESSION_STORAGE_KEY = 'crsync.session';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? '',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? '',
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL ?? '',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? '',
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? ''
};

function isFirebaseConfigured(): boolean {
  return Object.values(firebaseConfig).every((value) => typeof value === 'string' && value.length > 0 && !value.startsWith('COLE_'));
}

let firebaseApp: FirebaseApp | null = null;
let firebaseAuth: Auth | null = null;
let database: Database | null = null;
let activeRoom: RoomSession | null = null;
let restoreInFlight: Promise<RoomSession | null> | null = null;
let subscriptions: Unsubscribe[] = [];
let roomMembers: Record<string, string> = {};
let roomPresence: Record<string, PresenceRecord> = {};
let latestCommand: RoomCommand | null = null;
let latestEpisode: EpisodePointer | null = null;
let lastAppliedCommandId = '';
let lastWarning: string | null = null;
let deferEpisodeFollowTabId: number | null = null;
const pageContexts = new Map<number, PageContext>();
const pendingNavigation = new Map<number, Set<string>>();

function hasPendingNavigation(tabId: number, episodeId: string): boolean {
  return pendingNavigation.get(tabId)?.has(episodeId) ?? false;
}

function clearPendingNavigation(tabId: number, episodeId?: string): void {
  if (episodeId == null) {
    pendingNavigation.delete(tabId);
    return;
  }
  const pending = pendingNavigation.get(tabId);
  if (!pending) return;
  pending.delete(episodeId);
  if (pending.size === 0) pendingNavigation.delete(tabId);
}

function addPendingNavigation(tabId: number, episodeId: string): void {
  const pending = pendingNavigation.get(tabId) ?? new Set<string>();
  pending.add(episodeId);
  pendingNavigation.set(tabId, pending);
  setTimeout(() => clearPendingNavigation(tabId, episodeId), 15_000);
}

function getFirebase(): { auth: Auth; db: Database } {
  if (!isFirebaseConfigured()) throw new Error('Firebase ainda não está configurado. Copie .env.example para .env.local, preencha os campos e gere novamente a extensão.');
  if (!firebaseApp) {
    firebaseApp = initializeApp(firebaseConfig, 'crsync-extension');
    firebaseAuth = initializeAuth(firebaseApp, { persistence: indexedDBLocalPersistence });
    database = getDatabase(firebaseApp, firebaseConfig.databaseURL);
  }
  return { auth: firebaseAuth!, db: database! };
}

async function ensureUser(): Promise<User> {
  const { auth } = getFirebase();
  await auth.authStateReady();
  if (auth.currentUser) return auth.currentUser;
  return (await signInAnonymously(auth)).user;
}

function roomPath(roomId: string, child = ''): string {
  return `rooms/${roomId}${child ? `/${child}` : ''}`;
}

function safeSendToExtension(message: unknown): void {
  try {
    void chrome.runtime.sendMessage(message).catch(() => undefined);
  } catch {
    // The popup is usually closed; status is also available on the next popup open.
  }
}

function friendlyError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (text.includes('Firebase ainda não está configurado')) return text;
  if (text.includes('PERMISSION_DENIED') || text.includes('permission_denied') || text.includes('permission-denied')) {
    return 'Não foi possível entrar: confira o código, a validade da sala e se ainda há vaga.';
  }
  if (text.includes('network') || text.includes('NETWORK')) return 'Falha de rede ao conectar ao Firebase. Verifique sua conexão e tente novamente.';
  return `Não foi possível concluir a operação: ${text.slice(0, 180)}`;
}

function stopRoomListeners(clearEpisode = true): void {
  for (const unsubscribe of subscriptions) unsubscribe();
  subscriptions = [];
  roomMembers = {};
  roomPresence = {};
  latestCommand = null;
  if (clearEpisode) latestEpisode = null;
  lastAppliedCommandId = '';
  pendingNavigation.clear();
  if (clearEpisode) deferEpisodeFollowTabId = null;
}

async function saveSession(): Promise<void> {
  if (activeRoom) await chrome.storage.session.set({ [SESSION_STORAGE_KEY]: activeRoom });
  else await chrome.storage.session.remove(SESSION_STORAGE_KEY);
}

function getCurrentPage(tabId: number | null | undefined): PageContext | null {
  if (tabId == null) return null;
  return pageContexts.get(tabId) ?? null;
}

async function writePresence(): Promise<void> {
  if (!activeRoom) return;
  const { db } = getFirebase();
  const page = getCurrentPage(activeRoom.activeTabId);
  const presenceRef = ref(db, roomPath(activeRoom.roomId, `presence/${activeRoom.uid}`));
  await set(presenceRef, {
    connectedAt: Date.now(),
    mediaKey: page?.mediaKey ?? '',
    syncEnabled: activeRoom.syncing
  });
}

function buildStatus(tabId?: number): Record<string, unknown> {
  const currentTabId = tabId ?? activeRoom?.activeTabId ?? undefined;
  const currentPage = getCurrentPage(currentTabId);
  const memberUids = Object.values(roomMembers).filter((uid): uid is string => typeof uid === 'string');
  const members: RoomMemberView[] = memberUids.map((uid) => {
    const presence = roomPresence[uid];
    return {
      uid,
      connected: Boolean(presence),
      syncEnabled: Boolean(presence?.syncEnabled),
      mediaKey: presence?.mediaKey ?? ''
    };
  }).sort((a, b) => Number(b.uid === activeRoom?.uid) - Number(a.uid === activeRoom?.uid));
  const pageMismatch = Boolean(currentPage?.mediaKey && members.some((member) =>
    member.uid !== activeRoom?.uid && member.connected && member.mediaKey && member.mediaKey !== currentPage.mediaKey
  ));
  return {
    configured: isFirebaseConfigured(),
    room: activeRoom ? {
      roomId: activeRoom.roomId,
      uid: activeRoom.uid,
      expiresAt: activeRoom.expiresAt,
      syncing: Boolean(activeRoom.syncing && currentTabId === activeRoom.activeTabId),
      episodeId: latestEpisode?.episodeId ?? '',
      participants: members,
      pageMismatch
    } : null,
    currentPage: currentPage ? { mediaKey: currentPage.mediaKey, hasVideo: currentPage.hasVideo } : null,
    warning: lastWarning
  };
}

function broadcastStatus(): void {
  safeSendToExtension({ type: 'SESSION_UPDATE', status: buildStatus() });
}

async function setWarning(message: string): Promise<void> {
  lastWarning = message;
  broadcastStatus();
}

function makeCommandId(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID()}`;
}

function makeRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function readEpisodePointer(value: unknown): EpisodePointer | null {
  if (!value || typeof value !== 'object') return null;
  const pointer = value as Partial<EpisodePointer>;
  if (!pointer.episodeId || !episodeUrlFromId(pointer.episodeId) || typeof pointer.originUid !== 'string' || typeof pointer.updatedAt !== 'number') return null;
  return pointer as EpisodePointer;
}

async function loadEpisodePointer(roomId: string): Promise<EpisodePointer | null> {
  const { db } = getFirebase();
  const snapshot = await get(ref(db, roomPath(roomId, 'currentEpisode')));
  latestEpisode = snapshot.exists() ? readEpisodePointer(snapshot.val()) : null;
  return latestEpisode;
}

async function setCurrentEpisode(episodeId: string): Promise<void> {
  if (!activeRoom || !episodeUrlFromId(episodeId) || Date.now() >= activeRoom.expiresAt) return;
  if (latestEpisode?.episodeId === episodeId) return;
  const previous = latestEpisode;
  const pointer: EpisodePointer = { episodeId, originUid: activeRoom.uid, updatedAt: Date.now() };
  latestEpisode = pointer;
  const { db } = getFirebase();
  try {
    await set(ref(db, roomPath(activeRoom.roomId, 'currentEpisode')), pointer);
  } catch (error) {
    latestEpisode = previous;
    throw error;
  }
  lastWarning = null;
  broadcastStatus();
}

async function attemptFollowRemoteEpisode(): Promise<void> {
  const room = activeRoom;
  const pointer = latestEpisode;
  if (!room || room.activeTabId == null || !pointer || Date.now() >= room.expiresAt) return;
  const destination = episodeUrlFromId(pointer.episodeId);
  if (!destination) return;
  const tabId = room.activeTabId;
  if (hasPendingNavigation(tabId, pointer.episodeId)) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    const localEpisodeId = extractEpisodeId(tab.url ?? '');
    if (!shouldFollowEpisode(room.uid, localEpisodeId, pointer)) {
      if (localEpisodeId === pointer.episodeId) clearPendingNavigation(tabId, pointer.episodeId);
      return;
    }
    addPendingNavigation(tabId, pointer.episodeId);
    await chrome.tabs.update(tabId, { url: destination });
    lastWarning = null;
    broadcastStatus();
  } catch {
    clearPendingNavigation(tabId, pointer.episodeId);
    await setWarning('Não consegui abrir o episódio da outra participante. Abra o link do episódio e mantenha a sala conectada.');
  }
}

async function publishCommand(type: RoomCommand['type'], state: VideoState): Promise<void> {
  if (!activeRoom || !activeRoom.syncing || Date.now() >= activeRoom.expiresAt) return;
  const { db } = getFirebase();
  const command: RoomCommand = {
    commandId: makeCommandId(),
    originUid: activeRoom.uid,
    type,
    mediaKey: state.mediaKey,
    position: Math.max(0, Math.min(14_400, Number.isFinite(state.position) ? state.position : 0)),
    paused: Boolean(state.paused),
    playbackRate: Math.max(0.25, Math.min(4, Number.isFinite(state.playbackRate) ? state.playbackRate : 1)),
    updatedAt: Date.now()
  };
  await set(ref(db, roomPath(activeRoom.roomId, 'state')), command);
}

async function attemptApplyRemoteCommand(): Promise<void> {
  if (!activeRoom?.syncing || activeRoom.activeTabId == null || !latestCommand) return;
  const context = getCurrentPage(activeRoom.activeTabId);
  if (!context?.hasVideo || !context.mediaKey) return;
  const decision = classifyRemoteCommand(activeRoom.uid, context.mediaKey, latestCommand);
  if (decision === 'ignore') return;
  if (decision === 'mismatch') {
    await setWarning('Os comandos de reprodução aguardam a aba chegar ao episódio atual da sala.');
    return;
  }
  if (latestCommand.commandId === lastAppliedCommandId) return;
  lastAppliedCommandId = latestCommand.commandId;
  lastWarning = null;
  try {
    await chrome.tabs.sendMessage(activeRoom.activeTabId, { type: 'APPLY_REMOTE', command: latestCommand });
  } catch {
    lastAppliedCommandId = '';
    await setWarning('A aba de vídeo não respondeu. Recarregue a página da Crunchyroll e inicie a sincronização novamente.');
  }
  broadcastStatus();
}

async function registerRoomListeners(room: RoomSession): Promise<void> {
  stopRoomListeners(false);
  const { db } = getFirebase();
  const stateRef = ref(db, roomPath(room.roomId, 'state'));
  const episodeRef = ref(db, roomPath(room.roomId, 'currentEpisode'));
  const membersRef = ref(db, roomPath(room.roomId, 'members'));
  const presenceRef = ref(db, roomPath(room.roomId, 'presence'));
  subscriptions.push(onValue(stateRef, (snapshot) => {
    latestCommand = snapshot.exists() ? snapshot.val() as RoomCommand : null;
    void attemptApplyRemoteCommand();
    broadcastStatus();
  }, (error) => { void setWarning(friendlyError(error)); }));
  subscriptions.push(onValue(episodeRef, (snapshot) => {
    latestEpisode = snapshot.exists() ? readEpisodePointer(snapshot.val()) : null;
    if (deferEpisodeFollowTabId != null && deferEpisodeFollowTabId === activeRoom?.activeTabId) deferEpisodeFollowTabId = null;
    else void attemptFollowRemoteEpisode();
    broadcastStatus();
  }, (error) => { void setWarning(friendlyError(error)); }));
  subscriptions.push(onValue(membersRef, (snapshot) => {
    roomMembers = snapshot.exists() ? snapshot.val() as Record<string, string> : {};
    broadcastStatus();
  }, (error) => { void setWarning(friendlyError(error)); }));
  subscriptions.push(onValue(presenceRef, (snapshot) => {
    roomPresence = snapshot.exists() ? snapshot.val() as Record<string, PresenceRecord> : {};
    broadcastStatus();
  }, (error) => { void setWarning(friendlyError(error)); }));
  await refreshPresenceConnection();
}

async function refreshPresenceConnection(): Promise<void> {
  if (!activeRoom) return;
  const { db } = getFirebase();
  const presenceRef = ref(db, roomPath(activeRoom.roomId, `presence/${activeRoom.uid}`));
  await onDisconnect(presenceRef).remove();
  await writePresence();
}

async function restoreRoom(deferInitialEpisodeFollow = false): Promise<RoomSession | null> {
  if (activeRoom) return activeRoom;
  if (restoreInFlight) return restoreInFlight;
  restoreInFlight = (async () => {
    if (!isFirebaseConfigured()) return null;
    const stored = await chrome.storage.session.get(SESSION_STORAGE_KEY);
    const saved = stored[SESSION_STORAGE_KEY] as RoomSession | undefined;
    if (!saved?.roomId) return null;
    const user = await ensureUser();
    if (user.uid !== saved.uid) {
      await chrome.storage.session.remove(SESSION_STORAGE_KEY);
      return null;
    }
    activeRoom = { ...saved };
    await loadEpisodePointer(activeRoom.roomId);
    if (deferInitialEpisodeFollow) deferEpisodeFollowTabId = activeRoom.activeTabId;
    await registerRoomListeners(activeRoom);
    if (activeRoom.activeTabId != null) {
      try {
        const tab = await chrome.tabs.get(activeRoom.activeTabId);
        const response = await chrome.tabs.sendMessage(activeRoom.activeTabId, { type: activeRoom.syncing ? 'START_SYNC' : 'GET_CONTEXT' });
        const page = { mediaKey: normalizeMediaKey(tab.url ?? ''), hasVideo: Boolean(response?.page?.hasVideo ?? response?.state), title: '' };
        pageContexts.set(activeRoom.activeTabId, page);
        if (activeRoom.syncing && response?.ok && response.state) {
          pageContexts.set(activeRoom.activeTabId, { ...page, mediaKey: response.state.mediaKey, hasVideo: true });
          await writePresence();
          await attemptApplyRemoteCommand();
        } else if (activeRoom.syncing) {
          pageContexts.set(activeRoom.activeTabId, { ...page, hasVideo: false });
          lastWarning = 'Aguardando o player carregar para retomar a sincronização de reprodução.';
          await writePresence();
        } else if (!deferInitialEpisodeFollow) {
          await attemptFollowRemoteEpisode();
        }
      } catch {
        if (activeRoom.syncing) {
          lastWarning = 'A aba ainda não respondeu. A sincronização será retomada quando o content script estiver ativo.';
          await writePresence();
        }
      }
    }
    return activeRoom;
  })();
  try {
    return await restoreInFlight;
  } finally {
    restoreInFlight = null;
  }
}

async function leaveCurrentRoom(): Promise<void> {
  const room = activeRoom;
  if (!room) return;
  stopRoomListeners();
  const { db } = getFirebase();
  if (room.activeTabId != null) {
    try { await chrome.tabs.sendMessage(room.activeTabId, { type: 'STOP_SYNC' }); } catch { /* tab may be gone */ }
  }
  const presenceRef = ref(db, roomPath(room.roomId, `presence/${room.uid}`));
  try { await onDisconnect(presenceRef).cancel(); } catch { /* already disconnected */ }
  try { await remove(presenceRef); } catch { /* expired rooms may reject presence cleanup */ }
  try { await remove(ref(db, roomPath(room.roomId, `members/${room.memberSlot}`))); } catch { /* membership cleanup is best-effort */ }
  activeRoom = null;
  lastWarning = null;
  await saveSession();
  broadcastStatus();
}

async function createRoom(tabId: number): Promise<Record<string, unknown>> {
  const episode = await requireEpisodeVideo(tabId);
  if (activeRoom) await leaveCurrentRoom();
  const user = await ensureUser();
  const { db } = getFirebase();
  const roomId = makeRoomCode();
  const expiresAt = Date.now() + ROOM_LIFETIME_MS;
  const pointer: EpisodePointer = { episodeId: episode.episodeId, originUid: user.uid, updatedAt: Date.now() };
  await set(ref(db, roomPath(roomId, 'meta')), {
    ownerUid: user.uid,
    createdAt: Date.now(),
    expiresAt
  });
  await set(ref(db, roomPath(roomId, 'members/owner')), user.uid);
  await set(ref(db, roomPath(roomId, 'currentEpisode')), pointer);
  latestEpisode = pointer;
  pageContexts.set(tabId, episode.page);
  activeRoom = { roomId, uid: user.uid, memberSlot: 'owner', expiresAt, syncing: false, activeTabId: tabId };
  lastWarning = null;
  await saveSession();
  await registerRoomListeners(activeRoom);
  broadcastStatus();
  return buildStatus();
}

async function joinRoom(roomId: string, tabId?: number): Promise<Record<string, unknown>> {
  const normalized = roomId.trim();
  if (!isValidRoomCode(normalized)) throw new Error('O código precisa ter o formato de um convite válido.');
  if (activeRoom?.roomId === normalized) {
    if (tabId != null) {
      activeRoom.activeTabId = tabId;
      await saveSession();
    }
    await attemptFollowRemoteEpisode();
    return buildStatus(tabId);
  }
  if (activeRoom) await leaveCurrentRoom();
  const user = await ensureUser();
  const { db } = getFirebase();
  let memberSlot: RoomSession['memberSlot'] = 'guest';
  try {
    await set(ref(db, roomPath(normalized, 'members/guest')), user.uid);
  } catch (guestError) {
    try {
      await set(ref(db, roomPath(normalized, 'members/owner')), user.uid);
      memberSlot = 'owner';
    } catch {
      throw guestError;
    }
  }
  const metaSnapshot = await get(ref(db, roomPath(normalized, 'meta')));
  if (!metaSnapshot.exists()) {
    try { await remove(ref(db, roomPath(normalized, `members/${memberSlot}`))); } catch { /* stale invitation cleanup is best-effort */ }
    throw new Error('Código inválido, sala cheia ou expirada.');
  }
  const meta = metaSnapshot.val() as { expiresAt?: number };
  if (typeof meta.expiresAt !== 'number' || meta.expiresAt <= Date.now()) {
    try { await remove(ref(db, roomPath(normalized, `members/${memberSlot}`))); } catch { /* expiration cleanup is best-effort */ }
    throw new Error('Esta sala expirou. Peça um novo convite.');
  }
  const pointerSnapshot = await get(ref(db, roomPath(normalized, 'currentEpisode')));
  const pointer = pointerSnapshot.exists() ? readEpisodePointer(pointerSnapshot.val()) : null;
  if (!pointer) {
    try { await remove(ref(db, roomPath(normalized, `members/${memberSlot}`))); } catch { /* stale room cleanup is best-effort */ }
    throw new Error('Esta sala não tem episódio inicial válido. Peça à host para criar uma nova sala em uma página de episódio.');
  }
  if (tabId != null) {
    try {
      const tab = await chrome.tabs.get(tabId);
      pageContexts.set(tabId, { mediaKey: normalizeMediaKey(tab.url ?? ''), hasVideo: false, title: '' });
    } catch { /* the tab may have closed while the code was being entered */ }
  }
  activeRoom = { roomId: normalized, uid: user.uid, memberSlot, expiresAt: meta.expiresAt, syncing: false, activeTabId: tabId ?? null };
  latestEpisode = pointer;
  lastWarning = null;
  await saveSession();
  await registerRoomListeners(activeRoom);
  await attemptFollowRemoteEpisode();
  broadcastStatus();
  return buildStatus(tabId);
}

async function activeTabContext(tabId: number): Promise<{ page: PageContext; state: VideoState } | null> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_CONTEXT' });
    if (!response?.ok || !response.state) return null;
    const tab = await chrome.tabs.get(tabId);
    if (!isCrunchyrollUrl(tab.url)) return null;
    const page = { mediaKey: normalizeMediaKey(tab.url ?? ''), hasVideo: Boolean(response.page?.hasVideo), title: '' };
    pageContexts.set(tabId, page);
    return { page, state: { ...response.state, mediaKey: page.mediaKey } as VideoState };
  } catch {
    return null;
  }
}

function isCrunchyrollUrl(value?: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'crunchyroll.com' || url.hostname.endsWith('.crunchyroll.com'));
  } catch {
    return false;
  }
}

async function requireEpisodeVideo(tabId: number): Promise<{ episodeId: string; page: PageContext }> {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error('Não consegui identificar a aba ativa. Abra o episódio desejado e tente novamente.');
  const tab = await chrome.tabs.get(tabId);
  if (!isCrunchyrollUrl(tab.url)) throw new Error('Para criar a sala, abra primeiro o episódio desejado na Crunchyroll.');
  const episodeId = extractEpisodeId(tab.url ?? '');
  if (!episodeId) throw new Error('A sala só pode ser criada em uma página específica de episódio (/watch/…).');
  let response: any;
  try {
    response = await chrome.tabs.sendMessage(tabId, { type: 'GET_CONTEXT' });
  } catch {
    throw new Error('A página da Crunchyroll ainda não está pronta. Recarregue a aba do episódio e tente novamente.');
  }
  const latestTab = await chrome.tabs.get(tabId);
  if (extractEpisodeId(latestTab.url ?? '') !== episodeId) {
    throw new Error('A página mudou enquanto o player era verificado. Confira o episódio atual e tente criar a sala novamente.');
  }
  if (!response?.ok || !response.state || !response.page?.hasVideo) {
    throw new Error('Não encontrei um vídeo ativo nesta página. Aguarde o player carregar e tente novamente.');
  }
  const mediaKey = `watch:${episodeId}`;
  if (response.state.mediaKey !== mediaKey) {
    throw new Error('O player e a URL não correspondem ao mesmo episódio. Atualize a página e tente novamente.');
  }
  return {
    episodeId,
    page: { mediaKey, hasVideo: true, title: '' }
  };
}

async function startSync(tabId: number): Promise<Record<string, unknown>> {
  const room = await restoreRoom();
  if (!room) throw new Error('Crie ou entre em uma sala antes de iniciar a sincronização.');
  if (Date.now() >= room.expiresAt) {
    await leaveCurrentRoom();
    throw new Error('Esta sala expirou. Crie uma nova sala ou peça outro convite.');
  }
  const tab = await chrome.tabs.get(tabId);
  if (!isCrunchyrollUrl(tab.url) || !extractEpisodeId(tab.url ?? '')) throw new Error('Abra uma página específica de episódio (/watch/…) na Crunchyroll para iniciar.');
  let response: any;
  try {
    response = await chrome.tabs.sendMessage(tabId, { type: 'START_SYNC' });
  } catch {
    throw new Error('A aba não tem o content script ativo. Recarregue a página da Crunchyroll e tente novamente.');
  }
  if (!response?.ok || !response.state) throw new Error(response?.error ?? 'Não encontrei um vídeo ativo na aba atual.');

  const context: PageContext = { mediaKey: normalizeMediaKey(tab.url ?? ''), hasVideo: true, title: '' };
  pageContexts.set(tabId, context);
  room.activeTabId = tabId;
  room.syncing = true;
  const episodeId = extractEpisodeId(tab.url ?? '');
  if (episodeId) await setCurrentEpisode(episodeId);
  lastWarning = null;
  lastAppliedCommandId = '';
  await saveSession();
  await writePresence();

  const { db } = getFirebase();
  const stateRef = ref(db, roomPath(room.roomId, 'state'));
  const stateSnapshot = await get(stateRef);
  const localState = { ...response.state, mediaKey: context.mediaKey } as VideoState;
  if (!stateSnapshot.exists() || (stateSnapshot.val() as RoomCommand).originUid === room.uid) {
    await publishCommand('snapshot', localState);
  } else {
    latestCommand = stateSnapshot.val() as RoomCommand;
    await attemptApplyRemoteCommand();
  }
  broadcastStatus();
  return buildStatus(tabId);
}

async function stopSync(tabId?: number): Promise<Record<string, unknown>> {
  const room = await restoreRoom();
  if (!room) return buildStatus(tabId);
  if (room.activeTabId != null) {
    try { await chrome.tabs.sendMessage(room.activeTabId, { type: 'STOP_SYNC' }); } catch { /* tab may be gone */ }
  }
  room.syncing = false;
  lastWarning = null;
  await saveSession();
  await writePresence();
  broadcastStatus();
  return buildStatus(tabId);
}

async function getStatus(tabId?: number): Promise<Record<string, unknown>> {
  if (!isFirebaseConfigured()) return buildStatus(tabId);
  await restoreRoom();
  if (tabId != null) {
    const context = await activeTabContext(tabId);
    if (context) {
      pageContexts.set(tabId, context.page);
      if (activeRoom?.activeTabId === tabId) await writePresence();
      void attemptApplyRemoteCommand();
    }
  }
  return buildStatus(tabId);
}

async function handleContentMessage(message: any, sender: chrome.runtime.MessageSender): Promise<Record<string, unknown>> {
  const tabId = sender.tab?.id;
  if (tabId == null || !isCrunchyrollUrl(sender.url)) return { ok: false };
  const mediaKey = normalizeMediaKey(sender.url ?? '');

  if (message.type === 'CONTENT_PAGE') {
    const room = await restoreRoom(true);
    const previousPage = pageContexts.get(tabId);
    const page: PageContext = { mediaKey, hasVideo: Boolean(message.page?.hasVideo), title: '' };
    pageContexts.set(tabId, page);
    const episodeId = extractEpisodeId(sender.url ?? '');
    if (room?.activeTabId === tabId) {
      const isPendingEpisode = episodeId && hasPendingNavigation(tabId, episodeId);
      if (isPendingEpisode) clearPendingNavigation(tabId, episodeId);
      else if (episodeId && latestEpisode?.episodeId !== episodeId && (message.navigation === true || previousPage?.mediaKey !== mediaKey)) {
        await setCurrentEpisode(episodeId);
      } else if (episodeId && latestEpisode?.episodeId !== episodeId) {
        await attemptFollowRemoteEpisode();
      }
      if (room.syncing && page.hasVideo) {
        try {
          await startSync(tabId);
        } catch (error) {
          await setWarning(friendlyError(error));
        }
      } else {
        await writePresence();
        await attemptApplyRemoteCommand();
      }
    }
    broadcastStatus();
    return { ok: true };
  }

  if (message.type === 'CONTENT_NOTICE') {
    const text = typeof message.message === 'string' ? message.message.slice(0, 240) : 'A reprodução precisa de atenção manual.';
    await setWarning(text);
    return { ok: true };
  }

  if (message.type === 'CONTENT_EVENT') {
    const room = await restoreRoom();
    if (!room?.syncing || room.activeTabId !== tabId || !message.command) return { ok: false };
    const input = message.command as Partial<VideoState> & { type?: RoomCommand['type'] };
    const allowedTypes: RoomCommand['type'][] = ['play', 'pause', 'seek', 'rate', 'heartbeat'];
    if (!input.type || !allowedTypes.includes(input.type) || !Number.isFinite(input.position) || !Number.isFinite(input.playbackRate)) return { ok: false };
    if (input.mediaKey !== mediaKey) return { ok: false };
    const page: PageContext = { mediaKey, hasVideo: true, title: '' };
    pageContexts.set(tabId, page);
    await writePresence();
    await publishCommand(input.type, {
      mediaKey,
      position: Number(input.position),
      paused: Boolean(input.paused),
      playbackRate: Number(input.playbackRate)
    });
    return { ok: true };
  }
  return { ok: false };
}

chrome.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
  const operation = (async () => {
    if (message?.type === 'CONTENT_PAGE' || message?.type === 'CONTENT_EVENT' || message?.type === 'CONTENT_NOTICE') {
      return handleContentMessage(message, sender);
    }
    try {
      switch (message?.type) {
        case 'GET_STATUS':
          return { ok: true, status: await getStatus(typeof message.tabId === 'number' ? message.tabId : undefined) };
        case 'CREATE_ROOM':
          return { ok: true, status: await createRoom(Number(message.tabId)) };
        case 'JOIN_ROOM':
          return { ok: true, status: await joinRoom(String(message.code ?? ''), typeof message.tabId === 'number' ? message.tabId : undefined) };
        case 'LEAVE_ROOM':
          await leaveCurrentRoom();
          return { ok: true, status: buildStatus() };
        case 'START_SYNC':
          return { ok: true, status: await startSync(Number(message.tabId)) };
        case 'STOP_SYNC':
          return { ok: true, status: await stopSync(typeof message.tabId === 'number' ? message.tabId : undefined) };
        default:
          return { ok: false, error: 'Comando desconhecido.' };
      }
    } catch (error) {
      return { ok: false, error: friendlyError(error), status: buildStatus() };
    }
  })();
  operation.then(sendResponse).catch((error) => sendResponse({ ok: false, error: friendlyError(error) }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pageContexts.delete(tabId);
  pendingNavigation.delete(tabId);
  if (activeRoom?.activeTabId === tabId) {
    activeRoom.syncing = false;
    activeRoom.activeTabId = null;
    void saveSession().then(writePresence).then(broadcastStatus);
  }
});

async function observeEpisodeNavigation(tabId: number, url: string): Promise<void> {
  const room = await restoreRoom(true);
  if (!room || room.activeTabId !== tabId) return;
  const episodeId = extractEpisodeId(url);
  if (!episodeId) return;
  if (hasPendingNavigation(tabId, episodeId)) {
    clearPendingNavigation(tabId, episodeId);
  } else if (latestEpisode?.episodeId !== episodeId) {
    await setCurrentEpisode(episodeId);
  }
  await writePresence();
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (typeof changeInfo.url !== 'string') return;
  void observeEpisodeNavigation(tabId, changeInfo.url).catch((error) => setWarning(friendlyError(error)));
});
