namespace Teren.Core.Processing;

/// <summary>
/// How a phone-facing request hands an entry to the background pipeline without ever waiting
/// for it (PROJECT.md principle 4). Hangfire lives behind this seam, so
/// <c>POST /entries/{id}/complete</c> depends on an enqueue, not on a job scheduler.
/// </summary>
public interface IPipelineQueue
{
    /// <summary>
    /// Queues one entry for processing. The company id travels with the job because a
    /// background job has no request and therefore no tenant: the job sets
    /// <c>TenantContext.CompanyId</c> from it and every query it runs is filtered as usual
    /// (ARCHITECTURE §12 — no <c>IgnoreQueryFilters</c> in the pipeline).
    /// <para>
    /// Enqueuing twice is harmless: the job claims the entry with a conditional UPDATE and the
    /// loser exits.
    /// </para>
    /// </summary>
    void EnqueueProcessing(Guid entryId, Guid companyId);

    /// <summary>
    /// Queues the report for a confirmed entry: render the PDF, hand it to the mail relay, seal
    /// the entry. Called by <c>POST /entries/{id}/confirm</c>, which must not do any of that
    /// work itself — the confirmation screen is a request a human is waiting on, and PDF
    /// generation plus an SMTP conversation are exactly what principle 4 keeps out of one.
    /// <para>
    /// Enqueuing twice is harmless. The report row is the claim: its unique <c>entry_id</c> lets
    /// exactly one pass own an entry's report, and the loser exits without sending anything.
    /// </para>
    /// </summary>
    void EnqueueReport(Guid entryId, Guid companyId);
}
