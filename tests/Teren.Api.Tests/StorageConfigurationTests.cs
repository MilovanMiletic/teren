using Microsoft.Extensions.Configuration;
using Teren.Api.Tests.Infrastructure;
using Teren.Infrastructure.Storage;

namespace Teren.Api.Tests;

/// <summary>
/// The presigned-URL lifetime is a security parameter (ARCHITECTURE §8, §12: 15 minutes, PUT
/// only, one exact key), and the endpoint test that watches <c>expires_at</c> come back can only
/// prove the handler honours whatever the host was configured with — the fixture pins that value
/// itself. These are what pin the number that actually ships.
/// </summary>
[Collection(TerenCollection.Name)]
public sealed class StorageConfigurationTests
{
    private static readonly TimeSpan ArchitecturalTtl = TimeSpan.FromMinutes(15);

    [Fact]
    public void The_compiled_default_upload_url_ttl_is_fifteen_minutes()
    {
        // What a deployment that configures nothing gets.
        new StorageOptions().UploadUrlTtl.ShouldBe(ArchitecturalTtl);
    }

    [Fact]
    public void The_shipped_appsettings_upload_url_ttl_is_fifteen_minutes()
    {
        // And what a deployment that takes the committed appsettings.json gets. Environment
        // variables are deliberately not part of this builder: the fixture sets
        // Storage__UploadUrlTtl process-wide, and reading it here would make this test assert
        // its own arrangement.
        var configuration = new ConfigurationBuilder()
            .SetBasePath(AppContext.BaseDirectory)
            .AddJsonFile("appsettings.json", optional: false)
            .Build();

        var options = configuration.GetSection(StorageOptions.SectionName).Get<StorageOptions>();

        options.ShouldNotBeNull();
        options.UploadUrlTtl.ShouldBe(ArchitecturalTtl);
    }

    [Fact]
    public void The_test_fixture_pins_the_same_ttl_the_product_ships()
    {
        // Without this, the fixture could quietly pin some convenient value and the endpoint
        // test would keep passing while asserting a number nobody deploys.
        TerenTestApp.UploadUrlTtl.ShouldBe(ArchitecturalTtl);
    }
}
