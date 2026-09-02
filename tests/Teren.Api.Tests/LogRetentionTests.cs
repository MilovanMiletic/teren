using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Infrastructure.Logging;

namespace Teren.Api.Tests;

/// <summary>
/// Retention (plan §12): the job that stops <c>app_log</c> becoming the largest thing in the
/// database.
/// <para>
/// It is tested against the real table rather than by counting a mock's calls, because the whole
/// question is whether a <c>DELETE</c> with the right cutoff actually removes rows and leaves the
/// rest alone — and because the chunking loop has a termination condition that a fake would not
/// exercise.
/// </para>
/// </summary>
public sealed class LogRetentionTests(TerenTestApp app) : ApiTestBase(app)
{
    private static AppLog Line(int daysAgo) => new()
    {
        At = DateTime.UtcNow.AddDays(-daysAgo),
        Level = AppLogLevels.Information,
        Source = "test",
        Template = "t",
        Message = "m",
    };

    private async Task<int> RunAsync(int retentionDays)
    {
        await using var identity = App.CreateIdentityDbContext();

        var job = new LogRetentionJob(
            identity,
            Options.Create(new LoggingOptions { RetentionDays = retentionDays }),
            NullLogger<LogRetentionJob>.Instance);

        return await job.RunAsync(null);
    }

    [Fact]
    public async Task Rows_past_the_window_go_and_rows_inside_it_stay()
    {
        await using (var identity = App.CreateIdentityDbContext())
        {
            identity.Logs.AddRange(Line(20), Line(15), Line(13), Line(1), Line(0));
            await identity.SaveChangesAsync(Ct);
        }

        (await RunAsync(retentionDays: 14)).ShouldBe(2);

        await using var after = App.CreateIdentityDbContext();
        var kept = await after.Logs.AsNoTracking().OrderBy(l => l.At).ToListAsync(Ct);

        kept.Count.ShouldBe(3);
        kept[0].At.ShouldBeGreaterThan(DateTime.UtcNow.AddDays(-14));
    }

    [Fact]
    public async Task Running_it_twice_deletes_nothing_the_second_time()
    {
        // Idempotent, which is why it carries [AutomaticRetry(Attempts = 0)]: a missed run costs
        // a day of extra rows and nothing else, so a scheduler retry would buy nothing.
        await using (var identity = App.CreateIdentityDbContext())
        {
            identity.Logs.Add(Line(30));
            await identity.SaveChangesAsync(Ct);
        }

        (await RunAsync(retentionDays: 14)).ShouldBe(1);
        (await RunAsync(retentionDays: 14)).ShouldBe(0);
    }

    [Fact]
    public async Task An_empty_table_is_not_an_error()
    {
        (await RunAsync(retentionDays: 14)).ShouldBe(0);
    }

    [Fact]
    public void Fourteen_days_is_the_shipped_default_and_it_is_a_decision()
    {
        // Pinned because the plan makes it a decision rather than a default: long enough to answer
        // "what happened last week", short enough that the table stays a rounding error beside the
        // evidence and the nightly backup does not grow without bound.
        new LoggingOptions().RetentionDays.ShouldBe(14);

        // And the client-event kill switch defaults ON — a phone that reports nothing is a log
        // viewer that shows half the product.
        new LoggingOptions().ClientEvents.Enabled.ShouldBeTrue();
    }
}
