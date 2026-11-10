import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { get, ref, set } from '@firebase/database';

let testEnv: RulesTestEnvironment;
const projectId = 'demo-crsync';
const roomId = 'AbCdEf0123456789_-xy';

beforeAll(async () => {
  const rules = readFileSync(new URL('../database.rules.json', import.meta.url), 'utf8');
  testEnv = await initializeTestEnvironment({
    projectId,
    database: { host: '127.0.0.1', port: 9000, rules }
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearDatabase();
});

async function createRoomAsAlice(expiry = Date.now() + 60 * 60 * 1000): Promise<void> {
  const db = testEnv.authenticatedContext('alice').database();
  await assertSucceeds(set(ref(db, `rooms/${roomId}/meta`), {
    ownerUid: 'alice',
    createdAt: Date.now(),
    expiresAt: expiry
  }));
  await assertSucceeds(set(ref(db, `rooms/${roomId}/members/owner`), 'alice'));
  await assertSucceeds(set(ref(db, `rooms/${roomId}/currentEpisode`), {
    episodeId: 'EP123',
    originUid: 'alice',
    updatedAt: Date.now()
  }));
}

function validCommand(originUid = 'alice') {
  return {
    commandId: 'test-command-1',
    originUid,
    type: 'play',
    mediaKey: 'watch:EP123',
    position: 42.5,
    paused: false,
    playbackRate: 1,
    updatedAt: Date.now()
  };
}

describe('regras de acesso por sala', () => {
  it('nega leitura anônima e leitura de sala por não participante', async () => {
    await createRoomAsAlice();
    const anonymousDb = testEnv.unauthenticatedContext().database();
    const bobDb = testEnv.authenticatedContext('bob').database();
    await assertFails(get(ref(anonymousDb, `rooms/${roomId}/state`)));
    await assertFails(get(ref(anonymousDb, `rooms/${roomId}/currentEpisode`)));
    await assertFails(get(ref(bobDb, `rooms/${roomId}/meta`)));
    await assertFails(get(ref(bobDb, `rooms/${roomId}/state`)));
    await assertFails(get(ref(bobDb, `rooms/${roomId}/currentEpisode`)));
    await assertFails(get(ref(bobDb, 'rooms')));
  });

  it('permite entrar com o código correto, mas somente no próprio membro', async () => {
    await createRoomAsAlice();
    const bobDb = testEnv.authenticatedContext('bob').database();
    await assertSucceeds(set(ref(bobDb, `rooms/${roomId}/members/guest`), 'bob'));
    await assertSucceeds(get(ref(bobDb, `rooms/${roomId}/meta`)));
    await assertSucceeds(get(ref(bobDb, `rooms/${roomId}/currentEpisode`)));
    await assertFails(set(ref(bobDb, `rooms/${roomId}/members/owner`), 'bob'));
  });

  it('limita uma sala a duas identidades participantes', async () => {
    await createRoomAsAlice();
    const bobDb = testEnv.authenticatedContext('bob').database();
    const carolDb = testEnv.authenticatedContext('carol').database();
    await assertSucceeds(set(ref(bobDb, `rooms/${roomId}/members/guest`), 'bob'));
    await assertFails(set(ref(carolDb, `rooms/${roomId}/members/guest`), 'carol'));
  });

  it('permite comandos válidos somente a membros e exige autoria correspondente', async () => {
    await createRoomAsAlice();
    const aliceDb = testEnv.authenticatedContext('alice').database();
    const bobDb = testEnv.authenticatedContext('bob').database();
    await assertSucceeds(set(ref(aliceDb, `rooms/${roomId}/state`), validCommand('alice')));
    await assertFails(set(ref(aliceDb, `rooms/${roomId}/state`), validCommand('bob')));
    await assertFails(set(ref(bobDb, `rooms/${roomId}/state`), validCommand('bob')));
    await assertFails(set(ref(aliceDb, `rooms/${roomId}/state`), { ...validCommand('alice'), playbackRate: 9 }));
    await assertFails(set(ref(aliceDb, `rooms/${roomId}/state`), { ...validCommand('alice'), episodeHistory: ['EP123'] }));
    await assertFails(set(ref(aliceDb, `rooms/${roomId}/state`), { ...validCommand('alice'), mediaKey: 'https://www.crunchyroll.com/watch/EP123' }));
  });

  it('aceita presença mínima e rejeita nome ou campos adicionais', async () => {
    await createRoomAsAlice();
    const aliceDb = testEnv.authenticatedContext('alice').database();
    const presence = { connectedAt: Date.now(), mediaKey: 'watch:EP123', syncEnabled: true };
    await assertSucceeds(set(ref(aliceDb, `rooms/${roomId}/presence/alice`), presence));
    await assertSucceeds(set(ref(aliceDb, `rooms/${roomId}/presence/alice`), { ...presence, mediaKey: 'path:/pt-br/series/ABC' }));
    await assertFails(set(ref(aliceDb, `rooms/${roomId}/presence/alice`), { ...presence, mediaKey: 'https://www.crunchyroll.com/watch/EP123' }));
    await assertFails(set(ref(aliceDb, `rooms/${roomId}/presence/alice`), { ...presence, displayName: 'Alice' }));
  });

  it('permite membros sincronizar apenas um ID de episódio atual e sem dados extras', async () => {
    await createRoomAsAlice();
    const aliceDb = testEnv.authenticatedContext('alice').database();
    const bobDb = testEnv.authenticatedContext('bob').database();
    await assertSucceeds(set(ref(bobDb, `rooms/${roomId}/members/guest`), 'bob'));
    await assertSucceeds(set(ref(bobDb, `rooms/${roomId}/currentEpisode`), {
      episodeId: 'EP456', originUid: 'bob', updatedAt: Date.now()
    }));
    await assertFails(set(ref(bobDb, `rooms/${roomId}/currentEpisode`), {
      episodeId: 'EP789', originUid: 'alice', updatedAt: Date.now()
    }));
    await assertFails(set(ref(aliceDb, `rooms/${roomId}/currentEpisode`), {
      episodeId: 'https://example.com', originUid: 'alice', updatedAt: Date.now()
    }));
    await assertFails(set(ref(aliceDb, `rooms/${roomId}/currentEpisode`), {
      episodeId: 'EP789', originUid: 'alice', updatedAt: Date.now(), episodeHistory: ['EP123']
    }));
  });

  it('nega entrada e leitura de estado quando a sala expirou', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.database();
      await set(ref(db, `rooms/${roomId}/meta`), {
        ownerUid: 'alice',
        createdAt: Date.now() - 2 * 60 * 60 * 1000,
        expiresAt: Date.now() - 60_000
      });
      await set(ref(db, `rooms/${roomId}/members/owner`), 'alice');
      await set(ref(db, `rooms/${roomId}/currentEpisode`), {
        episodeId: 'EP123', originUid: 'alice', updatedAt: Date.now()
      });
      await set(ref(db, `rooms/${roomId}/state`), validCommand('alice'));
    });
    const aliceDb = testEnv.authenticatedContext('alice').database();
    const bobDb = testEnv.authenticatedContext('bob').database();
    await assertFails(get(ref(aliceDb, `rooms/${roomId}/state`)));
    await assertFails(get(ref(aliceDb, `rooms/${roomId}/currentEpisode`)));
    await assertFails(set(ref(bobDb, `rooms/${roomId}/members/guest`), 'bob'));
    await assertSucceeds(set(ref(aliceDb, `rooms/${roomId}/members/owner`), null));
  });

  it('nega criar uma sala com expiração acima de 24 horas', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').database();
    await assertFails(set(ref(aliceDb, `rooms/${roomId}/meta`), {
      ownerUid: 'alice',
      createdAt: Date.now(),
      expiresAt: Date.now() + 25 * 60 * 60 * 1000
    }));
  });
});
