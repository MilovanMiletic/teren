using FluentValidation;
using Teren.Api.Contracts;
using Teren.Core.Entities;

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
