namespace Teren.Infrastructure.Seeding;

/// <summary>
/// Deleting objects out of the bucket, which is a capability the product deliberately does not
/// have anywhere else.
/// <para>
/// It is a separate interface from <see cref="Teren.Core.Storage.IObjectStorage"/> on purpose,
/// and it is registered in the container **only** when the process was started with the
/// <c>reset-demo</c> command (see <c>Program.cs</c>). The running API therefore has no injectable
/// way to erase evidence at all — no endpoint, no job, no accident. Widening
/// <c>IObjectStorage</c> instead would have handed a destructive verb to every service on the
/// request path in exchange for nothing.
/// </para>
/// <para>
/// Listing and deleting are separate calls because the reset reports what it removed, and a
/// count that came back from the same call that destroyed the objects would be an assertion
/// about work nobody could check. The dry run uses <see cref="ListAsync"/> alone.
/// </para>
/// </summary>
public interface IDemoObjectPurge
{
    /// <summary>Every object key under <paramref name="prefix"/>, following pagination.</summary>
    Task<IReadOnlyList<string>> ListAsync(string prefix, CancellationToken ct = default);

    /// <summary>Deletes exactly these keys. Returns how many the store confirmed.</summary>
    Task<int> DeleteAsync(IReadOnlyList<string> keys, CancellationToken ct = default);
}
