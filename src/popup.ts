import './popup.css';

interface PopupStatus {
  configured: boolean;
  room: null | {
    roomId: string;
    uid: string;
    expiresAt: number;
    syncing: boolean;
    episodeId: string;
    participants: Array<{ uid: string; connected: boolean; syncEnabled: boolean; mediaKey: string }>;
    pageMismatch: boolean;
  };
  currentPage: { mediaKey: string; hasVideo: boolean } | null;
  warning: string | null;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Elemento da interface ausente: ${id}`);
  return element as T;
};

const configNotice = $('config-notice');
const joinPanel = $('join-panel');
const roomPanel = $('room-panel');
const badge = $('connection-badge');
const messageArea = $('status-message');
const roomCodeInput = $('room-code') as HTMLInputElement;
let latestStatus: PopupStatus | null = null;
let activeTabId: number | undefined;

function showMessage(message: string, isError = false): void {
  messageArea.textContent = message;
  messageArea.classList.toggle('error', isError);
}

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id;
  return tab;
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

function render(status: PopupStatus): void {
  latestStatus = status;
  const room = status.room;
  configNotice.classList.toggle('hidden', status.configured);
  joinPanel.classList.toggle('hidden', Boolean(room));
  roomPanel.classList.toggle('hidden', !room);

  const createButton = $('create-button') as HTMLButtonElement;
  const joinButton = $('join-button') as HTMLButtonElement;
  createButton.disabled = !status.configured;
  joinButton.disabled = !status.configured;

  badge.textContent = !status.configured ? 'Config pendente' : room ? 'Conectada' : 'Sem sala';
  badge.className = `badge ${room ? 'badge-good' : status.configured ? 'badge-muted' : 'badge-bad'}`;

  if (!room) return;
  ($('active-room-code') as HTMLInputElement).value = room.roomId;
  const expiry = new Date(room.expiresAt);
  $('room-expiry').textContent = `Expira ${expiry.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}`;
  $('current-episode').textContent = room.episodeId ? `Episódio atual: ${room.episodeId}` : 'Carregando episódio da sala…';

  const participantList = $('participants-list');
  participantList.replaceChildren();
  room.participants.forEach((participant) => {
    const item = document.createElement('li');
    item.className = 'participant';
    const name = document.createElement('span');
    name.textContent = participant.uid === room.uid ? 'Você' : 'Outra participante';
    const state = document.createElement('span');
    state.className = 'participant-state';
    state.textContent = participant.connected
      ? participant.syncEnabled ? 'Conectada · sincronizando' : 'Conectada'
      : 'Desconectada';
    item.append(name, state);
    participantList.append(item);
  });
  if (!room.participants.length) {
    const item = document.createElement('li');
    item.className = 'participant';
    item.textContent = 'Carregando presença…';
    participantList.append(item);
  }

  const pageWarning = $('page-warning');
  pageWarning.textContent = room.pageMismatch
    ? 'A outra participante mudou de episódio. A extensão está abrindo o episódio da sala.'
    : '';
  pageWarning.classList.toggle('hidden', !room.pageMismatch);

  const syncWarning = $('sync-warning');
  syncWarning.textContent = status.warning ?? '';
  syncWarning.classList.toggle('hidden', !status.warning);

  const syncButton = $('sync-button') as HTMLButtonElement;
  syncButton.textContent = room.syncing ? 'Parar sincronização' : 'Iniciar sincronização';
}

async function request(type: string, extras: Record<string, unknown> = {}): Promise<any> {
  const response = await chrome.runtime.sendMessage({ type, ...extras });
  if (!response?.ok) throw new Error(response?.error ?? 'A extensão não conseguiu completar a ação.');
  if (response.status) render(response.status as PopupStatus);
  return response;
}

async function refresh(): Promise<void> {
  try {
    const tab = await getActiveTab();
    const response = await request('GET_STATUS', { tabId: tab?.id });
    if (!latestStatus && response.status) render(response.status as PopupStatus);
    if (tab?.url) {
      try {
        const code = new URL(tab.url).searchParams.get('crsync_room');
        if (code && !roomCodeInput.value) roomCodeInput.value = code;
      } catch { /* internal browser pages do not have URLs that can be parsed here */ }
    }
    if (!isCrunchyrollUrl(tab?.url) && latestStatus?.room && !latestStatus.room.syncing) {
      // Joining and room management can happen from any tab; only starting requires Crunchyroll.
    }
  } catch (error) {
    showMessage(error instanceof Error ? error.message : 'Não foi possível obter o estado da sala.', true);
  }
}

$('create-button').addEventListener('click', async () => {
  showMessage('Criando sala…');
  try {
    const tab = await getActiveTab();
    if (tab?.id == null) throw new Error('Não consegui identificar a aba ativa. Abra o episódio e tente novamente.');
    await request('CREATE_ROOM', { tabId: tab.id });
    showMessage('Sala criada neste episódio. Compartilhe o código somente com a participante autorizada.');
  } catch (error) {
    showMessage(error instanceof Error ? error.message : 'Não foi possível criar a sala.', true);
  }
});

$('join-button').addEventListener('click', async () => {
  showMessage('Entrando na sala…');
  try {
    const tab = await getActiveTab();
    if (tab?.id == null) throw new Error('Não consegui identificar a aba para abrir o episódio da sala.');
    await request('JOIN_ROOM', { code: roomCodeInput.value.trim(), tabId: tab.id });
    showMessage('Você entrou na sala. Abrindo o episódio da host; inicie a sincronização de reprodução pelo botão abaixo.');
  } catch (error) {
    showMessage(error instanceof Error ? error.message : 'Não foi possível entrar na sala.', true);
  }
});

$('room-code').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') ($('join-button') as HTMLButtonElement).click();
});

$('copy-code-button').addEventListener('click', async () => {
  if (!latestStatus?.room) return;
  try {
    await navigator.clipboard.writeText(latestStatus.room.roomId);
    showMessage('Código copiado.');
  } catch {
    showMessage('Não foi possível copiar automaticamente; selecione o código e copie-o.', true);
  }
});

$('copy-link-button').addEventListener('click', async () => {
  if (!latestStatus?.room) return;
  const inviteUrl = `https://www.crunchyroll.com/?crsync_room=${encodeURIComponent(latestStatus.room.roomId)}`;
  try {
    await navigator.clipboard.writeText(inviteUrl);
    showMessage('Link copiado. Ao entrar com o código, a participante será levada ao episódio atual da sala.');
  } catch {
    showMessage(`Link: ${inviteUrl}`, true);
  }
});

$('sync-button').addEventListener('click', async () => {
  if (!latestStatus?.room) return;
  try {
    const tab = await getActiveTab();
    if (latestStatus.room.syncing) {
      await request('STOP_SYNC', { tabId: tab?.id });
      showMessage('Sincronização parada nesta sessão.');
      return;
    }
    if (!tab?.id || !isCrunchyrollUrl(tab.url)) {
      throw new Error('Abra a página do episódio na Crunchyroll nesta aba antes de iniciar.');
    }
    await request('START_SYNC', { tabId: tab.id });
    showMessage('Sincronização iniciada. Os comandos normais de reprodução serão compartilhados.');
  } catch (error) {
    showMessage(error instanceof Error ? error.message : 'Não foi possível iniciar a sincronização.', true);
  }
});

$('leave-button').addEventListener('click', async () => {
  try {
    await request('LEAVE_ROOM');
    showMessage('Você saiu da sala.');
  } catch (error) {
    showMessage(error instanceof Error ? error.message : 'Não foi possível sair da sala.', true);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'SESSION_UPDATE' && message.status) render(message.status as PopupStatus);
});

void refresh();
