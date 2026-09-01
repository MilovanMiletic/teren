import { HttpErrorResponse } from '@angular/common/http';

import { CompanyGateway } from '../core/company/company-gateway';
import {
  ActivationCodeResponse,
  CreateWorkerRequest,
  CreateWorkerResponse,
  DeviceListResponse,
  DeviceResponse,
  ShareTextResponse,
  WorkerListResponse,
} from '../core/company/company-types';
import { MockCompanyGateway } from '../core/company/mock-company-gateway';

/** A promise a spec releases when it chooses, so it can look at the screen mid-flight. */
export interface Deferred {
  promise: Promise<void>;
  release: () => void;
}

export function deferred(): Deferred {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export function httpError(status: number, body: unknown = { detail: 'no' }): HttpErrorResponse {
  return new HttpErrorResponse({ status, statusText: 'x', error: body });
}

/**
 * `MockCompanyGateway` with knobs, shared by the two screens of the office.
 *
 * The mock already models the backend those screens were written against — one company, two
 * foremen, three phones, one live code, and issuing that really supersedes — so the happy paths run
 * through it untouched and a spec can assert on what was actually asked for. What it cannot do is
 * refuse, because the endpoint it models does not refuse; these knobs supply the verdicts the
 * screens have to be honest about, and the gates let a spec look at a screen *while* a call is in
 * flight.
 *
 * Hand-written, with plain fields, for the reason the house style has settled on: a `vi.mock` of
 * the whole module would replace the narrowing between the wire and the glass, which on these
 * screens is half of what is under test.
 *
 * It lives in `testing/` rather than inside one spec because the people list and one man's page are
 * two screens over one backend, and two copies of this class would drift — the read gate in
 * particular exists for the worker page's freshness guard and would otherwise be invisible to the
 * list's specs.
 */
export class KnobbedGateway implements CompanyGateway {
  readonly real = new MockCompanyGateway();

  workersError: unknown = null;
  devicesError: unknown = null;
  readError: unknown = null;
  issueError: unknown = null;
  addError: unknown = null;
  revokeError: unknown = null;

  /**
   * Held open, a read lets a spec navigate away before an answer lands.
   *
   * {@link readGateFor} narrows it to **one** worker, which is what makes the worker page's
   * freshness guard testable: gate the man you are leaving, let the man you arrive at answer
   * immediately, then release the first. Without the narrowing both reads wait on one promise and
   * resolve in call order, which is the one ordering the guard does not need to survive.
   */
  readGate: Deferred | null = null;
  readGateFor: string | null = null;

  /**
   * Held open, the worker list waits.
   *
   * One mutable field rather than a queue, and that is enough to order two navigations: gate it,
   * start the read for the man you are leaving, clear it, arrive at the next man — whose read
   * answers at once — then release. The first answer lands last, which is the ordering the worker
   * page's freshness guard exists for.
   */
  workersGate: Deferred | null = null;
  revokeGate: Deferred | null = null;
  issueGate: Deferred | null = null;

  /** How many times each list was actually asked for, so a reload can be told from a repaint. */
  workerListings = 0;
  deviceListings = 0;

  get reads(): string[] {
    return this.real.reads;
  }
  get issues(): string[] {
    return this.real.issues;
  }
  get revokes(): string[] {
    return this.real.revokes;
  }
  get added(): CreateWorkerRequest[] {
    return this.real.added;
  }

  async listWorkers(): Promise<WorkerListResponse> {
    this.workerListings += 1;
    await this.workersGate?.promise;
    this.refuse(this.workersError);
    return this.real.listWorkers();
  }

  async listDevices(): Promise<DeviceListResponse> {
    this.deviceListings += 1;
    this.refuse(this.devicesError);
    return this.real.listDevices();
  }

  async shareText(workerId: string): Promise<ShareTextResponse> {
    if (this.readGateFor === null || this.readGateFor === workerId) {
      await this.readGate?.promise;
    }
    this.refuse(this.readError);
    return this.real.shareText(workerId);
  }

  async issueCode(workerId: string): Promise<ActivationCodeResponse> {
    await this.issueGate?.promise;
    this.refuse(this.issueError);
    return this.real.issueCode(workerId);
  }

  async addWorker(request: CreateWorkerRequest): Promise<CreateWorkerResponse> {
    this.refuse(this.addError);
    return this.real.addWorker(request);
  }

  async revokeDevice(deviceId: string): Promise<DeviceResponse> {
    await this.revokeGate?.promise;
    this.refuse(this.revokeError);
    return this.real.revokeDevice(deviceId);
  }

  private refuse(error: unknown): void {
    if (error) {
      throw error;
    }
  }
}
