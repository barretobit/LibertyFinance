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
    private readonly ToolStripStatusLabel _labelVersion;
    private readonly ToolStripStatusLabel _labelStatus = new() { Spring = true, TextAlign = System.Drawing.ContentAlignment.MiddleLeft };
    private readonly ToolStripButton _btnCheckUpdates = new("Check for Updates");
    private readonly ToolStripButton _btnOpenData = new("Open Data Folder");
    private bool _updating;

    public MainForm(AppConfig config, EmbeddedServer server)
    {
        _config = config;
        _server = server;
        _update = new UpdateService(config);
        _labelVersion = new ToolStripStatusLabel(GetVersion()) { ForeColor = Color.DimGray };

        Text = "Liberty Finance";
        Icon = CreateAppIcon(GetWebRoot());
        StartPosition = FormStartPosition.CenterScreen;
        WindowState = FormWindowState.Maximized;
        Size = new Size(1280, 820);
        MinimumSize = new Size(900, 600);
        BackColor = Color.Black;
        ForeColor = Color.White;

        _webView.Dock = DockStyle.Fill;
        Controls.Add(_webView);

        _labelStatus.Text = "Starting...";
        _labelStatus.ForeColor = Color.DimGray;
        _btnCheckUpdates.Click += OnCheckForUpdatesClick;
        _btnOpenData.Click += OnOpenDataClick;

        _statusStrip.Items.Add(_labelVersion);
        _statusStrip.Items.Add(_labelStatus);
        _statusStrip.Items.Add(_btnOpenData);
        _statusStrip.Items.Add(_btnCheckUpdates);
        _statusStrip.Dock = DockStyle.Bottom;
        _statusStrip.BackColor = Color.Black;
        _statusStrip.ForeColor = Color.DimGray;
        _statusStrip.SizingGrip = false;
        _statusStrip.Renderer = new ToolStripProfessionalRenderer(new DarkColorTable());

        StyleBarButton(_btnOpenData);
        StyleBarButton(_btnCheckUpdates);

        Controls.Add(_statusStrip);
        _statusStrip.BringToFront();
    }

    private static void StyleBarButton(ToolStripButton button)
    {
        button.ForeColor = Color.DimGray;
        button.Margin = new Padding(4, 1, 4, 1);
    }

    private string GetWebRoot()
    {
        return string.IsNullOrWhiteSpace(_config.WebRoot)
            ? Path.Combine(_config.DataRoot, "Web")
            : _config.WebRoot;
    }

    private string GetVersion()
    {
        try
        {
            var versionFile = Path.Combine(GetWebRoot(), "version.txt");
            if (File.Exists(versionFile))
            {
                var text = File.ReadAllText(versionFile).Trim();
                if (!string.IsNullOrEmpty(text)) return text;
            }
        }
        catch { }
        return "v1.0";
    }

    private static Icon CreateAppIcon(string webRoot)
    {
        try
        {
            var logoPath = Path.Combine(webRoot, "logo.png");
            if (File.Exists(logoPath))
            {
                using var logoBmp = new Bitmap(logoPath);
                if (logoBmp.Width > 0 && logoBmp.Height > 0)
                    return Icon.FromHandle(logoBmp.GetHicon());
            }
        }
        catch
        {
            // fall back to the drawn icon below
        }

        using var bmp = new Bitmap(256, 256);
        using var g = Graphics.FromImage(bmp);
        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;

        g.Clear(Color.FromArgb(8, 12, 8));

        using var penGreen = new Pen(Color.FromArgb(51, 255, 51), 4);
        using var penDimGreen = new Pen(Color.FromArgb(26, 122, 26), 2);
        g.DrawRectangle(penGreen, 12, 12, 232, 232);
        g.DrawRectangle(penDimGreen, 20, 20, 216, 216);

        g.DrawLine(penGreen, 12, 36, 12, 12);
        g.DrawLine(penGreen, 12, 12, 36, 12);
        g.DrawLine(penGreen, 244, 36, 244, 12);
        g.DrawLine(penGreen, 244, 12, 220, 12);
        g.DrawLine(penGreen, 12, 220, 12, 244);
        g.DrawLine(penGreen, 12, 244, 36, 244);
        g.DrawLine(penGreen, 244, 220, 244, 244);
        g.DrawLine(penGreen, 244, 244, 220, 244);

        using var trendPen = new Pen(Color.FromArgb(51, 255, 51), 5);
        g.DrawLines(trendPen, new Point[] {
            new(60, 160),
            new(100, 110),
            new(140, 130),
            new(200, 75)
        });
        using var brushGreen = new SolidBrush(Color.FromArgb(51, 255, 51));
        g.FillEllipse(brushGreen, 194, 69, 12, 12);

        using var font = new Font("Segoe UI", 72, FontStyle.Bold);
        using var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
        g.DrawString("LF", font, brushGreen, new RectangleF(0, 40, 256, 180), sf);

        var hIcon = bmp.GetHicon();
        return Icon.FromHandle(hIcon);
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

            _labelStatus.Text = "Backing up Data...";
            await Task.Run(() => BackupService.Run(_config));

            _labelStatus.Text = "Checking for Updates...";
            await _webView.EnsureCoreWebView2Async();

            var message = await _update.CheckAndUpdateAsync(_ => { });
            _labelStatus.Text = message ?? "Updated.";

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
            _labelStatus.Text = "Checking for Updates...";
            var message = await _update.CheckAndUpdateAsync(_ => { });
            _labelStatus.Text = message ?? "Updated.";

            if (message is not null && _webView.CoreWebView2 is not null)
                _webView.CoreWebView2.Navigate(_server.RootUrl);
        }
        catch (Exception ex)
        {
            _labelStatus.Text = "Update Failed: " + ex.Message;
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
