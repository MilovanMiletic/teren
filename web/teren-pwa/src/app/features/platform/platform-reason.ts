import { PlatformStatus } from '../../core/platform/platform.service';

/**
 * Why the platform surface could not be read or written, in the words these screens may use.
 *
 * A literal map rather than a concatenation, so `i18n.spec.ts` sees every key by reading the
 * source — the same reason `company-reason.ts`, `profile-page.ts` and `archive-page.ts` write
 * theirs out in full. The `Record<Exclude<PlatformStatus, 'ok'>, string>` is what the compiler
 * checks: a new status does not build until it has a sentence, and `ok` is excluded because "it
 * worked" is not a reason.
 *
 * In a file of its own because the platform is more than one screen — the people directory and the
 * companies page — and both must say the same thing about the same failure. Importing the map from
 * one screen's component file would drag a whole lazy chunk across for a constant.
 */
export const PLATFORM_REASON_KEYS: Record<Exclude<PlatformStatus, 'ok'>, string> = {
  offline: 'platform.reason.offline',
  signedOut: 'platform.reason.signedOut',
  forbidden: 'platform.reason.forbidden',
  notSignedIn: 'platform.reason.notSignedIn',
  refused: 'platform.reason.refused',
  emailTaken: 'platform.reason.emailTaken',
  unavailable: 'platform.reason.unavailable',
};

/** The sentence for a status, or null when there is nothing to explain. */
export function platformReasonFor(status: PlatformStatus | null): string | null {
  return status === null || status === 'ok' ? null : PLATFORM_REASON_KEYS[status];
}
