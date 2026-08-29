using Microsoft.EntityFrameworkCore;
using Teren.Api.Contracts;
using Teren.Infrastructure.Persistence;

namespace Teren.Api.Endpoints;

public static class ProjectEndpoints
{
    public static RouteGroupBuilder MapProjectEndpoints(this RouteGroupBuilder api)
    {
        var group = api.MapGroup("/projects").WithTags("Projects");

        group.MapGet("/", GetProjectsAsync)
            .WithName("GetProjects")
            .WithSummary("Projects the calling device may write entries for.")
            .Produces<IReadOnlyList<ProjectResponse>>();

        return api;
    }

    // No CompanyId filter here on purpose: the global query filter applies it, and it applies it
    // whether or not a handler remembers to (ARCHITECTURE §4).
    private static async Task<IResult> GetProjectsAsync(
        TerenDbContext db, CancellationToken ct)
    {
        var projects = await db.Projects
            .AsNoTracking()
            .OrderBy(p => p.Name)
            .Select(p => new ProjectResponse(
                p.Id, p.Name, p.Address, p.Latitude, p.Longitude, p.ReportLanguage))
            .ToListAsync(ct);

        return TypedResults.Ok(projects);
    }
}
