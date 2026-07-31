using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace LibertyFinance.Shell;

public sealed class MainForm : Form
{
    private readonly AppConfig _config;
    private readonly EmbeddedServer _server;
    private readonly UpdateService _update;

    private readonly WebView2 _webView = new();
    private readonly StatusStrip _statusStrip = new();
    private readonly ToolStripStatusLabel _labelStatus = new() { Spring = true, TextAlign = System.Drawing.ContentAlignment.MiddleLeft };
    private readonly ToolStripButton _btnCheckUpdates = new("Check for updates");
    private readonly ToolStripButton _btnOpenData = new("Open data folder");
    private bool _updating;

    public MainForm(AppConfig config, EmbeddedServer server)
    {
        _config = config;
        _server = server;
        _update = new UpdateService(config);

        Text = "Liberty Finance";
        StartPosition = FormStartPosition.CenterScreen;
        WindowState = FormWindowState.Maximized;
        Size = new Size(1280, 820);
        MinimumSize = new Size(900, 600);
        BackColor = Color.Black;
        ForeColor = Color.White;

        _webView.Dock = DockStyle.Fill;
        Controls.Add(_webView);

        _labelStatus.Text = "Starting...";
        _labelStatus.ForeColor = Color.Lime;
        _btnCheckUpdates.Click += OnCheckForUpdatesClick;
        _btnOpenData.Click += OnOpenDataClick;

        _statusStrip.Items.Add(_labelStatus);
        _statusStrip.Items.Add(_btnOpenData);
        _statusStrip.Items.Add(_btnCheckUpdates);
        _statusStrip.Dock = DockStyle.Bottom;
        _statusStrip.BackColor = Color.Black;
        _statusStrip.ForeColor = Color.Lime;
        _statusStrip.SizingGrip = false;
        _statusStrip.Renderer = new ToolStripProfessionalRenderer(new DarkColorTable());

        StyleBarButton(_btnOpenData);
        StyleBarButton(_btnCheckUpdates);

        Controls.Add(_statusStrip);
        _statusStrip.BringToFront();
    }

    private static void StyleBarButton(ToolStripButton button)
    {
        button.ForeColor = Color.Lime;
        button.Margin = new Padding(4, 1, 4, 1);
    }

    private sealed class DarkColorTable : ProfessionalColorTable
    {
        public override Color ToolStripGradientBegin => Color.Black;
        public override Color ToolStripGradientMiddle => Color.Black;
        public override Color ToolStripGradientEnd => Color.Black;
        public override Color StatusStripGradientBegin => Color.Black;
        public override Color StatusStripGradientEnd => Color.Black;
        public override Color ButtonSelectedGradientBegin => Color.FromArgb(32, 32, 32);
        public override Color ButtonSelectedGradientMiddle => Color.FromArgb(32, 32, 32);
        public override Color ButtonSelectedGradientEnd => Color.FromArgb(32, 32, 32);
        public override Color ButtonSelectedBorder => Color.FromArgb(0, 128, 0);
        public override Color ButtonPressedGradientBegin => Color.FromArgb(0, 64, 0);
        public override Color ButtonPressedGradientMiddle => Color.FromArgb(0, 64, 0);
        public override Color ButtonPressedGradientEnd => Color.FromArgb(0, 64, 0);
        public override Color ButtonPressedBorder => Color.FromArgb(0, 128, 0);
        public override Color SeparatorDark => Color.FromArgb(0, 64, 0);
        public override Color SeparatorLight => Color.FromArgb(0, 64, 0);
    }

    private void ApplyDarkTitleBar()
    {
        if (Environment.OSVersion.Version.Major < 10) return;
        try
        {
            var hWnd = Handle;
            var value = 1;
            NativeMethods.DwmSetWindowAttribute(
                hWnd,
                NativeMethods.DWMWA_USE_IMMERSIVE_DARK_MODE,
                ref value,
                Marshal.SizeOf<int>());
        }
        catch
        {
            // title bar theming is best-effort
        }
    }

    private static class NativeMethods
    {
        public const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;

        [DllImport("dwmapi.dll")]
        public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        ApplyDarkTitleBar();
    }

    protected override async void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        await InitializeAsync();
    }

    private async Task InitializeAsync()
    {
        try
        {
            await EnsureWebView2Runtime();

            _labelStatus.Text = "Backing up data...";
            await Task.Run(() => BackupService.Run(_config));

            _labelStatus.Text = "Checking for updates...";
            await _webView.EnsureCoreWebView2Async();

            var message = await _update.CheckAndUpdateAsync(_ => { });
            _labelStatus.Text = message ?? "Up to date.";

            _webView.CoreWebView2.Navigate(_server.RootUrl);
        }
        catch (Exception ex)
        {
            _labelStatus.Text = "Error: " + ex.Message;
        }
    }

    private async void OnCheckForUpdatesClick(object? sender, EventArgs e)
    {
        if (_updating) return;
        _updating = true;
        _btnCheckUpdates.Enabled = false;

        try
        {
            _labelStatus.Text = "Checking for updates...";
            var message = await _update.CheckAndUpdateAsync(_ => { });
            _labelStatus.Text = message ?? "Up to date.";

            if (message is not null && _webView.CoreWebView2 is not null)
                _webView.CoreWebView2.Navigate(_server.RootUrl);
        }
        catch (Exception ex)
        {
            _labelStatus.Text = "Update failed: " + ex.Message;
        }
        finally
        {
            _updating = false;
            _btnCheckUpdates.Enabled = true;
        }
    }

    private void OnOpenDataClick(object? sender, EventArgs e)
    {
        try
        {
            Directory.CreateDirectory(_config.DataRoot);
            Process.Start(new ProcessStartInfo(_config.DataRoot) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            _labelStatus.Text = "Could not open data folder: " + ex.Message;
        }
    }

    private async Task EnsureWebView2Runtime()
    {        string? version;
        try
        {
            version = CoreWebView2Environment.GetAvailableBrowserVersionString();
        }
        catch
        {
            version = null;
        }

        if (version is not null) return;

        var result = MessageBox.Show(
            "The Microsoft Edge WebView2 Runtime is required to run Liberty Finance.\n\n" +
            "Install it now?",
            "WebView2 Runtime required",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Question);

        if (result == DialogResult.Yes)
        {
            try
            {
                Process.Start(new ProcessStartInfo("https://developer.microsoft.com/en-us/microsoft-edge/webview2/")
                {
                    UseShellExecute = true
                });
            }
            catch
            {
                // ignore; user can install manually
            }
        }
    }
}
