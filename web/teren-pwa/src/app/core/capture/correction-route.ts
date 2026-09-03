/**
 * The query parameter that turns `/record` into *record a correction of this day*.
 *
 * Named once and imported by both ends, exactly as `ARCHIVE_ENTRY_PARAM` is, because a query
 * parameter is the one half of a URL no guard derived from `app.routes.ts` can see. `?entry=` was
 * renamed in F4b and it was the single row of that table nothing pinned: flipping one producer
 * back left the whole suite green while a foreman landed on the diary list with his record
 * unopened. `app.routes.spec.ts` fails on a navigation that spells a parameter out as a literal,
 * which is what makes this constant load-bearing rather than tidy.
 *
 * **It carries an entry id and never a project id**, and that is the security property of the whole
 * gesture. The site of a correction is *derived* from the entry named here
 * (`correction.service.ts`); it is never passed alongside it, because a URL that carried both
 * could pair one day with another day's site — and the server answers a cross-project link with a
 * `404`, which is **terminal** in the outbox taxonomy. A wrong site would not bounce and heal; it
 * would abandon a captured day (ARCHITECTURE §7).
 */
export const CORRECTION_PARAM = 'supersedes';
