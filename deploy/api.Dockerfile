# Teren API — production image.
#
# Build from the repository root, not from deploy/:
#   docker build -f deploy/api.Dockerfile -t teren-api:local .
#
# Two properties this file exists to guarantee:
#   * no SDK in the shipped image — the runtime layer is the ASP.NET runtime and nothing else;
#   * the process does not run as root.
#
# It deliberately does NOT run migrations. `dotnet Teren.Api.dll migrate` is a separate,
# explicit step in deploy.sh (compose service `migrate`). Running them on start-up would mean
# every restart of a crash-looping container re-attempts a schema change, and two replicas would
# race. CLAUDE.md records that forgetting the migrate step has bitten twice; the answer to that
# is a deploy script that always runs it, not a container that sometimes does.

# ---------------------------------------------------------------------------- build
# Alpine SDK: ~700 MB smaller than the Debian one, and it makes no difference to the output.
# The publish is *portable* (no -r/RID), so it emits IL plus the whole runtimes/ tree — including
# runtimes/linux-x64/native/libQuestPdfSkia.so, the glibc build the Debian runtime layer below
# loads. A musl toolchain producing a glibc-compatible artefact is not a coincidence here; it is
# what "portable publish" means.
FROM mcr.microsoft.com/dotnet/sdk:10.0-alpine AS build
WORKDIR /src

# Restore on the manifests alone, so editing a .cs file does not re-download the package graph.
COPY global.json ./
COPY src/Teren.Core/Teren.Core.csproj src/Teren.Core/
COPY src/Teren.Infrastructure/Teren.Infrastructure.csproj src/Teren.Infrastructure/
COPY src/Teren.Api/Teren.Api.csproj src/Teren.Api/
RUN dotnet restore src/Teren.Api/Teren.Api.csproj

COPY src/ src/
RUN dotnet publish src/Teren.Api/Teren.Api.csproj \
      -c Release \
      -o /app/publish \
      --no-restore \
      /p:UseAppHost=false

# ------------------------------------------------------------------------- runtime
# Alpine, matching the SDK stage. QuestPDF ships a musl build of its native Skia
# (runtimes/linux-musl-x64/native/libQuestPdfSkia.so), so the report renderer is as much at home
# here as on glibc, and the image is roughly a third the size.
FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine AS runtime

# Three packages, each closing a failure that would otherwise appear far from its cause.
#
# icu-libs + icu-data-full — NOT optional, and the reason is subtle enough to be worth the
#   paragraph. Microsoft's Alpine images ship no ICU and set
#   DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=true. Under invariant globalization
#   CultureInfo.GetCultureInfo("sr-Latn-RS") does not throw — it yields the invariant culture —
#   and Teren.Core/Reporting/ReportStrings.cs deliberately catches CultureNotFoundException and
#   falls back to invariant anyway, "without taking the report down over a decimal comma". So a
#   report would render perfectly, in Serbian, with 12.5 where a Serbian reader expects 12,5.
#   Nothing would log, nothing would fail, and the first person to notice would be a client.
# fontconfig + freetype — QuestPDF's Skia initialises the platform font manager when it renders.
#   Missing, it fails at PDF generation: on the money path, inside a Hangfire job, hours after
#   the deploy looked healthy.
# tzdata — NOT optional either, and this one was found the hard way: with it absent, confirming
#   an entry parked at
#     time_zone_unknown: 'Europe/Belgrade' is not a time zone this host can resolve
#   and no report was ever rendered or sent. Alpine ships no IANA time-zone database, and B6's
#   reports carry project-local timestamps, so every report on a staging box would have failed
#   while working perfectly on the founder's Windows machine, where the OS supplies the zones.
#   This is the single strongest argument for standing the production stack up before trusting
#   it: /health said "ok" throughout.
# curl — the container healthcheck in docker-compose.prod.yml. The .NET runtime images ship
#   neither curl nor wget.
RUN apk add --no-cache icu-libs icu-data-full fontconfig freetype tzdata curl

WORKDIR /app
COPY --from=build /app/publish ./

ENV ASPNETCORE_ENVIRONMENT=Production \
    ASPNETCORE_HTTP_PORTS=8080 \
    DOTNET_RUNNING_IN_CONTAINER=true \
    # Overrides the base image's default. Paired with the icu packages above — set one without
    # the other and the runtime either ignores the cultures it has or fails to find the ones it
    # is told to use.
    DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false
EXPOSE 8080

# `app` (UID 1654) is defined by the base image. Nothing in this container writes to disk: logs
# go to stdout (Serilog), media goes to object storage, the database is elsewhere.
USER app

ENTRYPOINT ["dotnet", "Teren.Api.dll"]
