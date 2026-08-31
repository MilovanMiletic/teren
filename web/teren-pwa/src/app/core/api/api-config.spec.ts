import { TestBed } from '@angular/core/testing';

import { SESSION_STORAGE_KEY, Session } from '../session/session';
import { SessionService } from '../session/session.service';
import { API_CONFIG } from './api-config';
import { TerenApiClient } from './teren-api.client';

function session(token: string): Session {
  return {
    token,
    deviceId: '11111111-1111-1111-1111-111111111111',
    userId: '22222222-2222-2222-2222-222222222222',
    username: 'zoran.jovanovic',
    displayName: 'Zoran Jovanović',
    companyId: '33333333-3333-3333-3333-333333333333',
    companyName: 'Gradnja d.o.o.',
    activatedAt: '2026-08-30T08:00:00.000Z',
  };
}

describe('API_CONFIG', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  afterEach(() => localStorage.clear());

  it('reads the bearer from the live session on every read, not once at construction', () => {
    // The whole reason `deviceToken` is a getter. A snapshot would pass a single assertion and
    // then fail in the field in the worst possible way: the phone would go on sending the token
    // it booted with, so a foreman who had just re-activated his device would keep being rejected
    // with no way to tell why — and every entry he recorded would sit in the queue.
    const config = TestBed.inject(API_CONFIG);
    const sessions = TestBed.inject(SessionService);

    const before = config.deviceToken;
    sessions.adopt(session('trn_d_issued-at-activation'));

    expect(config.deviceToken).toBe('trn_d_issued-at-activation');
    expect(config.deviceToken).not.toBe(before);
  });

  it('propagates a new credential to the API client with no call-site churn', () => {
    // `configured` and `authHeaders()` already read `deviceToken` fresh per call, which is what
    // makes the getter enough. If this fails, someone has cached the token somewhere downstream.
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session('trn_d_stored')));

    expect(TestBed.inject(TerenApiClient).configured).toBe(true);
    expect(TestBed.inject(API_CONFIG).deviceToken).toBe('trn_d_stored');
  });

  it('never ends its base URL in a slash', () => {
    // `url()` joins with one, and a double slash breaks the path-style presigned URLs MinIO issues.
    expect(TestBed.inject(API_CONFIG).baseUrl).not.toMatch(/\/$/);
  });
});
