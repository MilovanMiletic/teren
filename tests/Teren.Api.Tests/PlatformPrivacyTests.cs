using System.Collections;
using System.Net;
using System.Reflection;
using Teren.Api.Platform;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Core.Platform;

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
    /// <b>What the founder admitted on 2026-08-30 was a <em>projection</em>, not
    /// <see cref="Project"/>.</b> The privacy claim narrowed when the health page and the log
    /// viewer were accepted: Teren staff can see <em>which companies and sites exist and what is
    /// failing</em>, so a site's <em>name</em> is admitted while its address, coordinates,
    /// recipients and vocabulary are not. That admission is carried by
    /// <see cref="Contracts.PlatformSiteHealthResponse"/>, which is
    /// <c>{id, company_id, name}</c> and cannot be anything else. The <em>entity</em> is a
    /// different shape and was never admitted — it is on this list since 2026-09-04, because it
    /// was absent for a day and the absence read as a decision.
    /// </para>
    /// <para>
    /// <b>The failure it prevents is not a leak; it is a lie.</b> A member here returning
    /// <see cref="Project"/> rows read through <c>TerenIdentityDbContext</c> serialises
    /// <c>address: null</c>, <c>recipients: null</c> and <c>latitude: null</c> for every customer,
    /// because <c>PlatformProjectConfiguration</c> <c>Ignore()</c>s them — <b>"absent" is
    /// indistinguishable from "not loaded"</b>, which is precisely the F10 defect, and the next
    /// person to "fix the nulls" does it by removing an <c>Ignore()</c>. Nothing went red at any
    /// step of that, in eleven privacy tests and <c>IdentityModelTests</c>, until this line.
    /// </para>
    /// </summary>
    private static readonly Type[] Forbidden =
    [
        typeof(Entry), typeof(Media), typeof(Report),
        // Added 2026-09-03 with the health page, and this is the hole the model widening opened in
        // the guard that exists for exactly this. EntryHealthRow and ReportHealthRow are the
        // four-column read-throughs of `entry` and `report` that TerenIdentityDbContext now maps,
        // and one of those four columns is `failure_reason` — the FULL "{code}: {detail}" string,
        // whose detail folds in an external provider's own words. PlatformDirectory.HealthAsync
        // reduces them to codes and counts before anything is serialised; a future public member
        // that simply RETURNED them would carry the raw text past both structural walks, and
        // before this line all eleven of these tests stayed green when one did.
        typeof(EntryHealthRow), typeof(ReportHealthRow),
        // Added 2026-09-04. Nothing on the surface returns it, which is exactly why it costs
        // nothing to forbid now and would cost an argument later.
        typeof(Project),
    ];

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
            where !IsBareIdentifier(property) && !IsAdmittedCount(property)
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
    /// The one exception to the vocabulary, and it is the plan's own, not a convenience.
    ///
    /// <para>
    /// D5's log viewer filters on <c>entry_id</c>, because "why did this day of work fail" is the
    /// question the stream exists to answer. The plan's <c>app_log</c> block settles it in as many
    /// words — <em>"an ID is not evidence; it is how you find the row"</em> — and it is the same
    /// call the founder made on 2026-08-30 when project <em>names</em> were admitted to this
    /// surface and everything else about a project was not.
    /// </para>
    /// <para>
    /// <b>It is deliberately the narrowest exception that works.</b> The name must be exactly
    /// <c>EntryId</c> and the type must really be a UUID. <c>EntryCount</c> is an <c>int</c> and
    /// still fails — which matters, because that is the example §12 itself gives for how this
    /// boundary gets lost. <c>EntryNotes</c> is a <c>string</c> and still fails. A property called
    /// <c>Entries</c> holding a list still fails. Widen this and you are making a decision, which
    /// is the whole point of writing it down here.
    /// </para>
    /// </summary>
    private static bool IsBareIdentifier(PropertyInfo property) =>
        property.Name == "EntryId"
        && (property.PropertyType == typeof(Guid) || property.PropertyType == typeof(Guid?));

    [Fact]
    public void The_identifier_exception_admits_an_id_and_nothing_that_merely_looks_like_one()
    {
        // Anti-vacuity for the exception above. Without this, loosening `IsBareIdentifier` to
        // `Name.Contains("Entry")` would silently re-open the door the vocabulary closed, and
        // every other assertion in this file would stay green.
        var admitted = typeof(Teren.Api.Contracts.PlatformLogResponse)
            .GetProperty(nameof(Teren.Api.Contracts.PlatformLogResponse.EntryId))!;

        IsBareIdentifier(admitted).ShouldBeTrue();

        foreach (var property in typeof(NotAnIdentifier)
                     .GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            IsBareIdentifier(property).ShouldBeFalse(property.Name);
        }
    }

    /// <summary>The three shapes that must keep failing however loudly they claim to be an id.</summary>
    private sealed record NotAnIdentifier(int EntryCount, string EntryNotes, string EntryId);

    /// <summary>
    /// The second exception, and it is the one the vocabulary was always going to collide with.
    ///
    /// <para>
    /// A health page (<c>GET /api/platform/health</c>, plan §8) is <em>inherently</em> a table of
    /// entry counts by state: <c>entry_count</c>, <c>reported</c>, <c>report_count</c>. Those are
    /// three of the words above, and there was no honest way round it. Naming them something bland
    /// would have been worse than an exemption — this file's own documentation admits that "a
    /// synonym always exists", so a euphemism does not satisfy the boundary, it merely walks past
    /// the tripwire. So the collision is admitted, in writing, and kept as small as it can be.
    /// </para>
    /// <para>
    /// <b>The reasoning, which is the part that has to survive this test being read in a year.</b>
    /// A count is not content. How many days of work sit in <c>needs_review</c> on one site is a
    /// fact about whether Teren's own pipeline is working; what was done on that site, what was
    /// said, what was photographed and where it is are facts about the customer's work, and none
    /// of them is reachable — <c>PlatformHealthResponse</c> is read from a model that maps four
    /// columns of <c>entry</c> and four of <c>report</c>
    /// (<see cref="IdentityModelTests.The_platform_path_sees_four_columns_of_entry_and_four_of_report"/>).
    /// A project's <em>name</em> is admitted by the founder's decision of 2026-08-30 and nothing
    /// else about a project is.
    /// </para>
    /// <para>
    /// <b>Narrow three ways, and every one of them matters.</b> The declaring type must be one of
    /// the two count blocks — <c>EntryCount</c> on <see cref="Contracts.PlatformCompanyResponse"/> still
    /// fails, which is the mutation plan §12 itself names as how this boundary is actually lost.
    /// The property must be an <c>int</c> — a <c>string</c> or a list called <c>EntryCount</c>
    /// still fails. And the pair must be on this list by name, so a fourth count is a decision
    /// somebody writes down rather than one that arrives with a field.
    /// </para>
    /// </summary>
    private static readonly (Type Dto, string Property)[] AdmittedCounts =
    [
        (typeof(Contracts.PlatformPipelineHealth),
            nameof(Contracts.PlatformPipelineHealth.EntryCount)),
        (typeof(Contracts.PlatformPipelineHealth),
            nameof(Contracts.PlatformPipelineHealth.Reported)),
        (typeof(Contracts.PlatformDeliveryHealth),
            nameof(Contracts.PlatformDeliveryHealth.ReportCount)),
    ];

    /// <inheritdoc cref="AdmittedCounts"/>
    private static bool IsAdmittedCount(PropertyInfo property) =>
        (property.PropertyType == typeof(int) || property.PropertyType == typeof(long))
        && AdmittedCounts.Any(admitted =>
            admitted.Dto == property.DeclaringType && admitted.Property == property.Name);

    [Fact]
    public void The_count_exemption_admits_three_integers_and_nothing_else()
    {
        // Anti-vacuity, in both directions. Loosening IsAdmittedCount to "any int on any platform
        // DTO" would re-open exactly the door §12 says this guard exists to hold, and every other
        // assertion in this file would stay green.
        foreach (var (dto, name) in AdmittedCounts)
        {
            IsAdmittedCount(dto.GetProperty(name)!).ShouldBeTrue($"{dto.Name}.{name}");
        }

        // The same name on a DTO that is not a health count block.
        IsAdmittedCount(
                typeof(NotTheHealthPage).GetProperty(nameof(NotTheHealthPage.EntryCount))!)
            .ShouldBeFalse("a count of a customer's diary on an account DTO is the mutation");

        // The right type, the wrong shape.
        foreach (var property in typeof(NotACount)
                     .GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            IsAdmittedCount(property).ShouldBeFalse(property.Name);
        }
    }

    /// <summary>A company row that learned how many diaries the customer keeps. Must keep failing.</summary>
    private sealed record NotTheHealthPage(Guid Id, int EntryCount);

    /// <summary>Things called a count that are not one, declared on an admitted type's name.</summary>
    private sealed record NotACount(string EntryCount, IReadOnlyList<int> Reported, bool ReportCount);

    // ------------------------------------------------------ the credential half (plan §12/§13.6)

    /// <summary>
    /// Words that mean "a credential", which no type on the platform surface may name.
    ///
    /// <para>
    /// <b>This is the second thing §13.6 asked for, and it is what turns a comment into a fact.</b>
    /// The set-password link left every response body on 2026-09-01 (founder: *"bad behaviour, I
    /// don't like that"*) and the doc comments on <c>InviteSentResponse</c> and
    /// <c>PlatformCreateAdminResponse</c> say it "is not in this body and never will be". Nothing
    /// enforced the second half of that sentence: a token, a link or a one-time code could be added
    /// back to any of these DTOs, every existing test would stay green, and the credential would be
    /// in a response body, a screen, a clipboard and a chat message again.
    /// </para>
    /// <para>
    /// <b>Names, not types</b> — for the same reason the evidence vocabulary above works on names:
    /// a credential is a <c>string</c>, and no walk of the type graph can tell one string from
    /// another. And <b>names, not values</b>, so this is a tripwire rather than a wall: a property
    /// called <c>Detail</c> stuffed with a URL would pass. What it buys is that the obvious mistake
    /// fails loudly and the deliberate one has to be deliberate. The wall is elsewhere and it is
    /// structural — the plaintext is minted inside <c>AdminInviteJob</c>, so no request path in this
    /// process ever holds one to put on a DTO.
    /// </para>
    /// </summary>
    private static readonly string[] CredentialWords =
    [
        "token", "link", "secret", "password", "code", "credential", "url", "hash",
    ];

    [Fact]
    public void No_type_on_the_platform_surface_can_carry_a_credential()
    {
        var offenders = CredentialOffenders(PlatformSurfaceTypes());

        offenders.ShouldBeEmpty(
            "A platform DTO names a credential. The set-password link is minted inside "
            + "AdminInviteJob and goes to exactly one address; it never enters a response body, a "
            + "screen or a clipboard (founder, 2026-09-01). Staff creating or resetting an "
            + "administrator in a customer's company is possible, audited and announced to that "
            + "company's other administrators — what it must never be is a credential handed to "
            + "the person who asked.\n"
            + string.Join("\n", offenders));
    }

    /// <summary>
    /// The one admitted name, kept as narrow as the identifier and count exceptions above.
    /// <para>
    /// <c>PlatformUserResponse.PasswordPending</c> is the whole meaning of the directory's
    /// <c>status=pending</c> filter — "this account has never had a password" — and it is the state
    /// a founder looks for when he chases an onboarding that stalled. It is a <c>bool</c>, and a
    /// boolean cannot carry a credential. <c>string PasswordPending</c> still fails, and so does
    /// <c>bool PasswordToken</c>: the name and the type and the declaring DTO all have to match, so
    /// widening this is a decision somebody writes down.
    /// </para>
    /// </summary>
    private static bool IsAdmittedPasswordFlag(PropertyInfo property) =>
        property.PropertyType == typeof(bool)
        && property.Name == nameof(Teren.Api.Contracts.PlatformUserResponse.PasswordPending)
        && property.DeclaringType == typeof(Teren.Api.Contracts.PlatformUserResponse);

    [Fact]
    public void The_credential_vocabulary_detects_the_shapes_it_exists_for()
    {
        // Anti-vacuity. A vocabulary that matched nothing would pass the assertion above for ever,
        // which is exactly how a guard becomes decoration.
        CredentialOffenders([typeof(CredentialBait)]).Count.ShouldBe(3);

        // …and it is not simply answering "yes" to everything.
        CredentialOffenders([typeof(Teren.Api.Contracts.PlatformCompanyResponse)]).ShouldBeEmpty();
        CredentialOffenders([typeof(Teren.Api.Contracts.PlatformUserResponse)]).ShouldBeEmpty(
            "PasswordPending is the one admitted name");
    }

    [Fact]
    public void The_password_flag_exception_admits_one_boolean_and_nothing_else()
    {
        IsAdmittedPasswordFlag(
                typeof(Teren.Api.Contracts.PlatformUserResponse)
                    .GetProperty(nameof(Teren.Api.Contracts.PlatformUserResponse.PasswordPending))!)
            .ShouldBeTrue();

        foreach (var property in typeof(NotThePasswordFlag)
                     .GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            IsAdmittedPasswordFlag(property).ShouldBeFalse(property.Name);
        }
    }

    [Fact]
    public void The_credential_walk_actually_reaches_the_platform_surface()
    {
        // The guard on this guard: a walk that visited nothing would report no offenders for ever.
        var reached = PlatformSurfaceTypes();

        foreach (var expected in new[]
                 {
                     typeof(Teren.Api.Contracts.PlatformCompanyResponse),
                     typeof(Teren.Api.Contracts.PlatformUserResponse),
                     typeof(Teren.Api.Contracts.PlatformCreateAdminResponse),
                     typeof(Teren.Api.Contracts.InviteSentResponse),
                     typeof(Teren.Api.Contracts.CreateAdminRequest),
                     typeof(Teren.Api.Contracts.PlatformLogResponse),
                     typeof(Teren.Api.Contracts.PlatformHealthResponse),
                 })
        {
            reached.ShouldContain(expected, expected.Name);
        }
    }

    /// <summary>Three shapes of the mistake this vocabulary exists to catch, all of which have
    /// been in a response body of this product at some point or nearly were.</summary>
    private sealed record CredentialBait(
        Guid Id, string SetPasswordLink, string ActivationCode, string TokenHash);

    /// <summary>Things called a password flag that are not one.</summary>
    private sealed record NotThePasswordFlag(
        string PasswordPending, bool PasswordToken, bool PasswordHash);

    private static List<string> CredentialOffenders(IEnumerable<Type> types) => [
        .. from type in types
           from property in type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
           where !IsAdmittedPasswordFlag(property)
           let word = CredentialWords.FirstOrDefault(w =>
               property.Name.Contains(w, StringComparison.OrdinalIgnoreCase))
           where word is not null
           select $"{type.Name}.{property.Name} (matched '{word}')"];

    /// <summary>
    /// Every type of our own that a caller of the platform surface can reach.
    ///
    /// <para>
    /// Seeded from <c>PlatformDirectory</c>'s public signatures — the surface the whole privacy
    /// proof is written against — <b>plus</b> the platform wire contracts, because two of them do
    /// not reach that class at all: <c>CreateAdminRequest</c> is unwrapped by the endpoint into
    /// strings, and <c>InviteSentResponse</c> is exactly where the credential used to live. A guard
    /// seeded only from the directory would have a hole precisely where §13.6 was written.
    /// </para>
    /// </summary>
    private static HashSet<Type> PlatformSurfaceTypes()
    {
        var seeds = typeof(PlatformDirectory)
            .GetMembers(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static
                        | BindingFlags.DeclaredOnly)
            .SelectMany(SignatureTypes)
            .Select(pair => pair.Type)
            .Concat(typeof(Teren.Api.Contracts.PlatformCompanyResponse).Assembly
                .GetTypes()
                .Where(t => t.IsPublic
                    && t.Namespace == "Teren.Api.Contracts"
                    && (t.Name.StartsWith("Platform", StringComparison.Ordinal)
                        || t.Name == nameof(Teren.Api.Contracts.InviteSentResponse)
                        || t.Name == nameof(Teren.Api.Contracts.CreateAdminRequest)
                        || t.Name == nameof(Teren.Api.Contracts.CreateCompanyRequest))));

        var reached = new HashSet<Type>();
        foreach (var seed in seeds)
        {
            Collect(seed, reached);
        }

        return reached;

        static void Collect(Type type, HashSet<Type> reached)
        {
            type = Nullable.GetUnderlyingType(type) ?? type;

            if (type.IsArray)
            {
                Collect(type.GetElementType()!, reached);
                return;
            }

            if (type.IsGenericType)
            {
                foreach (var argument in type.GetGenericArguments())
                {
                    Collect(argument, reached);
                }
            }

            if (!IsOurs(type) || type.IsEnum || type.IsPrimitive || !reached.Add(type))
            {
                return;
            }

            foreach (var property in type.GetProperties(
                         BindingFlags.Public | BindingFlags.Instance))
            {
                Collect(property.PropertyType, reached);
            }

            foreach (var constructor in type.GetConstructors())
            {
                foreach (var parameter in constructor.GetParameters())
                {
                    Collect(parameter.ParameterType, reached);
                }
            }
        }
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

        // The health page's two read-throughs, proven the same way: adding a type to `Forbidden`
        // without proving the walk can see it is how a list grows into decoration.
        FirstForbidden(typeof(EntryHealthRow), []).ShouldBe(typeof(EntryHealthRow));
        FirstForbidden(typeof(IReadOnlyList<ReportHealthRow>), [])
            .ShouldBe(typeof(ReportHealthRow));
        FirstForbidden(typeof(HealthBait), []).ShouldBe(typeof(EntryHealthRow));

        // The site entity, proven the same way. `PlatformSiteHealthResponse` — the shape the
        // founder actually admitted — must keep passing, and does: it names a site by id and name
        // and carries counts, never a row.
        FirstForbidden(typeof(Project), []).ShouldBe(typeof(Project));
        FirstForbidden(typeof(IReadOnlyList<Project>), []).ShouldBe(typeof(Project));
        FirstForbidden(typeof(SiteBait), []).ShouldBe(typeof(Project));
        FirstForbidden(typeof(Contracts.PlatformSiteHealthResponse), []).ShouldBeNull(
            "the admitted shape names a site and counts its days; it must stay readable");

        // And a type that does not, so the walk is not simply answering "yes" to everything.
        FirstForbidden(typeof(Teren.Api.Contracts.PlatformCompanyResponse), []).ShouldBeNull();
    }

    /// <summary>A DTO shaped exactly like the mistake this file exists to catch.</summary>
    private sealed record Bait(Guid Id, IReadOnlyList<Report> Reports);

    /// <summary>
    /// And the mistake the health page made reachable: a DTO that hands over the read-through rows
    /// themselves rather than counts of them. <c>FailureReason</c> on those rows is the whole
    /// stored string, detail included.
    /// </summary>
    private sealed record HealthBait(Guid ProjectId, IReadOnlyList<EntryHealthRow> Buckets);

    /// <summary>
    /// And the one C10 is about to make tempting: a sites list that hands over the entity instead
    /// of the three columns this surface is allowed to know. Must keep failing.
    /// </summary>
    private sealed record SiteBait(Guid CompanyId, IReadOnlyList<Project> Sites);

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
    [InlineData("/api/platform/health")]
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
