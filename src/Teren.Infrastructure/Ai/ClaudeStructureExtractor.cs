using System.Diagnostics;
using System.Text.Json;
using Anthropic;
using Anthropic.Exceptions;
using Anthropic.Models.Messages;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Teren.Core.Ai;

namespace Teren.Infrastructure.Ai;

/// <summary>
/// Transcript to structured entry, via the official Anthropic SDK (ARCHITECTURE §9.2).
/// <para>
/// Three decisions are embedded here and each has a reason:
/// </para>
/// <list type="bullet">
/// <item><b>Structured outputs</b> (<c>OutputConfig.Format</c>) rather than prompt-and-pray: the
/// answer is validated against the v1 schema before it ever reaches us, so the pipeline never
/// parses hopeful JSON.</item>
/// <item><b>Adaptive thinking.</b> <c>budget_tokens</c> is gone on current models and returns a
/// 400 — do not carry that pattern in from older code.</item>
/// <item><b>A cache breakpoint after the instructions.</b> The instruction block is identical on
/// every call in the product; the site vocabulary is not. Stable first, volatile after.</item>
/// </list>
/// <para>
/// The vocabulary block is the load-bearing part. A3 found every Azure path turns
/// <c>PPR cev 25</c> into <em>pipr cevi dvaes 5</em>, and phrase-list hinting is inert for
/// Serbian — so recovering the canonical material name here, from the site's own list, is the
/// product's mitigation rather than a nicety (<c>docs/stt-evaluation.md</c>).
/// </para>
/// </summary>
public sealed class ClaudeStructureExtractor : IStructureExtractor
{
    private readonly ExtractionOptions _options;
    private readonly ILogger<ClaudeStructureExtractor> _logger;
    private readonly Lazy<AnthropicClient> _client;

    /// <summary>
    /// The v1 schema, parsed once. Kept as text in <c>Teren.Core</c> so the domain carries no
    /// vendor SDK; shaped for the SDK exactly here, at the boundary.
    /// </summary>
    private static readonly Dictionary<string, JsonElement> SchemaV1 =
        JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(EntryStructureSchema.Json)
        ?? throw new InvalidOperationException("The v1 entry-structure schema is not valid JSON.");

    public ClaudeStructureExtractor(
        IOptions<ExtractionOptions> options, ILogger<ClaudeStructureExtractor> logger)
    {
        _options = options.Value;
        _logger = logger;

        // Lazy so a host with no key still starts: the client is only built when an entry
        // actually reaches extraction, and IsConfigured stops it before that.
        _client = new Lazy<AnthropicClient>(() => new AnthropicClient
        {
            ApiKey = _options.ApiKey,
            Timeout = _options.RequestTimeout,

            // The SDK's own default is two retries on 408/409/429/5xx — and it retries timeouts
            // too, so a single Create() could occupy RequestTimeout x 3 before returning. Retry
            // policy belongs to the processor, which owns Pipeline:MaxAttempts and the entry's
            // state machine; this is the same argument that makes the Hangfire job
            // [AutomaticRetry(Attempts = 0)]. Two stacked retry loops are also what let a live
            // pass outrun Pipeline:StaleProcessingAfter and get parked underneath itself — see
            // the arithmetic on that option.
            MaxRetries = 0,
        });
    }

    public string Name => "anthropic";

    public bool IsConfigured => _options.IsConfigured(out _);

    public async Task<ExtractionResult> ExtractAsync(ExtractionContext context, CancellationToken ct)
    {
        if (!_options.IsConfigured(out var missing))
        {
            throw new AiProviderNotConfiguredException(Name, missing);
        }

        var parameters = new MessageCreateParams
        {
            Model = _options.Model,
            MaxTokens = _options.MaxTokens,
            Thinking = new ThinkingConfigAdaptive(),
            System = new List<TextBlockParam>
            {
                // Stable prefix — identical on every call, and therefore the thing worth caching.
                new()
                {
                    Text = ExtractionPrompt.Instructions,
                    CacheControl = new CacheControlEphemeral(),
                },
                // Volatile per-site block, after the breakpoint.
                new()
                {
                    Text = ExtractionPrompt.SiteContext(
                        context.ProjectName, context.Vocabulary, context.EntryDate),
                },
            },
            OutputConfig = new OutputConfig
            {
                Format = new JsonOutputFormat { Schema = SchemaV1 },
            },
            Messages =
            [
                new()
                {
                    Role = Role.User,
                    Content = ExtractionPrompt.UserMessage(context.Transcript),
                },
            ],
        };

        var stopwatch = Stopwatch.StartNew();
        Message response;

        try
        {
            response = await _client.Value.Messages.Create(parameters, cancellationToken: ct);
        }
        catch (AnthropicRateLimitException ex)
        {
            throw new AiProviderException(Name, "rate limited (429)", retryable: true, ex);
        }
        catch (Anthropic5xxException ex)
        {
            throw new AiProviderException(
                Name, "the model API returned a server error", retryable: true, ex);
        }
        catch (AnthropicApiException ex)
        {
            // 4xx: a bad key, an unknown model id, a malformed schema. None of those improve on
            // a second attempt, and pretending otherwise only delays the honest needs_review.
            throw new AiProviderException(
                Name, $"the model API rejected the request: {ex.Message}", retryable: false, ex);
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new AiProviderException(
                Name,
                $"the request did not complete within {_options.RequestTimeout.TotalSeconds:0.#} s",
                retryable: true);
        }
        catch (HttpRequestException ex)
        {
            throw new AiProviderException(
                Name, $"could not reach the model API: {ex.Message}", retryable: true, ex);
        }

        stopwatch.Stop();

        if (response.StopReason == "refusal")
        {
            // Vanishingly unlikely on a plumber's site note, but it is a 200 with no content —
            // exactly the shape that becomes an empty report if nobody checks for it.
            throw new AiProviderException(
                Name, "the model declined to answer for this transcript", retryable: false);
        }

        var json = string.Concat(
            response.Content.Select(b => b.Value).OfType<TextBlock>().Select(t => t.Text));

        if (!EntryStructureSchema.IsValid(json, out var problem))
        {
            // Structured outputs should make this unreachable. It is checked anyway because the
            // alternative to checking is a constraint violation three frames away, or worse, a
            // row of nonsense presented to a foreman as what the system understood.
            throw new AiProviderException(
                Name,
                $"the model answered but {problem}",
                retryable: false,
                kind: AiFailureKind.UnusableAnswer);
        }

        _logger.LogInformation(
            "Extracted structure with {Model} in {ElapsedMs} ms "
            + "(in {InputTokens} tok, out {OutputTokens} tok, cache read {CacheRead} tok).",
            _options.Model, stopwatch.ElapsedMilliseconds,
            response.Usage.InputTokens, response.Usage.OutputTokens,
            response.Usage.CacheReadInputTokens);

        return new ExtractionResult(
            json,
            _options.Model,
            stopwatch.Elapsed,
            response.Usage.InputTokens,
            response.Usage.OutputTokens);
    }
}
