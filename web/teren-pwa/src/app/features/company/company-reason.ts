import { CompanyStatus } from '../../core/company/company.service';

/**
 * Why the office could not be read, in the words these screens are allowed to use.
 *
 * A literal map rather than a concatenation, so `i18n.spec.ts` sees every key by reading the
 * source — the same reason `profile-page.ts` and `archive-page.ts` write theirs out in full. The
 * `Record<Exclude<CompanyStatus, 'ok'>, string>` is what the compiler checks: a new status does
 * not build until it has a sentence, and `ok` is excluded because "it worked" is not a reason.
 *
 * It lives in a file of its own rather than on `company-page.ts` because the office is two screens
 * since the people/worker split — the list and one man's page — and both have to say the same
 * thing about the same failure. Importing the map from the other screen's component file would
 * drag a whole lazy chunk across for one constant.
 */
export const COMPANY_REASON_KEYS: Record<Exclude<CompanyStatus, 'ok'>, string> = {
  offline: 'company.reason.offline',
  signedOut: 'company.reason.signedOut',
  forbidden: 'company.reason.forbidden',
  notSignedIn: 'company.reason.notSignedIn',
  refused: 'company.reason.refused',
  unavailable: 'company.reason.unavailable',
};

/** The sentence for a status, or null when there is nothing to explain. */
export function companyReasonFor(status: CompanyStatus | null): string | null {
  return status === null || status === 'ok' ? null : COMPANY_REASON_KEYS[status];
}
