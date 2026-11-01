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
            Text = "Roblox Global Split-Tunnel & Bootstrapper";
            Size = new Size(640, 440);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(11, 15, 25);
            ForeColor = Color.FromArgb(241, 245, 249);
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            Icon = SystemIcons.Shield;

            Panel headerPanel = new Panel
            {
                Dock = DockStyle.Top,
                Height = 68,
                BackColor = Color.FromArgb(19, 27, 46),
                Padding = new Padding(18, 12, 18, 12)
            };

            Label titleLabel = new Label
            {
                Text = "ROBLOX GLOBAL SPLIT-TUNNEL ENGINE",
                Font = new Font("Segoe UI", 13F, FontStyle.Bold),
                ForeColor = Color.FromArgb(56, 189, 248),
                AutoSize = true,
                Location = new Point(18, 12)
            };

            statusLabel = new Label
            {
                Text = "Initializing default-wired Cloudflare WARP & Split-Tunnel Proxy...",
                Font = new Font("Segoe UI", 9.5F, FontStyle.Regular),
                ForeColor = Color.FromArgb(52, 211, 153),
                AutoSize = true,
                Location = new Point(18, 38)
            };

            headerPanel.Controls.Add(titleLabel);
            headerPanel.Controls.Add(statusLabel);
            Controls.Add(headerPanel);

            btnOpenUi = CreateStyledButton("Open Control Center UI", new Point(18, 84), new Size(185, 38), Color.FromArgb(56, 189, 248), Color.FromArgb(9, 13, 22));
            btnOpenUi.Click += (s, e) => OpenControlCenterWindow();

            btnLaunchRoblox = CreateStyledButton("Launch Global Roblox", new Point(213, 84), new Size(185, 38), Color.FromArgb(16, 185, 129), Color.White);
            btnLaunchRoblox.Click += (s, e) => TriggerApiPost("/api/roblox/launch", "{}");

            btnRewireWarp = CreateStyledButton("Re-Wire WARP Tunnel", new Point(408, 84), new Size(195, 38), Color.FromArgb(38, 50, 76), Color.White);
            btnRewireWarp.Click += (s, e) => TriggerApiPost("/api/upstreams/provision-warp", "{}");

            Controls.Add(btnOpenUi);
            Controls.Add(btnLaunchRoblox);
            Controls.Add(btnRewireWarp);

            logBox = new TextBox
            {
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Vertical,
                Location = new Point(18, 136),
                Size = new Size(585, 205),
                BackColor = Color.FromArgb(6, 9, 17),
                ForeColor = Color.FromArgb(186, 230, 253),
                BorderStyle = BorderStyle.FixedSingle,
                Font = new Font("Consolas", 9.5F, FontStyle.Regular)
            };
            Controls.Add(logBox);

            Button btnMinimizeTray = CreateStyledButton("Minimize to System Tray", new Point(18, 352), new Size(200, 34), Color.FromArgb(30, 41, 59), Color.FromArgb(203, 213, 225));
            btnMinimizeTray.Click += (s, e) => HideToTray();

            btnExit = CreateStyledButton("Stop Split-Tunnel & Exit", new Point(403, 352), new Size(200, 34), Color.FromArgb(159, 18, 57), Color.White);
            btnExit.Click += (s, e) => SafeExit();

            Controls.Add(btnMinimizeTray);
            Controls.Add(btnExit);

            ContextMenu trayMenu = new ContextMenu();
            trayMenu.MenuItems.Add("Open Control Center UI", (s, e) => { ShowFromTray(); OpenControlCenterWindow(); });
            trayMenu.MenuItems.Add("Show Engine Console", (s, e) => ShowFromTray());
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

        private Button CreateStyledButton(string text, Point location, Size size, Color backColor, Color foreColor)
        {
            Button btn = new Button
            {
                Text = text,
                Location = location,
                Size = size,
                BackColor = backColor,
                ForeColor = foreColor,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 9.5F, FontStyle.Bold),
                Cursor = Cursors.Hand
            };
            btn.FlatAppearance.BorderSize = 0;
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
                    AppendLog("ERROR: Could not find dist\\cli.js in " + appBaseDir);
                    statusLabel.Text = "Missing dist\\cli.js";
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
                                statusLabel.Text = "Wired & Protected: *.roblox.com Tunneled | UDP Gameplay Direct ISP";
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
                statusLabel.Text = "Error starting engine";
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
                    Process.Start(edge32, "--app=" + url + " --window-size=1220,820");
                }
                else if (File.Exists(edge64))
                {
                    Process.Start(edge64, "--app=" + url + " --window-size=1220,820");
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
