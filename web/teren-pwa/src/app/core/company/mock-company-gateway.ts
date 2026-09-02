import { HttpErrorResponse } from '@angular/common/http';

import { MeResponse } from '../api/api-types';
import { CompanyGateway } from './company-gateway';
import {
  ActivationCodeResponse,
  CreateWorkerRequest,
  CreateWorkerResponse,
  DeviceListResponse,
  DeviceResponse,
  ShareTextResponse,
  WorkerListResponse,
  WorkerResponse,
} from './company-types';

/**
 * A standing-in backend for the company-admin surface.
 *
 * ## What it models, and why it models *that*
 *
 * One company, two foremen, three phones. It is not a toy: the states it can be in are the ones
 * the screen has to get right, and every one of them was read off the running API rather than
 * imagined —
 *
 * - a worker with a live code and an active phone,
 * - a worker with **no** live code at all, which the server reports as
 *   `409 no_live_activation_code` from `GET /share-text` and which is the state the demo company
 *   was actually in on 2026-08-31,
 * - phones that are already revoked, which `GET /api/devices` returns alongside the live ones.
 *
 * **Issuing supersedes**, exactly as the endpoint does, and every call is recorded. That is what
 * lets a spec prove the constraint this feature exists to enforce: reading a code never spends it,
 * and no screen ever holds two workers' codes at once.
 *
 * ## It is not wired into the app
 *
 * `COMPANY_GATEWAY`'s factory returns `HttpCompanyGateway`, always. Nothing in `app.config.ts`
 * provides this class, so it is not in the production bundle — a mock the app could fall back to
 * on its own is a mock that will one day answer a real admin.
 */
export class MockCompanyGateway implements CompanyGateway {
  static readonly ZORAN_ID = 'd3a0c1f0-5b8e-4f1a-9c62-0000000000a2';
  static readonly MARKO_ID = 'd3a0c1f0-5b8e-4f1a-9c62-0000000000a3';
  static readonly ZORAN_PHONE_ID = 'd3a0c1f0-5b8e-4f1a-9c62-0000000000dd';
  static readonly ZORAN_OLD_PHONE_ID = 'd3a0c1f0-5b8e-4f1a-9c62-0000000000de';
  static readonly MARKO_PHONE_ID = 'd3a0c1f0-5b8e-4f1a-9c62-0000000000df';
  static readonly LIVE_CODE = 'XKD4-7HMP';
  static readonly ADMIN_ID = 'd3a0c1f0-5b8e-4f1a-9c62-0000000000a1';
  static readonly ADMIN_EMAIL = 'petar.petrovic@vodoinstal-petrovic.example.com';

  /** Every call that reached the wire, so a spec can assert on what was actually asked for. */
  readonly reads: string[] = [];
  readonly issues: string[] = [];
  readonly revokes: string[] = [];
  readonly added: CreateWorkerRequest[] = [];

  /** Which workers currently hold a code a man could type. Keyed by worker id. */
  private codes = new Map<string, string>([[MockCompanyGateway.ZORAN_ID, MockCompanyGateway.LIVE_CODE]]);

  private issuedCount = 0;

  /** How many times the account screen asked who it is showing. */
  meCalls = 0;

  /** Swap this to model an older server, a foreman's answer, or a missing address. */
  account: MeResponse = {
    role: 'company_admin',
    user_id: MockCompanyGateway.ADMIN_ID,
    display_name: 'Petar Petrović',
    username: null,
    email: MockCompanyGateway.ADMIN_EMAIL,
    language: 'sr',
    company: { id: 'd3a0c1f0-5b8e-4f1a-9c62-000000000001', name: 'Vodoinstal Petrović d.o.o.' },
    device: null,
    created_at: '2026-07-15T09:00:00.000Z',
    last_login_at: '2026-08-31T06:40:00.000Z',
  };

  private workers: WorkerResponse[] = [
    {
      id: MockCompanyGateway.ZORAN_ID,
      username: 'zoran.jovanovic',
      display_name: 'Zoran Jovanović',
      email: 'zoran.jovanovic@vodoinstal-petrovic.example.com',
      language: 'sr',
      created_at: '2026-08-01T07:00:00.000Z',
      disabled_at: null,
      active_device_count: 1,
      last_seen_at: '2026-08-31T13:19:13.000Z',
      has_live_activation_code: true,
    },
    {
      id: MockCompanyGateway.MARKO_ID,
      username: 'marko.markovic',
      display_name: 'Marko Marković',
      email: null,
      language: 'sr',
      created_at: '2026-08-20T07:00:00.000Z',
      disabled_at: null,
      active_device_count: 0,
      last_seen_at: null,
      has_live_activation_code: false,
    },
  ];

  private devices: DeviceResponse[] = [
    {
      id: MockCompanyGateway.ZORAN_PHONE_ID,
      name: 'Zoranov telefon',
      user_id: MockCompanyGateway.ZORAN_ID,
      worker_display_name: 'Zoran Jovanović',
      worker_username: 'zoran.jovanovic',
      created_at: '2026-08-01T07:05:00.000Z',
      last_seen_at: '2026-08-31T13:19:13.000Z',
      revoked_at: null,
    },
    {
      id: MockCompanyGateway.ZORAN_OLD_PHONE_ID,
      name: 'Stari telefon',
      user_id: MockCompanyGateway.ZORAN_ID,
      worker_display_name: 'Zoran Jovanović',
      worker_username: 'zoran.jovanovic',
      created_at: '2026-07-01T07:05:00.000Z',
      last_seen_at: '2026-07-30T13:19:13.000Z',
      revoked_at: '2026-08-01T07:05:00.000Z',
    },
    {
      id: MockCompanyGateway.MARKO_PHONE_ID,
      name: 'Markov telefon',
      user_id: MockCompanyGateway.MARKO_ID,
      worker_display_name: 'Marko Marković',
      worker_username: 'marko.markovic',
      created_at: '2026-08-21T07:05:00.000Z',
      last_seen_at: null,
      revoked_at: null,
    },
  ];

  /**
   * The admin himself — **a company_admin, not a worker**, and the distinction is the point.
   *
   * He has no username and no device by constraint (§4), so a mock that handed back a foreman
   * here would let the account screen pass its specs while rendering rows that cannot exist for
   * the man it is built for.
   */
  async me(): Promise<MeResponse> {
    this.meCalls += 1;
    return { ...this.account };
  }

  async listWorkers(): Promise<WorkerListResponse> {
    const workers = this.workers.map((worker) => ({
      ...worker,
      has_live_activation_code: this.codes.has(worker.id ?? ''),
    }));
    return { workers, count: workers.length };
  }

  async addWorker(request: CreateWorkerRequest): Promise<CreateWorkerResponse> {
    this.added.push(request);
    const id = `d3a0c1f0-5b8e-4f1a-9c62-00000000${(this.workers.length + 10).toString().padStart(4, '0')}`;
    const worker = {
      id,
      username: request.display_name.toLowerCase().replace(/\s+/g, '.'),
      display_name: request.display_name,
      email: request.email ?? null,
      language: request.language ?? 'sr',
      created_at: '2026-08-31T14:00:00.000Z',
      disabled_at: null,
      active_device_count: 0,
      last_seen_at: null,
      has_live_activation_code: true,
    };
    this.workers = [...this.workers, worker];
    const code = this.mint(id);
    return { worker, activation_code: code };
  }

  /** A read. It never mints, never supersedes, and a spec proves both. */
  async shareText(workerId: string): Promise<ShareTextResponse> {
    this.reads.push(workerId);
    const code = this.codes.get(workerId);
    if (!code) {
      throw noLiveCode();
    }
    const worker = this.workers.find((candidate) => candidate.id === workerId);
    return {
      text: `Zdravo ${worker?.display_name ?? ''}, kod: ${code}`,
      language: 'sr',
      activation_code: this.describe(code),
    };
  }

  async issueCode(workerId: string): Promise<ActivationCodeResponse> {
    this.issues.push(workerId);
    return this.mint(workerId);
  }

  async listDevices(): Promise<DeviceListResponse> {
    return { devices: this.devices.map((device) => ({ ...device })), count: this.devices.length };
  }

  async revokeDevice(deviceId: string): Promise<DeviceResponse> {
    this.revokes.push(deviceId);
    const device = this.devices.find((candidate) => candidate.id === deviceId);
    if (!device) {
      throw notFound();
    }
    // Idempotent, as the endpoint is: a second revoke answers exactly as the first.
    device.revoked_at ??= '2026-08-31T15:00:00.000Z';
    return { ...device };
  }

  /** A fresh code, superseding whatever that worker had. The endpoint's behaviour, in one line. */
  private mint(workerId: string): ActivationCodeResponse {
    this.issuedCount += 1;
    const code = `NEW${this.issuedCount}-CODE`;
    this.codes.set(workerId, code);
    return this.describe(code);
  }

  private describe(code: string): ActivationCodeResponse {
    return {
      code,
      created_at: '2026-08-31T14:00:00.000Z',
      expires_at: '2026-09-07T14:00:00.000Z',
      email_delivery: 'not_configured',
    };
  }
}

/**
 * The server's answer when there is nothing the man could type right now.
 *
 * A 409 with a **`code`**, not prose: `ApiProblems.Conflict(code, detail)` puts the stable token
 * in the body precisely so a client can branch on it, and a mock that omitted it would let a
 * client that reads the English detail string pass its specs.
 */
function noLiveCode(): HttpErrorResponse {
  return new HttpErrorResponse({
    status: 409,
    statusText: 'Conflict',
    error: {
      title: 'Conflict',
      code: 'no_live_activation_code',
      detail: 'Worker has no live activation code. POST to this route to issue one.',
    },
  });
}

function notFound(): HttpErrorResponse {
  return new HttpErrorResponse({
    status: 404,
    statusText: 'Not Found',
    error: { title: 'Not found', detail: 'Device was not found.' },
  });
}
