using Microsoft.Extensions.Logging;

namespace Teren.Infrastructure.Processing;

/// <summary>
/// The one retry loop in the background pipeline, shared by the processing pass and the report
/// pass.
/// <para>
/// One implementation on purpose. Retry policy belongs to the layer that owns the entry's state
/// machine and can write an honest <c>failure_reason</c> — which is why every adapter beneath it
/// runs with its own retries switched off (<c>AnthropicClient.MaxRetries</c>,
/// <c>Storage:DownloadRetries</c>, MailKit's absence of one). Two budgets multiply the
/// worst-case wall-clock of a pass invisibly, until it outruns the stale window that is supposed
/// to outlast it (ARCHITECTURE §10). A second copy of this loop would be the same mistake with
/// extra steps.
/// </para>
/// <para>
/// <b>"One implementation" was a claim rather than a fact until 2026-09-02:</b>
/// <c>EntryProcessor.WithRetriesAsync</c> was a second, line-for-line copy of the loop below,
/// sitting under this very comment. It now delegates here, which is what makes
/// <c>PipelineOptionsTests</c>' recomputation of the worst-case pass — the arithmetic
/// <c>Pipeline:StaleProcessingAfter</c> is set against — a check on the shipped code rather than
/// on one of two copies of it.
/// </para>
/// <para>
/// Only failures that could plausibly succeed on a second attempt are retried; the caller
/// decides which those are, because "retryable" means different things to a model API and to a
/// mail relay. Everything else is raised at once — repeating a rejected credential or a
/// corrupted file only delays the honest answer.
/// </para>
/// </summary>
public static class BoundedRetry
{
    public static async Task<T> RunAsync<T>(
        string operation,
        Guid subjectId,
        int maxAttempts,
        TimeSpan firstDelay,
        Func<Exception, bool> isRetryable,
        ILogger logger,
        Func<CancellationToken, Task<T>> action,
        CancellationToken ct)
    {
        var delay = firstDelay;

        for (var attempt = 1; ; attempt++)
        {
            try
            {
                return await action(ct);
            }
            catch (Exception ex) when (isRetryable(ex) && attempt < maxAttempts)
            {
                logger.LogWarning(
                    ex,
                    "{SubjectId}: {Operation} attempt {Attempt} of {MaxAttempts} failed; "
                    + "retrying in {DelayMs} ms.",
                    subjectId, operation, attempt, maxAttempts, (long)delay.TotalMilliseconds);

                if (delay > TimeSpan.Zero)
                {
                    await Task.Delay(delay, ct);
                }

                delay += delay;
            }
        }
    }
}
