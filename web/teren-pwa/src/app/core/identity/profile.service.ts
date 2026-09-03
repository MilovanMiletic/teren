import { Injectable, inject } from '@angular/core';

import { MeResponse } from '../api/api-types';
import { classifyApiError } from '../api/api-failure';
import { TerenApiClient } from '../api/teren-api.client';

/**
 * The three roles, plus the answer for a role this build has never heard of.
 *
 * `unknown` is a member rather than a `null`, because the profile screen names the role out loud
 * and every branch of that must land on a sentence. A server that grows a fourth role — or an
 * older phone meeting a newer server — then reads "role this app does not recognise" instead of
 * rendering a raw wire string next to a man's name.
 */
export type ProfileRole = 'worker' | 'company_admin' | 'super_admin' | 'unknown';

/**
 * Every member of {@link ProfileRole} as a value, kept complete by a `Record` the compiler checks.
 *
 * The screen builds `profile.role.${role}` by concatenation, so no scan of string literals can see
 * the keys it produces — the same hazard `AUTH_FAILURES` and `CONFIRM_FAILURES` exist for, and the
 * same fix. `i18n.spec.ts` walks this list, so a new role does not pass until both dictionaries
 * can name it.
 */
const ALL_PROFILE_ROLES: Record<ProfileRole, true> = {
  worker: true,
  company_admin: true,
  super_admin: true,
  unknown: true,
};

export const PROFILE_ROLES = Object.keys(ALL_PROFILE_ROLES) as readonly ProfileRole[];

/**
 * How the last look at `/api/me` went.
 *
 * `ok` is the only status that lets the screen claim what it shows was confirmed by the server a
 * moment ago. The other four are the ways a profile can be *unconfirmed*, and the screen says
 * which one it met — a profile screen that quietly showed a stale name would be this app's sixth
 * screen to claim knowledge it did not have.
 */
export type ProfileStatus = 'ok' | 'offline' | 'unauthorized' | 'not_configured' | 'unavailable';

/**
 * A person, as this app is allowed to describe one.
 *
 * Every field is nullable and none of them is inferred. A worker has a username, a company and a
 * device; a company admin has a company and neither of the others; a super admin has only a name
 * and a role (§4: `ck_app_user_company_scope` makes a super admin inside a company impossible, so
 * a null company there is the *correct* answer rather than a missing one). The screen draws the
 * rows it has and says nothing about the rest.
 */
export interface Profile {
  role: ProfileRole;
  userId: string | null;
  displayName: string | null;
  /** The durable identity (decision 7) — the one thing that survives a broken phone. */
  username: string | null;
  companyName: string | null;
  deviceName: string | null;
  /** The language the *server* holds for this person, which is not this phone's UI setting. */
  language: string | null;
}

export interface ProfileResult {
  status: ProfileStatus;
  /** What the server said. Null on every failure — never a half-read person. */
  profile: Profile | null;
}

/**
 * The profile screen's connection to the server.
 *
 * **Best effort by construction**, exactly as `ArchiveService` is: no method throws, and every one
 * returns a status alongside whatever it managed to get. The screen has a second source — the
 * session this phone stored when it was activated — so a failure here is not an empty screen, it
 * is a screen that shows what the phone knows and says plainly that it could not check.
 *
 * Nothing here is on the capture path and nothing awaits it. The route gate reads `localStorage`
 * synchronously and must keep doing so (`core/session/device.guard.ts`); this call happens after a
 * screen is already on the glass.
 */
@Injectable({ providedIn: 'root' })
export class ProfileService {
  private readonly api = inject(TerenApiClient);

  async load(): Promise<ProfileResult> {
    if (!this.api.configured) {
      return { status: 'not_configured', profile: null };
    }
    try {
      return { status: 'ok', profile: narrow(await this.api.getMe()) };
    } catch (error) {
      return { status: toProfileStatus(error), profile: null };
    }
  }
}

/**
 * The wire shape, field by field, with no field invented.
 *
 * Unlike `toSession`, this is deliberately **not** all-or-nothing. A session is a credential and
 * half of one is worse than none; a profile is a description, and a response that carried a name
 * but no device name should still put the man's name on screen. What must never happen is a field
 * being *filled in* from somewhere else, so every absent value stays `null` and the screen omits
 * the row rather than guessing.
 */
function narrow(response: MeResponse): Profile {
  return {
    role: toRole(response.role),
    userId: text(response.user_id),
    displayName: text(response.display_name),
    username: text(response.username),
    companyName: text(response.company?.name),
    deviceName: text(response.device?.name),
    language: text(response.language),
  };
}

function toRole(value: unknown): ProfileRole {
  return typeof value === 'string' && value in ALL_PROFILE_ROLES && value !== 'unknown'
    ? (value as ProfileRole)
    : 'unknown';
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The B3 taxonomy reduced to the four things this screen can say.
 *
 * Reusing `classifyApiError` rather than reading statuses again is the same choice `ArchiveService`
 * and `ActivationService` made, for the same reason: what a status *means* — status 0 is a network
 * failure and not the server's answer, every 5xx is the server being unwell — was settled at B3 and
 * is binding. Two places deciding it independently is how two screens end up disagreeing about
 * whether the server is down.
 *
 * 401 and 403 are one answer here. The upload path splits them because only it has to decide
 * whether retrying can help; this screen says "the server did not accept this phone" either way.
 *
 * **Since 2026-09-03 the 401 half is mostly unreachable, and that is by founder decision rather
 * than by accident.** This comment said the screen reports a refusal "without locking anything: a
 * revoked device keeps recording" (decision 8). A refused phone now signs itself out
 * (`core/session/device-refusal.service.ts`) and `/profile` is device-gated, so a 401 here takes
 * him to `/welcome` before the sentence can be read. The mapping stays exactly as it is: the 403
 * path is unaffected and must not sign anybody out, and a sentence that is correct and rarely
 * reached is worth more than a screen that renders a blank card in the case nobody predicted.
 */
function toProfileStatus(error: unknown): ProfileStatus {
  switch (classifyApiError(error).kind) {
    case 'offline':
      return 'offline';
    case 'unauthenticated':
    case 'unauthorized':
      return 'unauthorized';
    case 'not_configured':
    case 'insecure_context':
      return 'not_configured';
    default:
      return 'unavailable';
  }
}
