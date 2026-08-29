namespace Teren.Core.Ai;

/// <summary>
/// What went wrong with an external AI call, in a form the pipeline can branch on.
/// <para>
/// The distinction that matters is not "which provider" but "did the call fail, or did it
/// succeed and hand back something unusable". The second case is a 200 with content nobody can
/// build an entry from — no speech in the recording, an answer that is not a v1 structure — and
/// it deserves its own <c>failure_reason</c> code so the phone can say something true in
/// Serbian. Which code that is depends on the stage, so the mapping lives in the processor;
/// this enum is only the fact the provider observed.
/// </para>
/// </summary>
public enum AiFailureKind
{
    /// <summary>The call itself failed: a timeout, a 429, a 5xx, a rejected request.</summary>
    CallFailed,

    /// <summary>The provider answered, but the answer cannot be used as this entry's content.</summary>
    UnusableAnswer,

    /// <summary>No key, region or model is configured. See <see cref="AiProviderNotConfiguredException"/>.</summary>
    NotConfigured,
}

/// <summary>
/// An external AI call did not produce a usable answer.
/// <para>
/// <see cref="Retryable"/> is the whole point of this type. A retryable failure (a timeout, a
/// 429, a 5xx) is worth attempting again inside the job; a terminal one (a rejected key, an
/// unsupported locale, a provider with no configuration at all) never is — retrying it only
/// burns time before the entry lands in <c>needs_review</c> anyway. Nothing is ever lost in
/// either case: the entry parks with whatever raw evidence exists, visible to a human.
/// </para>
/// <para>
/// <see cref="Kind"/> is the second half of that contract, and it exists because the alternative
/// was classifying failures by <c>Message.Contains("no speech")</c> — the exact mistake B3's
/// failure taxonomy refused to make. Rewording an error string must never silently change what
/// a foreman is told.
/// </para>
/// </summary>
public class AiProviderException(
    string provider,
    string message,
    bool retryable,
    Exception? inner = null,
    AiFailureKind kind = AiFailureKind.CallFailed)
    : Exception(message, inner)
{
    public string Provider { get; } = provider;

    public bool Retryable { get; } = retryable;

    /// <summary>What the provider observed, independent of how the message is worded.</summary>
    public AiFailureKind Kind { get; } = kind;
}

/// <summary>
/// The provider has no key / region / model configured. Terminal by construction: no number of
/// attempts conjures a credential. Thrown rather than returned so a caller cannot ignore it,
/// and caught by the pipeline into an honest <c>needs_review</c> reason — never into silence,
/// and never into a host that refuses to boot.
/// </summary>
public sealed class AiProviderNotConfiguredException(string provider, string missing)
    : AiProviderException(
        provider,
        $"{provider} is not configured: {missing} is missing. Set it via user-secrets or an "
        + "environment variable; until then this entry waits in needs_review with its raw "
        + "evidence intact.",
        retryable: false,
        kind: AiFailureKind.NotConfigured)
{
    public string Missing { get; } = missing;
}
