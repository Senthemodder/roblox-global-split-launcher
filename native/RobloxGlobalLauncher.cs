using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace RobloxGlobalSplit
{
    public class LauncherForm : Form
    {
        private Process backendProcess;
        private NotifyIcon trayIcon;
        private Label statusLabel;
        private TextBox logBox;
        private Button btnOpenUi;
        private Button btnLaunchRoblox;
        private Button btnRewireWarp;
        private Button btnExit;
        private bool isExiting = false;
        private readonly string appBaseDir;

        public LauncherForm()
        {
            appBaseDir = AppDomain.CurrentDomain.BaseDirectory;
            Text = "AG // ROBLOX GLOBAL SPLIT-TUNNEL & BOOTSTRAPPER";
            Size = new Size(660, 450);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(255, 255, 255);
            ForeColor = Color.FromArgb(10, 10, 10);
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            Icon = SystemIcons.Shield;

            Panel headerPanel = new Panel
            {
                Dock = DockStyle.Top,
                Height = 72,
                BackColor = Color.FromArgb(245, 245, 243),
                Padding = new Padding(18, 12, 18, 12)
            };

            Panel headerBottomLine = new Panel
            {
                Dock = DockStyle.Bottom,
                Height = 2,
                BackColor = Color.FromArgb(10, 10, 10)
            };
            headerPanel.Controls.Add(headerBottomLine);

            Label titleLabel = new Label
            {
                Text = "AG // ROBLOX GLOBAL SPLIT-TUNNEL ENGINE",
                Font = new Font("Consolas", 12F, FontStyle.Bold),
                ForeColor = Color.FromArgb(10, 10, 10),
                AutoSize = true,
                Location = new Point(18, 14)
            };

            statusLabel = new Label
            {
                Text = "STATUS: INITIALIZING DEFAULT-WIRED CLOUDFLARE WARP & SPLIT-PROXY...",
                Font = new Font("Consolas", 8.8F, FontStyle.Regular),
                ForeColor = Color.FromArgb(0, 82, 255),
                AutoSize = true,
                Location = new Point(18, 40)
            };

            headerPanel.Controls.Add(titleLabel);
            headerPanel.Controls.Add(statusLabel);
            Controls.Add(headerPanel);

            btnOpenUi = CreateSquareButton("OPEN CONTROL MATRIX", new Point(18, 88), new Size(192, 36), Color.FromArgb(10, 10, 10), Color.White, Color.FromArgb(10, 10, 10));
            btnOpenUi.Click += (s, e) => OpenControlCenterWindow();

            btnLaunchRoblox = CreateSquareButton("LAUNCH GLOBAL ROBLOX", new Point(218, 88), new Size(192, 36), Color.FromArgb(0, 82, 255), Color.White, Color.FromArgb(0, 82, 255));
            btnLaunchRoblox.Click += (s, e) => TriggerApiPost("/api/roblox/launch", "{}");

            btnRewireWarp = CreateSquareButton("RE-WIRE WARP TUNNEL", new Point(418, 88), new Size(204, 36), Color.White, Color.FromArgb(10, 10, 10), Color.FromArgb(10, 10, 10));
            btnRewireWarp.Click += (s, e) => TriggerApiPost("/api/upstreams/provision-warp", "{}");

            Controls.Add(btnOpenUi);
            Controls.Add(btnLaunchRoblox);
            Controls.Add(btnRewireWarp);

            logBox = new TextBox
            {
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Vertical,
                Location = new Point(18, 138),
                Size = new Size(604, 210),
                BackColor = Color.FromArgb(250, 250, 250),
                ForeColor = Color.FromArgb(10, 10, 10),
                BorderStyle = BorderStyle.FixedSingle,
                Font = new Font("Consolas", 9F, FontStyle.Regular)
            };
            Controls.Add(logBox);

            Button btnMinimizeTray = CreateSquareButton("MINIMIZE TO TRAY", new Point(18, 360), new Size(192, 34), Color.White, Color.FromArgb(10, 10, 10), Color.FromArgb(10, 10, 10));
            btnMinimizeTray.Click += (s, e) => HideToTray();

            btnExit = CreateSquareButton("STOP ENGINE & EXIT", new Point(430, 360), new Size(192, 34), Color.White, Color.FromArgb(200, 30, 30), Color.FromArgb(200, 30, 30));
            btnExit.Click += (s, e) => SafeExit();

            Controls.Add(btnMinimizeTray);
            Controls.Add(btnExit);

            ContextMenu trayMenu = new ContextMenu();
            trayMenu.MenuItems.Add("Open Control Matrix UI", (s, e) => { ShowFromTray(); OpenControlCenterWindow(); });
            trayMenu.MenuItems.Add("Show Engine Window", (s, e) => ShowFromTray());
            trayMenu.MenuItems.Add("Launch Global Roblox", (s, e) => TriggerApiPost("/api/roblox/launch", "{}"));
            trayMenu.MenuItems.Add("-");
            trayMenu.MenuItems.Add("Stop Split-Tunnel & Exit", (s, e) => SafeExit());

            trayIcon = new NotifyIcon
            {
                Text = "Roblox Global Split-Tunnel (Active)",
                Icon = SystemIcons.Shield,
                ContextMenu = trayMenu,
                Visible = true
            };
            trayIcon.DoubleClick += (s, e) => ShowFromTray();

            Shown += (s, e) => StartBackendEngine();
            FormClosing += OnFormClosing;
        }

        private Button CreateSquareButton(string text, Point location, Size size, Color backColor, Color foreColor, Color borderColor)
        {
            Button btn = new Button
            {
                Text = text,
                Location = location,
                Size = size,
                BackColor = backColor,
                ForeColor = foreColor,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Consolas", 9F, FontStyle.Bold),
                Cursor = Cursors.Hand
            };
            btn.FlatAppearance.BorderSize = 1;
            btn.FlatAppearance.BorderColor = borderColor;
            return btn;
        }

        private void AppendLog(string line)
        {
            if (IsDisposed) return;
            if (InvokeRequired)
            {
                BeginInvoke(new Action<string>(AppendLog), line);
                return;
            }
            logBox.AppendText("[" + DateTime.Now.ToString("HH:mm:ss") + "] " + line + Environment.NewLine);
        }

        private void StartBackendEngine()
        {
            try
            {
                string cliScript = Path.Combine(appBaseDir, "dist", "cli.js");
                if (!File.Exists(cliScript))
                {
                    AppendLog("ERROR: Missing dist\\cli.js in " + appBaseDir);
                    statusLabel.Text = "STATUS: MISSING DIST\\CLI.JS";
                    return;
                }

                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = "node.exe",
                    Arguments = "\"" + cliScript + "\" ui",
                    WorkingDirectory = appBaseDir,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };

                backendProcess = new Process { StartInfo = psi, EnableRaisingEvents = true };
                backendProcess.OutputDataReceived += (s, e) =>
                {
                    if (!string.IsNullOrEmpty(e.Data))
                    {
                        AppendLog(e.Data);
                        if (e.Data.Contains("Desktop Control Center UI"))
                        {
                            BeginInvoke(new Action(() =>
                            {
                                statusLabel.Text = "STATUS: WIRED // *.ROBLOX.COM TUNNELED | UDP GAMEPLAY DIRECT ISP";
                            }));
                        }
                    }
                };
                backendProcess.ErrorDataReceived += (s, e) =>
                {
                    if (!string.IsNullOrEmpty(e.Data))
                    {
                        AppendLog("WARN: " + e.Data);
                    }
                };

                backendProcess.Start();
                backendProcess.BeginOutputReadLine();
                backendProcess.BeginErrorReadLine();
                AppendLog("Started background Split-Tunnel & Bootstrapper engine (PID " + backendProcess.Id + ").");
            }
            catch (Exception ex)
            {
                AppendLog("Failed to start node.exe: " + ex.Message);
                statusLabel.Text = "STATUS: ENGINE ERROR";
            }
        }

        private void OpenControlCenterWindow()
        {
            try
            {
                string url = "http://127.0.0.1:7898";
                string edge32 = @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe";
                string edge64 = @"C:\Program Files\Microsoft\Edge\Application\msedge.exe";
                if (File.Exists(edge32))
                {
                    Process.Start(edge32, "--app=" + url + " --window-size=1280,840");
                }
                else if (File.Exists(edge64))
                {
                    Process.Start(edge64, "--app=" + url + " --window-size=1280,840");
                }
                else
                {
                    Process.Start(url);
                }
            }
            catch (Exception ex)
            {
                AppendLog("Could not open browser window: " + ex.Message);
            }
        }

        private void TriggerApiPost(string path, string jsonBody)
        {
            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:7898" + path);
                    req.Method = "POST";
                    req.ContentType = "application/json";
                    byte[] bytes = Encoding.UTF8.GetBytes(jsonBody);
                    req.ContentLength = bytes.Length;
                    using (Stream reqStream = req.GetRequestStream())
                    {
                        reqStream.Write(bytes, 0, bytes.Length);
                    }
                    using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                    using (StreamReader reader = new StreamReader(resp.GetResponseStream()))
                    {
                        string text = reader.ReadToEnd();
                        AppendLog("API " + path + " -> " + text.Replace("\r", "").Replace("\n", " "));
                    }
                }
                catch (Exception ex)
                {
                    AppendLog("API action note: " + ex.Message);
                }
            });
        }

        private void HideToTray()
        {
            Hide();
            trayIcon.ShowBalloonTip(2000, "Roblox Global Split-Tunnel", "Running in background. Double-click the shield icon to restore.", ToolTipIcon.Info);
        }

        private void ShowFromTray()
        {
            Show();
            WindowState = FormWindowState.Normal;
            Activate();
        }

        private void ClearWindowsPacRegistry()
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Internet Settings", true))
                {
                    if (key != null && key.GetValue("AutoConfigURL") != null)
                    {
                        key.DeleteValue("AutoConfigURL", false);
                    }
                }
            }
            catch
            {
            }
        }

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            if (!isExiting && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                HideToTray();
                return;
            }
            CleanupProcesses();
        }

        private void CleanupProcesses()
        {
            ClearWindowsPacRegistry();
            try
            {
                if (backendProcess != null && !backendProcess.HasExited)
                {
                    backendProcess.Kill();
                }
                foreach (Process sb in Process.GetProcessesByName("sing-box"))
                {
                    sb.Kill();
                }
            }
            catch
            {
            }
            if (trayIcon != null)
            {
                trayIcon.Visible = false;
                trayIcon.Dispose();
            }
        }

        private void SafeExit()
        {
            isExiting = true;
            CleanupProcesses();
            Application.Exit();
        }

        [STAThread]
        public static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new LauncherForm());
        }
    }
}
