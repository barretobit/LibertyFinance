using System.Text;

namespace LibertyFinance.Shell;

public static class CrashLog
{
    private static readonly object Sync = new();
    private static string? _dir;

    public static void Configure(string dataRoot)
    {
        _dir = Path.Combine(dataRoot, "Logs");
    }

    public static string FilePath
    {
        get
        {
            var dir = _dir ?? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "LibertyFinance");
            return Path.Combine(dir, "crash.log");
        }
    }

    public static void Write(string message)
    {
        try
        {
            lock (Sync)
            {
                var path = FilePath;
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                File.AppendAllText(path, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + "  " + message + Environment.NewLine, Encoding.UTF8);
            }
        }
        catch
        {
            // logging must never crash the app
        }
    }
}
