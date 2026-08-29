using System.Text.Json;

namespace Teren.Core.Reporting;

/// <summary>
/// Turns an entry's structure JSONB (schema v1, ARCHITECTURE §6) into what the report puts on
/// paper.
/// <para>
/// **Tolerant by construction, and that is a product decision rather than laziness.** The JSON
/// on the way in was written by a language model and then edited by a foreman on a phone; the
/// column is JSONB precisely so the shape can differ per trade. A reader that threw on an
/// unexpected type would turn "the model put the quantity in as a string" into "the client gets
/// no report at all". So every field is read defensively: what parses is used, what does not is
/// dropped, and the entry still reaches the inbox. The one thing the pass refuses to do is send
/// an <em>empty</em> report — see <see cref="ReportContent.IsEmpty"/>.
/// </para>
/// <para>
/// Nothing here translates anything. Descriptions, material names, units and roles go onto the
/// page in the language they were spoken (CLAUDE.md: only UI chrome is localised).
/// </para>
/// </summary>
public static class ReportContentReader
{
    public static ReportContent Read(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return ReportContent.Empty;
        }

        JsonElement root;
        try
        {
            using var document = JsonDocument.Parse(json);
            root = document.RootElement.Clone();
        }
        catch (JsonException)
        {
            // Postgres validated it as JSONB on the way in, so this is close to unreachable —
            // but "close to" is not a reason to throw inside the money path.
            return ReportContent.Empty;
        }

        if (root.ValueKind != JsonValueKind.Object)
        {
            return ReportContent.Empty;
        }

        return new ReportContent(
            ReadArray(root, "work_done", ReadWorkDone),
            ReadHeadcount(root),
            ReadArray(root, "materials", ReadMaterial),
            ReadArray(root, "blockers", ReadBlocker),
            ReadArray(root, "hidden_work", ReadHiddenWork),
            Text(root, "notes"))
        {
            // The one key outside schema v1's own shape, and it is deliberate (founder,
            // 2026-08-29, PROJECT.md §11): the confirmation screen sets it when a foreman
            // approves his own transcript as the day's record, with `notes` holding that
            // transcript verbatim and the structured sections empty.
            //
            // Read strictly — only a JSON `true` counts. Everything else on this page is read
            // forgivingly because a language model wrote it, but nothing writes this key except
            // the confirmation screen, and the flag changes what the document *claims about its
            // own provenance*. "true" as a string, or 1, is a client that does not know the
            // contract, and guessing its intent would put a claim on a client's document that
            // nobody made.
            DescribedVerbatim = root.TryGetProperty(DescribedVerbatimKey, out var verbatim)
                                && verbatim.ValueKind == JsonValueKind.True,
        };
    }

    /// <summary>
    /// The top-level flag the confirmation screen sends inside <c>corrected</c>. It lives here
    /// rather than in <c>EntryStructureSchema</c> because it is never something the model
    /// produces: the extraction schema stays exactly the shape the model must answer in, and this
    /// is a human's statement about that answer being absent.
    /// </summary>
    public const string DescribedVerbatimKey = "described_verbatim";

    // ------------------------------------------------------------------ sections

    private static WorkDoneItem? ReadWorkDone(JsonElement item)
    {
        var description = Text(item, "description");
        return description is null
            ? null
            : new WorkDoneItem(description, Text(item, "location"), ReadQuantity(item, "quantity"));
    }

    private static MaterialItem? ReadMaterial(JsonElement item)
    {
        var name = Text(item, "name");
        return name is null
            ? null
            : new MaterialItem(name, ReadQuantity(item, "quantity"), Bool(item, "delivered"));
    }

    private static BlockerItem? ReadBlocker(JsonElement item)
    {
        var description = Text(item, "description");
        return description is null
            ? null
            : new BlockerItem(description, Text(item, "waiting_on"));
    }

    private static HiddenWorkItem? ReadHiddenWork(JsonElement item)
    {
        var description = Text(item, "description");
        if (description is null)
        {
            return null;
        }

        var mediaIds = new List<Guid>();
        if (item.TryGetProperty("media_ids", out var ids) && ids.ValueKind == JsonValueKind.Array)
        {
            foreach (var id in ids.EnumerateArray())
            {
                if (id.ValueKind == JsonValueKind.String && Guid.TryParse(id.GetString(), out var parsed))
                {
                    mediaIds.Add(parsed);
                }
            }
        }

        return new HiddenWorkItem(description, mediaIds);
    }

    private static ReportHeadcount? ReadHeadcount(JsonElement root)
    {
        if (!root.TryGetProperty("headcount", out var headcount)
            || headcount.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var total = Int(headcount, "total");

        var roles = new List<ReportRole>();
        if (headcount.TryGetProperty("roles", out var roleArray)
            && roleArray.ValueKind == JsonValueKind.Array)
        {
            foreach (var role in roleArray.EnumerateArray())
            {
                if (role.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                var name = Text(role, "role");
                if (name is not null)
                {
                    roles.Add(new ReportRole(name, Int(role, "count")));
                }
            }
        }

        // "headcount": {} carries nothing worth a line on the page.
        return total is null && roles.Count == 0 ? null : new ReportHeadcount(total, roles);
    }

    private static ReportQuantity? ReadQuantity(JsonElement parent, string property)
    {
        if (!parent.TryGetProperty(property, out var quantity))
        {
            return null;
        }

        // The model sometimes answers with a bare number or "40 m" instead of the object the
        // schema asks for. Both are readable; neither is worth losing a line over.
        switch (quantity.ValueKind)
        {
            case JsonValueKind.Number:
                return new ReportQuantity(quantity.GetDouble(), null);

            case JsonValueKind.String:
                var raw = quantity.GetString();
                return string.IsNullOrWhiteSpace(raw) ? null : new ReportQuantity(null, raw.Trim());

            case JsonValueKind.Object:
                var value = Double(quantity, "value");
                var unit = Text(quantity, "unit");
                return value is null && unit is null ? null : new ReportQuantity(value, unit);

            default:
                return null;
        }
    }

    // ------------------------------------------------------------------ primitives

    private static IReadOnlyList<T> ReadArray<T>(
        JsonElement root, string property, Func<JsonElement, T?> read)
        where T : class
    {
        if (!root.TryGetProperty(property, out var array) || array.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var items = new List<T>();
        foreach (var element in array.EnumerateArray())
        {
            if (element.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            var item = read(element);
            if (item is not null)
            {
                items.Add(item);
            }
        }

        return items;
    }

    /// <summary>A non-blank string, or null. Blank is the same as absent on a printed page.</summary>
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

    private static double? Double(JsonElement parent, string property) =>
        parent.TryGetProperty(property, out var value)
        && value.ValueKind == JsonValueKind.Number
        && value.TryGetDouble(out var number)
            ? number
            : null;

    private static int? Int(JsonElement parent, string property) =>
        parent.TryGetProperty(property, out var value)
        && value.ValueKind == JsonValueKind.Number
        && value.TryGetInt32(out var number)
            ? number
            : null;

    private static bool? Bool(JsonElement parent, string property) =>
        parent.TryGetProperty(property, out var value)
            ? value.ValueKind switch
            {
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                _ => null,
            }
            : null;
}
