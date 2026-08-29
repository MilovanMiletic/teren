namespace SttSpike;

/// <summary>
/// The demo projects' vocabulary, copied verbatim from
/// <c>src/Teren.Infrastructure/Seeding/DemoSeeder.cs</c>.
/// <para>
/// Copied, not referenced, on purpose: roadmap A1 says this harness is throwaway, so nothing in
/// <c>src/</c> may depend on it and it may not depend on <c>src/</c> — otherwise deleting it
/// after A3 becomes a refactor. If DemoSeeder's vocabulary changes and this drifts, nothing in
/// the product breaks; only the phrase-list hints get slightly stale, and the founder can pass
/// <c>--phrases &lt;file&gt;</c> to override them anyway.
/// </para>
/// <para>
/// In production this same list arrives as <c>TranscriptionContext.ProjectVocabulary</c>
/// (ARCHITECTURE §9.1), so what is measured here is what the pipeline will actually send.
/// </para>
/// </summary>
public static class DemoVocabulary
{
    /// <summary>Site 1 — Stambena zgrada Vojvode Stepe 212 (the demo narrative's site).</summary>
    public static readonly IReadOnlyList<string> Project1 =
    [
        // work_items
        "razvod tople i hladne vode", "montaža vodokotlića", "montaža kotla", "štemovanje",
        "tlačna proba", "izolacija cevi",
        // materials
        "PPR cev 25mm", "PPR cev 32mm", "PPR fiting", "ugradni vodokotlić Geberit Duofix",
        "kotao Bosch Condens 4300i", "kuglasti ventil 1 col",
        // workers
        "Nenad", "Zoran", "Miloš", "Ivan",
    ];

    /// <summary>Site 2 — Poslovni prostor Bulevar oslobođenja 84.</summary>
    public static readonly IReadOnlyList<string> Project2 =
    [
        "razvod sanitarne vode", "kanalizacioni razvod", "montaža sanitarije",
        "montaža fan-coil jedinica", "hidrantska mreža", "probijanje prodora", "tlačna proba",
        "PPR cev 40mm", "kanalizaciona cev PVC 110mm", "bakarna cev 18mm",
        "fan-coil jedinica Daikin FWM", "hidrantski ormarić sa crevom 15m",
        "izolacija Armaflex 13mm", "kuglasti ventil tri četvrtine",
        "Nenad", "Ivan", "Saša",
    ];

    /// <summary>Site 3 — Kuća Miloša Obrenovića 17.</summary>
    public static readonly IReadOnlyList<string> Project3 =
    [
        "podno grejanje", "razvod vode u kupatilima", "montaža toplotne pumpe",
        "montaža sanitarije", "izolacija cevi", "tlačna proba",
        "Pex-Al-Pex cev 16mm", "razdelnik podnog grejanja 6 krugova",
        "toplotna pumpa Vaillant aroTHERM plus", "PPR cev 20mm", "sifon za tuš kadu",
        "termostatska glava",
        "Zoran", "Miloš",
    ];

    /// <summary>
    /// Every demo site's vocabulary, de-duplicated. The default for a run, because the founder's
    /// A2 recordings are from one plumbing site and we do not know which of these three it most
    /// resembles — Azure's phrase list comfortably takes all of them (limit is 1024 phrases).
    /// </summary>
    public static IReadOnlyList<string> All { get; } =
        Project1.Concat(Project2).Concat(Project3)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

    public static IReadOnlyList<string> ForProject(int project) => project switch
    {
        1 => Project1,
        2 => Project2,
        3 => Project3,
        _ => All,
    };
}
