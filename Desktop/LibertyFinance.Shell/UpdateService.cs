using System.IO.Compression;
using System.Text.Json;

namespace LibertyFinance.Shell;

public sealed class UpdateService
{
    private static readonly HashSet<string> AllowedWebDirs = new(StringComparer.OrdinalIgnoreCase)
    {
        "css", "js", "assets"
    };

    private static readonly HashSet<string> AllowedWebRootFiles = new(StringComparer.OrdinalIgnoreCase)
    {
        "index.html", "app.html"
    };

    private static readonly HashSet<string> AllowedExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".html", ".css", ".js", ".json",
        ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
        ".ttf", ".woff", ".woff2"
    };

    private readonly AppConfig _config;
    private readonly HttpClient _http;

    public UpdateService(AppConfig config)
    {
        _config = config;
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(45) };
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("LibertyFinance-Shell/1.0");
    }

    public string WebRoot => string.IsNullOrWhiteSpace(_config.WebRoot)
        ? Path.Combine(_config.DataRoot, "Web")
        : _config.WebRoot;

    /// <summary>Downloads and deploys the latest web assets if the remote SHA differs.</summary>
    /// <returns>Status message, or null when already up to date.</returns>
    public async Task<string?> CheckAndUpdateAsync(Action<string>? progress = null)
    {
        if (!string.IsNullOrWhiteSpace(_config.WebRoot))
            return "Development mode: using repository Web folder";

        var gh = _config.GitHub;
        if (string.IsNullOrWhiteSpace(gh.Owner) || string.IsNullOrWhiteSpace(gh.Repo))
            return "Configure GitHub Owner/Repo in appsettings.json";

        string latest;
        try
        {
            latest = await GetLatestShaAsync(gh);
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException("Could not reach GitHub (" + ex.Message + ")", ex);
        }

        if (string.IsNullOrWhiteSpace(latest))
            throw new InvalidOperationException("GitHub returned no commit SHA.");

        var webRoot = WebRoot;
        if (File.Exists(Path.Combine(webRoot, "index.html")) && ReadSha(webRoot) == latest)
            return null;

        progress?.Invoke("Downloading version " + ShortSha(latest) + "...");
        await DeployAsync(latest, gh, progress);
        return "Updated to " + ShortSha(latest);
    }

    private async Task<string> GetLatestShaAsync(GitHubConfig gh)
    {
        var url = $"https://api.github.com/repos/{gh.Owner}/{gh.Repo}/commits?sha={Uri.EscapeDataString(gh.Branch)}&per_page=1";
        using var response = await _http.GetAsync(url);
        response.EnsureSuccessStatusCode();
        var json = await response.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        if (doc.RootElement.ValueKind == JsonValueKind.Array && doc.RootElement.GetArrayLength() > 0)
            return doc.RootElement[0].GetProperty("sha").GetString() ?? "";
        return "";
    }

    private async Task DeployAsync(string sha, GitHubConfig gh, Action<string>? progress)
    {
        var dataRoot = _config.DataRoot;
        var staging = Path.Combine(dataRoot, ".web-staging");
        var webRoot = WebRoot;
        var oldRoot = Path.Combine(dataRoot, ".web-old");

        Directory.CreateDirectory(dataRoot);
        if (Directory.Exists(staging)) Directory.Delete(staging, true);
        Directory.CreateDirectory(staging);

        var zipUrl = $"https://codeload.github.com/{gh.Owner}/{gh.Repo}/zip/refs/heads/{Uri.EscapeDataString(gh.Branch)}";

        using (var stream = await _http.GetStreamAsync(zipUrl))
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Read))
        {
            var top = FindTopFolder(archive);
            if (top is null)
                throw new InvalidOperationException("Downloaded archive is empty.");

            var prefix = top + "/" + gh.WebFolder + "/";
            var extracted = 0;

            foreach (var entry in archive.Entries)
            {
                if (!entry.FullName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) continue;
                var rel = entry.FullName[prefix.Length..];
                if (rel.Length == 0 || entry.FullName.EndsWith("/")) continue;
                if (!IsAllowed(rel)) continue;

                var dest = Path.GetFullPath(Path.Combine(staging, rel));
                var root = staging.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
                if (!dest.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue;

                Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                entry.ExtractToFile(dest, overwrite: true);
                extracted++;
            }

            if (extracted == 0)
                throw new InvalidOperationException("No web files found in the downloaded archive.");
        }

        File.WriteAllText(Path.Combine(staging, "current.sha"), sha);

        if (Directory.Exists(oldRoot)) Directory.Delete(oldRoot, true);
        if (Directory.Exists(webRoot)) Directory.Move(webRoot, oldRoot);

        try
        {
            Directory.Move(staging, webRoot);
        }
        catch
        {
            if (Directory.Exists(webRoot)) Directory.Delete(webRoot, true);
            if (Directory.Exists(oldRoot)) Directory.Move(oldRoot, webRoot);
            throw;
        }

        if (Directory.Exists(oldRoot)) Directory.Delete(oldRoot, true);
    }

    private static bool IsAllowed(string rel)
    {
        var parts = rel.Split('/');
        if (parts.Length == 1)
            return AllowedWebRootFiles.Contains(parts[0]);

        var dir = parts[0];
        var ext = Path.GetExtension(parts[^1]);
        return AllowedWebDirs.Contains(dir) && AllowedExtensions.Contains(ext);
    }

    private static string? FindTopFolder(ZipArchive archive)
    {
        foreach (var entry in archive.Entries)
        {
            var idx = entry.FullName.IndexOf('/');
            var candidate = idx >= 0 ? entry.FullName[..idx] : entry.FullName;
            if (candidate.Length > 0) return candidate;
        }
        return null;
    }

    private static string ReadSha(string webRoot)
    {
        var path = Path.Combine(webRoot, "current.sha");
        return File.Exists(path) ? File.ReadAllText(path).Trim() : "";
    }

    private static string ShortSha(string sha) => sha[..Math.Min(7, sha.Length)];
}
