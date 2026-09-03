/**
 * The action vocabulary, from the wire contract §4 — **the only file in the app that spells one
 * out as a string.**
 *
 * ## Why it is a map of constants rather than thirty string literals at their call sites
 *
 * The vocabulary is a slug namespace (`area.thing.verb`) and it collides, by pure coincidence,
 * with the shape of a Transloco key (`namespace.block.leaf`). `i18n.spec.ts` scans every source
 * file for anything shaped like a key and fails when the dictionaries cannot answer it — which is
 * a guard worth keeping, and which would read `'capture.send'` in a component as a missing Serbian
 * sentence. Naming the slugs here, in one file the scan skips, keeps both true: the screens
 * reference `ACTIONS.captureSend`, the dictionaries stay honest, and the vocabulary is in one
 * place where it can be compared against the contract by eye.
 *
 * A template declares its slug as `data-log="capture.send"` instead; the same spec strips those
 * attributes before scanning, for the same reason.
 *
 * **Adding a member here is not enough to make it legal.** The server validates the slug shape and
 * refuses an event whole if it fails; `client-event.spec.ts` walks this map against the pattern so
 * a typo is a red spec rather than a log line that silently never arrives.
 */
export const ACTIONS = {
  navRouteEnter: 'nav.route.enter',

  captureRecordStart: 'capture.record.start',
  captureRecordStop: 'capture.record.stop',
  captureRecordDiscard: 'capture.record.discard',
  capturePhotoAdd: 'capture.photo.add',
  // No `capture.photo.remove`: there is no control that removes a photograph from an entry.
  // A slug for a button nobody can press is the same defect as a button nobody logs — the
  // vocabulary would describe an app that does not exist, and `action-wiring.spec.ts` would
  // have to carry an exception for it. Add it back in the same commit as the control.
  captureSend: 'capture.send',

  confirmOpen: 'confirm.open',
  confirmEdit: 'confirm.edit',
  confirmSend: 'confirm.send',
  confirmVerbatim: 'confirm.verbatim',

  archiveOpen: 'archive.open',
  archiveEntryOpen: 'archive.entry.open',
  archiveMediaOpen: 'archive.media.open',
  archiveReportDownload: 'archive.report.download',
  /**
   * A correction was started from a closed record (2026-09-03).
   *
   * Worth a name of its own rather than folding into `capture.record.start`: this is the gesture
   * that answers PROJECT.md invariant 2, and how often a foreman reaches for it is the measure of
   * whether the confirmation gate is catching mistakes before the report goes out or after.
   *
   * No entry id and no site travel with it — a slug and nothing else, like every other press.
   */
  archiveCorrectionStart: 'archive.correction.start',

  companyWorkerOpen: 'company.worker.open',
  companyWorkerAdd: 'company.worker.add',
  companyCodeIssue: 'company.code.issue',
  companyCodeReveal: 'company.code.reveal',

  platformCompanyOpen: 'platform.company.open',
  platformUserOpen: 'platform.user.open',
  platformInviteSend: 'platform.invite.send',
  platformUserDisable: 'platform.user.disable',

  logsOpen: 'logs.open',
  logsFilter: 'logs.filter',
  logsExport: 'logs.export',

  /**
   * The estate's health screen was opened (`/platform/health`, F7).
   *
   * One slug for the screen and none for its controls, the same as the log viewer: there is
   * exactly one thing to do on it — read it — and a reload that logged itself would tell us how
   * often a founder pressed refresh rather than anything about the product.
   */
  healthOpen: 'health.open',

  sessionLogin: 'session.login',
  sessionLogout: 'session.logout',
  sessionActivate: 'session.activate',
  /**
   * The server refused this phone's credential and the phone signed itself out (2026-09-03).
   *
   * Not a press — nobody chose it — and that is exactly why it is worth a slug: it is the one
   * event that answers "why did this phone stop" without anybody having to guess between a
   * revoked device, a removed worker and a suspended company, which the 401 itself deliberately
   * cannot tell apart. Raised by `core/session/device-refusal.service.ts`.
   */
  sessionDeviceRefused: 'session.device.refused',

  appStart: 'app.start',
  appOffline: 'app.offline',
  appOnline: 'app.online',
  /** Not only a crash: it is also how the log says its own buffer overflowed and lost lines. */
  appError: 'app.error',
} as const;

/** Every slug as a value, for the spec that checks each one against the contract's pattern. */
export const ACTION_VOCABULARY: readonly string[] = Object.values(ACTIONS);
