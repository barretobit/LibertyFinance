using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace LibertyFinance.Shell;

public sealed class EmbeddedServer : IDisposable
{
    private const int PreferredPort = 8765;

    private static readonly Dictionary<string, string> Mime = new(StringComparer.OrdinalIgnoreCase)
    {
        [".html"] = "text/html",
        [".css"] = "text/css",
        [".js"] = "application/javascript",
        [".json"] = "application/json",
        [".png"] = "image/png",
        [".jpg"] = "image/jpeg",
        [".gif"] = "image/gif",
        [".svg"] = "image/svg+xml",
        [".ttf"] = "font/ttf",
        [".woff"] = "font/woff",
        [".woff2"] = "font/woff2",
        [".ico"] = "image/x-icon",
    };

    private const string EmptyData =
        "{\"custodians\":[],\"portfolios\":[],\"accounts\":[],\"transactions\":[]," +
        "\"incomes\":[],\"expenses\":[],\"debts\":[],\"goals\":[]}";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    private readonly AppConfig _config;
    private readonly string _webRoot;
    private HttpListener? _listener;
    private CancellationTokenSource? _cts;

    public EmbeddedServer(AppConfig config)
    {
        _config = config;
        _webRoot = string.IsNullOrWhiteSpace(config.WebRoot)
            ? Path.Combine(config.DataRoot, "Web")
            : config.WebRoot;
    }

    public string RootUrl { get; private set; } = "";
    public int Port { get; private set; }

    public void Start()
    {
        _listener = new HttpListener();

        try
        {
            _listener.Prefixes.Add($"http://127.0.0.1:{PreferredPort}/");
            _listener.Start();
            Port = PreferredPort;
        }
        catch (HttpListenerException)
        {
            _listener.Close();
            _listener = new HttpListener();
            Port = FindFreePort();
            _listener.Prefixes.Add($"http://127.0.0.1:{Port}/");
            _listener.Start();
        }

        RootUrl = $"http://127.0.0.1:{Port}/";
        _cts = new CancellationTokenSource();
        _ = Task.Run(async () =>
        {
            try
            {
                await ListenLoop();
            }
            catch (Exception ex)
            {
                CrashLog.Write("Server loop: " + ex);
            }
        });
    }

    public void Stop()
    {
        _cts?.Cancel();
        try { _listener?.Stop(); } catch { }
        try { _listener?.Close(); } catch { }
    }

    public void Dispose() => Stop();

    private async Task ListenLoop()
    {
        while (_listener is { IsListening: true } && !_cts!.IsCancellationRequested)
        {
            HttpListenerContext ctx;
            try
            {
                ctx = await _listener.GetContextAsync();
            }
            catch (HttpListenerException)
            {
                if (_cts.IsCancellationRequested) break;
                continue;
            }
            catch (ObjectDisposedException)
            {
                break;
            }

            _ = Task.Run(() => Handle(ctx));
        }
    }

    private async Task Handle(HttpListenerContext ctx)
    {
        try
        {
            AddCorsHeaders(ctx.Response);

            if (ctx.Request.HttpMethod == "OPTIONS")
            {
                ctx.Response.StatusCode = 204;
                return;
            }

            var path = ctx.Request.Url!.AbsolutePath;

            if (path.Equals("/api/data", StringComparison.OrdinalIgnoreCase))
            {
                await HandleData(ctx);
                return;
            }

            if (path.Equals("/api/files", StringComparison.OrdinalIgnoreCase))
            {
                await HandleFiles(ctx);
                return;
            }

            await HandleStatic(ctx, path);
        }
        catch
        {
            try { ctx.Response.StatusCode = 500; } catch { }
        }
        finally
        {
            try { ctx.Response.Close(); } catch { }
        }
    }

    private async Task HandleData(HttpListenerContext ctx)
    {
        var dataFile = ResolveDataFile(GetFileParam(ctx));

        if (ctx.Request.HttpMethod == "GET")
        {
            if (File.Exists(dataFile))
            {
                var bytes = await File.ReadAllBytesAsync(dataFile);
                Write(ctx.Response, bytes, "application/json", 200);
            }
            else
            {
                Write(ctx.Response, Encoding.UTF8.GetBytes(EmptyData), "application/json", 200);
            }
            return;
        }

        if (ctx.Request.HttpMethod == "POST")
        {
            string body;
            using (var reader = new StreamReader(ctx.Request.InputStream, Encoding.UTF8))
            {
                body = await reader.ReadToEndAsync();
            }

            var dir = Path.GetDirectoryName(dataFile);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            await File.WriteAllTextAsync(dataFile, body, Encoding.UTF8);

            Write(ctx.Response, Encoding.UTF8.GetBytes("{\"success\":true}"), "application/json", 200);
            return;
        }

        Write(ctx.Response, null, null, 405);
    }

    private async Task HandleFiles(HttpListenerContext ctx)
    {
        var method = ctx.Request.HttpMethod;

        if (method == "GET")
        {
            var files = new List<DataFileInfo>();
            if (Directory.Exists(_config.DataRoot))
            {
                foreach (var filePath in Directory.GetFiles(_config.DataRoot, "*.json"))
                {
                    var info = new FileInfo(filePath);
                    files.Add(new DataFileInfo(info.Name, info.Length, info.LastWriteTimeUtc.ToString("o")));
                }
            }
            files.Sort((a, b) => string.CompareOrdinal(b.Modified, a.Modified));
            var json = JsonSerializer.Serialize(new { files }, JsonOptions);
            Write(ctx.Response, Encoding.UTF8.GetBytes(json), "application/json", 200);
            return;
        }

        if (method == "POST")
        {
            var dataFile = ResolveDataFile(GetFileParam(ctx));
            var dir = Path.GetDirectoryName(dataFile);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            if (!File.Exists(dataFile))
                await File.WriteAllTextAsync(dataFile, EmptyData, Encoding.UTF8);
            Write(ctx.Response, Encoding.UTF8.GetBytes("{\"success\":true}"), "application/json", 200);
            return;
        }

        if (method == "DELETE")
        {
            var dataFile = ResolveDataFile(GetFileParam(ctx));
            if (File.Exists(dataFile))
            {
                try { File.Delete(dataFile); } catch { /* best effort */ }
            }
            Write(ctx.Response, Encoding.UTF8.GetBytes("{\"success\":true}"), "application/json", 200);
            return;
        }

        Write(ctx.Response, null, null, 405);
    }

    private static string? GetFileParam(HttpListenerContext ctx)
    {
        var query = ctx.Request.Url?.Query;
        if (string.IsNullOrEmpty(query)) return null;

        foreach (var pair in query.TrimStart('?').Split('&'))
        {
            var eq = pair.IndexOf('=');
            if (eq <= 0) continue;
            if (pair[..eq].Equals("file", StringComparison.OrdinalIgnoreCase))
                return Uri.UnescapeDataString(pair[(eq + 1)..]);
        }
        return null;
    }

    private string ResolveDataFile(string? fileName)
    {
        if (string.IsNullOrWhiteSpace(fileName)) fileName = "liberty-finance.json";
        var safe = Path.GetFileName(fileName);
        if (!string.Equals(safe, fileName, StringComparison.Ordinal) ||
            !Path.GetExtension(safe).Equals(".json", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("Invalid data file name.");
        }
        return Path.Combine(_config.DataRoot, safe);
    }

    private async Task HandleStatic(HttpListenerContext ctx, string path)
    {
        var rel = path == "/" ? "index.html" : Uri.UnescapeDataString(path).TrimStart('/');
        var full = Path.GetFullPath(Path.Combine(_webRoot, rel));
        var root = Path.GetFullPath(_webRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;

        if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase))
        {
            Write(ctx.Response, null, null, 403);
            return;
        }

        if (!File.Exists(full))
        {
            Write(ctx.Response, null, null, 404);
            return;
        }

        var ext = Path.GetExtension(full);
        var mime = Mime.TryGetValue(ext, out var m) ? m : "application/octet-stream";
        var bytes = await File.ReadAllBytesAsync(full);
        Write(ctx.Response, bytes, mime, 200);
    }

    private static void Write(HttpListenerResponse response, byte[]? body, string? contentType, int statusCode)
    {
        response.StatusCode = statusCode;
        if (body is not null)
        {
            response.ContentType = contentType;
            response.ContentLength64 = body.Length;
            response.OutputStream.Write(body, 0, body.Length);
        }
    }

    private static void AddCorsHeaders(HttpListenerResponse response)
    {
        response.Headers["Access-Control-Allow-Origin"] = "*";
        response.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
        response.Headers["Access-Control-Allow-Headers"] = "Content-Type";
    }

    private static int FindFreePort()
    {
        using var tcp = new TcpListener(IPAddress.Loopback, 0);
        tcp.Start();
        var port = ((IPEndPoint)tcp.LocalEndpoint).Port;
        tcp.Stop();
        return port;
    }

    private sealed record DataFileInfo(string Name, long Size, string Modified);
}
