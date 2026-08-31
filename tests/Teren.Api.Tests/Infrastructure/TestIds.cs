using Teren.Infrastructure.Seeding;

namespace Teren.Api.Tests.Infrastructure;

/// <summary>
/// Fixed ids for the baseline every endpoint test starts from. Company A is the tenant the test
/// device token resolves to; company B exists solely so "another tenant's data" is a real row in
/// the same database rather than a hypothetical.
/// </summary>
public static class TestIds
{
    /// <summary>The token's company. Deliberately the demo company id, so the fixture exercises
    /// the same ids the demo runs on and the seeder contract in ARCHITECTURE §6 pins.</summary>
    public static readonly Guid CompanyA = DemoSeeder.CompanyId;

    public static readonly Guid ProjectA1 = Guid.Parse("aaaaaaaa-0000-4000-8000-000000000001");
    public static readonly Guid ProjectA2 = Guid.Parse("aaaaaaaa-0000-4000-8000-000000000002");

    public static readonly Guid CompanyB = Guid.Parse("bbbbbbbb-0000-4000-8000-00000000000b");
    public static readonly Guid ProjectB1 = Guid.Parse("bbbbbbbb-0000-4000-8000-000000000001");

    public static readonly Guid DeviceA = DemoSeeder.DemoDeviceId;

    /// <summary>The worker company A's device is bound to. A device belongs to a person now, so
    /// the fixture has to have one before it can have a phone.</summary>
    public static readonly Guid WorkerA = DemoSeeder.WorkerId;

    public const string WorkerAUsername = DemoSeeder.WorkerUsername;

    /// <summary>Company B's worker and phone, used to prove the authenticator is a lookup rather
    /// than a constant: a second, different token must resolve to a second, different company.</summary>
    public static readonly Guid WorkerB = Guid.Parse("bbbbbbbb-0000-4000-8000-0000000000a2");

    public static readonly Guid DeviceB = Guid.Parse("bbbbbbbb-0000-4000-8000-0000000000dd");

    /// <summary>Company A's owner — the man who signs in with an email and a password and manages
    /// his own foremen. Deliberately the demo company's admin id, for the same reason
    /// <see cref="CompanyA"/> is the demo company's.</summary>
    public static readonly Guid CompanyAdminA = DemoSeeder.CompanyAdminId;

    /// <summary>Company B's owner, so "another company's admin" is a real row and every
    /// cross-tenant 404 is proven against something that exists.</summary>
    public static readonly Guid CompanyAdminB = Guid.Parse("bbbbbbbb-0000-4000-8000-0000000000a1");

    /// <summary>Teren staff. No company at all — <c>ck_app_user_company_scope</c> would refuse the
    /// row otherwise, which is the point of the constraint.</summary>
    public static readonly Guid SuperAdmin = Guid.Parse("cccccccc-0000-4000-8000-0000000000a0");

    public const string CompanyAdminAEmail = "petar@vodoinstal-petrovic.test";
    public const string CompanyAdminBEmail = "admin@druga-firma.test";
    public const string SuperAdminEmail = "staff@teren.test";

    /// <summary>Company A's name carries Serbian diacritics on purpose: the JSON encoder is
    /// configured to emit them as themselves, and only real data proves it.</summary>
    public const string CompanyAName = "Vodoinstal Petrović d.o.o.";
}
