import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { environment } from '../../../environments/environment';
import { AUTH_GATEWAY, AuthGateway } from './auth-gateway';

/**
 * The two properties of the unauthenticated routes that are worth a spec of their own.
 *
 * 1. **They carry no `Authorization` header.** These are the only routes in the product reached
 *    without a credential. A phone that has never been activated still holds the build-time demo
 *    token (`environment.deviceToken`, until D7/F9), so a gateway built on `TerenApiClient` would
 *    send it — authenticating as the demo device while asking to become someone else. The seam
 *    exists to make that unavailable rather than merely discouraged.
 * 2. **They live under `/auth`, not `/api`.** That is what keeps the backend's
 *    `TenancyTests.Every_api_route_sits_behind_the_token` literally true rather than "true with
 *    exceptions" (§8).
 */
describe('HttpAuthGateway', () => {
  let http: HttpTestingController;
  let gateway: AuthGateway;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    gateway = TestBed.inject(AUTH_GATEWAY);
  });

  afterEach(() => http.verify());

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
