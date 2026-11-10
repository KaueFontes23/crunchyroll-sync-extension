export type CommandType = 'snapshot' | 'play' | 'pause' | 'seek' | 'rate' | 'heartbeat';

export interface VideoState {
  mediaKey: string;
  position: number;
  paused: boolean;
  playbackRate: number;
}

export interface RoomCommand extends VideoState {
  commandId: string;
  originUid: string;
  type: CommandType;
  updatedAt: number;
}

export interface EpisodePointer {
  episodeId: string;
  originUid: string;
  updatedAt: number;
}

export interface PresenceRecord {
  connectedAt: number;
  mediaKey: string;
  syncEnabled: boolean;
}

export interface RoomMemberView {
  uid: string;
  connected: boolean;
  syncEnabled: boolean;
  mediaKey: string;
}

export interface RoomSession {
  roomId: string;
  uid: string;
  memberSlot: 'owner' | 'guest';
  expiresAt: number;
  syncing: boolean;
  activeTabId: number | null;
}

export interface PageContext {
  mediaKey: string;
  hasVideo: boolean;
  title: string;
}
