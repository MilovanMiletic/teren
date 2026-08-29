namespace Teren.Api.Endpoints;

/// <summary>
/// The error vocabulary of the API, in one place so it stays consistent.
/// <para>
/// Note the deliberate absence of 403: anything the caller's company does not own is reported as
/// <see cref="NotFound"/>, identically to something that does not exist at all. A 403 would
/// confirm that an id is real, which is exactly the signal an enumerator wants.
/// </para>
/// </summary>
internal static class ApiProblems
{
    public static IResult NotFound(string detail) => TypedResults.Problem(
        title: "Not found", detail: detail, statusCode: StatusCodes.Status404NotFound);

    public static IResult BadRequest(string detail) => TypedResults.Problem(
        title: "Bad request", detail: detail, statusCode: StatusCodes.Status400BadRequest);

    public static IResult Conflict(string detail) => TypedResults.Problem(
        title: "Conflict", detail: detail, statusCode: StatusCodes.Status409Conflict);
}
