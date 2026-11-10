import type { CommandType, RoomCommand, VideoState } from './types';

const HEARTBEAT_MS = 8_000;
const CONTEXT_REFRESH_MS = 3_000;
const SUPPRESSION_MS = 1_200;

// Content scripts MV3 injetados pelo manifesto são scripts clássicos, não módulos.
// Mantenha esta função local para que o build não extraia um chunk importado.
function normalizeMediaKey(url: string): string {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/watch\/([^/?#]+)/i);
    if (match) return `watch:${match[1]}`;
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    return `path:${path.slice(0, 180)}`;
  } catch {
    return '';
  }
}

let currentVideo: HTMLVideoElement | null = null;
let syncEnabled = false;
let suppressUntil = 0;
let lastContextKey = '';
const attachedVideos = new WeakSet<HTMLVideoElement>();
const pendingRemoteSeeks = new WeakMap<HTMLVideoElement, { target: number; timeoutId: number }>();

function safeSend(message: unknown): void {
  try {
    void chrome.runtime.sendMessage(message).catch(() => undefined);
  } catch {
    // The extension service worker may not be awake yet; a later page event retries.
  }
}

function isReadyVideo(video: HTMLVideoElement): boolean {
  return video.readyState >= HTMLMediaElement.HAVE_METADATA && video.error === null;
}

function findReadyVideo(): HTMLVideoElement | null {
  return Array.from(document.querySelectorAll('video')).find(isReadyVideo) ?? null;
}

function getPageContext() {
  return {
    mediaKey: normalizeMediaKey(location.href),
    hasVideo: Boolean(findReadyVideo())
  };
}

function emitPageContext(force = false): void {
  const context = getPageContext();
  const contextKey = `${context.mediaKey}|${context.hasVideo}`;
  if (!force && contextKey === lastContextKey) return;
  const previousMediaKey = lastContextKey.split('|', 1)[0] ?? '';
  const navigation = Boolean(previousMediaKey && previousMediaKey !== context.mediaKey);
  lastContextKey = contextKey;
  safeSend({ type: 'CONTENT_PAGE', page: context, navigation });
}

function snapshot(): VideoState | null {
  const video = findReadyVideo();
  if (!video) return null;
  const position = Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0;
  const playbackRate = Number.isFinite(video.playbackRate) ? video.playbackRate : 1;
  return {
    mediaKey: normalizeMediaKey(location.href),
    position,
    paused: video.paused,
    playbackRate
  };
}

function emitCommand(type: CommandType): void {
  if (!syncEnabled || (type !== 'seek' && Date.now() < suppressUntil)) return;
  const state = snapshot();
  if (!state || !state.mediaKey) return;
  safeSend({ type: 'CONTENT_EVENT', command: { type, ...state } });
}

function suppressLocalEvents(action: () => void): void {
  suppressUntil = Date.now() + SUPPRESSION_MS;
  action();
}

function markRemoteSeek(video: HTMLVideoElement, target: number): void {
  const previous = pendingRemoteSeeks.get(video);
  if (previous) window.clearTimeout(previous.timeoutId);
  const timeoutId = window.setTimeout(() => pendingRemoteSeeks.delete(video), 8_000);
  pendingRemoteSeeks.set(video, { target, timeoutId });
}

function onSeeked(video: HTMLVideoElement): void {
  const pending = pendingRemoteSeeks.get(video);
  if (pending) {
    window.clearTimeout(pending.timeoutId);
    pendingRemoteSeeks.delete(video);
    if (Math.abs(video.currentTime - pending.target) <= 0.5) return;
  }
  emitCommand('seek');
}

function reportNotice(code: string, message: string): void {
  safeSend({ type: 'CONTENT_NOTICE', code, message });
}

function attachVideo(video: HTMLVideoElement): void {
  currentVideo = video;
  if (attachedVideos.has(video)) return;
  attachedVideos.add(video);
  video.addEventListener('play', () => emitCommand('play'));
  video.addEventListener('pause', () => emitCommand('pause'));
  video.addEventListener('seeked', () => onSeeked(video));
  video.addEventListener('ratechange', () => emitCommand('rate'));
  video.addEventListener('loadedmetadata', () => emitPageContext(true));
  video.addEventListener('loadeddata', () => emitPageContext(true));
  emitPageContext(true);
}

function findVideo(): void {
  const video = findReadyVideo() ?? document.querySelector('video');
  if (video && video !== currentVideo) attachVideo(video);
  emitPageContext();
}

function applyRemote(command: RoomCommand): void {
  if (!syncEnabled) return;
  const video = findReadyVideo();
  if (!video) {
    reportNotice('NO_VIDEO', 'Não encontrei um vídeo ativo nesta página da Crunchyroll.');
    return;
  }
  const localMediaKey = normalizeMediaKey(location.href);
  if (!command.mediaKey || command.mediaKey !== localMediaKey) {
    reportNotice('MEDIA_MISMATCH', 'Comando de reprodução ignorado enquanto a sala segue para o outro episódio.');
    emitPageContext(true);
    return;
  }

  if (command.type === 'heartbeat') {
    if (video.paused || command.paused) return;
    const difference = command.position - video.currentTime;
    const magnitude = Math.abs(difference);
    if (magnitude > 0.75 && magnitude <= 3) {
      markRemoteSeek(video, command.position);
      suppressLocalEvents(() => { video.currentTime = command.position; });
    } else if (magnitude > 3) {
      reportNotice('LARGE_DRIFT', 'O atraso entre os vídeos é grande demais para corrigir automaticamente. Use a linha do tempo e sincronize novamente.');
    }
    return;
  }

  suppressLocalEvents(() => {
    if (command.type === 'snapshot' || command.type === 'play' || command.type === 'pause' || command.type === 'seek') {
      if (Number.isFinite(command.position)) {
        if (Math.abs(command.position - video.currentTime) > 0.05) markRemoteSeek(video, command.position);
        video.currentTime = command.position;
      }
    }
    if (command.type === 'snapshot' || command.type === 'rate' || command.type === 'play' || command.type === 'pause') {
      if (Number.isFinite(command.playbackRate) && command.playbackRate >= 0.25 && command.playbackRate <= 4) {
        video.playbackRate = command.playbackRate;
      }
    }

    if (command.type === 'snapshot') {
      if (command.paused) video.pause();
      else void video.play().catch(() => reportNotice('PLAY_BLOCKED', 'O navegador bloqueou o play automático. Confirme a reprodução manualmente nesta aba.'));
    } else if (command.type === 'play') {
      void video.play().catch(() => reportNotice('PLAY_BLOCKED', 'O navegador bloqueou o play automático. Confirme a reprodução manualmente nesta aba.'));
    } else if (command.type === 'pause') {
      video.pause();
    }
  });
}

chrome.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return;

  if (message.type === 'GET_CONTEXT') {
    findVideo();
    sendResponse({ ok: true, page: getPageContext(), state: snapshot() });
    return;
  }

  if (message.type === 'START_SYNC') {
    findVideo();
    const state = snapshot();
    if (!state) {
      sendResponse({ ok: false, error: 'Não encontrei um vídeo ativo na aba atual.' });
      return;
    }
    syncEnabled = true;
    sendResponse({ ok: true, state });
    return;
  }

  if (message.type === 'STOP_SYNC') {
    syncEnabled = false;
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'APPLY_REMOTE' && message.command) {
    applyRemote(message.command as RoomCommand);
    sendResponse({ ok: true });
  }
});

const observer = new MutationObserver(() => findVideo());
observer.observe(document.documentElement, { childList: true, subtree: true });

window.addEventListener('popstate', () => emitPageContext(true));
window.setInterval(findVideo, CONTEXT_REFRESH_MS);
window.setInterval(() => {
  if (syncEnabled && currentVideo && !currentVideo.paused) emitCommand('heartbeat');
}, HEARTBEAT_MS);

findVideo();
