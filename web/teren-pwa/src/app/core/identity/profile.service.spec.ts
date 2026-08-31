import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';

import { TerenApiClient } from '../api/teren-api.client';
import { PROFILE_ROLES, ProfileService } from './profile.service';

/** What `GET /api/me` answers for the demo phone, field for field as the endpoint spells it. */
const ZORAN = {
  role: 'worker',
  user_id: '22222222-2222-2222-2222-222222222222',
  display_name: 'Zoran Jovanović',
  username: 'zoran.jovanovic',
  language: 'sr',
  company: { id: '33333333-3333-3333-3333-333333333333', name: 'Vodoinstal Petrović d.o.o.' },
  device: { id: '11111111-1111-1111-1111-111111111111', name: 'Zoranov telefon' },
};

describe('ProfileService', () => {
  let api: { configured: boolean; getMe: ReturnType<typeof vi.fn> };
  let profiles: ProfileService;

  beforeEach(() => {
    api = { configured: true, getMe: vi.fn().mockResolvedValue(ZORAN) };
    TestBed.configureTestingModule({
      providers: [{ provide: TerenApiClient, useValue: api as unknown as TerenApiClient }],
    });
    profiles = TestBed.inject(ProfileService);
  });

  it('reads a worker out of the wire shape without renaming or inventing anything', async () => {
    const result = await profiles.load();

    expect(result.status).toBe('ok');
    expect(result.profile).toEqual({
      role: 'worker',
      userId: '22222222-2222-2222-2222-222222222222',
      displayName: 'Zoran Jovanović',
      username: 'zoran.jovanovic',
      companyName: 'Vodoinstal Petrović d.o.o.',
      deviceName: 'Zoranov telefon',
      language: 'sr',
    });
  });

  /**
   * The role the screen must not assume.
   *
   * A super admin belongs to no company and holds no phone — `ck_app_user_company_scope` makes the
   * first structurally impossible — so these nulls are the *correct* answer rather than a missing
   * one, and nothing may fill them in from somewhere else.
   */
  it('keeps a super admin a super admin: no username, no company, no device', async () => {
    api.getMe.mockResolvedValue({
      role: 'super_admin',
      user_id: 'aaaa',
      display_name: 'Milovan',
      language: 'en',
      username: null,
      company: null,
      device: null,
    });

    const { profile } = await profiles.load();

    expect(profile?.role).toBe('super_admin');
    expect(profile?.username).toBeNull();
    expect(profile?.companyName).toBeNull();
    expect(profile?.deviceName).toBeNull();
  });

  it('names a role it has never heard of instead of putting a wire string on screen', async () => {
    // An older phone meeting a newer server. `profile.role.unknown` has a sentence behind it in
    // both dictionaries (`i18n.spec.ts`), so this lands on words rather than on `auditor`.
    api.getMe.mockResolvedValue({ ...ZORAN, role: 'auditor' });

    expect((await profiles.load()).profile?.role).toBe('unknown');
  });

  it('reads a response that is missing fields as missing them, not as empty strings', async () => {
    // A stale staging box, a cached origin. Half a profile is fine — half a *name* is not, and a
    // blank string would render as an empty row that looks like a value nobody filled in.
    api.getMe.mockResolvedValue({ role: 'worker', display_name: '   ', company: {} });

    const { profile } = await profiles.load();

    expect(profile?.displayName).toBeNull();
    expect(profile?.companyName).toBeNull();
    expect(profile?.userId).toBeNull();
  });

  it('never throws — it reports how the look went and returns nothing', async () => {
    // The contract this service shares with `ArchiveService`. A rejected promise reaching the
    // screen would leave a man looking at a spinner with no sentence under it.
    api.getMe.mockRejectedValue(new HttpErrorResponse({ status: 0 }));

    expect(await profiles.load()).toEqual({ status: 'offline', profile: null });
  });

  it('tells an unwell server apart from a refused credential', async () => {
    api.getMe.mockRejectedValue(new HttpErrorResponse({ status: 503 }));
    expect((await profiles.load()).status).toBe('unavailable');

    // 401 and 403 are one answer here: the server would not confirm this phone. Pinned because
    // `toProfileStatus` has a `default:` arm, so an unnamed kind would degrade in silence to
    // "the server is unwell" — telling a foreman the wrong thing about a revoked device.
    api.getMe.mockRejectedValue(new HttpErrorResponse({ status: 401 }));
    expect((await profiles.load()).status).toBe('unauthorized');

    api.getMe.mockRejectedValue(new HttpErrorResponse({ status: 403 }));
    expect((await profiles.load()).status).toBe('unauthorized');
  });

  it('does not call a server this build has none of', async () => {
    api.configured = false;

    expect(await profiles.load()).toEqual({ status: 'not_configured', profile: null });
    expect(api.getMe).not.toHaveBeenCalled();
  });

  it('enumerates every role, so the dictionaries can be checked against it', () => {
    // The screen builds `profile.role.${role}` by concatenation; `i18n.spec.ts` walks this list.
    expect([...PROFILE_ROLES].sort()).toEqual([
      'company_admin',
      'super_admin',
      'unknown',
      'worker',
    ]);
  });
});
