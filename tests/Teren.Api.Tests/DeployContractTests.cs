using Teren.Api.Tests.Infrastructure;

namespace Teren.Api.Tests;

/// <summary>
/// The deployment read off disk, because <c>deploy/</c> ships and nothing in this suite looked at
/// it.
///
/// <para>
/// <b>What this exists for.</b> D7/F9 emptied <c>environment.deviceToken</c> on 2026-08-31.
/// <c>deploy/web.Dockerfile</c> went on grepping the PWA for the placeholder that had been in it
/// and exiting 1 on a miss, and <c>deploy.sh</c> went on requiring <c>TEREN_DEVICE_TOKEN</c> and
/// passing it as a build arg — so **the deploy chain could not complete on either target**, and it
/// was found by a code review rather than by a red test. 991 backend tests and 1575 PWA specs were
/// green throughout, because the coupling crosses three files none of them read.
/// </para>
///
/// <para>
/// It is a text scan, and that is the honest description of what it can do: it cannot prove a
/// deploy works — only <c>deploy.sh --target local</c> does that, and it takes several minutes and
/// a Docker daemon. What it can do is fail the moment somebody reintroduces a credential seam into
/// the bundle, or moves a health route without moving the proxy rule that reaches it.
/// </para>
/// </summary>
public sealed class DeployContractTests
{
    /// <summary>The literal that used to be compiled into the PWA bundle. It is still the demo
    /// device's <em>server-side</em> token in appsettings.Development.json, which is why the check
    /// below is about the web image and not about the string existing anywhere.</summary>
    private const string RetiredPlaceholder = "teren-dev-device-token-not-a-secret";

    [Fact]
    public void The_web_image_bakes_no_credential_into_the_bundle()
    {
        var dockerfile = Read("web.Dockerfile");

        // The exact failure of 2026-09-02: `grep -q <placeholder> ... || exit 1` against a file
        // that no longer contains it, so every `deploy.sh` run died at "2/7 Building images".
        dockerfile.ShouldNotContain(
            RetiredPlaceholder,
            Case.Sensitive,
            "deploy/web.Dockerfile substitutes a device token into the PWA source again. There is "
            + "nothing to substitute — environment.deviceToken has been empty since D7/F9 and a "
            + "spec pins it empty — so the fail-loud grep stops every deploy on both targets. And "
            + "a working credential compiled into a public bundle is readable from devtools by "
            + "anyone, which is why it was removed.");

        dockerfile.ShouldNotContain(
            "TEREN_DEVICE_TOKEN",
            Case.Sensitive,
            "the web image takes a device-token build arg again. The bundle carries no credential.");
    }

    [Fact]
    public void The_deploy_script_does_not_require_a_device_token()
    {
        var script = Read("deploy.sh");

        var required = Between(script, "required=(", ")");

        required.ShouldNotContain(
            "TEREN_DEVICE_TOKEN",
            Case.Sensitive,
            "deploy.sh refuses to run without TEREN_DEVICE_TOKEN. It is now only the demo "
            + "device's server-side credential and empty is a working host — Program.cs says so "
            + "once at start-up and DemoSeeder provisions no phone.");

        script.ShouldNotContain(
            "--build-arg",
            Case.Sensitive,
            "deploy.sh passes a build arg to the web image again. See web.Dockerfile.");

        // Anti-vacuous: if the `required=(` block ever moves or is renamed, the assertion above
        // would pass on an empty string and prove nothing.
        required.ShouldContain("TEREN_DB_PASSWORD", Case.Sensitive);
    }

    [Fact]
    public void Readiness_is_what_the_deploy_and_the_container_actually_ask()
    {
        // /health is a constant and always was. It cannot see the failure this repository keeps
        // having — a host that boots, answers `ok`, and dies per request on an un-migrated schema
        // — so both probes were pointed at /health/ready.
        Read("deploy.sh").ShouldContain("/health/ready", Case.Sensitive);
        Read("docker-compose.prod.yml").ShouldContain("/health/ready", Case.Sensitive);
    }

    /// <summary>
    /// <c>Auth__AppUrl</c> reaches a deployed host, and <c>deploy.sh</c> will not run without the
    /// value behind it.
    ///
    /// <para>
    /// <b>The variable was in no deploy artefact at all until 2026-09-04</b> — only in
    /// <c>appsettings.Development.json</c>, which a deployed host never reads. The admin invite
    /// mail has no content but a link, so on <c>dev.teren.rs</c> with Resend live the platform
    /// screen said <em>emailed</em>, nothing went out, and pressing send again retired the
    /// previous attempt's token on its way past. The code half of that is fixed and tested
    /// elsewhere (<c>AdminInviteJobTests</c>, <c>PlatformInvitePreconditionTests</c>); this is the
    /// half that made it reachable, and it is exactly the class of defect this file exists for —
    /// a coupling across three files that no other test reads.
    /// </para>
    /// <para>
    /// It rides on <c>TEREN_APP_ORIGIN</c> rather than a variable of its own, because two settings
    /// obliged to hold one URL is what makes the storage endpoints above the most expensive
    /// mistake in that file, and here there is no configuration in which they could differ.
    /// </para>
    /// </summary>
    [Fact]
    public void The_app_origin_reaches_the_container_and_the_deploy_insists_on_it()
    {
        Read("docker-compose.prod.yml").ShouldContain(
            "Auth__AppUrl: ${TEREN_APP_ORIGIN}",
            Case.Sensitive,
            "the production stack no longer passes Auth__AppUrl to the API. The admin invite mail "
            + "is nothing but a set-password link, so a host without it cannot onboard an "
            + "administrator: the invite is refused before a token is minted and the platform "
            + "screen says emailed: false. That is honest and it is still a box nobody can be "
            + "invited to. It was missing for the whole life of this file before 2026-09-04.");

        var required = Between(Read("deploy.sh"), "required=(", ")");

        required.ShouldContain(
            "TEREN_APP_ORIGIN",
            Case.Sensitive,
            "deploy.sh will deploy without TEREN_APP_ORIGIN again. It stopped being a CORS detail "
            + "when it became Auth__AppUrl as well; unset, the box comes up healthy and cannot "
            + "invite anybody, which presents as a customer who never gets his mail.");

        // Anti-vacuous, the same guard the device-token test above uses: a moved or renamed
        // `required=(` block would make the assertion pass on an empty string.
        required.ShouldContain("TEREN_DB_PASSWORD", Case.Sensitive);

        // And it is documented where a founder filling the file in would actually look. The
        // template is the only place that says what a value is FOR.
        Read(".env.example").ShouldContain("Auth__AppUrl", Case.Sensitive);
    }

    [Theory]
    [InlineData("Caddyfile")]
    [InlineData("Caddyfile.local")]
    public void The_proxy_routes_the_whole_health_prefix_to_the_api(string file)
    {
        // The trap found while wiring readiness: the backend matcher listed `/health` exactly, so
        // `/health/ready` fell through to the SPA handler and the deploy would have verified
        // against an HTML shell. Production and the local rehearsal must agree — a divergence is
        // how staging stops being evidence about production (ARCHITECTURE §13).
        var caddyfile = Read(file);

        caddyfile.ShouldContain("@backend path ", Case.Sensitive);
        caddyfile.ShouldContain(
            "/health/*",
            Case.Sensitive,
            $"deploy/{file} does not proxy /health/* to the API, so /health/ready is served the "
            + "SPA shell and the deploy's verify step passes on an HTML page.");
    }

    private static string Read(string name) =>
        File.ReadAllText(Path.Combine(SourceTree.RepoRoot(), "deploy", name));

    /// <summary>The text between two markers, or empty when the opening marker is gone — which the
    /// callers assert about, so a moved block cannot become a silent pass.</summary>
    private static string Between(string text, string start, string end)
    {
        var from = text.IndexOf(start, StringComparison.Ordinal);
        if (from < 0)
        {
            return string.Empty;
        }

        from += start.Length;
        var to = text.IndexOf(end, from, StringComparison.Ordinal);

        return to < 0 ? string.Empty : text[from..to];
    }
}
