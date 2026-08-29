namespace Teren.Core.Storage;

/// <summary>
/// Object storage could not be reached, or did not answer in time.
/// <para>
/// Distinct from "the object is not there", which is an ordinary null answer. This one means the
/// server does not know, and the caller should be told to come back — never that its evidence
/// failed. Handlers let it escape; the API translates it into 503 with a Retry-After.
/// </para>
/// </summary>
public sealed class ObjectStorageUnavailableException(string message, Exception? innerException = null)
    : Exception(message, innerException);
