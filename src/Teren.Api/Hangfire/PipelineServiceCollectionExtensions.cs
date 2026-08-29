using Hangfire;
using Hangfire.PostgreSql;
using Teren.Core.Ai;
using Teren.Core.Processing;
using Teren.Infrastructure.Ai;
using Teren.Infrastructure.Processing;

namespace Teren.Api.Hangfire;

/// <summary>
/// Everything B4 adds to the container, in one place: the two external-service adapters, the
/// processor and sweeper that use them, and Hangfire — which is optional, because the upload
/// path needs none of it and must stay runnable and testable without a job server.
/// </summary>
public static class PipelineServiceCollectionExtensions
{
    public static IServiceCollection AddTerenPipeline(
        this IServiceCollection services, IConfiguration configuration)
    {
        // ---- configuration -------------------------------------------------
        // Note what is and is not validated at start-up. Shape is: an empty model name or a
        // nonsensical timeout is a deployment mistake worth refusing to boot over. Keys are not:
        // most machines that build this have neither an Azure nor an Anthropic key, and a host
        // that would not start without them would make the entire upload path — which needs
        // neither — impossible to run. A missing key surfaces as an honest needs_review.
        services
            .AddOptions<TranscriptionOptions>()
            .Bind(configuration.GetSection(TranscriptionOptions.SectionName))
            .ValidateDataAnnotations()
            .ValidateOnStart();

        services
            .AddOptions<ExtractionOptions>()
            .Bind(configuration.GetSection(ExtractionOptions.SectionName))
            .ValidateDataAnnotations()
            .ValidateOnStart();

        services
            .AddOptions<PipelineOptions>()
            .Bind(configuration.GetSection(PipelineOptions.SectionName))
            .ValidateDataAnnotations()
            .ValidateOnStart();

        // ---- external services --------------------------------------------

        var azure = configuration
            .GetSection($"{TranscriptionOptions.SectionName}:Azure")
            .Get<AzureSpeechOptions>() ?? new AzureSpeechOptions();

        services
            .AddHttpClient(AzureFastTranscriptionProvider.HttpClientName)
            .ConfigureHttpClient(client => client.Timeout = azure.RequestTimeout);

        services.AddSingleton<ITranscriptionProvider, AzureFastTranscriptionProvider>();
        services.AddSingleton<IStructureExtractor, ClaudeStructureExtractor>();

        // ---- the pipeline --------------------------------------------------
        // Scoped: both take the request-or-job-scoped DbContext and TenantContext.
        services.AddScoped<EntryProcessor>();
        services.AddScoped<PipelineSweeper>();
        services.AddScoped<EntryProcessingJob>();
        services.AddScoped<PipelineSweepJob>();

        return services;
    }

    /// <summary>
    /// Wires Hangfire — storage, server, and the <see cref="IPipelineQueue"/> implementation —
    /// or, when <c>Hangfire:Enabled</c> is false, wires only a queue that says so out loud.
    /// Hangfire and the API run in **one process** (ARCHITECTURE §4).
    /// </summary>
    public static IServiceCollection AddTerenJobs(
        this IServiceCollection services, IConfiguration configuration, string connectionString)
    {
        if (!configuration.GetValue("Hangfire:Enabled", defaultValue: true))
        {
            services.AddSingleton<IPipelineQueue, DisabledPipelineQueue>();
            return services;
        }

        services.AddHangfire(config => config
            .SetDataCompatibilityLevel(CompatibilityLevel.Version_180)
            .UseSimpleAssemblyNameTypeSerializer()
            .UseRecommendedSerializerSettings()
            .UsePostgreSqlStorage(postgres => postgres.UseNpgsqlConnection(connectionString)));

        services.AddHangfireServer(server =>
        {
            server.Queues = [EntryProcessingJob.QueueName, "default"];
            // A handful of workers, not the default (processor count x 5). Every job here is
            // dominated by waiting on two external services, and each one holds a downloaded
            // voice note in memory while it works; unbounded concurrency buys nothing but a
            // larger bill and a larger heap.
            server.WorkerCount = configuration.GetValue("Hangfire:WorkerCount", 4);
        });

        services.AddSingleton<IPipelineQueue, HangfirePipelineQueue>();

        return services;
    }
}
