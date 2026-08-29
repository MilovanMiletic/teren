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
}
