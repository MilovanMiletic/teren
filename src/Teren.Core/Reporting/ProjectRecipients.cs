using System.Text.Json;

namespace Teren.Core.Reporting;

/// <summary>
/// Reads <c>project.recipients</c> — <c>[{name, email, role}]</c> (ARCHITECTURE §6).
/// <para>
/// Multi-recipient is the ordinary commercial case in Serbia, not an edge one: a job carries the
/// investor and the <em>nadzorni organ</em> on the same distribution list, which is why the demo
/// seed's second site has two.
/// </para>
/// </summary>
public static class ProjectRecipients
{
    public static IReadOnlyList<ReportRecipient> Read(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return [];
        }

        JsonElement root;
        try
        {
            using var document = JsonDocument.Parse(json);
            root = document.RootElement.Clone();
        }
        catch (JsonException)
        {
            return [];
        }

        if (root.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var recipients = new List<ReportRecipient>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var element in root.EnumerateArray())
        {
            if (element.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            var email = Text(element, "email");
            if (email is null)
            {
                continue;
            }

            // The same address twice on one list would put two identical reports in one inbox.
            if (!seen.Add(email))
            {
                continue;
            }

            recipients.Add(new ReportRecipient(Text(element, "name"), email, Text(element, "role")));
        }

        return recipients;
    }

    private static string? Text(JsonElement parent, string property)
    {
        if (!parent.TryGetProperty(property, out var value)
            || value.ValueKind != JsonValueKind.String)
        {
            return null;
        }

        var text = value.GetString();
        return string.IsNullOrWhiteSpace(text) ? null : text.Trim();
    }
}
