using System.Text.Json;
using Teren.Core.Ai;

namespace Teren.Api.Tests;

/// <summary>
/// The v1 structured-output contract (ARCHITECTURE §6). These are cheap tests guarding an
/// expensive mistake: the schema is what the model is held to, and a malformed one degrades
/// structured outputs into prompt-and-pray without failing anything visibly.
/// </summary>
public sealed class EntryStructureSchemaTests
{
    [Fact]
    public void The_schema_is_valid_json_and_describes_an_object()
    {
        using var document = JsonDocument.Parse(EntryStructureSchema.Json);

        document.RootElement.GetProperty("type").GetString().ShouldBe("object");
        document.RootElement.GetProperty("additionalProperties").GetBoolean().ShouldBeFalse();
    }

    [Fact]
    public void Every_field_of_the_documented_shape_is_required()
    {
        // Required-and-nullable, not optional: "always present, may be null" is what structured
        // outputs enforce reliably. An empty day is work_done: [], never a missing key.
        using var document = JsonDocument.Parse(EntryStructureSchema.Json);

        var required = document.RootElement.GetProperty("required")
            .EnumerateArray().Select(e => e.GetString()).ToList();

        required.ShouldBe(
            [
                "schema_version", "work_done", "headcount", "materials", "blockers",
                "hidden_work", "notes",
            ],
            ignoreOrder: true);
    }

    [Fact]
    public void The_schema_pins_version_one()
    {
        using var document = JsonDocument.Parse(EntryStructureSchema.Json);

        document.RootElement
            .GetProperty("properties").GetProperty("schema_version").GetProperty("const")
            .GetInt32().ShouldBe(EntryStructureSchema.Version);
    }

    [Fact]
    public void The_empty_document_satisfies_the_check_constraint_and_the_validator()
    {
        EntryStructureSchema.IsValid(EntryStructureSchema.Empty, out var problem)
            .ShouldBeTrue(problem);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("not json at all")]
    [InlineData("[1,2,3]")]
    [InlineData("\"a string\"")]
    [InlineData("""{"work_done":[]}""")]
    [InlineData("""{"schema_version":"1"}""")]
    public void Anything_that_is_not_a_v1_document_is_rejected(string? json)
    {
        EntryStructureSchema.IsValid(json, out var problem).ShouldBeFalse();
        problem.ShouldNotBeNullOrWhiteSpace();
    }

    [Fact]
    public void A_realistic_answer_passes()
    {
        EntryStructureSchema.IsValid(
            Infrastructure.FakeStructureExtractor.SampleStructure, out var problem)
            .ShouldBeTrue(problem);
    }

    [Fact]
    public void The_prompt_carries_the_site_vocabulary_it_is_supposed_to_map_from()
    {
        // The canonical-name mapping is load-bearing (docs/stt-evaluation.md), so the vocabulary
        // must actually reach the model rather than being a parameter nobody renders.
        var block = ExtractionPrompt.SiteContext(
            "Stambena zgrada Vojvode Stepe 212",
            """{"materials":["PPR cev 25mm"]}""",
            new DateOnly(2026, 8, 29));

        block.ShouldContain("Stambena zgrada Vojvode Stepe 212");
        block.ShouldContain("PPR cev 25mm");
        block.ShouldContain("2026-08-29");
    }

    [Fact]
    public void A_site_with_no_vocabulary_still_produces_a_usable_block()
    {
        var block = ExtractionPrompt.SiteContext("Kuća", vocabularyJson: null, new DateOnly(2026, 1, 2));

        block.ShouldContain("no vocabulary recorded");
    }
}
