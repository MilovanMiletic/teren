using System.Reflection;
using Microsoft.EntityFrameworkCore;
using Teren.Api.Contracts;
using Teren.Core.Entities;
using Teren.Core.Processing;
using Teren.Core.Reporting;
using Teren.Core.Time;

namespace Teren.Api.Platform;

/// <summary>
/// The health half of the platform surface: what the pipeline is doing, and whose (plan §8).
///
/// <para>
/// <b>A partial of <see cref="PlatformDirectory"/> for the same reason the log stream is one.</b>
/// <c>PlatformPrivacyTests</c> reflects over exactly one named type; a tidy little
/// <c>PlatformHealth</c> class beside it would be a second surface the guard never looks at, which
/// is the hole the guard exists to close, opened in the name of neatness.
/// </para>
///
/// <para>
/// <b>This is the one place on the platform path that reads the evidence tables, and it reads four
/// columns of each.</b> <c>TerenIdentityDbContext</c> maps <c>EntryHealthRow</c> and
/// <c>ReportHealthRow</c> — company, site, status, failure reason — and nothing else about an entry
/// or a report is in the model at all, so there is no transcript, structure, photograph or PDF for
/// a query written here to reach. <c>db.Set&lt;Entry&gt;()</c> still throws. Read
/// <c>EntryHealthRow</c>'s own summary before widening anything.
/// </para>
///
/// <para>
/// <b>What it costs.</b> Four statements, all of them grouped aggregates or two-column projections,
/// none of them per-row: <c>company</c> and <c>project</c> are scanned whole (tens of rows at seed
/// scale, hundreds at real scale), and <c>entry</c> and <c>report</c> are hash-aggregated over
/// <c>(company_id, project_id, status, failure_reason)</c>. <b>No index was added and none is
/// wanted.</b> A full aggregate has to touch every row by definition, so an index could only help
/// as a covering index over four columns of the widest table in the product — paid for on every
/// insert of every entry, on the phone-facing path, to make one super-admin screen faster than the
/// hundred milliseconds it already is. At a hundred thousand entries this is a sequential scan of
/// a few megabytes and a hash aggregate over a few thousand groups. If it ever stops being cheap
/// the answer is a materialised snapshot on a schedule, not an index on the write path.
/// </para>
///
/// <para>
/// <b>"A few thousand groups" is optimistic, and the reason belongs here rather than in a
/// surprise.</b> The grouping key includes the <em>whole</em> stored reason — <c>"{code}:
/// {detail}"</c> — and some details interpolate variable text (a provider's own message, a
/// configuration key). A site whose failures carry distinct details therefore produces one group
/// per failed entry, so the real bound on rows returned is <c>companies × sites × 6</c> plus
/// <c>one per entry carrying a reason</c>. The <em>response</em> is unaffected —
/// <see cref="Tally"/> folds every group to a code before anything is serialised — and what grows
/// is the intermediate result set: order of tens of thousands of narrow rows at a hundred thousand
/// entries with a fifth of them parked. Large enough to state, nowhere near large enough to have
/// justified fixing here. Grouping by code in SQL would need string surgery in the one query on
/// this path (<c>split_part</c>, or a <c>Substring</c>/<c>IndexOf</c> pair that has to behave when
/// there is no colon at all); the durable fix is a <c>failure_code</c> column beside the reason,
/// which is a migration and a decision rather than a tidy-up.
/// </para>
/// </summary>
public sealed partial class PlatformDirectory
{
    /// <summary>
    /// The cap on <see cref="PlatformHealthResponse.Sites"/>. There is no paging here — these are
    /// aggregates, so the "a row seen twice while he scrolls" problem keyset paging exists for
    /// cannot arise — but an uncapped array is an unbounded response, and one row per site of every
    /// customer is unbounded in exactly the direction the business is meant to grow.
    /// <para>
    /// Safe to truncate only because of the ordering: sites needing attention come first, so what
    /// is dropped is always healthy. <see cref="PlatformHealthResponse.SitesOmitted"/> says how
    /// many, because a screen quietly showing part of an estate is how a founder comes to believe
    /// nothing is wrong.
    /// </para>
    /// </summary>
    public const int MaxSites = 500;

    /// <summary>
    /// Pipeline state counts, failure tallies, delivery failures and queue depth — estate-wide and
    /// per site.
    /// <para>
    /// The estate totals are computed from the aggregates themselves rather than by summing the
    /// site rows, so a site created between two of the four statements cannot make the headline
    /// numbers disagree with the sum of the table below them. It can leave one site's counts out of
    /// the list for as long as one request takes, which is the honest trade: a total that is right
    /// and a row that is a second late, rather than a total assembled from an incomplete join.
    /// </para>
    /// </summary>
    public async Task<PlatformHealthResponse> HealthAsync(CancellationToken ct)
    {
        var companies = await db.Companies.AsNoTracking()
            .Select(c => new { c.Id, c.Name })
            .ToListAsync(ct);

        // {id, company_id, name} is the whole of what this model knows about a project — see
        // PlatformProjectConfiguration, where the address and the coordinates are `Ignore`d rather
        // than merely left off this Select.
        var projects = await db.Projects.AsNoTracking()
            .Select(p => new { p.Id, p.CompanyId, p.Name })
            .ToListAsync(ct);

        var entryBuckets = await db.EntryHealth.AsNoTracking()
            .GroupBy(r => new { r.CompanyId, r.ProjectId, r.Status, r.FailureReason })
            .Select(g => new EntryBucket(
                g.Key.CompanyId, g.Key.ProjectId, g.Key.Status, g.Key.FailureReason, g.Count()))
            .ToListAsync(ct);

        var reportBuckets = await db.ReportHealth.AsNoTracking()
            .GroupBy(r => new { r.CompanyId, r.ProjectId, r.Status, r.FailureReason })
            .Select(g => new ReportBucket(
                g.Key.CompanyId, g.Key.ProjectId, g.Key.Status, g.Key.FailureReason, g.Count()))
            .ToListAsync(ct);

        var companyNames = companies.ToDictionary(c => c.Id, c => c.Name);
        var entriesBySite = entryBuckets.ToLookup(b => b.ProjectId);
        var reportsBySite = reportBuckets.ToLookup(b => b.ProjectId);

        var sites = projects
            .Where(p => companyNames.ContainsKey(p.CompanyId))
            .Select(p => new PlatformSiteHealthResponse(
                p.CompanyId,
                companyNames[p.CompanyId],
                p.Id,
                p.Name,
                Pipeline(entriesBySite[p.Id]),
                PipelineFailures(entriesBySite[p.Id]),
                Delivery(reportsBySite[p.Id]),
                DeliveryFailures(reportsBySite[p.Id])))
            .OrderByDescending(NeedsAttention)
            .ThenBy(s => s.CompanyName, StringComparer.OrdinalIgnoreCase)
            .ThenBy(s => s.ProjectName, StringComparer.OrdinalIgnoreCase)
            .ToList();

        var depth = queue.Read();

        return new PlatformHealthResponse(
            UtcStamp.Of(DateTime.UtcNow),
            Pipeline(entryBuckets),
            PipelineFailures(entryBuckets),
            Delivery(reportBuckets),
            DeliveryFailures(reportBuckets),
            new PlatformQueueHealth(
                depth.Available,
                depth.Detail,
                depth.Enqueued,
                depth.Scheduled,
                depth.Processing,
                depth.Failed,
                depth.Servers),
            sites.Take(MaxSites).ToList(),
            Math.Max(0, sites.Count - MaxSites));
    }

    /// <summary>
    /// How badly one site wants looking at. This is the sort key, and it is what makes the cap on
    /// <see cref="MaxSites"/> a truncation of healthy sites rather than a lottery.
    ///
    /// <para>
    /// <b>Deliberately a severity signal and not a partition.</b> An entry parked in
    /// <c>needs_review</c> almost always carries a reason as well, so the terms overlap. That
    /// costs nothing — this number is never serialised and nothing on the screen adds it up — and
    /// the only property that has to hold is that a site with something wrong outranks a site with
    /// nothing. Undercounting is the failure that would matter, because it is what would let the
    /// cap drop a site somebody needed to see.
    /// </para>
    /// <para>
    /// <c>DeliveryFailures</c> is deliberately <em>not</em> a term: a <c>failed</c> report row
    /// always carries a reason, so summing both counted one problem twice for no extra signal.
    /// </para>
    /// </summary>
    private static int NeedsAttention(PlatformSiteHealthResponse site) =>
        site.Pipeline.NeedsReview
        + site.PipelineFailures.Sum(f => f.Count)
        + site.Delivery.Failed;

    private static PlatformPipelineHealth Pipeline(IEnumerable<EntryBucket> buckets)
    {
        var rows = buckets as IReadOnlyCollection<EntryBucket> ?? buckets.ToList();

        int Of(EntryStatus status) =>
            rows.Where(b => b.Status == status).Sum(b => b.Count);

        return new PlatformPipelineHealth(
            rows.Sum(b => b.Count),
            Of(EntryStatus.Received),
            Of(EntryStatus.Processing),
            Of(EntryStatus.AwaitingConfirmation),
            Of(EntryStatus.NeedsReview),
            Of(EntryStatus.Confirmed),
            Of(EntryStatus.Reported));
    }

    private static PlatformDeliveryHealth Delivery(IEnumerable<ReportBucket> buckets)
    {
        var rows = buckets as IReadOnlyCollection<ReportBucket> ?? buckets.ToList();

        int Of(ReportStatus status) =>
            rows.Where(b => b.Status == status).Sum(b => b.Count);

        return new PlatformDeliveryHealth(
            rows.Sum(b => b.Count),
            Of(ReportStatus.Sending),
            Of(ReportStatus.Sent),
            Of(ReportStatus.Failed));
    }

    /// <summary>
    /// The reasons recorded <b>on the entries</b>, folded against <see cref="FailureVocabulary.Entry"/>
    /// — <em>both</em> vocabularies, and the first cut of this method got that wrong.
    /// <para>
    /// <c>entry.failure_reason</c> is not the pipeline's private column. The report pass writes to
    /// it too: <c>EntryReporter.FailAsync</c> records why nothing was sent "in both places a person
    /// might look", and <c>RecordSupersededAfterSendAsync</c> puts <c>superseded_after_send</c>
    /// there and nowhere else. Folding entry buckets against <c>ProcessingFailure</c> alone made
    /// every delivery failure appear <em>twice</em> — correctly in
    /// <see cref="PlatformHealthResponse.DeliveryFailures"/> and again as <c>unrecognised</c> here —
    /// and it rendered anonymous the one terminal state whose documented remedy is "resolve by
    /// hand", on the screen whose entire job is saying what is wrong.
    /// </para>
    /// </summary>
    private static IReadOnlyList<PlatformFailureTally> PipelineFailures(
        IEnumerable<EntryBucket> buckets) =>
        Tally(
            buckets.Select(b => (b.FailureReason, b.Count)),
            // The two CodeOf implementations are the same split on the same convention; which one
            // is named here is arbitrary, and the vocabulary above is what decides the answer.
            ProcessingFailure.CodeOf,
            FailureVocabulary.Entry);

    private static IReadOnlyList<PlatformFailureTally> DeliveryFailures(
        IEnumerable<ReportBucket> buckets) =>
        Tally(
            buckets.Select(b => (b.FailureReason, b.Count)),
            ReportFailure.CodeOf,
            FailureVocabulary.Delivery);

    /// <summary>
    /// Folds stored reasons into codes and counts them, largest first.
    ///
    /// <para>
    /// <b>The detail half of a stored reason never leaves the server, and this is the only place
    /// that could have let it.</b> A reason is <c>"{code}: {detail}"</c> and the detail is written
    /// by the pipeline, which folds an external provider's own message into it in at least one
    /// place — precisely the text that keeps <c>AiProviderException</c> off the log sink's
    /// exception allow-list (ARCHITECTURE §12).
    /// </para>
    /// <para>
    /// <b>And the code is checked against the vocabulary rather than trusted.</b>
    /// <c>CodeOf</c> splits on the first colon and returns the <em>whole string</em> when there is
    /// none, so a reason written by some future path without the conventional shape would arrive
    /// here as free text on a super admin's screen. An unrecognised code is reported as
    /// <see cref="FailureVocabulary.Unrecognised"/>, which makes the guarantee absolute: every
    /// string on this response other than a company or site name is a constant declared in
    /// <c>src/</c>.
    /// </para>
    /// </summary>
    private static IReadOnlyList<PlatformFailureTally> Tally(
        IEnumerable<(string? Reason, int Count)> rows,
        Func<string?, string> codeOf,
        IReadOnlySet<string> vocabulary)
    {
        var tallies = new Dictionary<string, int>(StringComparer.Ordinal);

        foreach (var (reason, count) in rows)
        {
            if (string.IsNullOrWhiteSpace(reason))
            {
                // Not a failure. Most rows are this.
                continue;
            }

            var code = codeOf(reason);
            var name = vocabulary.Contains(code) ? code : FailureVocabulary.Unrecognised;

            tallies[name] = tallies.GetValueOrDefault(name) + count;
        }

        return
        [
            .. tallies
                .OrderByDescending(pair => pair.Value)
                .ThenBy(pair => pair.Key, StringComparer.Ordinal)
                .Select(pair => new PlatformFailureTally(pair.Key, pair.Value)),
        ];
    }

    /// <summary>One grouped row of <c>entry</c>: a bucket, never a day of anybody's work.</summary>
    private sealed record EntryBucket(
        Guid CompanyId, Guid ProjectId, EntryStatus Status, string? FailureReason, int Count);

    /// <inheritdoc cref="EntryBucket"/>
    private sealed record ReportBucket(
        Guid CompanyId, Guid ProjectId, ReportStatus Status, string? FailureReason, int Count);
}

/// <summary>
/// The closed set of failure codes this product declares, read off its own source.
///
/// <para>
/// <b>Reflection over the constants rather than a hand-kept list</b>, because a hand-kept list is
/// a second place to remember: a new code would be admitted by the vocabulary the day it is
/// declared, whereas a forgotten list entry would silently rename a real failure to
/// <see cref="Unrecognised"/> on the one screen whose job is saying what is wrong.
/// </para>
/// <para>
/// Values containing a colon are excluded: <c>ReportFailure.ReportInterruptedPrefix</c> and its
/// sibling are stored-reason <em>prefixes</em> for the one predicate that has to ask the question
/// in SQL, not codes, and a code never contains a colon by construction.
/// </para>
/// </summary>
public static class FailureVocabulary
{
    /// <summary>What a code that is not in either vocabulary is reported as. A fixed token, so
    /// nothing that was not compiled into this assembly can reach a platform response.</summary>
    public const string Unrecognised = "unrecognised";

    /// <inheritdoc cref="FailureVocabulary"/>
    public static readonly IReadOnlySet<string> Pipeline = CodesDeclaredBy(typeof(ProcessingFailure));

    /// <inheritdoc cref="FailureVocabulary"/>
    public static readonly IReadOnlySet<string> Delivery = CodesDeclaredBy(typeof(ReportFailure));

    /// <summary>
    /// Everything that can legitimately stand on <c>entry.failure_reason</c> — <b>both</b>
    /// vocabularies, because that one column is written from both sides.
    /// <para>
    /// <c>EntryProcessor.ParkAsync</c> writes a <c>ProcessingFailure</c>; <c>EntryReporter</c>
    /// writes a <c>ReportFailure</c> to the same column, on purpose ("in both places a person
    /// might look"), and <c>superseded_after_send</c> exists nowhere else. Two sets and one column
    /// is what made the first cut of the health page report every delivery failure as
    /// <c>unrecognised</c> while also counting it correctly one field away.
    /// </para>
    /// </summary>
    public static readonly IReadOnlySet<string> Entry =
        new HashSet<string>(Pipeline.Concat(Delivery), StringComparer.Ordinal);

    private static IReadOnlySet<string> CodesDeclaredBy(Type vocabulary) =>
        vocabulary
            .GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where(field => field is { IsLiteral: true } && field.FieldType == typeof(string))
            .Select(field => (string)field.GetRawConstantValue()!)
            .Where(value => value.Length > 0 && !value.Contains(':', StringComparison.Ordinal))
            .ToHashSet(StringComparer.Ordinal);
}
