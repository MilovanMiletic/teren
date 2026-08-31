using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Core.Identity;
using Teren.Infrastructure.Seeding;

namespace Teren.Api.Tests;

/// <summary>
/// The deterministic half of the activation timing-oracle guard: every way
/// <c>POST /auth/activate</c> can be refused must issue the <b>same SQL statements, in the same
/// order</b>.
/// <para>
/// <b>Why this exists alongside <see cref="ActivationTimingTests"/>.</b> That test compares branch
/// medians, and a median comparison is only sharp against an order-of-magnitude difference. The
/// D3 review measured the case that matters: with the device insert moved back in front of the
/// claim, the wrong-code branch ran 44–61% slower than its neighbours — a clean, repeatable
/// oracle an attacker reads with a few hundred samples — and the stopwatch bound never fired,
/// four times out of four. There is no bound that both survives a busy machine and sees one extra
/// insert. So the property is asserted on the work itself instead, where a busy machine has no
/// vote.
/// </para>
/// <para>
/// The two mutations this is built to catch, and it catches both outright:
/// <list type="bullet">
/// <item>an early <c>return InvalidActivation()</c> after the code fails to parse — the malformed
/// branch then issues no statements at all while its neighbours issue three;</item>
/// <item>moving the device insert back in front of the claim — the wrong-code branch then carries
/// an <c>INSERT INTO device</c> the other three do not.</item>
/// </list>
/// </para>
/// </summary>
public sealed class ActivationStatementShapeTests(TerenTestApp app) : ApiTestBase(app)
{
    /// <summary>A syntactically valid Crockford code — so the parse succeeds and the request
    /// reaches the database — that is not the live one.</summary>
    private const string WrongCode = "ZZZZ-ZZZZ";

    [Fact]
    public async Task Every_activation_rejection_issues_the_identical_statement_sequence()
    {
        var live = await GivenLiveCodeAsync();
        live.ShouldNotBe(ActivationCodeFormat.Fold(WrongCode));

        var suspended = await GivenWorkerInASuspendedCompanyAsync();

        (string Name, Func<HttpClient, Task<HttpResponseMessage>> Call)[] branches =
        [
            // Seven characters, not eight — the ordinary typo, and genuinely unparseable. Note
            // that "not-a-code" is NOT: Crockford folding strips the dashes and maps the O, so it
            // resolves to the eight valid characters N0TAC0DE and takes the wrong-code path.
            ("malformed code", client => Activate(client, DemoSeeder.WorkerUsername, "XKD4-7HM")),
            ("unknown username", client => Activate(client, "nobody.at.all", WrongCode)),
            ("suspended company", client => Activate(client, suspended, WrongCode)),

            // The one that has to cost exactly what the other three cost: a real, active worker,
            // in a live company, whose code is simply wrong.
            ("wrong code", client => Activate(client, DemoSeeder.WorkerUsername, WrongCode)),
        ];

        var recorded = new List<(string Name, IReadOnlyList<string> Statements)>();

        foreach (var (name, call) in branches)
        {
            // Two requests per client keeps every branch inside the shipped /auth/* rate limit of
            // ten attempts per IP; CreateAnonymousClient hands out a fresh address each time.
            using var client = App.CreateAnonymousClient();

            // Discarded. The first request through a route compiles its EF queries, and a
            // compilation is not a statement — but nothing about it belongs in the comparison.
            (await call(client)).Dispose();

            recorded.Add((name, await App.CommandTap.RecordAsync(async () =>
            {
                using var response = await call(client);
                response.StatusCode.ShouldBe(
                    HttpStatusCode.Unauthorized, $"{name}: {await response.TextAsync()}");
            })));
        }

        recorded.ShouldContain(
            branch => branch.Statements.Count > 0,
            "not one branch issued a statement — the recording is not wired up, and this test is "
            + "proving nothing");

        foreach (var branch in recorded)
        {
            branch.Statements.ShouldNotBeEmpty(
                $"'{branch.Name}' reached no database at all while its neighbours did. A refusal "
                + $"that returns the instant it knows is the enumeration oracle by stopwatch this "
                + $"handler has no early returns in order to avoid.{Report(recorded)}");
        }

        var reference = recorded[0];

        foreach (var branch in recorded.Skip(1))
        {
            branch.Statements.Count.ShouldBe(
                reference.Statements.Count,
                $"'{branch.Name}' issues {branch.Statements.Count} statements and "
                + $"'{reference.Name}' issues {reference.Statements.Count}. A refusal that costs "
                + $"a different number of round trips is an account-enumeration oracle by "
                + $"stopwatch.{Report(recorded)}");

            branch.Statements.ShouldBe(
                reference.Statements,
                $"'{branch.Name}' and '{reference.Name}' do not do the same database work, so "
                + $"they can be told apart by how long they take.{Report(recorded)}");
        }

        // Named explicitly rather than left implied by equality: four branches that all skipped
        // the claim would also be "identical", and the point is that every one of them pays for
        // the conditional UPDATE that settles a real activation.
        reference.Statements.Count(Claims).ShouldBe(
            1, $"the claim is what every rejection has to pay for.{Report(recorded)}");

        reference.Statements.Any(InsertsADevice).ShouldBeFalse(
            $"the phone is written only after the claim succeeds. An INSERT on a path that is "
            + $"going to be refused is exactly the extra round trip the wrong-code branch used to "
            + $"pay and an unknown username did not.{Report(recorded)}");
    }

    private static bool Claims(string sql) =>
        sql.Contains("UPDATE activation_code", StringComparison.Ordinal);

    private static bool InsertsADevice(string sql) =>
        sql.Contains("INSERT INTO device", StringComparison.Ordinal);

    /// <summary>Every branch's sequence, one short line per statement — so a failure names the
    /// difference instead of leaving the reader to find it.</summary>
    private static string Report(
        IReadOnlyList<(string Name, IReadOnlyList<string> Statements)> recorded)
    {
        var lines = recorded.Select(branch => $"  {branch.Name}: "
            + string.Join(" | ", branch.Statements.Select(Summarise)));

        return "\n\nStatements issued:\n" + string.Join("\n", lines);
    }

    private static string Summarise(string sql)
    {
        var flat = string.Join(' ', sql.Split(
            (char[]?)null, StringSplitOptions.RemoveEmptyEntries));

        return flat.Length <= 70 ? flat : flat[..70] + "…";
    }

    // ------------------------------------------------------------ arrange

    private static Task<HttpResponseMessage> Activate(
        HttpClient client, string username, string code) =>
        client.PostJson(
            "/auth/activate",
            new JsonObject
            {
                ["username"] = username,
                ["activation_code"] = code,
                ["device_name"] = "Zoranov telefon",
            });

    private async Task<string> GivenLiveCodeAsync()
    {
        await GivenCompanyAdminAsync();
        using var owner = await SignInAsync(TestIds.CompanyAdminAEmail);

        var response = await owner.PostNothing(
            $"/api/workers/{TestIds.WorkerA}/activation-code");
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());

        return ActivationCodeFormat.Fold((await response.JsonAsync()).GetText("code"));
    }

    /// <summary>A real worker whose company is suspended — a branch that finds its man and then
    /// gives up.</summary>
    private async Task<string> GivenWorkerInASuspendedCompanyAsync()
    {
        const string username = "milan.milanovic";

        await using var identity = App.CreateIdentityDbContext();

        identity.Users.Add(new AppUser
        {
            Id = Guid.NewGuid(),
            CompanyId = TestIds.CompanyB,
            Role = AppUserRole.Worker,
            Username = username,
            DisplayName = "Milan Milanović",
            Language = "sr",
            CreatedAt = DateTime.UtcNow,
        });

        await identity.SaveChangesAsync(Ct);

        await identity.Companies
            .Where(c => c.Id == TestIds.CompanyB)
            .ExecuteUpdateAsync(u => u.SetProperty(c => c.SuspendedAt, DateTime.UtcNow), Ct);

        return username;
    }
}
