using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.Extensions.Options;
using Teren.Api.Auth;
using Teren.Api.Contracts;
using Teren.Api.Validation;
using Teren.Core.Entities;
using Teren.Infrastructure.Logging;

namespace Teren.Api.Endpoints;

/// <summary>
/// <c>POST /api/client-events</c> — what was clicked, from the app that did it (D5, contract §3).
///
/// <para>
/// <b>Both credentials, on purpose.</b> There is no role gate: a device token and an admin session
/// are equally welcome, because the founder asked for every action in the <em>app</em>, not every
/// action in the office. A worker's phone and an owner's browser are the same product. The caller
/// is resolved exactly as <see cref="MeEndpoints"/> resolves it — one
/// <see cref="Teren.Core.Tenancy.TerenPrincipal"/> from <see cref="BearerAuthFilter"/>, whichever
/// table issued the token.
/// </para>
///
/// <para>
/// <b><c>company_id</c> comes from the caller's scope and never from the body.</b> A phone that
/// could name its own company could write log rows against another customer's account — the
/// cheapest possible way to make the one stream Teren staff trust untrustworthy. It is not in the
/// request shape at all, so there is nothing to forget to ignore.
/// </para>
///
/// <para>
/// <b>Validation here is the security boundary, so it rejects rather than sanitises.</b> Everything
/// arriving is destined for a screen Teren staff read, and the product's central claim is that they
/// cannot read a customer's work. An <c>action</c> is a slug and a slug cannot carry a transcript;
/// a <c>route</c> may carry an id and may never carry a query string, because a query string is
/// where the words somebody typed end up; a <c>detail</c> value may be a number, a boolean or a
/// slug, and nothing else. The rejections are counted, never 4xx'd — see
/// <see cref="ClientEventBatchResponse"/> for why a partly bad batch must not be refused.
/// </para>
/// </summary>
public static partial class ClientEventEndpoints
{
    public static RouteGroupBuilder MapClientEventEndpoints(this RouteGroupBuilder api)
    {
        var maxBodyBytes = ((IEndpointRouteBuilder)api).ServiceProvider
            .GetRequiredService<IOptions<LoggingOptions>>().Value.ClientEvents.MaxBodyBytes;

        // Deliberately no RequireRole: every authenticated caller may report what he did.
        api.MapPost("/client-events", IngestAsync)
            // The body cap, as endpoint metadata, because that is the only place it can be
            // enforced BEFORE the body is read. A check in the handler runs after model binding
            // has already deserialised whatever arrived, and `ContentLength` is null for a chunked
            // request — so the cap this route documents was, in practice, Kestrel's 30 MB default.
            // Kestrel enforces this one while reading, chunked or not, and answers 413 through
            // MalformedRequestExceptionHandler.
            .WithMetadata(new BodySizeLimit(maxBodyBytes))
            // Per caller, 60 batches a minute (Logging:ClientEvents:RateLimitPerMinute). The cap
            // above bounds one request; this bounds a client, which the drop-oldest queue behind
            // the route makes necessary rather than tidy — see ClientEventRateLimitPolicy.
            .RequireRateLimiting(ClientEventRateLimitPolicy.Name)
            .AddEndpointFilter<ValidationFilter<ClientEventBatchRequest>>()
            .WithTags("Logs")
            .WithName("IngestClientEvents")
            .WithSummary("Record what happened in the app. Always accepted; never a conflict.")
            .Produces<ClientEventBatchResponse>(StatusCodes.Status202Accepted)
            .ProducesProblem(StatusCodes.Status413PayloadTooLarge);

        return api;
    }

    /// <summary>`area.thing.verb`, two to five lower-case segments. A slug cannot carry a sentence.</summary>
    [GeneratedRegex(@"^[a-z][a-z0-9]*(\.[a-z0-9-]+){1,4}$", RegexOptions.CultureInvariant)]
    private static partial Regex ActionPattern();

    /// <summary>
    /// An app path. <b>No <c>?</c> and no <c>#</c></b> — the character class simply has no room for
    /// either, which is stricter than stripping them and impossible to get half right.
    /// </summary>
    [GeneratedRegex(@"^/[A-Za-z0-9/_:.\-]{0,120}$", RegexOptions.CultureInvariant)]
    private static partial Regex RoutePattern();

    [GeneratedRegex(@"^[a-z][a-z0-9_]{0,30}$", RegexOptions.CultureInvariant)]
    private static partial Regex DetailKeyPattern();

    /// <summary>A slug value: no spaces, so no sentence, so no dictated note.</summary>
    [GeneratedRegex(@"^[a-z0-9_.\-]{1,40}$", RegexOptions.CultureInvariant)]
    private static partial Regex DetailSlugPattern();

    private static readonly string[] Outcomes = ["ok", "fail", "cancel", "blocked"];

    private const int MaxDetailKeys = 10;
    private const long MaxDurationMs = 3_600_000;
    private const int MaxActionLength = 80;

    /// <summary>
    /// The per-route request body cap. Metadata rather than a check in the handler: minimal-API
    /// endpoint filters and handlers both run <em>after</em> the body has been bound, so by the
    /// time either could look at it the megabytes are already in the process.
    /// </summary>
    private sealed class BodySizeLimit(long bytes) : IRequestSizeLimitMetadata
    {
        public long? MaxRequestBodySize => bytes;
    }

    private static IResult IngestAsync(
        ClientEventBatchRequest request,
        HttpContext http,
        AppLogQueue queue,
        IOptions<LoggingOptions> options)
    {
        var settings = options.Value.ClientEvents;
        var events = request.Events ?? [];

        if (!settings.Enabled)
        {
            // The kill switch answers 202 with nothing accepted. An error would make an
            // offline-first client retry the same batch for ever over a setting that means
            // "we do not want these".
            return TypedResults.Accepted((string?)null, new ClientEventBatchResponse(0, 0));
        }

        var principal = http.GetPrincipal();
        var now = DateTime.UtcNow;
        var accepted = 0;
        var rejected = 0;

        foreach (var candidate in events)
        {
            var row = Convert(candidate, principal, now);

            if (row is null)
            {
                rejected++;
                continue;
            }

            // Handed to the same bounded queue every server-side log line goes through, so this
            // route never waits on the database — and so a phone reporting what it did costs the
            // request path exactly one enqueue.
            queue.Enqueue(row);
            accepted++;
        }

        return TypedResults.Accepted(
            (string?)null, new ClientEventBatchResponse(accepted, rejected));
    }

    /// <summary>
    /// One event, or null when it is rejected whole.
    /// <para>
    /// <b>Whole-event rejection is limited to the four fields that identify it</b> — <c>id</c>,
    /// <c>at</c>, <c>action</c>, <c>route</c>. A bad <c>detail</c> key is dropped and the event is
    /// kept: the event still says what a person did, and throwing that away because one extra fact
    /// was malformed would lose the more valuable half.
    /// </para>
    /// </summary>
    private static AppLogRow? Convert(
        ClientEventRequest candidate, Teren.Core.Tenancy.TerenPrincipal principal, DateTime now)
    {
        if (candidate.Id is not { } id || id == Guid.Empty)
        {
            return null;
        }

        if (candidate.At is not { } at)
        {
            return null;
        }

        var action = candidate.Action?.Trim();
        if (action is null || action.Length > MaxActionLength || !ActionPattern().IsMatch(action))
        {
            return null;
        }

        var route = candidate.Route?.Trim();
        if (route is null || !RoutePattern().IsMatch(route))
        {
            return null;
        }

        var outcome = candidate.Outcome?.Trim().ToLowerInvariant();
        if (outcome is not null && Array.IndexOf(Outcomes, outcome) < 0)
        {
            return null;
        }

        if (candidate.DurationMs is { } duration && duration is < 0 or > MaxDurationMs)
        {
            return null;
        }

        // A phone's clock drifts and travels, and an event stamped next year would sit at the top
        // of the viewer for ever. Anything ahead of the server is stamped now instead of rejected:
        // what the person did is worth more than what his clock said.
        var stamped = at.UtcDateTime > now ? now : at.UtcDateTime;

        var area = action[..action.IndexOf('.', StringComparison.Ordinal)];

        return new AppLogRow(
            At: stamped,
            // A failed action is a Warning so that "what is failing" — the level filter an
            // operator actually reaches for — includes the app and not only the server.
            Level: outcome == "fail" ? AppLogLevels.Warning : AppLogLevels.Information,
            // `web.` prefixed, so one glance at the source column separates the phone from the
            // server without reading a single message.
            Source: "web." + area,
            Template: action,
            Message: Describe(action, route, outcome, candidate.DurationMs),
            Properties: Properties(candidate, principal, action, route, outcome),
            Exception: null,
            // From the caller's credential. Never from the body — there is no field for it.
            CompanyId: principal.CompanyId,
            EntryId: candidate.EntryId,
            // The client's own event id: what makes a replayed batch recognisable afterwards.
            Correlation: id.ToString());
    }

    private static string Describe(string action, string route, string? outcome, long? duration)
    {
        var line = new System.Text.StringBuilder(action).Append(" on ").Append(route);

        if (outcome is not null)
        {
            line.Append(" → ").Append(outcome);
        }

        if (duration is { } ms)
        {
            line.Append(" (").Append(ms.ToString(CultureInfo.InvariantCulture)).Append(" ms)");
        }

        return line.ToString();
    }

    /// <summary>
    /// The JSON bag: route, outcome, duration, the surviving detail keys, and who was holding the
    /// credential.
    /// <para>
    /// <c>user_id</c> and <c>device_id</c> come from the principal, like the company — the log
    /// stream's answer to "who was this" must not be something the caller can write.
    /// </para>
    /// </summary>
    private static string Properties(
        ClientEventRequest candidate,
        Teren.Core.Tenancy.TerenPrincipal principal,
        string action,
        string route,
        string? outcome)
    {
        var buffer = new System.Buffers.ArrayBufferWriter<byte>();
        using var json = new Utf8JsonWriter(buffer);

        json.WriteStartObject();
        json.WriteString("action", action);
        json.WriteString("route", route);

        if (outcome is not null)
        {
            json.WriteString("outcome", outcome);
        }

        if (candidate.DurationMs is { } duration)
        {
            json.WriteNumber("duration_ms", duration);
        }

        if (candidate.ProjectId is { } projectId)
        {
            json.WriteString("project_id", projectId);
        }

        json.WriteString("user_id", principal.UserId);

        if (principal.DeviceId is { } deviceId)
        {
            json.WriteString("device_id", deviceId);
        }

        WriteDetail(json, candidate.Detail);

        json.WriteEndObject();
        json.Flush();

        return System.Text.Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    /// <summary>
    /// The extra facts, filtered.
    /// <para>
    /// <b>A value may be a number, a boolean, or a slug — and nothing else.</b> A string with a
    /// space in it, an object, an array: the key is dropped. That single rule is what makes it true
    /// that there is no path by which free text from a phone reaches the log table, and it is
    /// stated as a whitelist of shapes rather than a blacklist of dangerous ones because a
    /// blacklist over JSON cannot be finished.
    /// </para>
    /// </summary>
    private static void WriteDetail(
        Utf8JsonWriter json, IReadOnlyDictionary<string, JsonElement>? detail)
    {
        if (detail is null || detail.Count == 0)
        {
            return;
        }

        var written = 0;

        json.WriteStartObject("detail");

        foreach (var (key, value) in detail)
        {
            if (written == MaxDetailKeys)
            {
                break;
            }

            if (!DetailKeyPattern().IsMatch(key))
            {
                continue;
            }

            switch (value.ValueKind)
            {
                case JsonValueKind.Number:
                    json.WritePropertyName(key);
                    value.WriteTo(json);
                    written++;
                    break;

                case JsonValueKind.True or JsonValueKind.False:
                    json.WriteBoolean(key, value.GetBoolean());
                    written++;
                    break;

                case JsonValueKind.String
                    when value.GetString() is { } text && DetailSlugPattern().IsMatch(text):
                    json.WriteString(key, text);
                    written++;
                    break;

                default:
                    // An object, an array, a null, or a string that is not a slug. Dropped, and
                    // the event survives without it.
                    break;
            }
        }

        json.WriteEndObject();
    }
}
