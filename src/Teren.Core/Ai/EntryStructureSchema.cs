using System.Text.Json;

namespace Teren.Core.Ai;

/// <summary>
/// The v1 entry-structure JSON schema (ARCHITECTURE §6), used as the model's structured-output
/// contract so the pipeline never parses hopeful JSON.
/// <para>
/// Every property is listed in <c>required</c> and made explicitly nullable instead of being
/// optional, and every object sets <c>additionalProperties: false</c>. That is what structured
/// outputs enforce reliably: "this key is always present, and may be null" is checkable, while
/// "this key may be absent" degrades to the model's judgement. An empty day is
/// <c>work_done: []</c>, not a missing field.
/// </para>
/// </summary>
public static class EntryStructureSchema
{
    public const int Version = 1;

    /// <summary>The key ARCHITECTURE §6 requires in both JSONB shapes; Postgres CHECKs it too.</summary>
    public const string VersionKey = "schema_version";

    /// <summary>
    /// The schema as JSON text. Kept as text so <c>Teren.Core</c> stays free of any vendor SDK;
    /// the adapter in <c>Teren.Infrastructure</c> parses it into whatever shape the SDK wants.
    /// </summary>
    public const string Json =
        """
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["schema_version", "work_done", "headcount", "materials", "blockers", "hidden_work", "notes"],
          "properties": {
            "schema_version": { "type": "integer", "const": 1 },
            "work_done": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["description", "location", "quantity"],
                "properties": {
                  "description": { "type": "string" },
                  "location": { "type": ["string", "null"] },
                  "quantity": {
                    "type": ["object", "null"],
                    "additionalProperties": false,
                    "required": ["value", "unit"],
                    "properties": {
                      "value": { "type": "number" },
                      "unit": { "type": "string" }
                    }
                  }
                }
              }
            },
            "headcount": {
              "type": ["object", "null"],
              "additionalProperties": false,
              "required": ["total", "roles"],
              "properties": {
                "total": { "type": "integer" },
                "roles": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["role", "count"],
                    "properties": {
                      "role": { "type": "string" },
                      "count": { "type": "integer" }
                    }
                  }
                }
              }
            },
            "materials": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["name", "quantity", "delivered"],
                "properties": {
                  "name": { "type": "string" },
                  "quantity": {
                    "type": ["object", "null"],
                    "additionalProperties": false,
                    "required": ["value", "unit"],
                    "properties": {
                      "value": { "type": "number" },
                      "unit": { "type": "string" }
                    }
                  },
                  "delivered": { "type": ["boolean", "null"] }
                }
              }
            },
            "blockers": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["description", "waiting_on"],
                "properties": {
                  "description": { "type": "string" },
                  "waiting_on": { "type": ["string", "null"] }
                }
              }
            },
            "hidden_work": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["description", "media_ids"],
                "properties": {
                  "description": { "type": "string" },
                  "media_ids": { "type": "array", "items": { "type": "string" } }
                }
              }
            },
            "notes": { "type": ["string", "null"] }
          }
        }
        """;

    /// <summary>
    /// The shape stored when there is nothing to extract but the entry must still carry a valid
    /// v1 document — never used to fake a successful extraction, only where an explicitly empty
    /// structure is the truth.
    /// </summary>
    public const string Empty =
        """
        {"schema_version":1,"work_done":[],"headcount":null,"materials":[],"blockers":[],"hidden_work":[],"notes":null}
        """;

    /// <summary>
    /// Last line of defence before a model's answer becomes a database row: it must be a JSON
    /// object carrying <c>schema_version</c>. Postgres CHECKs the same thing, but a clear
    /// exception here beats a constraint violation three frames down.
    /// </summary>
    public static bool IsValid(string? json, out string problem)
    {
        problem = string.Empty;

        if (string.IsNullOrWhiteSpace(json))
        {
            problem = "the extracted structure was empty";
            return false;
        }

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(json);
        }
        catch (JsonException ex)
        {
            problem = "the extracted structure was not valid JSON: " + ex.Message;
            return false;
        }

        using (document)
        {
            if (document.RootElement.ValueKind != JsonValueKind.Object)
            {
                problem = "the extracted structure was not a JSON object";
                return false;
            }

            if (!document.RootElement.TryGetProperty(VersionKey, out var version)
                || version.ValueKind != JsonValueKind.Number)
            {
                problem = $"the extracted structure has no numeric {VersionKey}";
                return false;
            }
        }

        return true;
    }
}
