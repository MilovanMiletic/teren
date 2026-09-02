using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;

namespace Teren.Infrastructure.Logging;

/// <summary>
/// Everything D5 adds to the container: the queue, the writer, the flusher and the sink.
///
/// <para>
/// <b>The sink is registered here but wired to Serilog in <c>Program.cs</c>, on purpose.</b> The
/// logger is built from the application's own service provider, so the sink has to exist as a
/// resolvable singleton before <c>UseSerilog</c>'s delegate runs — and the alternative, letting
/// Serilog construct it, would put the queue's lifetime outside the container and give the log
/// viewer a second, invisible copy of the buffer.
/// </para>
/// </summary>
public static class LoggingServiceCollectionExtensions
{
    public static IServiceCollection AddTerenLogging(
        this IServiceCollection services,
        IConfiguration configuration,
        string connectionString,
        bool storeDebugLevels)
    {
        services
            .AddOptions<LoggingOptions>()
            .Bind(configuration.GetSection(LoggingOptions.SectionName))
            .ValidateDataAnnotations()
            .ValidateOnStart();

        // A data source of its own rather than the EF connection: the writer must be able to open
        // a connection while nothing else in the process can, and it must not inherit the
        // DbContext's own command logging, which is how a log sink ends up logging about itself.
        services.AddSingleton(_ => new NpgsqlDataSourceBuilder(connectionString).Build());

        services.AddSingleton<AppLogQueue>();
        services.AddSingleton<AppLogWriter>();
        services.AddSingleton(provider => new PostgresLogSink(
            provider.GetRequiredService<AppLogQueue>(),
            provider.GetRequiredService<Microsoft.Extensions.Options.IOptions<LoggingOptions>>(),
            storeDebugLevels));

        services.AddHostedService<AppLogFlushService>();

        // Scoped, because it takes the identity DbContext. Hangfire resolves it per execution.
        services.AddScoped<LogRetentionJob>();

        return services;
    }
}
