using FluentValidation;

namespace Teren.Api.Validation;

/// <summary>
/// Runs the FluentValidation validator for a request body before the handler sees it, so
/// handlers only ever deal with structurally valid input and can spend their attention on state
/// (does this project exist, is this entry still open) instead of on shapes.
/// </summary>
public sealed class ValidationFilter<T> : IEndpointFilter where T : class
{
    public async ValueTask<object?> InvokeAsync(
        EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var body = context.Arguments.OfType<T>().FirstOrDefault();
        if (body is null)
        {
            return TypedResults.Problem(
                title: "Bad request",
                detail: "A JSON request body is required.",
                statusCode: StatusCodes.Status400BadRequest);
        }

        var validator = context.HttpContext.RequestServices.GetRequiredService<IValidator<T>>();
        var result = await validator.ValidateAsync(body, context.HttpContext.RequestAborted);
        if (result.IsValid)
        {
            return await next(context);
        }

        var errors = result.Errors
            .GroupBy(e => e.PropertyName)
            .ToDictionary(g => g.Key, g => g.Select(e => e.ErrorMessage).ToArray());

        return TypedResults.ValidationProblem(errors, detail: "The request payload is not valid.");
    }
}
