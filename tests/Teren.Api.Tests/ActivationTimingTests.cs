using System.Diagnostics;
using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Core.Identity;
using Teren.Infrastructure.Seeding;

namespace Teren.Api.Tests;

/// <summary>
/// The two unauthenticated activation routes must be indistinguishable <b>by stopwatch</b>, not
/// merely byte for byte.
/// <para>
/// <c>ActivationTests.Every_activation_failure_is_byte_identical</c> and
/// <c>Asking_for_a_code_answers_the_same_way_whether_or_not_the_username_exists</c> compare bodies
/// and statuses, and nothing measures time — so an implementation that returns the instant it
/// knows a username is unknown, and grinds through an insert and a rollback when it is known,
/// passes both of them while handing out the staff list to anyone with a stopwatch. Usernames here
/// are guessable: <c>UsernameFormat.Propose</c> derives one deterministically from a display name,
/// and company and worker names are public.
/// </para>
/// <para>
/// <b>Why this is not a flaky test.</b> It never asserts a wall-clock number, only branches
/// against each other. Samples are interleaved round by round and the branch order rotates, so a
/// GC pause or a busy CI box lands on every branch alike; medians discard the outliers that
/// remain. What it is built to catch is a branch that skips several database round trips its
/// neighbours pay, and the bound is set above ordinary jitter and below that.
/// </para>
/// <para>
/// <b>Read this before trusting it with more than it can carry.</b> A median comparison is sharp
/// against a branch that does almost no work and blunt against a branch that does a little extra.
/// The mutation it does catch decisively is the early <c>return InvalidActivation()</c> after the
/// code fails to parse: the malformed branch drops to ~0.43 ms against ~2 ms, a ratio over 5.
/// The mutation it does <b>not</b> catch is moving the device insert back in front of the claim.
/// The D3 review ran exactly that four times: the wrong-code branch sat 44–61% above its
/// neighbours every time — a clean, repeatable oracle — and the test passed on all four runs.
/// That half of the property is now held by
/// <see cref="ActivationStatementShapeTests"/>, which compares the statements themselves and has
/// no opinion about how busy the machine is. <b>This test is the end-to-end backstop, not the
/// proof.</b>
/// </para>
/// </summary>
public sealed class ActivationTimingTests(TerenTestApp app) : ApiTestBase(app)
{
    /// <summary>Discarded: the first request through a route pays for JIT and for EF compiling
    /// each query, which is a one-off cost of milliseconds and has nothing to do with the
    /// branch.</summary>
    private const int WarmupRounds = 6;

    private const int MeasuredRounds = 80;

    /// <summary>
    /// The slowest branch's median may not exceed the fastest's by more than this.
    /// <para>
    /// Measured, not guessed: ten baseline runs of the two tests in this class on the development
    /// machine produced ratios between <b>1.01 and 1.09</b>. 1.35 leaves a quarter again of
    /// headroom over the worst of those and still sits below the 1.44 the D3 review's slowest
    /// insert-before-claim mutation reached — but do not lean on that last part, because the same
    /// review's runs ranged up to 1.61 and a run that landed at 1.30 would have passed.
    /// <see cref="ActivationStatementShapeTests"/> is what actually catches that mutation. The
    /// numbers this bound was set against are printed by the test itself on every run.
    /// </para>
    /// </summary>
    private const double MaxMedianRatio = 1.35;

    /// <summary>A syntactically valid Crockford code — so the parse succeeds and the request
    /// reaches the database — that is not the live one.</summary>
    private const string WrongCode = "ZZZZ-ZZZZ";

    [Fact]
    public async Task Every_activation_rejection_costs_the_same_database_work()
    {
        var live = await GivenLiveCodeAsync();
        live.ShouldNotBe(ActivationCodeFormat.Fold(WrongCode));

        var suspended = await GivenWorkerInASuspendedCompanyAsync();

        var medians = await MeasureAsync(
        [
            // No database work at all before the fix: TryParse failed and the handler returned.
            // Seven characters, not eight — the ordinary typo, and genuinely unparseable. Note
            // that "not-a-code" is NOT: Crockford folding strips the dashes and maps the O, so it
            // resolves to the eight valid characters N0TAC0DE and takes the wrong-code path.
            ("malformed code", client => Activate(client, DemoSeeder.WorkerUsername, "XKD4-7HM")),

            // One indexed SELECT before the fix.
            ("unknown username", client => Activate(client, "nobody.at.all", WrongCode)),

            // Two before the fix.
            ("suspended company", client => Activate(client, suspended, WrongCode)),

            // THE EXPENSIVE ONE. Before the fix: two SELECTs, a BEGIN, an INSERT into device, a
            // SaveChanges, the failed claim and a ROLLBACK — deterministically slower, and
            // therefore an answer to "does this username exist and is it active". Restoring that
            // order is the mutation this test does NOT reliably see; the statement-shape test
            // does. See the class comment.
            ("wrong code", client => Activate(client, DemoSeeder.WorkerUsername, WrongCode)),
        ]);

        AssertUniform(medians);
    }

    [Fact]
    public async Task Asking_for_a_code_costs_the_same_whether_or_not_it_issues_one()
    {
        // §10.3: the runtime answer must be uniform, and the thing it must not reveal is not only
        // "this username exists" but "this worker has an address on file" — that is precisely the
        // fact the plan resolves at INVITE time so it need never be said at runtime.
        await GivenEmailAsync(TestIds.WorkerA, "zoran@vodoinstal-petrovic.test");
        var withoutEmail = await GivenWorkerAsync("Nenad Ilić");

        var medians = await MeasureAsync(
            [
                ("unknown username", client => RequestCode(client, "no.such.person")),
                ("known, no address", client => RequestCode(client, withoutEmail)),

                // The only branch that writes: a supersede, an insert and an audit row.
                ("known, address on file",
                    client => RequestCode(client, DemoSeeder.WorkerUsername)),
            ],
            HttpStatusCode.Accepted);

        AssertUniform(medians);
    }

    // ------------------------------------------------------------ the harness

    private static void AssertUniform(IReadOnlyList<(string Name, double Median)> medians)
    {
        var slowest = medians.MaxBy(m => m.Median);
        var fastest = medians.MinBy(m => m.Median);
        var ratio = slowest.Median / fastest.Median;

        var report = string.Join(
            ", ", medians.Select(m => $"{m.Name} {m.Median:F3} ms"));

        TestContext.Current.TestOutputHelper?.WriteLine(
            $"medians: {report} — ratio {ratio:F2}");

        ratio.ShouldBeLessThan(
            MaxMedianRatio,
            $"'{slowest.Name}' takes {ratio:F2}x as long as '{fastest.Name}', which is a "
            + $"stopwatch that tells them apart. Medians: {report}.");
    }

    /// <summary>
    /// Runs every branch once per round, rotating which goes first, and returns the median of the
    /// measured rounds. Interleaving is what makes this robust: a slow moment on the machine is
    /// shared out rather than landing on whichever branch happened to run in a block.
    /// <para>
    /// <b>No <c>Task.Delay</c>, no <c>Thread.Sleep</c>, nothing that waits.</b> The whole test is
    /// the requests themselves.
    /// </para>
    /// </summary>
    private async Task<IReadOnlyList<(string Name, double Median)>> MeasureAsync(
        (string Name, Func<HttpClient, Task<HttpResponseMessage>> Call)[] branches,
        HttpStatusCode expected = HttpStatusCode.Unauthorized)
    {
        var samples = branches.ToDictionary(b => b.Name, _ => new List<double>());

        for (var round = 0; round < WarmupRounds + MeasuredRounds; round++)
        {
            // A fresh client per round, because /auth/* is rate limited to ten attempts per
            // client IP per five minutes and CreateAnonymousClient hands out a new address each
            // time. Three or four requests per client stays well inside the shipped limit — which
            // is deliberately not raised for the suite.
            using var client = App.CreateAnonymousClient();

            var offset = round % branches.Length;

            for (var i = 0; i < branches.Length; i++)
            {
                var (name, call) = branches[(i + offset) % branches.Length];

                var started = Stopwatch.GetTimestamp();
                using var response = await call(client);
                var elapsed = Stopwatch.GetElapsedTime(started).TotalMilliseconds;

                response.StatusCode.ShouldBe(expected, $"{name}: {await response.TextAsync()}");

                if (round >= WarmupRounds)
                {
                    samples[name].Add(elapsed);
                }
            }
        }

        return [.. branches.Select(b => (b.Name, Median(samples[b.Name])))];
    }

    private static double Median(List<double> values)
    {
        var sorted = values.Order().ToList();

        return sorted.Count % 2 == 1
            ? sorted[sorted.Count / 2]
            : (sorted[(sorted.Count / 2) - 1] + sorted[sorted.Count / 2]) / 2;
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

    private static Task<HttpResponseMessage> RequestCode(HttpClient client, string username) =>
        client.PostJson("/auth/activation-code", new JsonObject { ["username"] = username });

    private async Task<string> GivenLiveCodeAsync()
    {
        using var owner = await OwnerAsync();

        var response = await owner.PostNothing(
            $"/api/workers/{TestIds.WorkerA}/activation-code");
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());

        return ActivationCodeFormat.Fold((await response.JsonAsync()).GetText("code"));
    }

    private async Task<string> GivenWorkerAsync(string displayName)
    {
        using var owner = await OwnerAsync();

        var response = await owner.PostJson(
            "/api/workers", new JsonObject { ["display_name"] = displayName });
        response.StatusCode.ShouldBe(HttpStatusCode.Created, await response.TextAsync());

        return (await response.JsonAsync()).GetProperty("worker").GetText("username");
    }

    /// <summary>A real worker whose company is suspended — the branch that costs two queries and
    /// then gives up.</summary>
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

    private async Task GivenEmailAsync(Guid userId, string email)
    {
        await using var identity = App.CreateIdentityDbContext();

        await identity.Users
            .Where(u => u.Id == userId)
            .ExecuteUpdateAsync(u => u.SetProperty(x => x.Email, email), Ct);
    }

    private async Task<HttpClient> OwnerAsync()
    {
        if (await LoadUserAsync(TestIds.CompanyAdminA) is null)
        {
            await GivenCompanyAdminAsync();
        }

        return await SignInAsync(TestIds.CompanyAdminAEmail);
    }
}
