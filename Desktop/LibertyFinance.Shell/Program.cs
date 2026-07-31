namespace LibertyFinance.Shell;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            CrashLog.Write("Unhandled: " + (e.ExceptionObject as Exception)?.ToString());
        Application.ThreadException += (_, e) =>
            CrashLog.Write("Thread: " + e.Exception);
        TaskScheduler.UnobservedTaskException += (_, e) =>
        {
            CrashLog.Write("Task: " + e.Exception);
            e.SetObserved();
        };

        var config = AppConfig.Load();
        CrashLog.Configure(config.DataRoot);

        try
        {
            Directory.CreateDirectory(config.DataRoot);
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "Could not create the data folder:\n" + config.DataRoot + "\n\n" + ex.Message,
                "Liberty Finance",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        var server = new EmbeddedServer(config);
        try
        {
            server.Start();
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "Could not start the local server:\n\n" + ex.Message,
                "Liberty Finance",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        Application.Run(new MainForm(config, server));
        server.Stop();
    }
}
