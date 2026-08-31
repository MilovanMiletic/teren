using System.ComponentModel.DataAnnotations;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Teren.Infrastructure.Tenancy;

namespace Teren.Api.Tests;

/// <summary>
/// The first test to pin <see cref="DeviceAuthOptions"/>, and it exists because D1 <b>loosened</b>
/// it: <c>Auth:DeviceToken</c> stopped being <c>[Required]</c>.
/// <para>
/// That was safe only because the token stopped being the authentication system. It is now one
/// device's credential, provisioned as a real <c>device</c> row by <c>DemoSeeder</c>, and an empty
/// value means "provision no demo device" rather than "let anybody in" — the bearer gate is
/// unconditional either way. The loosening is bounded: a token that is set at all must still be
/// long enough, so this can never quietly become "any two-character token is fine".
/// </para>
/// </summary>
public sealed class DeviceAuthOptionsTests
{
    [Fact]
    public void An_empty_token_is_now_a_legitimate_configuration()
    {
        // The D7 end state: environment.deviceToken flips to '' and the demo device is retired.
        // A host in that state must boot.
        Validate(new DeviceAuthOptions { DeviceToken = string.Empty }).ShouldBeEmpty();
        Bind(new Dictionary<string, string?>()).DeviceToken.ShouldBe(string.Empty);
    }

    [Fact]
    public void A_configured_token_that_is_too_short_is_still_refused()
    {
        var errors = Validate(new DeviceAuthOptions { DeviceToken = "short" });

        errors.ShouldHaveSingleItem().ErrorMessage.ShouldNotBeNull()
            .ShouldContain("at least 16");
    }

    [Fact]
    public void A_real_token_validates() =>
        Validate(new DeviceAuthOptions { DeviceToken = "teren-dev-device-token-not-a-secret" })
            .ShouldBeEmpty();

    [Theory]
    [InlineData("", false)]
    [InlineData("   ", false)]
    [InlineData("teren-dev-device-token-not-a-secret", true)]
    public void HasDeviceToken_is_what_the_seeder_and_the_startup_warning_read(
        string token, bool expected) =>
        new DeviceAuthOptions { DeviceToken = token }.HasDeviceToken.ShouldBe(expected);

    [Fact]
    public void The_options_class_no_longer_carries_a_company_or_a_device_id()
    {
        // Both are gone because the device row carries them. If either came back it would mean
        // somebody had reintroduced a tenant asserted by configuration rather than proven by a
        // credential — which is exactly what put the founder's own B6 entry inside the demo
        // company.
        var names = typeof(DeviceAuthOptions).GetProperties().Select(p => p.Name).ToList();

        names.ShouldNotContain("CompanyId");
        names.ShouldNotContain("DeviceId");
    }

    [Fact]
    public void The_option_binds_from_the_Auth_section()
    {
        var options = Bind(new Dictionary<string, string?>
        {
            ["Auth:DeviceToken"] = "teren-test-device-token-not-a-secret",
        });

        options.DeviceToken.ShouldBe("teren-test-device-token-not-a-secret");
    }

    private static List<ValidationResult> Validate(DeviceAuthOptions options)
    {
        var results = new List<ValidationResult>();
        Validator.TryValidateObject(
            options, new ValidationContext(options), results, validateAllProperties: true);

        return results;
    }

    /// <summary>
    /// Binds and validates through the real options pipeline, so a rule that held only when
    /// called by hand would fail here. <c>ValidateDataAnnotations</c> is what Program.cs uses, and
    /// it is what has to reach <see cref="IValidatableObject"/> for the length floor to survive.
    /// </summary>
    private static DeviceAuthOptions Bind(Dictionary<string, string?> settings)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(settings).Build();
        var services = new ServiceCollection();

        services
            .AddOptions<DeviceAuthOptions>()
            .Bind(configuration.GetSection(DeviceAuthOptions.SectionName))
            .ValidateDataAnnotations();

        return services.BuildServiceProvider()
            .GetRequiredService<IOptions<DeviceAuthOptions>>().Value;
    }

    [Fact]
    public void A_short_token_is_refused_by_the_options_pipeline_too()
    {
        // The floor must hold where it actually runs — at ValidateOnStart — not only when
        // Validator is called directly.
        Should.Throw<OptionsValidationException>(() =>
            Bind(new Dictionary<string, string?> { ["Auth:DeviceToken"] = "short" }));
    }
}
