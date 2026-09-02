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
