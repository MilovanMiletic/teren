import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';

import { TerenApiClient } from '../api/teren-api.client';
import { ArchiveService } from './archive.service';

describe('ArchiveService', () => {
  let api: {
    configured: boolean;
    listEntries: ReturnType<typeof vi.fn>;
    getEntry: ReturnType<typeof vi.fn>;
  };
  let archive: ArchiveService;

  beforeEach(() => {
    api = {
      configured: true,
      listEntries: vi.fn().mockResolvedValue({ entries: [], count: 0 }),
      getEntry: vi.fn().mockResolvedValue({ id: 'a' }),
    };
    TestBed.configureTestingModule({
      providers: [{ provide: TerenApiClient, useValue: api as unknown as TerenApiClient }],
    });
    archive = TestBed.inject(ArchiveService);
  });

  it('asks for one project at a time', async () => {
    await archive.listEntries('project-1');

    expect(api.listEntries).toHaveBeenCalledWith({ projectId: 'project-1', limit: 200 });
  });

  it('never throws when the network is gone — it reports and returns nothing', async () => {
    // The whole contract of this service. A rejected promise here would empty a list the phone
    // could have drawn on its own, and the archive has to work in a basement.
    api.listEntries.mockRejectedValue(new HttpErrorResponse({ status: 0 }));

    const result = await archive.listEntries('project-1');

    expect(result).toEqual({ status: 'offline', items: [] });
  });

  it('distinguishes an unwell server from an unauthorised device', async () => {
    api.listEntries.mockRejectedValue(new HttpErrorResponse({ status: 503 }));
    expect((await archive.listEntries('p')).status).toBe('unavailable');

    api.listEntries.mockRejectedValue(new HttpErrorResponse({ status: 401 }));
    expect((await archive.listEntries('p')).status).toBe('unauthorized');
  });

  it('does not call a server this build has no credentials for', async () => {
    api.configured = false;

    const result = await archive.listEntries('project-1');

    expect(api.listEntries).not.toHaveBeenCalled();
    expect(result.status).toBe('not_configured');
  });

  it('treats a 404 on one entry as information, not as a failure', async () => {
    // The normal state of everything still in the outbox: the phone has it, the server has never
    // seen it. The detail screen renders that as "not sent yet", not as an error.
    api.getEntry.mockRejectedValue(new HttpErrorResponse({ status: 404 }));

    const result = await archive.getEntry('a');

    expect(result).toEqual({ status: 'ok', entry: null, missing: true });
  });

  it('does not mistake a rejected request for a missing entry', async () => {
    // 400/409/422 all classify as `rejected`; only a 404 means "no such entry".
    api.getEntry.mockRejectedValue(new HttpErrorResponse({ status: 422 }));

    const result = await archive.getEntry('a');

    expect(result.missing).toBe(false);
    expect(result.status).toBe('unavailable');
  });
});
