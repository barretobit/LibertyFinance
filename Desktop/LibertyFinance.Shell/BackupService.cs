namespace LibertyFinance.Shell;

public static class BackupService
{
    public static void Run(AppConfig config)
    {
        var dataRoot = config.DataRoot;
        if (!Directory.Exists(dataRoot)) return;

        var dataFiles = Directory.GetFiles(dataRoot, "*.json");
        if (dataFiles.Length == 0) return;

        var backupsDir = Path.Combine(dataRoot, "Backups");
        Directory.CreateDirectory(backupsDir);

        var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmssfff");
        var max = Math.Max(config.Backups.MaxFiles, 1);

        foreach (var dataFile in dataFiles)
        {
            var baseName = Path.GetFileNameWithoutExtension(dataFile);
            File.Copy(dataFile, Path.Combine(backupsDir, $"{baseName}-{stamp}.json"));

            var pattern = $"{baseName}-*.json";
            foreach (var old in Directory.GetFiles(backupsDir, pattern)
                .OrderByDescending(f => f, StringComparer.OrdinalIgnoreCase)
                .Skip(max))
            {
                try { File.Delete(old); } catch { /* best effort */ }
            }
        }
    }
}
