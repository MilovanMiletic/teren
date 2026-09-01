using System.Collections;
using System.Net;
using System.Reflection;
using Teren.Api.Platform;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;

namespace Teren.Api.Tests;

/// <summary>
/// The guard that catches slow rot rather than a sharp break (plan §12).
///
/// <para>
/// Four mutations already have tests, and none of them is here, because D4 did not weaken any of
/// them: adding <c>SuperAdmin</c> to <c>RoleGates.Evidence</c> is caught by
/// <c>RoleGateTests.A_super_admin_is_refused_by_every_evidence_route</c> and
/// <c>MediaDownloadTests.A_super_admin_cannot_read_a_photograph</c>; setting the tenant from a
/// route value instead of null is caught by
/// <c>RoleGateTests.Super_admin_reads_no_evidence_even_with_the_route_gate_removed</c>; adding
/// <c>DbSet&lt;Entry&gt;</c> to the identity context and reaching for
/// <c>IgnoreQueryFilters()</c> are both caught by <c>IdentityModelTests</c>.
/// </para>
///
/// <para>
/// <b>What was missing is the one that fails quietly.</b> Every layer above stops a super admin
/// <em>reaching</em> evidence. None of them stops evidence being <em>carried to him</em> on a DTO
/// he is entitled to read — and that is the realistic way this boundary is lost. Nobody will
/// remove the role gate. Somebody will add <c>entry_count</c> to a company row because a health
/// page would look better with it, and every existing test will stay green.
/// </para>
/// </summary>
public sealed class PlatformPrivacyTests(TerenTestApp app) : ApiTestBase(app)
{
    /// <summary>
    /// The types no platform DTO may transitively mention.
    /// <para>
    /// <b><see cref="Project"/> is deliberately absent from this list</b>, and that is a founder
    /// decision dated 2026-08-30, not an oversight. The privacy claim narrowed when the health page
    /// and the log viewer were accepted: Teren staff can see <em>which companies and sites exist
    /// and what is failing</em>, so a project's <em>name</em> is admitted while its address,
    /// coordinates, recipients and vocabulary are not. It is written down here because the next
    /// person to widen this list will otherwise assume the previous widening was casual too.
    /// </para>
    /// </summary>
    private static readonly Type[] Forbidden = [typeof(Entry), typeof(Media), typeof(Report)];

    [Fact]
    public void No_platform_signature_can_carry_evidence()
    {
        var offenders = new List<string>();

        foreach (var member in typeof(PlatformDirectory)
                     .GetMembers(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static
                                 | BindingFlags.DeclaredOnly))
        {
            foreach (var (type, where) in SignatureTypes(member))
            {
                var leak = FirstForbidden(type, []);
                if (leak is not null)
                {
                    offenders.Add($"{member.Name} ({where}) reaches {leak.Name} via {type.Name}");
                }
            }
        }

        offenders.ShouldBeEmpty(
            "A platform signature reaches evidence. Teren staff can see which companies and sites "
            + "exist and what is failing; they cannot read a transcript, view a photo, or open a "
            + "report. If this is a deliberate narrowing of that claim it is a founder decision, "
            + "and it belongs in plans/profile-and-identity.md before it belongs here.\n"
            + string.Join("\n", offenders));
    }

    /// <summary>
    /// Words no platform DTO may name, whatever their type.
    /// <para>
    /// <b>This is the half a type-walk cannot do, and the plan's own example is why it is needed.</b>
    /// §12 says the guard should go red "the day someone adds <c>entry_count</c> to a company
    /// DTO" — but <c>entry_count</c> is an <c>int</c>, and no amount of walking the type graph
    /// will find <c>Entry</c> in an integer. A count of a customer's diary entries is a fact about
    /// his work rather than about his account, and it is exactly the useful-looking field that
    /// erodes this boundary one dashboard at a time. So the names are checked too.
    /// </para>
    /// <para>
    /// <b>Known incomplete, and the limit is worth stating rather than discovering.</b> A denylist
    /// of words cannot be finished — a synonym always exists — and neither guard can see inside a
    /// <c>string</c>. Adding <c>string? Summary</c> to a company DTO and filling it with a verbatim
    /// transcript would pass both. What the pair buys is that the *obvious* mistakes fail loudly
    /// and the deliberate one has to be deliberate; it is a tripwire, not a wall. The wall is the
    /// closed identity model, which has no <c>Entry</c> to read in the first place.
    /// </para>
    /// <para>
    /// The list is aligned with §12's log-redaction vocabulary on purpose. <c>notes</c> is on it
    /// because <c>notes</c> is the field the verbatim flow puts a foreman's own words in — the two
    /// guards enforcing the same boundary must not disagree about what counts as evidence.
    /// </para>
    /// </summary>
    private static readonly string[] EvidenceWords =
    [
        "entry", "entries", "media", "report", "transcript", "photo", "structure", "corrected",
        "recipient", "latitude", "longitude", "coordinate", "address", "vocabulary",
        // Added after the D4 review: all of these can carry a customer's work in a plain string.
        "notes", "summary", "highlight", "description", "activity", "workdone", "blocker",
    ];

    [Fact]
    public void No_platform_dto_names_a_fact_about_the_work()
    {
        var dtos = typeof(Teren.Api.Contracts.PlatformCompanyResponse).Assembly
            .GetTypes()
            .Where(t => t.IsPublic
                && t.Namespace == "Teren.Api.Contracts"
                && t.Name.StartsWith("Platform", StringComparison.Ordinal))
            .ToList();

        dtos.Count.ShouldBeGreaterThan(3, "the scan found no platform DTOs to check");

        var offenders = (
            from dto in dtos
            from property in dto.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            let word = EvidenceWords.FirstOrDefault(w =>
                property.Name.Contains(w, StringComparison.OrdinalIgnoreCase))
            where word is not null
            select $"{dto.Name}.{property.Name} (matched '{word}')").ToList();

        offenders.ShouldBeEmpty(
            "A platform DTO names something about a customer's work rather than about his account. "
            + "Teren staff can see which companies and sites exist and what is failing; they "
            + "cannot see what was done on site. Narrowing that claim is a founder decision.\n"
            + string.Join("\n", offenders));
    }

    /// <summary>
    /// A guard on the guard: if the walk below ever stopped visiting anything, the assertion above
    /// would pass for the wrong reason and go on passing forever.
    /// </summary>
    [Fact]
    public void The_privacy_walk_actually_inspects_the_platform_surface()
    {
        var inspected = typeof(PlatformDirectory)
            .GetMembers(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)
            .SelectMany(SignatureTypes)
            .Count();

        // Companies, users, invite and audit, each with parameters and a return type. A floor, not
        // an exact count: the point is that this file is looking at a surface rather than at
        // nothing, and pinning the exact number would make every new route a two-file change.
        inspected.ShouldBeGreaterThan(20);
    }

    /// <summary>And it must be capable of failing — proven against a type that really does reach
    /// evidence, so "no offenders" means the walk looked and found none.</summary>
    [Fact]
    public void The_privacy_walk_detects_a_type_that_does_reach_evidence()
    {
        FirstForbidden(typeof(Entry), []).ShouldBe(typeof(Entry));
        FirstForbidden(typeof(List<Media>), []).ShouldBe(typeof(Media));
        FirstForbidden(typeof(Bait), []).ShouldBe(typeof(Report));

        // And a type that does not, so the walk is not simply answering "yes" to everything.
        FirstForbidden(typeof(Teren.Api.Contracts.PlatformCompanyResponse), []).ShouldBeNull();
    }

    /// <summary>A DTO shaped exactly like the mistake this file exists to catch.</summary>
    private sealed record Bait(Guid Id, IReadOnlyList<Report> Reports);

    private static IEnumerable<(Type Type, string Where)> SignatureTypes(MemberInfo member)
    {
        switch (member)
        {
            case MethodInfo method when !method.IsSpecialName:
                foreach (var parameter in method.GetParameters())
                {
                    yield return (parameter.ParameterType, $"parameter {parameter.Name}");
                }
                yield return (Unwrap(method.ReturnType), "return type");
                break;

            case PropertyInfo property:
                yield return (property.PropertyType, "property");
                break;

            case FieldInfo field:
                yield return (field.FieldType, "field");
                break;
        }
    }

    /// <summary>`Task&lt;T&gt;` is not the interesting type; `T` is.</summary>
    private static Type Unwrap(Type type) =>
        type.IsGenericType && type.GetGenericTypeDefinition() == typeof(Task<>)
            ? type.GetGenericArguments()[0]
            : type;

    /// <summary>
    /// Walk a type's shape looking for evidence, following generics, arrays and the public
    /// properties and constructor parameters of anything declared in our own assemblies.
    /// <para>
    /// Framework types are not descended into — walking <c>string</c> or <c>DateTimeOffset</c>
    /// finds nothing and costs a stack. The cycle set is what keeps a record that references its
    /// own kind from spinning.
    /// </para>
    /// </summary>
    private static Type? FirstForbidden(Type type, HashSet<Type> seen)
    {
        type = Nullable.GetUnderlyingType(type) ?? type;

        if (!seen.Add(type))
        {
            return null;
        }

        if (Array.IndexOf(Forbidden, type) >= 0)
        {
            return type;
        }

        if (type.IsArray)
        {
            return FirstForbidden(type.GetElementType()!, seen);
        }

        if (type.IsGenericType)
        {
            foreach (var argument in type.GetGenericArguments())
            {
                var leak = FirstForbidden(argument, seen);
                if (leak is not null)
                {
                    return leak;
                }
            }
        }

        if (!IsOurs(type) || type.IsEnum || type.IsPrimitive)
        {
            return null;
        }

        foreach (var property in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            var leak = FirstForbidden(property.PropertyType, seen);
            if (leak is not null)
            {
                return leak;
            }
        }

        foreach (var constructor in type.GetConstructors())
        {
            foreach (var parameter in constructor.GetParameters())
            {
                var leak = FirstForbidden(parameter.ParameterType, seen);
                if (leak is not null)
                {
                    return leak;
                }
            }
        }

        return null;
    }

    private static bool IsOurs(Type type) =>
        type.Assembly.GetName().Name?.StartsWith("Teren", StringComparison.Ordinal) == true
        && !typeof(IEnumerable).IsAssignableFrom(type);

    // -------------------------------------------------------------- the gate, from both sides

    [Theory]
    [InlineData("/api/platform/companies")]
    [InlineData("/api/platform/users")]
    [InlineData("/api/platform/audit")]
    public async Task A_company_admin_is_refused_by_every_platform_route(string route)
    {
        // The mirror of RoleGateTests: the customer cannot see the platform, exactly as the
        // platform cannot see his diaries. Refused by RoleFilter before a row is read, so the 403
        // says nothing about what exists behind it.
        using var customer = await GivenCompanyAdminClientAsync();

        (await customer.Get(route)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task A_foreman_is_refused_too_and_learns_nothing_from_the_refusal()
    {
        var real = await Client.Get("/api/platform/users");
        var nonsense = await Client.Get("/api/platform/users?company_id=" + Guid.NewGuid());

        real.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await RejectionFingerprint.OfAsync(nonsense))
            .ShouldBe(await RejectionFingerprint.OfAsync(real));
    }
}
