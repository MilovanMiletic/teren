using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Npgsql;
using Teren.Core.Entities;
using Teren.Core.Reporting;
using Teren.Core.Storage;
using Teren.Core.Tenancy;
using Teren.Core.Time;
using Teren.Infrastructure.Persistence;
using Teren.Infrastructure.Processing;
using Teren.Infrastructure.Storage;

namespace Teren.Infrastructure.Reporting;

public enum ReportOutcome
{
    /// <summary>Not this pass's work: the entry is not confirmed, is already reported, or another
    /// pass holds the claim. Never a state change.</summary>
    Skipped,

    /// <summary>
    /// The relay took custody, and — in every ordinary case — the entry is sealed.
    /// <para>
    /// Deliberately not "sealed", because two states hand the message over and then refuse the
    /// stamp, and both are reported as facts rather than smoothed into a failure: the claim on the
    /// row was gone before the send could be recorded, and the entry changed under the pass after
    /// the document had already gone out (<c>superseded_after_send</c>). <c>Failed</c> would be a
    /// lie in the one direction that costs the most — it means "nothing left the building" — and
    /// <c>Skipped</c> promises no state change. The entry carries the truth in either case.
    /// </para>
    /// </summary>
    Sent,

    /// <summary>Nothing left the building; the reason is on the entry and, where one exists, on
    /// the report row.</summary>
    Failed,
}

/// <summary>
/// B6: a confirmed entry becomes a PDF in the project's language and is handed to a mail relay,
/// after which the entry is sealed forever.
/// <para>
/// Separated from the Hangfire job for the same reason <c>EntryProcessor</c> is: everything
/// worth testing lives here and knows nothing about a scheduler.
/// </para>
///
/// <para><b>The ordering is the whole design, because one of these writes cannot be undone.</b></para>
/// <list type="number">
/// <item>Everything reversible happens first — read the entry, verify every photograph's
/// checksum, lay out the PDF, store it. If any of it fails, nothing has left the building and
/// the entry stays <c>confirmed</c> with a visible reason, ready to be reported again.</item>
/// <item>Then the <c>report</c> row is inserted. **That insert is the claim**: <c>entry_id</c>
/// is unique, so of two concurrent passes exactly one proceeds and the other sends nothing. It
/// is deliberately created as late as possible and immediately before the relay call, so the
/// window in which the server cannot say whether the client has the report is as narrow as SMTP
/// allows.</item>
/// <item>Then the message goes to the relay.</item>
/// <item>Only then is <c>reported_at</c> stamped — after the PDF exists and after a relay has
/// accepted it. That stamp is irreversible by design: a Postgres trigger makes the row immutable
/// and undeletable from that moment, and corrections become new entries via
/// <c>supersedes_entry_id</c>. Nothing may stamp it on the strength of an intention.</item>
/// </list>
/// <para>
/// Every terminal write is conditional on this pass still owning what it is writing to — the
/// report row must still be <c>sending</c>, the entry must still be <c>confirmed</c> and
/// unreported. B4's gating bug was exactly this: a late worker dragged a confirmed entry back
/// out of the reportable set. A pass that has lost its claim writes nothing.
/// </para>
/// </summary>
public sealed class EntryReporter(
    TerenDbContext db,
    TenantContext tenant,
    IObjectStorage storage,
    IReportRenderer renderer,
    IReportDelivery delivery,
    IOptions<ReportingOptions> reportingOptions,
    IOptions<PipelineOptions> pipelineOptions,
    ILogger<EntryReporter> logger)
{
    private readonly ReportingOptions _options = reportingOptions.Value;
    private readonly PipelineOptions _pipeline = pipelineOptions.Value;

    public async Task<ReportOutcome> ReportAsync(
        Guid entryId, Guid companyId, CancellationToken ct)
    {
        // A job has no request and therefore no tenant; setting it here is what makes every
        // query below run through the ordinary global filters (ARCHITECTURE §12).
        tenant.CompanyId = companyId;

        using var scope = logger.BeginScope(new Dictionary<string, object>
        {
            ["EntryId"] = entryId,
            ["CompanyId"] = companyId,
        });

        var entry = await db.Entries.AsNoTracking()
            .FirstOrDefaultAsync(e => e.Id == entryId, ct);

        if (entry is null)
        {
            logger.LogWarning("Entry {EntryId} is not visible to this company.", entryId);
            return ReportOutcome.Skipped;
        }

        if (entry.ReportedAt is not null || entry.Status == EntryStatus.Reported)
        {
            logger.LogInformation(
                "Entry {EntryId} was already reported at {ReportedAt}.", entryId, entry.ReportedAt);
            return ReportOutcome.Skipped;
        }

        if (entry.Status != EntryStatus.Confirmed)
        {
            // The confirmation screen is mandatory before any report is sent (PROJECT.md
            // principle 5). Nothing else is reportable, ever.
            logger.LogInformation(
                "Entry {EntryId} is {Status}; only a confirmed entry is reported.",
                entryId, EntryStatusNames.ToWire(entry.Status));
            return ReportOutcome.Skipped;
        }

        var existing = await db.Reports.AsNoTracking()
            .FirstOrDefaultAsync(r => r.EntryId == entryId, ct);

        switch (existing?.Status)
        {
            case ReportStatus.Sending:
                // Another pass has the claim. If it died mid-send, the sweeper — not this pass —
                // is what makes that visible, because re-sending on a guess would put a second
                // copy of a site diary in an investor's inbox.
                logger.LogInformation(
                    "Entry {EntryId} already has a report in flight ({ReportId}).",
                    entryId, existing.Id);
                return ReportOutcome.Skipped;

            case ReportStatus.Sent:
                // The relay took custody but the entry was never sealed — the pass died in the
                // gap between those two writes. Finish it rather than send a second copy.
                //
                // **Through the same comparison the sealing pass makes**, and for the same
                // reason: the entry may have moved since that document went out, and this path is
                // reached a minute later by a sweep rather than microseconds later by the pass
                // that rendered it, so it is the *wider* window of the two. What was sent is
                // recorded on the row (report.corrected_sha256), which is the only thing a
                // different process can compare against.
                logger.LogWarning(
                    "Entry {EntryId} has a report already handed over at {SentAt} but was never "
                    + "sealed; finishing it instead of sending again.",
                    entryId, existing.SentAt);

                return await SealDeliveredAsync(entry, existing, ct);
        }

        if (existing is { Status: ReportStatus.Failed }
            && ReportFailure.IsCustodyUnknown(existing.FailureReason))
        {
            // **The guard that makes ARCHITECTURE §6's promise hold against everything, not just
            // against the sweeper.** A previous attempt ended without the server knowing whether
            // the relay took the message — it was abandoned mid-send, or the conversation broke
            // after transmission had begun. Nothing automatic may resolve that: not the sweeper,
            // not a phone replaying its confirmation over a flaky link, not a foreman revising
            // his answer. Each of those is a wire event, and none of them is a person deciding
            // that the client does not have yesterday's report.
            //
            // The reason is written back onto the entry — a changed confirmation will have
            // cleared it — so the entry stops visibly here instead of being rendered and skipped
            // once a minute forever. The report row keeps its own original reason: FailAsync
            // only writes to a row still `sending`, and this one is `failed`.
            logger.LogWarning(
                "Entry {EntryId}: report {ReportId} previously ended with custody unknown "
                + "({Reason}); it is not sent again by itself.",
                entryId, existing.Id, ReportFailure.CodeOf(existing.FailureReason));

            return await FailAsync(
                entryId,
                existing.Id,
                ReportFailure.CodeOf(existing.FailureReason),
                "an earlier attempt ended without the server knowing whether the mail relay took "
                + "the message, so it is never sent again automatically — a person decides "
                + "whether the client has this report",
                ct);
        }

        try
        {
            return await RunAsync(entry, existing, ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // The host is shutting down. Leave whatever state exists; the sweeper is what makes
            // an abandoned report visible.
            throw;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Entry {EntryId}: unexpected failure in the report pass.", entryId);
            return await FailAsync(entryId, existing?.Id, ReportFailure.Unexpected, ex.Message, ct);
        }
    }

    // ------------------------------------------------------------------ the pass

    private async Task<ReportOutcome> RunAsync(Entry entry, Report? existing, CancellationToken ct)
    {
        var project = await db.Projects.AsNoTracking()
            .FirstOrDefaultAsync(p => p.Id == entry.ProjectId, ct);

        if (project is null)
        {
            return await FailAsync(
                entry.Id, existing?.Id, ReportFailure.Unexpected,
                "the entry's project is not visible to this company", ct);
        }

        var company = await db.Companies.AsNoTracking()
            .FirstOrDefaultAsync(c => c.Id == entry.CompanyId, ct);

        // The project's language, not the caller's and not the foreman's phone setting. This is
        // the client's language (ARCHITECTURE §6); a foreign investor gets an English report out
        // of exactly this machinery.
        var strings = ReportStrings.For(project.ReportLanguage);

        // ---- 1. who it is for ---------------------------------------------

        var declared = ProjectRecipients.Read(project.Recipients);
        if (declared.Count == 0)
        {
            return await FailAsync(
                entry.Id, existing?.Id, ReportFailure.NoRecipients,
                "the project has no recipients, so there is no inbox for the report to land in",
                ct);
        }

        var recipients = declared.Where(delivery.CanAddress).ToList();
        if (recipients.Count == 0)
        {
            return await FailAsync(
                entry.Id, existing?.Id, ReportFailure.RecipientsUnusable,
                $"none of the {declared.Count} recipient(s) on the project is an address the "
                + $"{delivery.Name} transport can use", ct);
        }

        if (recipients.Count != declared.Count)
        {
            logger.LogWarning(
                "Entry {EntryId}: {Skipped} of {Total} recipients on the project are not usable "
                + "addresses and are not written to.",
                entry.Id, declared.Count - recipients.Count, declared.Count);
        }

        if (!delivery.IsConfigured)
        {
            // Same policy as a missing AI key: honest and visible, never a host that will not
            // boot. Checked before anything is rendered, because rendering a PDF nobody can send
            // is work for nothing.
            return await FailAsync(
                entry.Id, existing?.Id, ReportFailure.DeliveryNotConfigured,
                $"no {delivery.Name} relay is configured (Reporting:Smtp:Host, "
                + "Reporting:FromAddress)", ct);
        }

        // ---- 2. what it says ----------------------------------------------

        // `corrected` is what the human approved, and it is the only version a client ever sees.
        // `structure` is the model's answer and stays untouched as one third of the eval triple
        // (ARCHITECTURE §9.3); it is read only as a fallback for an entry confirmed before that
        // column existed.
        var content = ReportContentReader.Read(entry.Corrected ?? entry.Structure);

        var photoMedia = await db.Media.AsNoTracking()
            .Where(m => m.EntryId == entry.Id && m.Kind == MediaKind.Photo)
            .ToListAsync(ct);

        photoMedia = [.. photoMedia.OrderBy(m => m.CapturedAt ?? m.CreatedAt).ThenBy(m => m.Id)];

        if (content.IsEmpty && photoMedia.Count == 0)
        {
            // An empty page with a letterhead is worse than no report: it tells the client the
            // day was documented when it was not. Same refusal as the pipeline's `no_evidence`.
            return await FailAsync(
                entry.Id, existing?.Id, ReportFailure.NothingToReport,
                "the confirmed entry carries no work, materials, blockers, notes or photographs",
                ct);
        }

        // What this document replaces, if anything — after the refusal above, because an entry
        // with nothing to report needs no predecessor, and before the render budget opens, because
        // these are small indexed reads and must not be charged to the layout.
        var correction = await ReadCorrectionAsync(entry, ct);

        // ---- 3. the reversible half, under one budget ----------------------

        var workspace = Path.Combine(
            Path.GetTempPath(), "teren-report", $"{entry.Id:N}-{Guid.NewGuid():N}");

        using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
        budget.CancelAfter(_options.RenderBudget);

        byte[] pdf;
        string objectKey;
        string pdfSha256;

        try
        {
            Directory.CreateDirectory(workspace);

            var photos = await GatherPhotosAsync(entry, photoMedia, workspace, budget.Token);

            var report = new DailyReport(
                company?.Name ?? string.Empty,
                project.Name,
                project.Address,
                entry.EntryDate,
                strings.Language,
                // Per project, exactly like the language on the line above, and read from the
                // same row: the report is rendered for the place the work happened.
                project.TimeZone,
                content,
                photos,
                new ReportProvenance(
                    entry.Id,
                    UtcStamp.Of(entry.CreatedAt),
                    UtcStamp.OrNull(entry.ReceivedAt),
                    DateTimeOffset.UtcNow))
            {
                Correction = correction,
            };

            pdf = renderer.RenderDaily(report);

            // Recorded so the bytes can be proven again when the app downloads this report months
            // from now (GET /api/entries/{id}/report). Hashed here, from the array that is about
            // to be both stored and attached to the mail, so the hash describes exactly what went
            // out — not a re-read of storage, which is the thing being checked.
            pdfSha256 = Convert.ToHexStringLower(SHA256.HashData(pdf));

            if (pdf.LongLength > _options.AttachmentSizeWarningBytes)
            {
                // Not a refusal — a report that exists must go out — but the founder should hear
                // about it before a relay does. Many refuse attachments over 10–25 MB.
                logger.LogWarning(
                    "Entry {EntryId}: the report PDF is {Megabytes:0.0} MB, over the "
                    + "Reporting:AttachmentSizeWarningBytes threshold; some relays refuse "
                    + "attachments this large.",
                    entry.Id, pdf.LongLength / 1024d / 1024d);
            }

            objectKey = ObjectKeys.ForEntryReport(entry.CompanyId, entry.ProjectId, entry.Id);

            await BoundedRetry.RunAsync(
                "report-store",
                entry.Id,
                _pipeline.MaxAttempts,
                _pipeline.RetryDelay,
                IsRetryableStorage,
                logger,
                async token =>
                {
                    await storage.PutAsync(objectKey, pdf, "application/pdf", token);
                    return true;
                },
                budget.Token);
        }
        catch (EvidenceIntegrityException ex)
        {
            // A photograph is not the photograph that was captured. **The whole report is
            // refused**, not just that image: this document is the thing a contractor hands to a
            // client in a dispute, and quietly dropping one exhibit — or worse, embedding bytes
            // that do not match the record — would make every other page less trustworthy too.
            var code = ex.Kind == EvidenceIntegrityKind.Missing
                ? ReportFailure.PhotoMissing
                : ReportFailure.PhotoChecksumMismatch;

            logger.LogError(
                "Entry {EntryId}: refusing to build a report — {Reason}", entry.Id, ex.Message);

            return await FailAsync(entry.Id, existing?.Id, code, ex.Message, ct);
        }
        catch (ObjectStorageUnavailableException ex)
        {
            return await FailAsync(
                entry.Id, existing?.Id, ReportFailure.StorageUnavailable, ex.Message, ct);
        }
        catch (ReportTimeZoneException ex)
        {
            // Deliberately not a silent fall back to UTC. Nothing is sent, the reason names the
            // offending id, and a person fixes one column — after which confirming again reports
            // the entry with correct local times.
            logger.LogError(
                "Entry {EntryId}: project time zone {TimeZoneId} cannot be resolved; refusing to "
                + "print timestamps that would be wrong.", entry.Id, ex.TimeZoneId);

            return await FailAsync(
                entry.Id, existing?.Id, ReportFailure.TimeZoneUnknown, ex.Message, ct);
        }
        catch (OperationCanceledException) when (budget.IsCancellationRequested
                                                 && !ct.IsCancellationRequested)
        {
            // The budget ran out, not the host. Nothing was claimed and nothing was sent, so the
            // entry is simply reportable again.
            return await FailAsync(
                entry.Id, existing?.Id, ReportFailure.RenderTimeout,
                $"gathering the evidence and laying out the document took longer than the "
                + $"{_options.RenderBudget.TotalSeconds:0} s Reporting:RenderBudget", ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogError(ex, "Entry {EntryId}: the document could not be produced.", entry.Id);
            return await FailAsync(
                entry.Id, existing?.Id, ReportFailure.RenderFailed, ex.Message, ct);
        }
        finally
        {
            Cleanup(workspace);
        }

        // ---- 4. the claim --------------------------------------------------

        var reportId = await ClaimAsync(entry, existing, recipients, objectKey, pdfSha256, ct);
        if (reportId is null)
        {
            logger.LogInformation(
                "Entry {EntryId}: another pass claimed the report first; sending nothing.",
                entry.Id);
            return ReportOutcome.Skipped;
        }

        // ---- 4a. is the document still the entry? --------------------------

        // The claim is held, and the PDF in hand was laid out from the `corrected` this pass read
        // minutes ago. In between, a foreman who spotted his own mistake may have re-confirmed:
        // /confirm refuses a changed confirmation while a report row is `sending`, but the gap
        // before the claim exists — the whole render — is not covered by that refusal, and it is
        // the longest part of the pass.
        //
        // Sending now would put v1 in the client's inbox and seal v2 in the archive: the
        // contractor's own record would contradict the report he sent, which for an evidence
        // product is worse than sending nothing. So the claim is released instead and the
        // replacement pass — already enqueued by that confirmation — reports the new content.
        var currentCorrected = await db.Entries.AsNoTracking()
            .Where(e => e.Id == entry.Id)
            .Select(e => e.Corrected)
            .FirstOrDefaultAsync(ct);

        if (!string.Equals(currentCorrected, entry.Corrected, StringComparison.Ordinal))
        {
            return await ReleaseClaimAsync(entry.Id, reportId.Value, ct);
        }

        // ---- 5. delivery ---------------------------------------------------

        ReportDeliveryReceipt receipt;
        try
        {
            var message = new ReportMessage(
                reportId.Value,
                recipients,
                ReportMailBody.Subject(strings, project.Name, entry.EntryDate),
                ReportMailBody.Text(
                    strings, company?.Name ?? string.Empty, project.Name, entry.EntryDate),
                ReportMailBody.Html(
                    strings, company?.Name ?? string.Empty, project.Name, entry.EntryDate),
                ReportFileName.ForDaily(strings, project.Name, entry.EntryDate),
                pdf);

            receipt = await BoundedRetry.RunAsync(
                "report-delivery",
                entry.Id,
                _pipeline.MaxAttempts,
                _pipeline.RetryDelay,
                static ex => ex is ReportDeliveryException { Retryable: true },
                logger,
                token => delivery.SendAsync(message, token),
                ct);
        }
        catch (ReportDeliveryException ex)
        {
            // Classified on the typed kind, never on the relay's English banner.
            var code = ex.Kind switch
            {
                ReportDeliveryFailureKind.Unauthorized => ReportFailure.DeliveryUnauthorized,
                ReportDeliveryFailureKind.Rejected => ReportFailure.DeliveryRejected,
                ReportDeliveryFailureKind.NotConfigured => ReportFailure.DeliveryNotConfigured,
                // The relay stopped answering after transmission had begun. `delivery_failed`
                // would be a lie in the one direction that costs the most: it means "nothing left
                // the building", and here the message may well have. Recorded as the same
                // unknown the sweeper records for a crashed pass, and guarded the same way.
                ReportDeliveryFailureKind.CustodyUnknown =>
                    ReportFailure.DeliveryCustodyUnknown,
                _ => ReportFailure.DeliveryFailed,
            };

            logger.LogError(ex, "Entry {EntryId}: the report was not delivered.", entry.Id);
            return await FailAsync(entry.Id, reportId, code, ex.Message, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogError(ex, "Entry {EntryId}: the report delivery failed unexpectedly.", entry.Id);
            return await FailAsync(entry.Id, reportId, ReportFailure.Unexpected, ex.Message, ct);
        }

        // ---- 6. record what the relay said, then seal ----------------------

        var recorded = await db.Reports
            .Where(r => r.Id == reportId && r.Status == ReportStatus.Sending)
            .ExecuteUpdateAsync(
                s => s
                    .SetProperty(r => r.Status, ReportStatus.Sent)
                    .SetProperty(r => r.SentAt, DateTime.UtcNow)
                    .SetProperty(r => r.DeliveryDetail, receipt.RelayResponse)
                    .SetProperty(r => r.AttemptStartedAt, (DateTime?)null)
                    .SetProperty(r => r.FailureReason, (string?)null),
                ct);

        if (recorded != 1)
        {
            // Essentially unreachable — only the sweeper takes a `sending` claim away, and
            // Reporting:StaleAfter is several times the worst-case pass — but if it ever
            // happens the message *was* handed over and the row now says otherwise. That is the
            // one state a person must be told about rather than have papered over, and the entry
            // is deliberately not sealed while its record is in doubt.
            logger.LogCritical(
                "Entry {EntryId}: report {ReportId} was accepted by the relay ({Response}) but "
                + "the claim on the row was already gone, so the send could not be recorded. The "
                + "client most likely has this report; the entry is NOT sealed. Resolve by hand.",
                entry.Id, reportId, receipt.RelayResponse);

            return ReportOutcome.Sent;
        }

        // The rendered document, not the row: this pass knows exactly what it laid out, and the
        // seal is refused if the entry is no longer that. See SealAsync.
        if (!await SealAsync(entry.Id, entry.Corrected, ct))
        {
            return await RecordSupersededAfterSendAsync(entry.Id, ct);
        }

        logger.LogInformation(
            "Entry {EntryId} reported: {Recipients} recipient(s), {Photos} photo(s), "
            + "{Kilobytes} KB, language {Language}, via {Transport}.",
            entry.Id, recipients.Count, photoMedia.Count, pdf.LongLength / 1024,
            strings.Language, receipt.Transport);

        return ReportOutcome.Sent;
    }

    // ------------------------------------------------------------------ what this replaces

    /// <summary>
    /// The predecessor of a correction, named the way the report prints it — a work date, a send
    /// time, and a site only when it is not this report's own. Null for an ordinary entry, and
    /// then the document says nothing extra at all.
    ///
    /// <para>
    /// <b>One hop, deliberately.</b> A correction of a correction names its <em>immediate</em>
    /// predecessor, because that is the document the client last received; walking to the head of
    /// the chain would name a report two revisions old and hide the one he is holding. Chains are
    /// explicitly allowed (<c>EntrySupersedesTests</c>), so this is a choice rather than an
    /// omission.
    /// </para>
    /// <para>
    /// <b>Tenant-scoped, like every other read in this pass.</b> The global filter is what makes
    /// "not visible" and "not there" one answer; <c>fk_entry_supersedes_entry</c> is satisfied by
    /// any entry row there is and enforces nothing about whose it is.
    /// </para>
    /// <para>
    /// <b>A link that cannot be read is loud and does not stop the report.</b> The entry declares
    /// itself a correction, so silence would be a document that hides its own standing — but
    /// refusing to send a client his diary over an unreadable back-reference would trade the thing
    /// that matters for the thing that does not. It logs and prints nothing, which is the one case
    /// where this page is as weak as it was before this existed.
    /// </para>
    /// </summary>
    private async Task<ReportCorrection?> ReadCorrectionAsync(Entry entry, CancellationToken ct)
    {
        if (entry.SupersedesEntryId is not { } supersededId)
        {
            return null;
        }

        var superseded = await db.Entries.AsNoTracking()
            .Where(e => e.Id == supersededId)
            .Select(e => new { e.EntryDate, e.ProjectId })
            .FirstOrDefaultAsync(ct);

        if (superseded is null)
        {
            logger.LogWarning(
                "Entry {EntryId} declares that it supersedes {SupersededEntryId}, which this "
                + "company cannot see; the report will not name what it corrects.",
                entry.Id, supersededId);
            return null;
        }

        // Never the seal on the superseded entry: `superseded_after_send` is a report that went
        // out and an entry deliberately left unsealed, and printing "never sent" over a document
        // the client is holding is the worst thing this line could say.
        var sentAt = await db.Reports.AsNoTracking()
            .Where(r => r.EntryId == supersededId)
            .Select(r => r.SentAt)
            .FirstOrDefaultAsync(ct);

        // Only when it is not this report's own site. `POST /entries` refuses a cross-site link,
        // so this is here for a row that predates that check or was written by hand — where a bare
        // date would name a document belonging to somebody else's inbox.
        string? siteName = null;
        if (superseded.ProjectId != entry.ProjectId)
        {
            siteName = await db.Projects.AsNoTracking()
                .Where(p => p.Id == superseded.ProjectId)
                .Select(p => p.Name)
                .FirstOrDefaultAsync(ct);

            logger.LogWarning(
                "Entry {EntryId} supersedes {SupersededEntryId}, which belongs to a different "
                + "site; the report names that site explicitly.",
                entry.Id, supersededId);
        }

        return new ReportCorrection(
            superseded.EntryDate, siteName, UtcStamp.OrNull(sentAt));
    }

    // ------------------------------------------------------------------ evidence

    /// <summary>
    /// Downloads every photograph and verifies its SHA-256 against what the phone declared,
    /// before a single one reaches the renderer.
    /// <para>
    /// This is the obligation B3 handed to report generation (ARCHITECTURE §6, review F3):
    /// <c>/complete</c> checked existence and byte size only, because the API never reads media
    /// bytes. A mismatch here means the bytes in storage are not the bytes that were captured —
    /// and an evidence product must not quietly put them in front of a client.
    /// </para>
    /// </summary>
    private async Task<IReadOnlyList<ReportPhoto>> GatherPhotosAsync(
        Entry entry, IReadOnlyList<Media> media, string workspace, CancellationToken ct)
    {
        var photos = new List<ReportPhoto>(media.Count);

        foreach (var item in media)
        {
            var path = Path.Combine(workspace, $"{item.Id:N}.bin");

            await BoundedRetry.RunAsync(
                "photo-download",
                entry.Id,
                _pipeline.MaxAttempts,
                _pipeline.RetryDelay,
                IsRetryableStorage,
                logger,
                async token =>
                {
                    await VerifiedMediaReader.ReadToFileAsync(storage, item, path, logger, token);
                    return true;
                },
                ct);

            photos.Add(new ReportPhoto(
                item.Id, path, item.Sha256.TrimEnd(), UtcStamp.OrNull(item.CapturedAt)));
        }

        return photos;
    }

    /// <summary>Storage that did not answer may answer next time; bytes that do not hash to what
    /// was declared never will.</summary>
    private static bool IsRetryableStorage(Exception ex) =>
        ex is ObjectStorageUnavailableException;

    private void Cleanup(string workspace)
    {
        try
        {
            if (Directory.Exists(workspace))
            {
                Directory.Delete(workspace, recursive: true);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // A leftover temp file is untidy, not a failed report. Never let it mask the outcome.
            logger.LogWarning(
                ex, "Could not remove the report workspace {Workspace}.", workspace);
        }
    }

    // ------------------------------------------------------------------ claim

    /// <summary>
    /// Takes ownership of this entry's report, or returns null when somebody else already has it.
    /// <para>
    /// For a first attempt the claim <em>is</em> the insert: <c>ux_report_entry_id</c> is unique,
    /// so two concurrent passes cannot both proceed and the loser gets a unique violation rather
    /// than a second email. For a retry of a failed report it is a conditional UPDATE off
    /// <c>failed</c>, which is the same mechanism in the same shape.
    /// </para>
    /// </summary>
    private async Task<Guid?> ClaimAsync(
        Entry entry,
        Report? existing,
        IReadOnlyList<ReportRecipient> recipients,
        string objectKey,
        string pdfSha256,
        CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var snapshot = Snapshot(recipients);

        if (existing is not null)
        {
            // Only a report that has already failed may be picked up again. `sending` was
            // handled by the caller, and `sent` never comes back here.
            //
            // The custody-unknown reasons are excluded here as well as in ReportAsync, and not
            // out of caution about the caller: this is the only check that is part of the same
            // conditional UPDATE as the claim, so it is the only one that cannot be raced by a
            // sweeper marking the row interrupted in the microseconds after the pre-check.
            var reclaimed = await db.Reports
                .Where(r => r.Id == existing.Id
                            && r.Status == ReportStatus.Failed
                            && (r.FailureReason == null
                                || (!r.FailureReason.StartsWith(
                                        ReportFailure.ReportInterruptedPrefix)
                                    && !r.FailureReason.StartsWith(
                                        ReportFailure.DeliveryCustodyUnknownPrefix))))
                .ExecuteUpdateAsync(
                    s => s
                        .SetProperty(r => r.Status, ReportStatus.Sending)
                        .SetProperty(r => r.Attempts, r => r.Attempts + 1)
                        .SetProperty(r => r.AttemptStartedAt, now)
                        .SetProperty(r => r.PdfObjectKey, objectKey)
                        .SetProperty(r => r.PdfSha256, pdfSha256)
                        .SetProperty(r => r.CorrectedSha256, Sha256Of(entry.Corrected))
                        .SetProperty(r => r.Recipients, snapshot)
                        .SetProperty(r => r.FailureReason, (string?)null),
                    ct);

            return reclaimed == 1 ? existing.Id : null;
        }

        var report = new Report
        {
            Id = Guid.CreateVersion7(),
            CompanyId = entry.CompanyId,
            ProjectId = entry.ProjectId,
            EntryId = entry.Id,
            Kind = ReportKind.Daily,
            PeriodStart = entry.EntryDate,
            PeriodEnd = entry.EntryDate,
            PdfObjectKey = objectKey,
            PdfSha256 = pdfSha256,
            // What this document says, so a later pass can ask whether the entry still says it.
            CorrectedSha256 = Sha256Of(entry.Corrected),
            // A snapshot, not a reference: editing the project's distribution list next month
            // must never rewrite who this report went to.
            Recipients = snapshot,
            Status = ReportStatus.Sending,
            Attempts = 1,
            AttemptStartedAt = now,
            CreatedAt = now,
        };

        db.Reports.Add(report);

        try
        {
            await db.SaveChangesAsync(ct);
            return report.Id;
        }
        catch (DbUpdateException ex)
            when (ex.InnerException is PostgresException
                  {
                      SqlState: PostgresErrorCodes.UniqueViolation,
                      ConstraintName: "ux_report_entry_id",
                  })
        {
            // Another pass got there first. It owns the send; this one goes away having done
            // nothing but waste a render.
            db.ChangeTracker.Clear();
            return null;
        }
    }

    private static string Snapshot(IReadOnlyList<ReportRecipient> recipients) =>
        JsonSerializer.Serialize(recipients.Select(r => new
        {
            name = r.Name,
            email = r.Email,
            role = r.Role,
        }));

    // ------------------------------------------------------------------ terminal writes

    /// <summary>
    /// Stamps <c>reported_at</c> — the irreversible write. True when this pass sealed the entry.
    /// <para>
    /// Conditional on the entry still being <c>confirmed</c> and unreported, which is both the
    /// claim check and what keeps the Postgres immutability trigger out of it: the trigger
    /// rejects any UPDATE whose OLD row already carries <c>reported_at</c>, and this predicate
    /// can never select one.
    /// </para>
    /// <para>
    /// <b>And conditional on <c>corrected</c> still being the document that was sent.</b> That
    /// clause closes the last gap between the confirm endpoint's refusal and this pass's own
    /// re-read, neither of which can close it alone: <c>/confirm</c> checks for a <c>sending</c>
    /// row and then writes, the pass claims and then re-reads, and a confirmation whose check ran
    /// before the claim and whose write landed after the re-read passed both. What it cost was the
    /// one write that cannot be taken back — <c>reported_at</c> on content the client never
    /// received, with the archive then contradicting the report itself. The comparison is in the
    /// same statement as the stamp, so there is nothing left to race.
    /// </para>
    /// <para>
    /// <b>Compared as <c>jsonb</c>, not as text, and that is deliberate.</b> The column is
    /// <c>jsonb</c> and EF sends the parameter as one, so Postgres compares the two documents
    /// semantically — key order and whitespace do not enter into it. A hash of the string would
    /// have been the stricter check and the wrong one: it would refuse a seal over a
    /// re-serialisation that says exactly the same thing. (The <em>row</em> stores a hash, in
    /// <c>report.corrected_sha256</c>, because the recovery path runs in another process and has
    /// no document to compare — see <see cref="SealDeliveredAsync"/>.)
    /// </para>
    /// </summary>
    private async Task<bool> SealAsync(Guid entryId, string? corrected, CancellationToken ct)
    {
        // Written as two predicates rather than one because `e.Corrected == corrected` with a
        // null parameter translates to `corrected = NULL`, which is never true — so a legitimately
        // empty document would never seal.
        var claim = corrected is null
            ? db.Entries.Where(e => e.Corrected == null)
            : db.Entries.Where(e => e.Corrected == corrected);

        var sealedRows = await claim
            .Where(e => e.Id == entryId
                        && e.Status == EntryStatus.Confirmed
                        && e.ReportedAt == null)
            .ExecuteUpdateAsync(
                s => s
                    .SetProperty(e => e.Status, EntryStatus.Reported)
                    .SetProperty(e => e.ReportedAt, DateTime.UtcNow)
                    .SetProperty(e => e.FailureReason, (string?)null),
                ct);

        if (sealedRows == 1)
        {
            return true;
        }

        logger.LogWarning(
            "Entry {EntryId}: the report went out but the entry was no longer `confirmed`, "
            + "unreported and holding the content that was sent, so it was not sealed by this "
            + "pass.", entryId);

        return false;
    }

    /// <summary>
    /// Finishes a report the relay already took: seals the entry if it still holds what went out,
    /// and refuses to if it does not.
    /// <para>
    /// The two answers are different facts and neither may be papered over. If the entry moved on
    /// (a re-confirmation that raced the seal), the client holds one version and the archive holds
    /// another; sealing would assert that the archive's version was sent, and a second report of
    /// the same day is what <c>ux_report_entry_id</c> and ARCHITECTURE §6 exist to prevent. So it
    /// stops, visibly, and a person decides — the correction path after a report is a new entry
    /// with <c>supersedes_entry_id</c>.
    /// </para>
    /// <para>
    /// A row from before <c>corrected_sha256</c> existed cannot be compared. It is sealed as it
    /// always was, and the log says the check was unavailable rather than implying one happened.
    /// </para>
    /// </summary>
    private async Task<ReportOutcome> SealDeliveredAsync(
        Entry entry, Report report, CancellationToken ct)
    {
        if (report.CorrectedSha256 is null)
        {
            logger.LogWarning(
                "Entry {EntryId}: report {ReportId} predates corrected_sha256, so what was sent "
                + "cannot be compared with what the entry holds; sealing it as before.",
                entry.Id, report.Id);

            await SealAsync(entry.Id, entry.Corrected, ct);
            return ReportOutcome.Sent;
        }

        if (!string.Equals(report.CorrectedSha256, Sha256Of(entry.Corrected), StringComparison.Ordinal))
        {
            return await RecordSupersededAfterSendAsync(entry.Id, ct);
        }

        if (!await SealAsync(entry.Id, entry.Corrected, ct))
        {
            // The hashes agreed a moment ago and the conditional stamp still found nothing, so
            // something changed between the two — the same race, one turn later.
            return await RecordSupersededAfterSendAsync(entry.Id, ct);
        }

        return ReportOutcome.Sent;
    }

    /// <summary>
    /// A document was delivered and the entry is not it. Says so on the entry and stops.
    /// <para>
    /// <c>LogCritical</c> because nothing automatic can resolve this and nothing should try: the
    /// report row keeps its truthful <c>sent</c> — the relay did take that message — and the entry
    /// stays <c>confirmed</c> with a reason, which is the state the report sweeper deliberately
    /// leaves alone. A replayed confirmation clears the reason and re-queues; the pass then lands
    /// on the recovery path above, compares again, and writes the same reason back, so the state
    /// is re-derived rather than laundered.
    /// </para>
    /// </summary>
    private async Task<ReportOutcome> RecordSupersededAfterSendAsync(
        Guid entryId, CancellationToken ct)
    {
        var reason = ReportFailure.Describe(
            ReportFailure.SupersededAfterSend,
            "a report of an earlier version of this entry has already been delivered, and the "
            + "version held now was never sent — so the entry is not sealed. A correction after a "
            + "report is a new entry referencing this one; nothing automatic sends a second "
            + "document for the same day");

        logger.LogCritical(
            "Entry {EntryId}: the report was delivered and the entry has since changed, so it is "
            + "NOT sealed. The client holds the earlier version; the archive holds a newer one. "
            + "Resolve by hand — a correction after a report is a new entry.", entryId);

        await db.Entries
            .Where(e => e.Id == entryId
                        && e.Status == EntryStatus.Confirmed
                        && e.ReportedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(e => e.FailureReason, reason), ct);

        return ReportOutcome.Sent;
    }

    /// <summary>
    /// The hash recorded on a report row, over the <c>corrected</c> document as Postgres handed it
    /// back. Both sides of the comparison are read from the same normalised column, so the string
    /// is stable across passes.
    /// </summary>
    internal static string? Sha256Of(string? corrected) =>
        corrected is null
            ? null
            : Convert.ToHexStringLower(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(corrected)));

    /// <summary>
    /// Hands the claim back because the entry moved underneath this pass, having sent nothing.
    /// <para>
    /// Deliberately writes <b>only</b> the report row and leaves <c>entry.failure_reason</c> null.
    /// Nothing has gone wrong that a person needs to see — a newer confirmation exists and its
    /// own pass is already queued — and a clean entry with a <c>failed</c> report row is exactly
    /// what the sweeper's report predicate picks up, so the replacement is covered even if that
    /// enqueue is lost too.
    /// </para>
    /// </summary>
    private async Task<ReportOutcome> ReleaseClaimAsync(
        Guid entryId, Guid reportId, CancellationToken ct)
    {
        var reason = ReportFailure.Describe(
            ReportFailure.Superseded,
            "the entry was confirmed again with different content while this report was being "
            + "produced, so nothing was sent and the newer confirmation's pass reports it");

        await db.Reports
            .Where(r => r.Id == reportId && r.Status == ReportStatus.Sending)
            .ExecuteUpdateAsync(
                s => s
                    .SetProperty(r => r.Status, ReportStatus.Failed)
                    .SetProperty(r => r.AttemptStartedAt, (DateTime?)null)
                    .SetProperty(r => r.FailureReason, reason),
                ct);

        logger.LogWarning(
            "Entry {EntryId}: it was re-confirmed with different content while report "
            + "{ReportId} was being produced. Nothing was sent; the claim is released so the "
            + "newer confirmation is what reaches the client.",
            entryId, reportId);

        return ReportOutcome.Skipped;
    }

    /// <summary>
    /// Records why nothing was sent, in both places a person might look.
    /// <para>
    /// The entry keeps its <c>confirmed</c> status on purpose — it is still perfectly reportable
    /// once the cause is fixed — and only <c>failure_reason</c> changes, conditionally, so a pass
    /// that has lost its claim cannot write over an entry that has since been reported.
    /// </para>
    /// </summary>
    private async Task<ReportOutcome> FailAsync(
        Guid entryId, Guid? reportId, string code, string detail, CancellationToken ct)
    {
        var reason = ReportFailure.Describe(code, detail);

        if (reportId is not null)
        {
            await db.Reports
                .Where(r => r.Id == reportId && r.Status == ReportStatus.Sending)
                .ExecuteUpdateAsync(
                    s => s
                        .SetProperty(r => r.Status, ReportStatus.Failed)
                        .SetProperty(r => r.AttemptStartedAt, (DateTime?)null)
                        .SetProperty(r => r.FailureReason, reason),
                    ct);
        }

        var marked = await db.Entries
            .Where(e => e.Id == entryId
                        && e.Status == EntryStatus.Confirmed
                        && e.ReportedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(e => e.FailureReason, reason), ct);

        if (marked != 1)
        {
            logger.LogWarning(
                "Entry {EntryId}: the report failed with {FailureCode}, but the entry is no "
                + "longer `confirmed` and unreported, so the reason was not recorded on it.",
                entryId, code);
        }

        logger.LogWarning(
            "Entry {EntryId}: no report was sent ({FailureCode}).", entryId, code);

        return ReportOutcome.Failed;
    }
}
