using Microsoft.EntityFrameworkCore;
using Teren.Api.Auth;
using Teren.Api.Contracts;
using Teren.Core.Entities;
using Teren.Core.Time;
using Teren.Infrastructure.Persistence;

namespace Teren.Api.Endpoints;

/// <summary>
/// The company's phones, and the button that takes one away.
/// <para>
/// <b>Revocation is the security control</b> (§2 decision 8). There is no expiry on a device token
/// and no cache in front of the device table, so a phone that has been in a basement for a week
/// presents its token, the row says revoked, and it is refused on first contact — nothing to push,
/// nothing to wait for.
/// </para>
/// <para>
/// <b>Revoking is a soft stamp and never a DELETE.</b> <c>entry.device_id</c> is provenance on
/// evidence rows, and an administrative action must not degrade evidence. Note that there is
/// currently <em>no</em> foreign key from <c>entry.device_id</c> to <c>device</c> — adding one
/// would validate every row on a live database — so the database would happily accept a delete
/// here. Until that constraint exists this is a code-level discipline backed by
/// <c>DeviceCredentialTests.Revocation_is_a_stamp_and_the_evidence_it_recorded_survives</c>, which
/// makes the test matter more, not less.
/// </para>
/// <para>
/// <b>What the admin must be told before he presses it.</b> Under today's client code a revoked
/// phone's outbox retries at the ten-minute ceiling and surfaces as a stuck queue (F1 split 401
/// from 403 precisely so it heals rather than abandoning the day). The revoke button's copy has to
/// say that a day of unsent evidence is about to stop going anywhere until the man re-activates.
/// </para>
/// </summary>
public static class DeviceEndpoints
{
    public static RouteGroupBuilder MapDeviceEndpoints(this RouteGroupBuilder api)
    {
        var group = api.MapGroup("/devices")
            .WithTags("Devices")
            .RequireRole(RoleGates.CompanyAdmin);

        group.MapGet("/", ListDevicesAsync)
            .WithName("ListDevices")
            .WithSummary("The company's phones, revoked ones included.")
            .Produces<DeviceListResponse>();

        group.MapDelete("/{id}", RevokeDeviceAsync)
            .WithName("RevokeDevice")
            .WithSummary("Withdraw a phone's credential. A stamp, never a delete.")
            .Produces<DeviceListItemResponse>();

        return api;
    }

    private static async Task<IResult> ListDevicesAsync(
        HttpContext http, TerenIdentityDbContext db, CancellationToken ct)
    {
        var companyId = http.GetPrincipal().CompanyId();

        var rows = await db.DevicesOf(companyId)
            .AsNoTracking()
            .Join(db.Users, d => d.UserId, u => u.Id, (d, u) => new { Device = d, User = u })
            // Live phones first, then the most recently used: the list is read to answer "which
            // of these is the one I am taking away".
            .OrderBy(r => r.Device.RevokedAt != null)
            .ThenByDescending(r => r.Device.LastSeenAt)
            .ThenBy(r => r.User.DisplayName)
            .ToListAsync(ct);

        var devices = rows.Select(r => Describe(r.Device, r.User)).ToList();

        return TypedResults.Ok(new DeviceListResponse(devices, devices.Count));
    }

    private static async Task<IResult> RevokeDeviceAsync(
        string id,
        HttpContext http,
        TerenIdentityDbContext db,
        ILogger<Device> logger,
        CancellationToken ct)
    {
        if (!Guid.TryParse(id, out var deviceId))
        {
            return ApiProblems.BadRequest("The device id in the path is not a valid UUID.");
        }

        var principal = http.GetPrincipal();
        var companyId = principal.CompanyId();

        var device = await db.DevicesOf(companyId).FirstOrDefaultAsync(d => d.Id == deviceId, ct);
        if (device is null)
        {
            // Another company's phone answers exactly as one that does not exist.
            return ApiProblems.NotFound($"Device {deviceId} was not found.");
        }

        var user = await db.Users.AsNoTracking().FirstAsync(u => u.Id == device.UserId, ct);

        if (device.RevokedAt is null)
        {
            device.RevokedAt = DateTime.UtcNow;
            device.RevokedByUserId = principal.UserId;

            db.AdminAudits.Add(AdminAudit.For(
                principal.UserId,
                AdminAuditActions.DeviceRevoked,
                "device",
                device.Id,
                companyId,
                device.RevokedAt.Value));

            await db.SaveChangesAsync(ct);

            logger.LogInformation(
                "Device {DeviceId} revoked by user {ActorUserId}.", device.Id, principal.UserId);
        }

        // Idempotent: revoking an already-revoked phone is the same answer as revoking it the
        // first time, because the admin's question was "is this phone off" and it is.
        return TypedResults.Ok(Describe(device, user));
    }

    private static DeviceListItemResponse Describe(Device device, AppUser user) => new(
        device.Id,
        device.Name,
        user.Id,
        user.DisplayName,
        user.Username ?? string.Empty,
        UtcStamp.Of(device.CreatedAt),
        UtcStamp.OrNull(device.LastSeenAt),
        UtcStamp.OrNull(device.RevokedAt));
}
