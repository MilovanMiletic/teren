namespace SttSpike.Providers;

/// <summary>
/// Reserved slot for Google Cloud Speech-to-Text.
/// <para>
/// Not implemented: Google authenticates with a service-account JSON and an OAuth token exchange
/// rather than a header key, and long audio wants the async <c>longrunningrecognize</c> flow with
/// a GCS upload. That is a real integration, not the "one multipart POST" the other slots were,
/// and A1 is a throwaway harness. It appears in every run so it is visibly a deliberate gap
/// rather than an oversight.
/// </para>
/// <para>
/// If A3 wants it: add the <c>Google.Cloud.Speech.V2</c> package, point
/// <c>Stt:Google:CredentialsPath</c> at the service-account file, and implement
/// <see cref="RunAsync"/> here — nothing else in the harness needs to change.
/// </para>
/// </summary>
public sealed class GoogleSttProvider(string credentialsPath) : ISttProvider
{
    public string Name => "google-stt";

    public Task<SttRunResult> RunAsync(SttRunContext context, CancellationToken ct)
    {
        var reason = string.IsNullOrWhiteSpace(credentialsPath)
            ? "slot reserved, not implemented (needs a service-account credential flow)"
            : "Stt:Google:CredentialsPath is set, but this slot is not implemented yet";

        return Task.FromResult(SttRunResult.Skipped(Name, reason));
    }
}
