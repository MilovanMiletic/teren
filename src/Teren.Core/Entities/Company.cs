namespace Teren.Core.Entities;

/// <summary>The tenant root: one contractor company.</summary>
public sealed class Company
{
    public Guid Id { get; set; }
    public string Name { get; set; } = null!;
    public DateTime CreatedAt { get; set; }

    /// <summary>
    /// Set when the platform suspends a customer. Every credential check requires this to be null,
    /// so suspension reaches every one of the company's phones on their next request — and, like a
    /// revoked device, it is indistinguishable from an unknown token in the response.
    /// </summary>
    public DateTime? SuspendedAt { get; set; }
}
