using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using Teren.Core.Entities;

namespace Teren.Infrastructure.Persistence.Configurations;

/// <summary>
/// Enums are stored as snake_case text — readable in psql, in dumps, and in a courtroom.
/// The spellings themselves live in <c>Teren.Core.Entities</c> (<see cref="EntryStatusNames"/>
/// and friends) so that the stored value and the value the API puts on the wire are the same
/// string by construction, and a rename in C# can never silently change either.
/// </summary>
internal static class StatusConverters
{
    public static readonly ValueConverter<EntryStatus, string> EntryStatus =
        new(status => EntryStatusNames.ToWire(status), value => EntryStatusNames.Parse(value));

    public static readonly ValueConverter<MediaKind, string> MediaKind =
        new(kind => MediaKindNames.ToWire(kind), value => MediaKindNames.Parse(value));

    public static readonly ValueConverter<MediaUploadStatus, string> MediaUploadStatus =
        new(status => MediaUploadStatusNames.ToWire(status),
            value => MediaUploadStatusNames.Parse(value));

    public static readonly ValueConverter<ReportKind, string> ReportKind =
        new(kind => ReportKindNames.ToWire(kind), value => ReportKindNames.Parse(value));
}
