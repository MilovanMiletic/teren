using System.Collections.Concurrent;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Teren.Core.Reporting;
using Teren.Infrastructure.Reporting;

namespace Teren.Api.Tests.Infrastructure;

/// <summary>
/// The mail relay stopped at the seam PROJECT.md §11 put there. No test in this suite opens a
/// socket, and none should: what is under test is what the report pass does around a relay —
/// what it sends, when it refuses to send, and what it records afterwards — which must be
/// provable on a machine with no mail account.
/// <para>
/// It records the whole <see cref="ReportMessage"/>, attachment included, because that is where
/// the increment's headline invariant is observable: **the report goes out in the project's
/// language, not the caller's**. The subject, the body and the attachment name all come from
/// <c>project.report_language</c>, so an assertion on them is an assertion on that rule.
/// </para>
/// </summary>
public sealed class FakeReportDelivery : IReportDelivery
{
    private readonly ConcurrentQueue<ReportMessage> _sent = new();

    public string Name => "fake-smtp";

    public bool Configured { get; set; } = true;

    public bool IsConfigured => Configured;

    /// <summary>Addresses this transport pretends it cannot use — the recipients_unusable path.</summary>
    public HashSet<string> UnusableAddresses { get; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>When set, every call throws this instead of accepting the message.</summary>
    public Func<Exception>? Fails { get; set; }

    /// <summary>
    /// When set, every call <b>accepts the message and then throws</b> — the relay took custody
    /// and the pass never heard so.
    /// <para>
    /// It exists because the state was previously unrepresentable here: <see cref="Fails"/>
    /// throws before the message is recorded, so "accepted <em>and</em> threw" could not be
    /// expressed, and the suite could not see the classic duplicate-email vector at all — a relay
    /// that scans content after DATA more slowly than the conversation budget, or resets the
    /// connection once it has accepted. Every retry of such a failure is another copy in a real
    /// inbox, so <see cref="Sent"/> is exactly where the damage becomes visible.
    /// </para>
    /// </summary>
    public Func<Exception>? FailsAfterAccepting { get; set; }

    /// <summary>How many attempts fail transiently before the relay starts accepting.</summary>
    public int FailFirstAttempts { get; set; }

    /// <summary>Runs while the pass is inside the relay call — the seam a test needs to change
    /// the world *during* the one step that cannot be taken back.</summary>
    public Func<Task>? WhileSending { get; set; }

    public string RelayResponse { get; set; } = "2.0.0 Ok: queued as FAKE0001";

    /// <summary>Every attempt, successful or not. The count is how "a terminal refusal is not
    /// retried" is provable.</summary>
    public int AttemptCount { get; private set; }

    public IReadOnlyList<ReportMessage> Sent => [.. _sent];

    public ReportMessage? LastSent => _sent.LastOrDefault();

    public void Reset()
    {
        _sent.Clear();
        Configured = true;
        UnusableAddresses.Clear();
        Fails = null;
        FailsAfterAccepting = null;
        FailFirstAttempts = 0;
        WhileSending = null;
        RelayResponse = "2.0.0 Ok: queued as FAKE0001";
        AttemptCount = 0;
    }

    public bool CanAddress(ReportRecipient recipient) =>
        !string.IsNullOrWhiteSpace(recipient.Email)
        && recipient.Email.Contains('@', StringComparison.Ordinal)
        && !UnusableAddresses.Contains(recipient.Email);

    public async Task<ReportDeliveryReceipt> SendAsync(ReportMessage message, CancellationToken ct)
    {
        AttemptCount++;

        if (WhileSending is not null)
        {
            await WhileSending();
        }

        if (!Configured)
        {
            throw new ReportDeliveryException(
                Name, "no relay configured", ReportDeliveryFailureKind.NotConfigured);
        }

        if (AttemptCount <= FailFirstAttempts)
        {
            throw new ReportDeliveryException(
                Name, "transient test failure", ReportDeliveryFailureKind.Transient);
        }

        if (Fails is not null)
        {
            throw Fails();
        }

        _sent.Enqueue(message);

        if (FailsAfterAccepting is not null)
        {
            // Recorded first, then thrown: the message is in the relay's hands and the caller is
            // about to be told nothing of the sort.
            throw FailsAfterAccepting();
        }

        return new ReportDeliveryReceipt(
            Name, RelayResponse, DateTimeOffset.UtcNow, message.Recipients.Count);
    }
}

/// <summary>
/// The **real** QuestPDF renderer, with the model it was handed recorded on the way through.
/// <para>
/// Deliberately a wrapper rather than a stub. The PDF is the product's face and the layout is
/// where a licence declaration, a missing Serbian glyph or an unlayoutable page would surface;
/// stubbing it out would leave every one of those untested while the suite stayed green. What
/// the wrapper adds is the <see cref="DailyReport"/> itself, which is where "the language came
/// from the project" and "these exact photographs were embedded" are assertable.
/// </para>
/// </summary>
public sealed class RecordingReportRenderer(
    IOptions<ReportingOptions> options,
    ILogger<QuestPdfReportRenderer> logger) : IReportRenderer
{
    private readonly QuestPdfReportRenderer _inner = new(options, logger);
    private readonly ConcurrentQueue<DailyReport> _rendered = new();

    public string Name => _inner.Name;

    /// <summary>When set, rendering throws — the render_failed path.</summary>
    public Func<Exception>? Fails { get; set; }

    /// <summary>
    /// Runs while the pass is inside the layout — the last moment before it takes its claim, and
    /// therefore the only place a test can make a competing pass appear in the gap the unique
    /// index exists to close. Synchronous because <see cref="IReportRenderer"/> is: the layout
    /// is CPU work with no network in it.
    /// </summary>
    public Action? WhileRendering { get; set; }

    public IReadOnlyList<DailyReport> Rendered => [.. _rendered];

    public DailyReport? LastRendered => _rendered.LastOrDefault();

    public int RenderCount => _rendered.Count;

    public void Reset()
    {
        _rendered.Clear();
        Fails = null;
        WhileRendering = null;
    }

    public byte[] RenderDaily(DailyReport report)
    {
        WhileRendering?.Invoke();

        if (Fails is not null)
        {
            throw Fails();
        }

        // Rendered before it is recorded: the photo files are still on disk at this point, and a
        // recorded model whose PDF was never produced would be a comfortable lie.
        var pdf = _inner.RenderDaily(report);
        _rendered.Enqueue(report);
        return pdf;
    }
}
