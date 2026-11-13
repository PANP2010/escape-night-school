import { describe, expect, it } from 'vitest';
import { maxPlayers, MAX_PLAYERS_CAMPAIGN, MAX_PLAYERS_ROYALE } from '../../shared/constants.ts';
import { parseLobbyMsg, type LobbyClientMsg } from '../../shared/lobby.ts';

describe('A1 royale mode basics', () => {
  it('maxPlayers returns 4 for campaign, 8 for royale, default campaign', () => {
    expect(maxPlayers('campaign')).toBe(MAX_PLAYERS_CAMPAIGN);
    expect(maxPlayers('royale')).toBe(MAX_PLAYERS_ROYALE);
    expect(maxPlayers(undefined)).toBe(MAX_PLAYERS_CAMPAIGN);
    expect(maxPlayers()).toBe(MAX_PLAYERS_CAMPAIGN);
  });

  it('parseLobbyMsg accepts mode field', () => {
    const createCampaign = parseLobbyMsg({ t: 'create', mode: 'campaign' }) as LobbyClientMsg & { mode?: string };
    expect(createCampaign).toMatchObject({ t: 'create', mode: 'campaign' });

    const createRoyale = parseLobbyMsg({ t: 'create', mode: 'royale' }) as LobbyClientMsg & { mode?: string };
    expect(createRoyale).toMatchObject({ t: 'create', mode: 'royale' });

    const quickRoyale = parseLobbyMsg({ t: 'quick', mode: 'royale' }) as LobbyClientMsg & { mode?: string };
    expect(quickRoyale).toMatchObject({ t: 'quick', mode: 'royale' });

    // old clients without mode: defaults to campaign
    const createNoMode = parseLobbyMsg({ t: 'create' }) as LobbyClientMsg & { mode?: string };
    expect(createNoMode?.mode).toBeUndefined();

    // invalid mode rejected
    const invalid = parseLobbyMsg({ t: 'create', mode: 'invalid' });
    expect(invalid).toBeNull();
  });

  it('parseLobbyMsg defaults to campaign when mode omitted (old client)', () => {
    const create = parseLobbyMsg({ t: 'create', public: true }) as LobbyClientMsg & { mode?: string };
    expect(create).toBeTruthy();
    expect(create?.mode).toBeUndefined(); // server defaults to campaign
    const quick = parseLobbyMsg({ t: 'quick' }) as LobbyClientMsg & { mode?: string };
    expect(quick).toBeTruthy();
    expect(quick?.mode).toBeUndefined();
  });
});
