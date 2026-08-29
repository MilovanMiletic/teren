using Teren.Infrastructure.Processing;

namespace Teren.Api.Tests;

/// <summary>
/// The pipeline's numbers, checked as arithmetic rather than trusted as comments.
/// <para>
/// Both facts here were review findings. <c>Pipeline:SweepInterval</c> was an inert knob — the
/// recurring job was registered with a hardcoded <c>Cron.Minutely</c> while the start-up log
/// asserted the configured interval, so a founder setting 10 minutes got minutely sweeps and a
/// log that agreed with him. And <c>StaleProcessingAfter</c> was shorter than the worst-case
/// pass it is supposed to outlast, which is what let the sweeper park a live entry.
/// </para>
/// <para>
/// No database and no host: these are pure functions over configuration.
/// </para>
/// </summary>
public sealed class PipelineOptionsTests
{
    [Theory]
    [InlineData("00:01:00", "*/1 * * * *")]
    [InlineData("00:05:00", "*/5 * * * *")]
    [InlineData("00:10:00", "*/10 * * * *")]
    [InlineData("00:30:00", "*/30 * * * *")]
    // Whole hours cannot be written as */60; cron says "at minute 0 of every hour".
    [InlineData("01:00:00", "0 * * * *")]
    // Not a whole number of minutes: rounded, never silently dropped to the default.
    [InlineData("00:01:30", "*/2 * * * *")]
    [InlineData("00:02:20", "*/2 * * * *")]
    public void The_sweep_interval_becomes_the_cron_the_scheduler_is_given(
        string interval, string cron) =>
        new PipelineOptions { SweepInterval = TimeSpan.Parse(interval) }
            .SweepCronExpression()
            .ShouldBe(cron);

    [Theory]
    // The ends of the allowed range and a couple of awkward values in between.
    [InlineData("00:01:00")]
    [InlineData("00:07:00")]
    [InlineData("00:10:00")]
    [InlineData("00:59:00")]
    [InlineData("01:00:00")]
    public void Every_expression_it_produces_comes_from_hangfires_own_helpers(string interval)
    {
        // The nearest thing to an acceptance test short of booting a job server: the string
        // handed to AddOrUpdate is built by the scheduler's own Cron helpers, so it cannot be
        // an expression this Hangfire will refuse. (Cronos, its parser, is internalised in
        // Hangfire.Core and cannot be called directly from here.)
        var span = TimeSpan.Parse(interval);
        var cron = new PipelineOptions { SweepInterval = span }.SweepCronExpression();

        var expected = span.TotalMinutes >= 60
            ? global::Hangfire.Cron.Hourly()
            : global::Hangfire.Cron.MinuteInterval((int)span.TotalMinutes);

        cron.ShouldBe(expected);
    }

    [Fact]
    public void The_default_sweep_is_every_minute()
    {
        // The behaviour that shipped before the option was wired up. Changing the default is
        // allowed; changing it by accident is not.
        new PipelineOptions().SweepCronExpression().ShouldBe("*/1 * * * *");
    }

    [Fact]
    public void The_stale_window_outlasts_the_worst_case_pass()
    {
        // The F1 arithmetic, recomputed from the shipped defaults rather than restated. If
        // anyone raises a timeout, drops a retry count back in, or shortens this window, this
        // test is where the contradiction surfaces — not in a foreman's needs_review list.
        var pipeline = new PipelineOptions();
        var storage = new Teren.Infrastructure.Storage.StorageOptions();
        var azure = new Teren.Infrastructure.Ai.AzureSpeechOptions();
        var anthropic = new Teren.Infrastructure.Ai.ExtractionOptions();

        // Neither provider may retry underneath the processor: an inner retry loop multiplies
        // the pass without making it more likely to succeed.
        storage.DownloadRetries.ShouldBe(0, "the AWS SDK must not retry under the pipeline");

        var attempts = pipeline.MaxAttempts;

        // Every external step gets MaxAttempts tries at its own per-call ceiling...
        var worstCase =
            (storage.DownloadTimeout * attempts)
            + (azure.RequestTimeout * attempts)
            + (anthropic.RequestTimeout * attempts);

        // ...plus the backoff between them: RetryDelay doubles, so 2 s + 4 s per operation.
        var backoff = TimeSpan.Zero;
        var delay = pipeline.RetryDelay;
        for (var attempt = 1; attempt < attempts; attempt++)
        {
            backoff += delay * 3;
            delay += delay;
        }

        worstCase += backoff;

        pipeline.StaleProcessingAfter.ShouldBeGreaterThan(
            worstCase,
            $"a healthy pass can take up to {worstCase}, and the sweeper must not park one that "
            + "is still running");
    }
}
