namespace Teren.Core.Entities;

/// <summary>The tenant root: one contractor company.</summary>
public sealed class Company
{
    public Guid Id { get; set; }
    public string Name { get; set; } = null!;
    public DateTime CreatedAt { get; set; }
}
