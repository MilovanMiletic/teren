namespace Teren.Api.Contracts;

/// <summary>
/// <c>GET /api/platform/health</c> — what the pipeline is doing across the whole estate, and which
/// customer and which site each number belongs to (plan §8, decision 12 plus the founder's call of
/// 2026-08-30 on naming projects).
///
/// <para>
/// <b>What these DTOs deliberately do not contain, on the same terms as the rest of the platform
/// surface</b> (<see cref="PlatformCompanyResponse"/>): no addresses, no coordinates, no recipient
/// addresses, no project vocabulary, and no entry, transcript, photograph or report content of any
/// kind. A project's <em>name</em> is in and everything else about a project is out. There is no
/// entry id here, no report id, no <c>delivery_detail</c> — that last one is the relay's own
/// sentence about a named inbox, which is a recipient address arriving by a side door.
/// </para>
///
/// <para>
/// <b>Every string on this response comes from a closed vocabulary declared in <c>src/</c>.</b>
/// The failure tallies carry the <em>code</em> half of a stored reason and only if that code is one
/// <c>ProcessingFailure</c> or <c>ReportFailure</c> declares; anything else is reported as
/// <c>unrecognised</c>. The detail half is written by the pipeline and can fold in an external
/// provider's own words — the same hazard that keeps <c>AiProviderException</c> off the log sink's
/// exception allow-list (ARCHITECTURE §12) — so it never leaves the server. The only free text on
/// the whole payload is a company name and a site name, both of which staff already read in the
/// directory.
/// </para>
///
/// <para>
/// <b>This is where <c>PlatformPrivacyTests</c>' vocabulary had to be given an exemption, and it is
/// three properties wide.</b> A health page is inherently a table of entry counts by state, so
/// <see cref="PlatformPipelineHealth.EntryCount"/>, <see cref="PlatformPipelineHealth.Reported"/>
/// and <see cref="PlatformDeliveryHealth.ReportCount"/> collide with the very words that guard is
/// built from. They are admitted by name, by declaring type, and only as integers — <em>a count is
/// not content</em>. Nothing about the guard is relaxed for anyone else: <c>EntryCount</c> on a
/// company DTO still turns it red, which is the mutation §12 itself names as how this boundary
/// gets lost. Naming them something bland would have been the worse answer, because the guard's
/// own documentation admits a synonym always exists; a euphemism evades the tripwire instead of
/// confronting it.
/// </para>
///
/// <para>
/// <b>No paging.</b> These are aggregates, so there is no row to be seen twice — the reason keyset
/// paging exists on every other platform list does not apply. <see cref="Sites"/> is capped
/// instead, and says how many it left out.
/// </para>
/// </summary>
public sealed record PlatformHealthResponse(
    /// <summary>When the server computed this. The numbers are a snapshot and the screen should
    /// say so rather than looking live.</summary>
    DateTimeOffset At,
    PlatformPipelineHealth Pipeline,
    /// <summary>Why entries are stuck, estate-wide, largest first.</summary>
    IReadOnlyList<PlatformFailureTally> PipelineFailures,
    PlatformDeliveryHealth Delivery,
    /// <summary>Why reports did not go out, estate-wide, largest first.</summary>
    IReadOnlyList<PlatformFailureTally> DeliveryFailures,
    PlatformQueueHealth Queue,
    /// <summary>
    /// One row per site of every customer, <b>sites needing attention first</b> and then
    /// alphabetically by customer and site. That order is not cosmetic: it is what makes
    /// <see cref="SitesOmitted"/> safe, because truncation can then only ever drop a healthy site.
    /// A site that has never recorded anything is present with zeroes — an empty site is a real
    /// state and two of the three demo sites are in it.
    /// </summary>
    IReadOnlyList<PlatformSiteHealthResponse> Sites,
    /// <summary>How many sites did not fit the cap. Non-zero means the screen is not showing the
    /// whole estate, and it must say so; the day this is routinely non-zero is the day this
    /// response needs the paging it does not have.</summary>
    int SitesOmitted);

/// <summary>
/// Where a customer's days of work currently stand. One number per state of the entry state
/// machine (ARCHITECTURE §6), so the six add up to <see cref="EntryCount"/>.
/// <para>
/// <c>needs_review</c> and a non-empty <see cref="PlatformHealthResponse.PipelineFailures"/> are
/// the two the founder is actually looking for: each one is a foreman whose day did not become a
/// record on its own.
/// </para>
/// </summary>
public sealed record PlatformPipelineHealth(
    /// <summary>How many days of work exist here. A count, not a diary — see the file summary for
    /// why this name confronts the privacy guard rather than dodging it.</summary>
    int EntryCount,
    int Received,
    int Processing,
    int AwaitingConfirmation,
    int NeedsReview,
    int Confirmed,
    /// <summary>Sealed: the PDF went out and the row is now immutable.</summary>
    int Reported);

/// <summary>
/// The report state machine (ARCHITECTURE §6), counted. <see cref="Sending"/> that never falls is
/// the interesting one — a claim nobody is holding — and the sweeper is what turns it into
/// <see cref="Failed"/>.
/// <para>
/// <c>sent</c> means the relay took custody and never that a person read anything; this product
/// does not claim delivery and neither does this number.
/// </para>
/// </summary>
public sealed record PlatformDeliveryHealth(
    int ReportCount,
    int Sending,
    int Sent,
    int Failed);

/// <summary>
/// One reason and how many carry it. <see cref="Reason"/> is a code from
/// <c>ProcessingFailure</c>/<c>ReportFailure</c> — never the English detail stored beside it, and
/// never a string that reached the server from outside.
/// </summary>
public sealed record PlatformFailureTally(string Reason, int Count);

/// <summary>
/// The job queue, which is the difference between "nothing is failing" and "nothing is happening".
/// <para>
/// <see cref="Available"/> false means <b>unknown</b>: no job server is configured in this process,
/// or the storage could not be read. The screen must not draw that as an empty queue — see
/// <c>JobQueueDepth</c>.
/// </para>
/// </summary>
public sealed record PlatformQueueHealth(
    bool Available,
    /// <summary>A fixed token when <see cref="Available"/> is false (<c>not_configured</c>,
    /// <c>unreadable</c>), null otherwise. Never an exception message.</summary>
    string? Detail,
    int Enqueued,
    int Scheduled,
    int Processing,
    int Failed,
    /// <summary>Live job servers. Zero with <see cref="Available"/> true is the state where every
    /// request answers 200 and nothing is being transcribed, extracted or sent.</summary>
    int Servers);

/// <summary>
/// One site of one customer. The name is here by the founder's decision of 2026-08-30, so the
/// screen can say which site rather than printing a uuid; the address, the coordinates, the
/// recipients and the vocabulary are not, and are not in the model this was read from.
/// </summary>
public sealed record PlatformSiteHealthResponse(
    Guid CompanyId,
    string CompanyName,
    Guid ProjectId,
    string ProjectName,
    PlatformPipelineHealth Pipeline,
    IReadOnlyList<PlatformFailureTally> PipelineFailures,
    PlatformDeliveryHealth Delivery,
    IReadOnlyList<PlatformFailureTally> DeliveryFailures);
