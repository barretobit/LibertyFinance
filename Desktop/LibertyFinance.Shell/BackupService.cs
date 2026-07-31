namespace LibertyFinance.Shell;

public static class BackupService
{
    public static void Run(AppConfig config)
    {
        var dataFile = Path.Combine(config.DataRoot, "liberty-finance.json");
        if (!File.Exists(dataFile)) return;

        var backupsDir = Path.Combine(config.DataRoot, "Backups");
        Directory.CreateDirectory(backupsDir);

        var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmssfff");
        var target = Path.Combine(backupsDir, $"liberty-finance-{stamp}.json");
        File.Copy(dataFile, target);

        var max = Math.Max(config.Backups.MaxFiles, 1);
        var files = Directory.GetFiles(backupsDir, "liberty-finance-*.json")
            .OrderByDescending(f => f, StringComparer.OrdinalIgnoreCase)
            .ToList();

        foreach (var file in files.Skip(max))
        {
            try { File.Delete(file); } catch { /* best effort */ }
        }
    }
}