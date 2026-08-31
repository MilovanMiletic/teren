/**
 * The archive's open record, as a query parameter — named once, imported by every side.
 *
 * `diary` is a single route and the open record travels as `?entry=<id>` rather than as a path
 * segment (`archive-page.ts` explains why: two sibling route configs would tear down and rebuild
 * the desktop list rail on every click). That choice has a cost, and this constant is the price:
 * a query parameter is a **contract between three producers and one consumer with no compiler in
 * between**, and unlike a path it is invisible to `app.routes.ts` — the route table cannot see it,
 * and neither can any guard derived from the table.
 *
 * F4b renamed `?unos=` to `?entry=` along with the six Serbian paths, and this was the one row of
 * that table nothing pinned: producer and consumer each restated their own literal, so flipping a
 * producer back to `unos` left the whole suite green while a foreman who confirmed an entry landed
 * on the diary *list* with his record unopened — the exact silent drift F4b existed to make
 * impossible.
 *
 * So: **never write this parameter's name as a literal.** Both sides import the constant, which
 * makes them one symbol the compiler resolves, and `app.routes.spec.ts` fails on any navigation
 * that spells a query parameter out by hand. `RETURN_URL_PARAM` in `core/session/return-url.ts` is
 * the same idea for `?next=`.
 */
export const ARCHIVE_ENTRY_PARAM = 'entry';
