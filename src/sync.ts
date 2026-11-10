import type { RoomCommand } from './types';

export const SMALL_DRIFT_THRESHOLD_SECONDS = 0.75;
export const MAX_AUTOMATIC_CORRECTION_SECONDS = 3;

export type RemoteCommandDecision = 'ignore' | 'mismatch' | 'apply';
export type DriftDecision = 'none' | 'correct' | 'large';

export function classifyRemoteCommand(
  localUid: string,
  localMediaKey: string,
  command: Pick<RoomCommand, 'originUid' | 'mediaKey' | 'commandId'>
): RemoteCommandDecision {
  if (!command.commandId || command.originUid === localUid) return 'ignore';
  if (!localMediaKey || command.mediaKey !== localMediaKey) return 'mismatch';
  return 'apply';
}

export function classifyDrift(currentPosition: number, targetPosition: number): DriftDecision {
  if (!Number.isFinite(currentPosition) || !Number.isFinite(targetPosition)) return 'large';
  const delta = Math.abs(targetPosition - currentPosition);
  if (delta <= SMALL_DRIFT_THRESHOLD_SECONDS) return 'none';
  if (delta <= MAX_AUTOMATIC_CORRECTION_SECONDS) return 'correct';
  return 'large';
}

export function normalizeMediaKey(url: string): string {
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

export function extractEpisodeId(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !(parsed.hostname === 'crunchyroll.com' || parsed.hostname.endsWith('.crunchyroll.com'))) return '';
    const match = parsed.pathname.match(/(?:^|\/)watch\/([^/?#]+)/i);
    const id = match?.[1] ?? '';
    return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : '';
  } catch {
    return '';
  }
}

export function episodeUrlFromId(episodeId: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(episodeId)) return null;
  return `https://www.crunchyroll.com/watch/${encodeURIComponent(episodeId)}`;
}

export function shouldFollowEpisode(
  localUid: string,
  localEpisodeId: string,
  pointer: { episodeId: string; originUid: string } | null
): boolean {
  return Boolean(
    pointer &&
    pointer.originUid !== localUid &&
    pointer.episodeId !== localEpisodeId &&
    episodeUrlFromId(pointer.episodeId)
  );
}

export function isValidRoomCode(code: string): boolean {
  return /^[A-Za-z0-9_-]{20,32}$/.test(code);
}
