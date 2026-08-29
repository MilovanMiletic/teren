using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Teren.Api.Tests.Infrastructure;

/// <summary>
/// Request and response helpers that speak the wire, not C# records.
/// <para>
/// Payloads are built as <see cref="JsonObject"/> with the field names spelled out, and responses
/// are read as raw JSON rather than deserialised into the API's contract types. That is
/// deliberate: deserialising with the same naming policy the server serialises with would make a
/// snake_case regression invisible, and snake_case is the contract the PWA is written against.
/// </para>
/// </summary>
public static class Wire
{
    public static DateOnly Today => DateOnly.FromDateTime(DateTime.UtcNow);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public static JsonObject Entry(
        Guid id,
        Guid projectId,
        DateOnly? entryDate = null,
        DateTimeOffset? createdAt = null,
        double? latitude = null,
        double? longitude = null,
        double? gpsAccuracyM = null,
        Guid? deviceId = null)
    {
        var body = new JsonObject
        {
            ["id"] = id.ToString(),
            ["project_id"] = projectId.ToString(),
            ["entry_date"] = (entryDate ?? Today).ToString("yyyy-MM-dd"),
        };

        if (createdAt is not null)
        {
            body["created_at"] = createdAt.Value.ToString("O");
        }

        if (latitude is not null)
        {
            body["latitude"] = latitude.Value;
        }

        if (longitude is not null)
        {
            body["longitude"] = longitude.Value;
        }

        if (gpsAccuracyM is not null)
        {
            body["gps_accuracy_m"] = gpsAccuracyM.Value;
        }

        if (deviceId is not null)
        {
            body["device_id"] = deviceId.Value.ToString();
        }

        return body;
    }

    public static JsonObject File(
        Guid id,
        string kind,
        string contentType,
        long byteSize,
        string? sha256 = null,
        DateTimeOffset? capturedAt = null)
    {
        var file = new JsonObject
        {
            ["id"] = id.ToString(),
            ["kind"] = kind,
            ["content_type"] = contentType,
            ["byte_size"] = byteSize,
            ["sha256"] = sha256 ?? Sha256Of(id.ToString()),
        };

        if (capturedAt is not null)
        {
            file["captured_at"] = capturedAt.Value.ToString("O");
        }

        return file;
    }

    public static JsonObject Audio(
        Guid id, long byteSize = 120_000, string contentType = "audio/ogg", string? sha256 = null)
        => File(id, "audio", contentType, byteSize, sha256);

    public static JsonObject Photo(
        Guid id, long byteSize = 300_000, string contentType = "image/jpeg", string? sha256 = null)
        => File(id, "photo", contentType, byteSize, sha256);

    /// <summary>Deep-clones each file so the same declaration object can be posted twice — which
    /// is exactly what a client re-declaring an expired upload does.</summary>
    public static JsonObject Files(params JsonObject[] files) =>
        new() { ["files"] = new JsonArray([.. files.Select(f => f.DeepClone())]) };

    /// <summary>Deterministic 64-hex-character checksum, so a re-declaration can repeat it exactly.</summary>
    public static string Sha256Of(string seed) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(seed)));

    // ------------------------------------------------------------------ HTTP

    // Named Get/Post rather than GetAsync/PostAsync because these thread the test's cancellation
    // token, and an extension method cannot shadow the instance method of the same name.

    public static Task<HttpResponseMessage> Get(this HttpClient client, string url) =>
        client.GetAsync(url, Ct);

    public static Task<HttpResponseMessage> PostJson(
        this HttpClient client, string url, JsonNode body) =>
        client.PostAsync(url, JsonContent(body.ToJsonString()), Ct);

    public static Task<HttpResponseMessage> PostRaw(
        this HttpClient client, string url, string rawBody) =>
        client.PostAsync(url, JsonContent(rawBody), Ct);

    public static Task<HttpResponseMessage> PostNothing(this HttpClient client, string url) =>
        client.PostAsync(url, new StringContent(string.Empty), Ct);

    private static StringContent JsonContent(string json)
    {
        var content = new StringContent(json, Encoding.UTF8);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        return content;
    }

    /// <summary>The response body as JSON. Fails the test with the body text if it is not JSON.</summary>
    public static async Task<JsonElement> JsonAsync(this HttpResponseMessage response)
    {
        var text = await response.Content.ReadAsStringAsync(Ct);
        try
        {
            using var document = JsonDocument.Parse(text);
            return document.RootElement.Clone();
        }
        catch (JsonException ex)
        {
            throw new ShouldAssertException(
                $"Response body was not JSON ({(int)response.StatusCode}): {text}", ex);
        }
    }

    public static Task<string> TextAsync(this HttpResponseMessage response) =>
        response.Content.ReadAsStringAsync(Ct);

    /// <summary>The problem-details <c>detail</c> string, or the whole body if there is none.</summary>
    public static async Task<string> ProblemDetailAsync(this HttpResponseMessage response)
    {
        var body = await response.JsonAsync();
        return body.TryGetProperty("detail", out var detail) && detail.ValueKind == JsonValueKind.String
            ? detail.GetString()!
            : body.ToString();
    }

    public static Guid GetGuid(this JsonElement element, string property) =>
        Guid.Parse(element.GetProperty(property).GetString()!);

    public static string GetText(this JsonElement element, string property) =>
        element.GetProperty(property).GetString()!;

    public static bool Has(this JsonElement element, string property) =>
        element.TryGetProperty(property, out _);

    public static bool IsNull(this JsonElement element, string property) =>
        element.GetProperty(property).ValueKind == JsonValueKind.Null;

    public static IReadOnlyList<Guid> GetGuids(this JsonElement element, string property) =>
        [.. element.GetProperty(property).EnumerateArray().Select(e => Guid.Parse(e.GetString()!))];

    /// <summary>The media array of an entry response, keyed by media id.</summary>
    public static Dictionary<Guid, JsonElement> MediaById(this JsonElement entry) =>
        entry.GetProperty("media").EnumerateArray().ToDictionary(m => m.GetGuid("id"));

    /// <summary>The upload targets of a declare response, keyed by media id.</summary>
    public static Dictionary<Guid, JsonElement> UploadsById(this JsonElement declare) =>
        declare.GetProperty("uploads").EnumerateArray().ToDictionary(u => u.GetGuid("media_id"));

    /// <summary>
    /// Deterministic pseudo-audio: the same seed always yields the same bytes, so a test can
    /// declare their real SHA-256 and the pipeline's verification is exercised against a
    /// checksum that actually describes the file rather than a placeholder.
    /// </summary>
    public static byte[] AudioBytes(string seed = "voice-note", int length = 4096)
    {
        var bytes = new byte[length];
        var block = SHA256.HashData(Encoding.UTF8.GetBytes(seed));
        for (var i = 0; i < length; i++)
        {
            bytes[i] = block[i % block.Length];
        }

        return bytes;
    }

    public static string Sha256OfBytes(byte[] bytes) =>
        Convert.ToHexStringLower(SHA256.HashData(bytes));
}
