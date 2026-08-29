using Teren.Infrastructure.Seeding;

namespace Teren.Api.Tests.Infrastructure;

/// <summary>
/// Fixed ids for the baseline every endpoint test starts from. Company A is the tenant the test
/// device token resolves to; company B exists solely so "another tenant's data" is a real row in
/// the same database rather than a hypothetical.
/// </summary>
public static class TestIds
{
    /// <summary>The token's company. Deliberately the demo company id: that is what the M0
    /// authenticator falls back to, and the seeder contract in ARCHITECTURE §6 pins it.</summary>
    public static readonly Guid CompanyA = DemoSeeder.CompanyId;

    public static readonly Guid ProjectA1 = Guid.Parse("aaaaaaaa-0000-4000-8000-000000000001");
    public static readonly Guid ProjectA2 = Guid.Parse("aaaaaaaa-0000-4000-8000-000000000002");

    public static readonly Guid CompanyB = Guid.Parse("bbbbbbbb-0000-4000-8000-00000000000b");
    public static readonly Guid ProjectB1 = Guid.Parse("bbbbbbbb-0000-4000-8000-000000000001");

    public static readonly Guid DeviceA = DemoSeeder.DemoDeviceId;

    /// <summary>Company A's name carries Serbian diacritics on purpose: the JSON encoder is
    /// configured to emit them as themselves, and only real data proves it.</summary>
    public const string CompanyAName = "Vodoinstal Petrović d.o.o.";
}
