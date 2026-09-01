using FluentValidation;
using Teren.Api.Contracts;
using Teren.Core.Entities;
using Teren.Core.Identity;

namespace Teren.Api.Validation;

/// <summary>
/// Shape validation only. Anything that depends on stored state — does the project exist, is the
/// entry still accepting uploads, has this entry already used its twenty photos — belongs in the
/// handler, where it can answer with the right status code and without leaking other tenants' ids.
/// </summary>
public sealed class CreateEntryRequestValidator : AbstractValidator<CreateEntryRequest>
{
    /// <summary>Phone clocks drift and travel; a day of slack absorbs that without accepting
    /// an entry dated next month.</summary>
    private static readonly TimeSpan FutureSkew = TimeSpan.FromDays(1);

    public CreateEntryRequestValidator()
    {
        // Stop each field at its first failure: a NotNull() that fails must not let the next
        // rule in the same chain dereference the null it just rejected. Fields are still all
        // reported (class-level cascade stays Continue) — one round trip, every problem named.
        RuleLevelCascadeMode = CascadeMode.Stop;

        RuleFor(r => r.Id)
            .NotNull()
            .NotEqual(Guid.Empty)
            .WithMessage("id must be the UUID generated on the device.");

        RuleFor(r => r.ProjectId)
            .NotNull()
            .NotEqual(Guid.Empty);

        RuleFor(r => r.EntryDate)
            .NotNull()
            .Must(d => d!.Value <= DateOnly.FromDateTime(DateTime.UtcNow.Add(FutureSkew)))
            .WithMessage("entry_date cannot be in the future.");

        RuleFor(r => r.CreatedAt)
            .Must(t => t!.Value <= DateTimeOffset.UtcNow.Add(FutureSkew))
            .When(r => r.CreatedAt is not null)
            .WithMessage("created_at cannot be in the future.");

        RuleFor(r => r.Latitude)
            .InclusiveBetween(-90, 90)
            .When(r => r.Latitude is not null);

        RuleFor(r => r.Longitude)
            .InclusiveBetween(-180, 180)
            .When(r => r.Longitude is not null);

        RuleFor(r => r.GpsAccuracyM)
            .GreaterThanOrEqualTo(0)
            .When(r => r.GpsAccuracyM is not null);
    }
}

public sealed class DeclareMediaRequestValidator : AbstractValidator<DeclareMediaRequest>
{
    /// <summary>One voice note plus a full set of photos is the largest legitimate batch — the
    /// same ceiling the handler enforces across the whole entry.</summary>
    private const int MaxFilesPerRequest = MediaPolicy.MaxMediaPerEntry;

    public DeclareMediaRequestValidator()
    {
        // Stop each field at its first failure: a NotNull() that fails must not let the next
        // rule in the same chain dereference the null it just rejected. Fields are still all
        // reported (class-level cascade stays Continue) — one round trip, every problem named.
        RuleLevelCascadeMode = CascadeMode.Stop;

        RuleFor(r => r.Files)
            .NotNull()
            .NotEmpty()
            .WithMessage("files must declare at least one file.");

        RuleFor(r => r.Files!)
            .Must(files => files.Count <= MaxFilesPerRequest)
            .When(r => r.Files is not null)
            .WithMessage($"files may declare at most {MaxFilesPerRequest} files per request.");

        RuleFor(r => r.Files!)
            .Must(files => files
                .Where(f => f.Id is not null)
                .GroupBy(f => f.Id!.Value)
                .All(g => g.Count() == 1))
            .When(r => r.Files is not null)
            .WithMessage("files contains the same id more than once.");

        RuleForEach(r => r.Files).SetValidator(new DeclaredMediaValidator());
    }
}

public sealed class DeclaredMediaValidator : AbstractValidator<DeclaredMedia>
{
    private static readonly TimeSpan FutureSkew = TimeSpan.FromDays(1);

    public DeclaredMediaValidator()
    {
        // Stop each field at its first failure: a NotNull() that fails must not let the next
        // rule in the same chain dereference the null it just rejected. Fields are still all
        // reported (class-level cascade stays Continue) — one round trip, every problem named.
        RuleLevelCascadeMode = CascadeMode.Stop;

        RuleFor(f => f.Id)
            .NotNull()
            .NotEqual(Guid.Empty)
            .WithMessage("id must be the UUID generated on the device.");

        RuleFor(f => f.Kind)
            .Must(k => MediaKindNames.TryParse(k, out _))
            .WithMessage(
                $"kind must be '{MediaKindNames.Audio}' or '{MediaKindNames.Photo}'.");

        RuleFor(f => f.ContentType)
            .Must((file, contentType) =>
                MediaKindNames.TryParse(file.Kind, out var kind)
                && MediaPolicy.TryResolveContentType(kind, contentType, out _, out _))
            .When(f => MediaKindNames.TryParse(f.Kind, out _))
            .WithMessage(f => AcceptedTypesMessage(f.Kind!));

        RuleFor(f => f.ByteSize)
            .NotNull()
            .GreaterThan(0)
            .WithMessage("byte_size must be the positive size of the file about to be uploaded.");

        RuleFor(f => f.ByteSize)
            .Must((file, size) =>
                size!.Value <= MediaPolicy.MaxBytesFor(MediaKindNames.Parse(file.Kind!)))
            .When(f => f.ByteSize is > 0 && MediaKindNames.TryParse(f.Kind, out _))
            .WithMessage(f => SizeLimitMessage(f.Kind!));

        RuleFor(f => f.Sha256)
            .Must(s => MediaPolicy.TryNormaliseSha256(s, out _))
            .WithMessage("sha256 must be 64 hexadecimal characters.");

        RuleFor(f => f.CapturedAt)
            .Must(t => t!.Value <= DateTimeOffset.UtcNow.Add(FutureSkew))
            .When(f => f.CapturedAt is not null)
            .WithMessage("captured_at cannot be in the future.");
    }

    private static string AcceptedTypesMessage(string kind)
    {
        var accepted = MediaPolicy.AcceptedContentTypes(MediaKindNames.Parse(kind));
        return $"content_type is not accepted for kind '{kind}'. Accepted: {string.Join(", ", accepted)}.";
    }

    private static string SizeLimitMessage(string kind)
    {
        var limitMb = MediaPolicy.MaxBytesFor(MediaKindNames.Parse(kind)) / (1024 * 1024);
        return $"byte_size exceeds the {limitMb} MB limit for kind '{kind}'.";
    }
}

/// <summary>
/// Shape validation for the confirmation payload. Whether the entry may be confirmed at all —
/// its status, whether a report has already gone out — is stored state and lives in the handler.
/// </summary>
public sealed class ConfirmEntryRequestValidator : AbstractValidator<ConfirmEntryRequest>
{
    public ConfirmEntryRequestValidator()
    {
        RuleLevelCascadeMode = CascadeMode.Stop;

        RuleFor(r => r.Corrected)
            .NotNull()
            .WithMessage("corrected must carry the structure the human approved.")
            .Must(node => node is System.Text.Json.Nodes.JsonObject)
            .WithMessage("corrected must be a JSON object.")
            .Must(node => node is System.Text.Json.Nodes.JsonObject obj
                          && obj.ContainsKey(Teren.Core.Ai.EntryStructureSchema.VersionKey))
            .WithMessage(
                $"corrected must carry {Teren.Core.Ai.EntryStructureSchema.VersionKey}, so a "
                + "future trade template can evolve the shape without a migration.");
    }
}

// ------------------------------------------------------------------ identity (D2/D3)

/// <summary>
/// Shape only, and deliberately generous: an activation screen is the one thing standing between a
/// foreman and the record button, so the server refuses a payload that is structurally missing —
/// never one that merely looks wrong. Whether the code is right is answered by the handler, once,
/// with a single indistinguishable 401.
/// <para>
/// In particular the code is <b>not</b> length-checked here. It is folded before it is judged
/// (separators, case and Cyrillic homoglyphs all collapse), so a 400 on "8 characters" would
/// reject <c>xkd4-7hmp</c>, which is exactly what a man pastes out of a chat message.
/// </para>
/// </summary>
public sealed class ActivateRequestValidator : AbstractValidator<ActivateRequest>
{
    public ActivateRequestValidator()
    {
        RuleLevelCascadeMode = CascadeMode.Stop;

        RuleFor(r => r.Username)
            .NotEmpty()
            .WithMessage("username is the name your foreman was given; it cannot be empty.");

        RuleFor(r => r.ActivationCode)
            .NotEmpty()
            .WithMessage("activation_code cannot be empty.");
    }
}

public sealed class ActivationCodeRequestBodyValidator
    : AbstractValidator<ActivationCodeRequestBody>
{
    public ActivationCodeRequestBodyValidator()
    {
        RuleLevelCascadeMode = CascadeMode.Stop;

        // Only that something was sent. Whether the username exists is never answered here or
        // anywhere else on this route: it always returns 202.
        RuleFor(r => r.Username).NotEmpty().WithMessage("username cannot be empty.");
    }
}

/// <summary>
/// <b>The password is not validated here, on purpose.</b> A 400 that says "too short" on the login
/// route would tell an attacker that his guess was structurally acceptable — and worse, a
/// validation failure would answer before the handler could equalise the timing. Login has exactly
/// one answer for everything: 401.
/// </summary>
public sealed class LoginRequestValidator : AbstractValidator<LoginRequest>
{
    public LoginRequestValidator()
    {
        RuleLevelCascadeMode = CascadeMode.Stop;

        RuleFor(r => r.Email).NotEmpty().WithMessage("email cannot be empty.");
        RuleFor(r => r.Password).NotEmpty().WithMessage("password cannot be empty.");
    }
}

/// <summary>
/// Here the password <em>is</em> validated, and the asymmetry with login is the point: the caller
/// holds a single-use token issued for his own account, so telling him his new password is too
/// short costs nothing and saves him a second round trip.
/// </summary>
public sealed class SetPasswordRequestValidator : AbstractValidator<SetPasswordRequest>
{
    public SetPasswordRequestValidator()
    {
        RuleLevelCascadeMode = CascadeMode.Stop;

        RuleFor(r => r.Token).NotEmpty().WithMessage("token cannot be empty.");

        RuleFor(r => r.Password)
            .NotEmpty()
            .Must(PasswordPolicy.IsAcceptable)
            .WithMessage(PasswordPolicy.Requirement);
    }
}

public sealed class CreateWorkerRequestValidator : AbstractValidator<CreateWorkerRequest>
{
    /// <summary>Long enough for "Aleksandar Stanković", short enough that a paste accident is
    /// refused rather than stored.</summary>
    private const int MaxDisplayNameLength = 120;

    public CreateWorkerRequestValidator()
    {
        RuleLevelCascadeMode = CascadeMode.Stop;

        RuleFor(r => r.DisplayName)
            .NotEmpty()
            .WithMessage("display_name is what the foreman is called; it cannot be empty.")
            .Must(name => name!.Trim().Length > 0)
            .WithMessage("display_name cannot be blank.")
            .MaximumLength(MaxDisplayNameLength);

        // Format and availability are the handler's: one of them needs the database, and both
        // want to answer with the same vocabulary rather than half in a validation problem and
        // half in a conflict.
        RuleFor(r => r.Username)
            .MaximumLength(UsernameFormat.MaximumLength)
            .When(r => r.Username is not null);

        RuleFor(r => r.Email)
            .MaximumLength(EmailAddress.MaximumLength)
            .When(r => r.Email is not null);
    }
}

public sealed class UpdateWorkerRequestValidator : AbstractValidator<UpdateWorkerRequest>
{
    private const int MaxDisplayNameLength = 120;

    public UpdateWorkerRequestValidator()
    {
        RuleLevelCascadeMode = CascadeMode.Stop;

        RuleFor(r => r.DisplayName)
            .MaximumLength(MaxDisplayNameLength)
            .When(r => r.DisplayName is not null);

        RuleFor(r => r.Email)
            .MaximumLength(EmailAddress.MaximumLength)
            .When(r => r.Email is not null);
    }
}

/// <summary>
/// A customer needs a name and nothing else. Everything about the company that matters — its
/// projects, its people — arrives afterwards, so demanding more here would only be ceremony
/// between a founder and a customer he has just signed.
/// </summary>
public sealed class CreateCompanyRequestValidator : AbstractValidator<CreateCompanyRequest>
{
    /// <summary>Room for "Vodoinstalaterske usluge Petrović i sinovi d.o.o." and not for a paste
    /// accident.</summary>
    private const int MaxNameLength = 160;

    public CreateCompanyRequestValidator()
    {
        RuleLevelCascadeMode = CascadeMode.Stop;

        RuleFor(r => r.Name)
            .NotEmpty()
            .WithMessage("name is what the customer is called; it cannot be empty.")
            .Must(name => name!.Trim().Length > 0)
            .WithMessage("name cannot be blank.")
            .MaximumLength(MaxNameLength);
    }
}
