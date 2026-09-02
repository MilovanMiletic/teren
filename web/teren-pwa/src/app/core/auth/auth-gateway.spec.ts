import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { environment } from '../../../environments/environment';
import { SESSION_STORAGE_KEY } from '../session/session';
import { SessionService } from '../session/session.service';
import { AUTH_GATEWAY, AuthGateway } from './auth-gateway';

/**
 * A phone that already belongs to somebody, seeded into `localStorage` before the injector is
 * built — `SessionService` reads the credential during construction.
 *
 * **This is not scenery.** The claim below is about *re*-activation, which happens on a phone that
 * holds a live session: a foreman whose device was revoked, or one being handed to another man. An
 * empty `localStorage` would make the assertion pass for the uninteresting reason (there is no
 * credential to leak) and say nothing about the interesting one.
 */
const SESSION = {
  token: 'trn_d_a-real-device-token',
  deviceId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  username: 'zoran.jovanovic',
  displayName: 'Zoran Jovanović',
  companyId: '33333333-3333-3333-3333-333333333333',
  companyName: 'Gradnja d.o.o.',
  activatedAt: '2026-08-30T08:00:00.000Z',
};

/**
 * The two properties of the unauthenticated routes that are worth a spec of their own.
 *
 * 1. **They carry no `Authorization` header.** These are the only routes in the product reached
 *    without a credential, and the seam exists to make sending one unavailable rather than merely
 *    discouraged. Until D7/F9 a phone that had never been activated still held the build-time demo
 *    token, so a gateway built on `TerenApiClient` would have authenticated as the demo device
 *    while asking to become someone else. That particular credential is gone; the shape of the
 *    mistake is not, because a *re*-activation happens on a phone that does hold a session, and
 *    that is the case this asserts against.
 * 2. **They live under `/auth`, not `/api`.** That is what keeps the backend's
 *    `TenancyTests.Every_api_route_sits_behind_the_token` literally true rather than "true with
 *    exceptions" (§8).
 */
describe('HttpAuthGateway', () => {
  let http: HttpTestingController;
  let gateway: AuthGateway;

  beforeEach(() => {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(SESSION));
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    gateway = TestBed.inject(AUTH_GATEWAY);
    // The premise of every assertion below: there *is* a credential on this phone, and none of
    // these three routes may send it.
    expect(TestBed.inject(SessionService).token()).toBe(SESSION.token);
  });

  afterEach(() => {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    http.verify();
  });

  it('activates without a bearer, under /auth', async () => {
    const pending = gateway.activate({
      username: 'zoran.jovanovic',
      activation_code: 'XKD47HMP',
      device_name: 'Android · Chrome',
    });

    const request = http.expectOne(`${environment.apiBaseUrl}/auth/activate`);
    expect(request.request.method).toBe('POST');
    expect(request.request.headers.has('Authorization')).toBe(false);
    // snake_case on the wire, like every other body this API exchanges.
    expect(Object.keys(request.request.body as object)).toEqual([
      'username',
      'activation_code',
      'device_name',
    ]);

    request.flush({ device_token: 'trn_d_x' });
    expect((await pending).device_token).toBe('trn_d_x');
  });

  it('asks for a code without a bearer', async () => {
    const pending = gateway.requestActivationCode({ username: 'zoran.jovanovic' });

    const request = http.expectOne(`${environment.apiBaseUrl}/auth/activation-code`);
    expect(request.request.headers.has('Authorization')).toBe(false);
    // 202 with no body is the specified answer, whether or not the username exists.
    request.flush(null, { status: 202, statusText: 'Accepted' });
    await pending;
  });

  it('signs in without a bearer', async () => {
    const pending = gateway.login({ email: 'vlasnik@gradnja.rs', password: 'x' });

    const request = http.expectOne(`${environment.apiBaseUrl}/auth/login`);
    expect(request.request.headers.has('Authorization')).toBe(false);

    request.flush({ session_token: 'trn_s_x', role: 'company_admin' });
    expect((await pending).role).toBe('company_admin');
  });
});
