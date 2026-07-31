using System.Text.Json;
using System.Text.Json.Nodes;

namespace LibertyFinance.Shell;

public sealed class AppConfig
{
    public GitHubConfig GitHub { get; set; } = new();
    public PathsConfig Paths { get; set; } = new();
    public BackupsConfig Backups { get; set; } = new();

    public string DataRoot => Paths.DataRoot;
    public string WebRoot => Paths.WebRoot;

    public static AppConfig Load()
    {
        var obj = ReadConfigObject(Path.Combine(AppContext.BaseDirectory, "appsettings.json"));

        var devPath = Path.Combine(AppContext.BaseDirectory, "appsettings.Development.json");
        if (File.Exists(devPath))
        {
            var dev = ReadConfigObject(devPath);
            if (dev is not null) MergeInto(obj, dev);
        }

        return obj.Deserialize<AppConfig>(Options) ?? new AppConfig();
    }

    private static JsonObject ReadConfigObject(string path)
    {
        if (!File.Exists(path)) return new JsonObject();
        try
        {
            return JsonNode.Parse(File.ReadAllText(path)) as JsonObject ?? new JsonObject();
        }
        catch
        {
            return new JsonObject();
        }
    }

    private static void MergeInto(JsonObject target, JsonObject source)
    {
        foreach (var (key, value) in source)
        {
            if (value is JsonObject srcObj && target[key] is JsonObject tgtObj)
            {
                MergeInto(tgtObj, srcObj);
            }
            else if (value is not null)
            {
                target[key] = value.DeepClone();
            }
        }
    }

    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true
    };
}

public sealed class GitHubConfig
{
    public string Owner { get; set; } = "";
    public string Repo { get; set; } = "";
    public string Branch { get; set; } = "main";
    public string WebFolder { get; set; } = "Web";
}

public sealed class PathsConfig
{
    public string DataRoot { get; set; } = @"C:\LibertyFinance\Data";
    public string WebRoot { get; set; } = "";
}

public sealed class BackupsConfig
{
    public int MaxFiles { get; set; } = 30;
}
