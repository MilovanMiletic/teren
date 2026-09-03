using Teren.Api.Health;
using Teren.Api.Jobs;
using Hangfire;
using Hangfire.PostgreSql;
using Hangfire.Server;
using Teren.Core.Ai;
using Teren.Core.Processing;
using Teren.Core.Reporting;
using Teren.Infrastructure.Ai;
using Teren.Infrastructure.Processing;
using Teren.Infrastructure.Reporting;

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

        // Same policy as the AI keys: the timings and limits are validated because a nonsensical
        // one is a deployment mistake, but an absent relay host is not — capture and upload need
        // no mail server, and a host that refused to boot without one would make the whole
        // upload path unrunnable on a laptop. A missing relay surfaces as an honest
        // `delivery_not_configured` on the entry.
        services
            .AddOptions<ReportingOptions>()
            .Bind(configuration.GetSection(ReportingOptions.SectionName))
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

        // B6. Both stateless: the renderer holds only layout settings, and the SMTP client is
        // created per send because a pooled connection to a relay is a connection that goes
        // stale between two reports a day.
        services.AddSingleton<IReportRenderer, QuestPdfReportRenderer>();
        services.AddSingleton<IReportDelivery, SmtpReportDelivery>();

        // ---- the pipeline --------------------------------------------------
        // Scoped: all of them take the request-or-job-scoped DbContext and TenantContext.
        services.AddScoped<EntryProcessor>();
        services.AddScoped<EntryReporter>();
        services.AddScoped<PipelineSweeper>();
        services.AddScoped<EntryProcessingJob>();
        services.AddScoped<EntryReportJob>();
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
        // Registered in both branches so that nothing has to ask "is Hangfire on" to resolve it.
        // With the job server off it simply stays empty, and the readiness check that would read
        // it is not registered either.
        services.AddSingleton<JobServerIdentity>();

        if (!configuration.GetValue("Hangfire:Enabled", defaultValue: true))
        {
            services.AddSingleton<IPipelineQueue, DisabledPipelineQueue>();
            services.AddSingleton<IInviteQueue, DisabledInviteQueue>();
            services.AddSingleton<IJobQueueDepth, DisabledJobQueueDepth>();
            return services;
        }

        services.AddHangfire(config => config
            .SetDataCompatibilityLevel(CompatibilityLevel.Version_180)
            .UseSimpleAssemblyNameTypeSerializer()
            .UseRecommendedSerializerSettings()
            .UsePostgreSqlStorage(postgres => postgres.UseNpgsqlConnection(connectionString)));

        // Runs alongside the workers and does one thing: records the server id Hangfire assigned
        // to this process, which is what lets /health/ready ask about THIS job server rather than
        // about any row in the table. `AddHangfireServer` resolves IBackgroundProcess from the
        // container, so registering it here is the whole wiring.
        services.AddSingleton<IBackgroundProcess, JobServerAnnouncement>();

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
        services.AddSingleton<IInviteQueue, HangfireInviteQueue>();
        services.AddSingleton<IJobQueueDepth, HangfireJobQueueDepth>();

        return services;
    }
}
