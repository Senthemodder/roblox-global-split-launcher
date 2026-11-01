using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

namespace RobloxGlobalSplitSetup
{
    public class SetupWizardForm : Form
    {
        private TextBox txtInstallDir;
        private CheckBox chkDesktopShortcut;
        private CheckBox chkStartMenuShortcut;
        private CheckBox chkLaunchAfter;
        private ProgressBar progressBar;
        private Label statusLabel;
        private Button btnInstall;
        private Button btnCancel;

        public SetupWizardForm()
        {
            Text = "Roblox Global Split-Tunnel & Bootstrapper Setup (v1.0.0)";
            Size = new Size(580, 410);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(11, 15, 25);
            ForeColor = Color.FromArgb(241, 245, 249);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            Icon = SystemIcons.Shield;

            Panel banner = new Panel
            {
                Dock = DockStyle.Top,
                Height = 76,
                BackColor = Color.FromArgb(19, 27, 46)
            };

            Label lblTitle = new Label
            {
                Text = "ROBLOX GLOBAL SPLIT-TUNNEL INSTALLER",
                Font = new Font("Segoe UI", 13F, FontStyle.Bold),
                ForeColor = Color.FromArgb(56, 189, 248),
                AutoSize = true,
                Location = new Point(20, 14)
            };

            Label lblSub = new Label
            {
                Text = "Installs the Default-Wired Split-Tunnel Proxy, Sing-Box Core & Global Bootstrapper",
                Font = new Font("Segoe UI", 9.2F, FontStyle.Regular),
                ForeColor = Color.FromArgb(148, 163, 184),
                AutoSize = true,
                Location = new Point(20, 42)
            };

            banner.Controls.Add(lblTitle);
            banner.Controls.Add(lblSub);
            Controls.Add(banner);

            Label lblDir = new Label
            {
                Text = "Installation Folder:",
                Font = new Font("Segoe UI", 9.5F, FontStyle.Bold),
                AutoSize = true,
                Location = new Point(22, 94)
            };
            Controls.Add(lblDir);

            string defaultDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs",
                "RobloxGlobalSplitLauncher"
            );

            txtInstallDir = new TextBox
            {
                Text = defaultDir,
                Location = new Point(22, 118),
                Size = new Size(430, 26),
                BackColor = Color.FromArgb(6, 9, 17),
                ForeColor = Color.White,
                BorderStyle = BorderStyle.FixedSingle,
                Font = new Font("Segoe UI", 9.5F)
            };
            Controls.Add(txtInstallDir);

            Button btnBrowse = new Button
            {
                Text = "Browse...",
                Location = new Point(460, 116),
                Size = new Size(86, 27),
                BackColor = Color.FromArgb(38, 50, 76),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat
            };
            btnBrowse.FlatAppearance.BorderSize = 0;
            btnBrowse.Click += (s, e) =>
            {
                using (FolderBrowserDialog fbd = new FolderBrowserDialog())
                {
                    fbd.SelectedPath = txtInstallDir.Text;
                    if (fbd.ShowDialog() == DialogResult.OK)
                    {
                        txtInstallDir.Text = fbd.SelectedPath;
                    }
                }
            };
            Controls.Add(btnBrowse);

            chkDesktopShortcut = new CheckBox
            {
                Text = "Create Desktop Shortcut (Roblox Global Split-Tunnel)",
                Checked = true,
                AutoSize = true,
                Location = new Point(22, 162),
                Font = new Font("Segoe UI", 9.5F)
            };
            Controls.Add(chkDesktopShortcut);

            chkStartMenuShortcut = new CheckBox
            {
                Text = "Create Start Menu Program Shortcut",
                Checked = true,
                AutoSize = true,
                Location = new Point(22, 192),
                Font = new Font("Segoe UI", 9.5F)
            };
            Controls.Add(chkStartMenuShortcut);

            chkLaunchAfter = new CheckBox
            {
                Text = "Launch Roblox Global Split-Tunnel immediately after setup",
                Checked = true,
                AutoSize = true,
                Location = new Point(22, 222),
                Font = new Font("Segoe UI", 9.5F),
                ForeColor = Color.FromArgb(52, 211, 153)
            };
            Controls.Add(chkLaunchAfter);

            statusLabel = new Label
            {
                Text = "Ready to install.",
                AutoSize = true,
                Location = new Point(22, 264),
                ForeColor = Color.FromArgb(148, 163, 184),
                Font = new Font("Segoe UI", 9F)
            };
            Controls.Add(statusLabel);

            progressBar = new ProgressBar
            {
                Location = new Point(22, 288),
                Size = new Size(524, 20),
                Style = ProgressBarStyle.Continuous
            };
            Controls.Add(progressBar);

            btnInstall = new Button
            {
                Text = "Install Now",
                Location = new Point(316, 326),
                Size = new Size(130, 36),
                BackColor = Color.FromArgb(16, 185, 129),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 10F, FontStyle.Bold),
                Cursor = Cursors.Hand
            };
            btnInstall.FlatAppearance.BorderSize = 0;
            btnInstall.Click += (s, e) => RunInteractiveInstall();
            Controls.Add(btnInstall);

            btnCancel = new Button
            {
                Text = "Cancel",
                Location = new Point(456, 326),
                Size = new Size(90, 36),
                BackColor = Color.FromArgb(30, 41, 59),
                ForeColor = Color.FromArgb(203, 213, 225),
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 9.5F)
            };
            btnCancel.FlatAppearance.BorderSize = 0;
            btnCancel.Click += (s, e) => Close();
            Controls.Add(btnCancel);
        }

        private void RunInteractiveInstall()
        {
            btnInstall.Enabled = false;
            string targetDir = txtInstallDir.Text.Trim();
            bool makeDesktop = chkDesktopShortcut.Checked;
            bool makeStartMenu = chkStartMenuShortcut.Checked;
            bool launchNow = chkLaunchAfter.Checked;

            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    ExtractEmbeddedPayload(targetDir, (pct, msg) =>
                    {
                        BeginInvoke(new Action(() =>
                        {
                            progressBar.Value = Math.Min(100, Math.Max(0, pct));
                            statusLabel.Text = msg;
                        }));
                    });

                    string exePath = Path.Combine(targetDir, "RobloxGlobalLauncher.exe");
                    if (makeDesktop)
                    {
                        string desktopDir = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                        CreateShortcut(Path.Combine(desktopDir, "Roblox Global Split-Tunnel.lnk"), exePath, targetDir);
                    }
                    if (makeStartMenu)
                    {
                        string startMenuDir = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
                        CreateShortcut(Path.Combine(startMenuDir, "Roblox Global Split-Tunnel.lnk"), exePath, targetDir);
                    }

                    BeginInvoke(new Action(() =>
                    {
                        progressBar.Value = 100;
                        statusLabel.Text = "Installation complete!";
                        if (launchNow && File.Exists(exePath))
                        {
                            Process.Start(new ProcessStartInfo
                            {
                                FileName = exePath,
                                WorkingDirectory = targetDir,
                                UseShellExecute = true
                            });
                        }
                        MessageBox.Show(
                            "Roblox Global Split-Tunnel & Bootstrapper has been installed to:\n" + targetDir,
                            "Setup Complete",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Information
                        );
                        Close();
                    }));
                }
                catch (Exception ex)
                {
                    BeginInvoke(new Action(() =>
                    {
                        btnInstall.Enabled = true;
                        statusLabel.Text = "Error: " + ex.Message;
                        MessageBox.Show("Installation failed: " + ex.Message, "Setup Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    }));
                }
            });
        }

        public static void ExtractEmbeddedPayload(string targetDir, Action<int, string> onProgress)
        {
            Directory.CreateDirectory(targetDir);
            Assembly asm = Assembly.GetExecutingAssembly();
            using (Stream resStream = asm.GetManifestResourceStream("RobloxGlobalSplit.payload.zip"))
            {
                if (resStream == null)
                {
                    throw new InvalidOperationException("Embedded payload.zip resource not found in installer binary.");
                }
                using (ZipArchive archive = new ZipArchive(resStream, ZipArchiveMode.Read))
                {
                    int total = archive.Entries.Count;
                    int index = 0;
                    foreach (ZipArchiveEntry entry in archive.Entries)
                    {
                        index++;
                        string fullPath = Path.Combine(targetDir, entry.FullName.Replace('/', Path.DirectorySeparatorChar));
                        if (string.IsNullOrEmpty(entry.Name))
                        {
                            Directory.CreateDirectory(fullPath);
                            continue;
                        }
                        string parentDir = Path.GetDirectoryName(fullPath);
                        if (!string.IsNullOrEmpty(parentDir))
                        {
                            Directory.CreateDirectory(parentDir);
                        }
                        entry.ExtractToFile(fullPath, true);
                        if (onProgress != null && (index % 5 == 0 || index == total))
                        {
                            int pct = total > 0 ? (index * 100) / total : 100;
                            onProgress(pct, "Extracting (" + index + "/" + total + "): " + entry.Name);
                        }
                    }
                }
            }
        }

        public static void CreateShortcut(string shortcutPath, string targetExe, string workingDir)
        {
            try
            {
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                if (shellType == null) return;
                object shell = Activator.CreateInstance(shellType);
                object shortcut = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { shortcutPath });
                Type scType = shortcut.GetType();
                scType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { targetExe });
                scType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { workingDir });
                scType.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { "Roblox Global Split-Tunnel & Bootstrapper" });
                scType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
            }
            catch
            {
            }
        }

        [STAThread]
        public static int Main(string[] args)
        {
            bool silent = false;
            string customDir = null;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--silent" || args[i] == "/S")
                {
                    silent = true;
                }
                else if (args[i].StartsWith("--dir="))
                {
                    customDir = args[i].Substring("--dir=".Length).Trim('"');
                }
            }

            if (silent)
            {
                string target = customDir ?? Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "Programs",
                    "RobloxGlobalSplitLauncher"
                );
                ExtractEmbeddedPayload(target, null);
                Console.WriteLine("Installed silently to: " + target);
                return 0;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupWizardForm());
            return 0;
        }
    }
}
