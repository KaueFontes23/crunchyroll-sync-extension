import { describe, expect, it } from 'vitest';
import { classifyDrift, classifyRemoteCommand, episodeUrlFromId, extractEpisodeId, isValidRoomCode, normalizeMediaKey, shouldFollowEpisode } from '../src/sync';

describe('classifyRemoteCommand', () => {
  const remote = { commandId: 'cmd-1', originUid: 'bob', mediaKey: 'watch:EP123' };

  it('ignora o eco do próprio participante para evitar ciclos', () => {
    expect(classifyRemoteCommand('bob', 'watch:EP123', remote)).toBe('ignore');
  });

  it('não aplica comando quando as páginas/episódios diferem', () => {
    expect(classifyRemoteCommand('alice', 'watch:EP999', remote)).toBe('mismatch');
  });

  it('aplica um comando válido de outra participante na mesma página', () => {
    expect(classifyRemoteCommand('alice', 'watch:EP123', remote)).toBe('apply');
  });

  it('ignora estado sem identificador de comando', () => {
    expect(classifyRemoteCommand('alice', 'watch:EP123', { ...remote, commandId: '' })).toBe('ignore');
  });
});

describe('classifyDrift', () => {
  it('não corrige diferenças menores que o limite de tolerância', () => {
    expect(classifyDrift(20, 20.5)).toBe('none');
  });

  it('corrige automaticamente pequenos atrasos', () => {
    expect(classifyDrift(20, 21.5)).toBe('correct');
  });

  it('não faz saltos automáticos para atrasos grandes', () => {
    expect(classifyDrift(20, 25)).toBe('large');
  });

  it('trata posições inválidas como não corrigíveis', () => {
    expect(classifyDrift(Number.NaN, 10)).toBe('large');
  });
});

describe('normalização de mídia e códigos', () => {
  it('guarda apenas o identificador atual do episódio e descarta query e fragmento', () => {
    expect(normalizeMediaKey('https://www.crunchyroll.com/watch/EP123/titulo?utm=x#player')).toBe('watch:EP123');
  });

  it('normaliza páginas que não são /watch sem armazenar query strings', () => {
    expect(normalizeMediaKey('https://www.crunchyroll.com/pt-br/series/ABC?foo=bar')).toBe('path:/pt-br/series/ABC');
  });

  it('aceita códigos de convite URL-safe com entropia compatível com o formato do MVP', () => {
    expect(isValidRoomCode('AbCdEf0123456789_-xy')).toBe(true);
    expect(isValidRoomCode('short')).toBe(false);
    expect(isValidRoomCode('not/a/code/with/slashes')).toBe(false);
  });

  it('extrai somente o ID do episódio de URLs válidas e descarta slug, query e fragmento', () => {
    expect(extractEpisodeId('https://www.crunchyroll.com/pt-br/watch/EP123/titulo?utm=x#player')).toBe('EP123');
    expect(extractEpisodeId('https://www.crunchyroll.com/watch/EP_123')).toBe('EP_123');
  });

  it('não aceita domínios externos, HTTP ou IDs que possam alterar o destino', () => {
    expect(extractEpisodeId('https://crunchyroll.com.evil.example/watch/EP123')).toBe('');
    expect(extractEpisodeId('http://www.crunchyroll.com/watch/EP123')).toBe('');
    expect(extractEpisodeId('https://www.crunchyroll.com/watch/%2F%2Fevil.example')).toBe('');
    expect(episodeUrlFromId('../evil.example')).toBeNull();
    expect(episodeUrlFromId('EP123')).toBe('https://www.crunchyroll.com/watch/EP123');
  });

  it('segue somente um ID novo publicado pela outra participante, evitando ciclos', () => {
    expect(shouldFollowEpisode('alice', 'EP123', { episodeId: 'EP456', originUid: 'bob' })).toBe(true);
    expect(shouldFollowEpisode('alice', 'EP456', { episodeId: 'EP456', originUid: 'bob' })).toBe(false);
    expect(shouldFollowEpisode('alice', 'EP123', { episodeId: 'EP456', originUid: 'alice' })).toBe(false);
    expect(shouldFollowEpisode('alice', '', null)).toBe(false);
  });
});
