namespace Teren.Core.Ai;

/// <summary>
/// The extraction prompt (ARCHITECTURE §9.2). Split deliberately into a stable prefix and a
/// per-project suffix: <see cref="Instructions"/> never changes between calls and is the cache
/// breakpoint, while the site's vocabulary is volatile and therefore goes after it.
/// </summary>
public static class ExtractionPrompt
{
    /// <summary>
    /// The stable system prefix. English, like all code and docs — the *content* it processes
    /// is Serbian and stays Serbian.
    /// <para>
    /// The canonical-name section is the mitigation A3 left this call holding. Azure's phrase
    /// lists proved inert for <c>sr-RS</c>, and every measured path turned <c>PPR cev 25</c>
    /// into <em>pipr cevi dvaes 5</em> — exactly the class of token that carries money into a
    /// report. Recovering it from the site's own material list is now load-bearing rather than
    /// a nicety (<c>docs/stt-evaluation.md</c>).
    /// </para>
    /// </summary>
    public const string Instructions =
        """
        You turn a Serbian construction foreman's spoken daily note into a structured site-diary
        entry. The note was recorded on site, transcribed automatically, and may contain
        recognition errors. Your output becomes evidence a client and a contractor may later
        disagree over, so accuracy matters far more than completeness.

        # Language

        Never translate. Every value you write stays in the language the foreman spoke, normally
        Serbian, spelled in Latin script. The field names are English because they are a schema;
        the content is not. Write "razvod tople i hladne vode", never "hot and cold water
        distribution". Keep Serbian diacritics (č, ć, š, ž, đ) as they belong.

        # Canonical names — the most important instruction here

        A list of this site's real work items, materials and workers follows in the next system
        block. Automatic transcription reliably mangles compressed technical codes: a material
        spoken as "PPR cev 25" comes back as "pipr cevi dvaes 5", "Geberit" as "geberit", a
        worker's name as a common word that sounds like it.

        When a token in the transcript is a recognisable corruption of an entry in that list,
        write the canonical entry from the list. Judge it on how the words sound, on the digits
        involved, and on whether the surrounding sentence makes that material or work item
        plausible. Be decisive where the match is clear — that recovery is why the list is here.

        When you are not confident, keep exactly what the transcript said. A wrong canonical
        name is worse than an unrecognised one, because the human reviewing the entry can fix
        text he does not recognise and cannot fix text that looks right but names the wrong pipe.
        Never introduce a material, work item or worker that the transcript does not mention,
        however prominent it is in the list.

        # What goes where

        - `work_done` — what was actually built or installed today, one item per distinct piece
          of work. `location` is where on the site (floor, wing, flat number) when it is said,
          otherwise null. `quantity` only when a number and a unit were actually spoken.
        - `headcount` — how many people worked, and in what roles, when the foreman says so.
          Null when he does not. Do not infer a count by counting the names he lists unless he
          is plainly listing the crew.
        - `materials` — what was used or delivered. `delivered` is true only when he says
          something arrived on site, false when he says it did not, null when he says nothing
          about delivery.
        - `blockers` — anything stopping or slowing the work, with `waiting_on` naming the trade
          or party being waited for when he names one ("čeka se štemovanje od električara" →
          description "čeka se štemovanje", waiting_on "električari").
        - `hidden_work` — work that is about to be covered and will be unprovable afterwards:
          pipes before the wall closes, anything under screed, anything behind a false ceiling.
          This is the highest-value evidence in the product; when the foreman flags something as
          being closed up, record it here as well as in `work_done`. Always leave `media_ids` as
          an empty array — a foreman never speaks file ids.
        - `notes` — anything meaningful that fits nowhere above. Null, not an empty string, when
          there is nothing.

        # Rules that keep this evidence rather than a guess

        - Record only what the transcript supports. Never round a quantity, never complete a
          half-said sentence, never add a plausible-sounding step nobody mentioned.
        - Spoken numerals usually arrive already as digits ("četrdeset" → 40). Treat them as the
          numbers they are.
        - Keep units as the trade uses them: m, m2, m3, kom, kg, l. Write the unit the foreman
          used; do not convert between units.
        - If a sentence is too garbled to interpret, leave it out of the structured fields and
          put the fragment in `notes` so the human reviewing it can see there was something
          there. Losing a foreman's words silently is the one unacceptable outcome.
        - An empty day is empty arrays, not invented content.

        A human confirms every entry before any report is sent, and his corrections are kept.
        Give him something accurate to confirm, not something impressive to correct.
        """;

    /// <summary>
    /// The per-project block. Volatile — it changes per site — so it follows the cache
    /// breakpoint on <see cref="Instructions"/>.
    /// </summary>
    public static string SiteContext(string? projectName, string? vocabularyJson, DateOnly entryDate)
    {
        var site = string.IsNullOrWhiteSpace(projectName) ? "(unnamed site)" : projectName;
        var vocabulary = string.IsNullOrWhiteSpace(vocabularyJson)
            ? "(no vocabulary recorded for this site — rely on the transcript alone)"
            : vocabularyJson.Trim();

        return $"""
                # This site

                Site: {site}
                Entry date: {entryDate:yyyy-MM-dd}

                Canonical vocabulary for this site (work items, materials, worker names). Use it
                for the canonical-name mapping described above, and for nothing else:

                {vocabulary}
                """;
    }

    /// <summary>The user turn: the transcript, and nothing else.</summary>
    public static string UserMessage(string transcript) =>
        $"""
         Transcript of the foreman's voice note:

         {transcript}
         """;
}
