import { HttpErrorResponse } from '@angular/common/http';

import { AuthGateway } from './auth-gateway';
import {
  ActivateRequest,
  ActivateResponse,
  LoginRequest,
  LoginResponse,
  RequestActivationCodeRequest,
} from './auth-types';

/**
 * A standing-in backend for the three auth routes.
 *
 * ## Why it exists
 *
 * D2 and D3 — the increments that build `/auth/activate` and `/auth/login` — are being written in
 * parallel and are not merged. Without this, none of F3 could be exercised: not the specs, not a
 * founder clicking through the screens, not a reviewer checking that a rejected code leaves the
 * field alone. With it, every path through the screens is reachable today, and the day the routes
 * land the only change is which implementation `AUTH_GATEWAY` resolves to.
 *
 * ## It is not wired into the app
 *
 * `AUTH_GATEWAY`'s factory returns {@link HttpAuthGateway}, always. Nothing in `app.config.ts`
 * provides this class, so it is not in the production bundle; a spec provides it explicitly, and
 * a developer wanting to click through the screens without a server adds one provider line and
 * takes it out again. That is deliberate: a mock that the app could fall back to on its own is a
 * mock that will one day answer a real foreman.
 *
 * ## What it pretends
 *
 * One worker, one code, one admin. The code is compared in canonical form, so a spec can prove
 * that a Cyrillic-typed code reaches the wire as the ASCII the server would hash. Everything else
 * is rejected the way the server is specified to reject it: **401 for every credential failure**
 * (§7 — unknown username, wrong code, revoked device and disabled user are byte-identical,
 * because "revoked" versus "unknown" is an oracle), and 202 with no body for a code request,
 * whether or not the username exists.
 */
export class MockAuthGateway implements AuthGateway {
  static readonly USERNAME = 'zoran.jovanovic';
  static readonly CODE = 'XKD47HMP';
  static readonly EMAIL = 'vlasnik@gradnja.rs';
  static readonly PASSWORD = 'lozinka-koja-nije-tajna';

  /** Every request that reached the wire, so a spec can assert on what was actually sent. */
  readonly activations: ActivateRequest[] = [];
  readonly codeRequests: RequestActivationCodeRequest[] = [];
  readonly logins: LoginRequest[] = [];

  async activate(request: ActivateRequest): Promise<ActivateResponse> {
    this.activations.push(request);

    if (
      request.username !== MockAuthGateway.USERNAME ||
      request.activation_code !== MockAuthGateway.CODE
    ) {
      throw unauthorized();
    }

    return {
      device_token: 'trn_d_mock-device-token',
      device_id: '44444444-4444-4444-4444-444444444444',
      worker: {
        user_id: '22222222-2222-2222-2222-222222222222',
        username: MockAuthGateway.USERNAME,
        display_name: 'Zoran Jovanović',
      },
      company: { id: '33333333-3333-3333-3333-333333333333', name: 'Gradnja d.o.o.' },
      email_delivery: 'not_configured',
    };
  }

  async requestActivationCode(request: RequestActivationCodeRequest): Promise<void> {
    // Accepted whatever the username is. The uniform answer is the point, not a shortcut.
    this.codeRequests.push(request);
  }

  async login(request: LoginRequest): Promise<LoginResponse> {
    this.logins.push(request);

    if (request.email !== MockAuthGateway.EMAIL || request.password !== MockAuthGateway.PASSWORD) {
      throw unauthorized();
    }

    return {
      session_token: 'trn_s_mock-session-token',
      expires_at: '2026-09-29T08:00:00.000Z',
      role: 'company_admin',
      display_name: 'Milan Gradnja',
      company: { id: '33333333-3333-3333-3333-333333333333', name: 'Gradnja d.o.o.' },
    };
  }
}

/** The server's one answer to every credential failure. */
function unauthorized(): HttpErrorResponse {
  return new HttpErrorResponse({
    status: 401,
    statusText: 'Unauthorized',
    error: { title: 'Unauthorized', detail: 'credential not accepted' },
  });
}
