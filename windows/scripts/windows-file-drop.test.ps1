# SPDX-License-Identifier: MIT
param([int]$AppProcessId = 0, [switch]$ShellDragImage)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, UIAutomationClient, UIAutomationTypes

# Exercise real OLE drag/drop into the running WebView2 app, rather than emitting
# a frontend event. Only a synthetic file is dragged; nothing is sent to an AI.
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing, UIAutomationClient, UIAutomationTypes @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
using System.Collections.Generic;
using ComData = System.Runtime.InteropServices.ComTypes.IDataObject;
using Format = System.Runtime.InteropServices.ComTypes.FORMATETC;
using Medium = System.Runtime.InteropServices.ComTypes.STGMEDIUM;
using Tymed = System.Runtime.InteropServices.ComTypes.TYMED;

// WinForms rejects the Shell's private drag-image formats. Retain those native
// media while delegating the ordinary CF_HDROP data to its existing data object.
[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
public sealed class ShellFileData : ComData, IDisposable {
    readonly ComData files;
    readonly Dictionary<short, Medium> media = new Dictionary<short, Medium>();
    [DllImport("ole32.dll")] static extern void ReleaseStgMedium(ref Medium medium);
    [DllImport("ole32.dll")] static extern IntPtr OleDuplicateData(IntPtr handle, ushort format, uint flags);
    public ShellFileData(string path) { files = (ComData)new DataObject(DataFormats.FileDrop, new string[] { path }); }
    static Medium Clone(Medium value, short format) {
        if (value.tymed != Tymed.TYMED_HGLOBAL) throw new NotSupportedException("Shell check expects global-memory drag formats.");
        var copy = new Medium { tymed = value.tymed, unionmember = OleDuplicateData(value.unionmember, (ushort)format, 0) };
        if (copy.unionmember == IntPtr.Zero) throw new Exception("Cannot clone the Shell drag data.");
        return copy;
    }
    public void GetData(ref Format format, out Medium value) {
        Medium stored;
        if (media.TryGetValue(format.cfFormat, out stored)) value = Clone(stored, format.cfFormat);
        else files.GetData(ref format, out value);
    }
    public void GetDataHere(ref Format format, ref Medium value) { files.GetDataHere(ref format, ref value); }
    public int QueryGetData(ref Format format) { return media.ContainsKey(format.cfFormat) ? 0 : files.QueryGetData(ref format); }
    public int GetCanonicalFormatEtc(ref Format input, out Format output) { return files.GetCanonicalFormatEtc(ref input, out output); }
    public void SetData(ref Format format, ref Medium value, bool release) {
        Medium old;
        if (media.TryGetValue(format.cfFormat, out old)) ReleaseStgMedium(ref old);
        media[format.cfFormat] = release ? value : Clone(value, format.cfFormat);
    }
    public System.Runtime.InteropServices.ComTypes.IEnumFORMATETC EnumFormatEtc(System.Runtime.InteropServices.ComTypes.DATADIR direction) { return files.EnumFormatEtc(direction); }
    public int DAdvise(ref Format format, System.Runtime.InteropServices.ComTypes.ADVF flags, System.Runtime.InteropServices.ComTypes.IAdviseSink sink, out int connection) { connection = 0; return unchecked((int)0x80040003); }
    public void DUnadvise(int connection) { }
    public int EnumDAdvise(out System.Runtime.InteropServices.ComTypes.IEnumSTATDATA enumerator) { enumerator = null; return unchecked((int)0x80040003); }
    public void Dispose() { foreach (var item in media) { var value = item.Value; ReleaseStgMedium(ref value); } media.Clear(); }
}
[ComImport, Guid("00000121-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface NativeDropSource {
    [PreserveSig] int QueryContinueDrag([MarshalAs(UnmanagedType.Bool)] bool escape, uint keys);
    [PreserveSig] int GiveFeedback(uint effect);
}
[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
public sealed class FileDragSource : NativeDropSource {
    public int QueryContinueDrag(bool escape, uint keys) { return escape ? 0x40101 : (keys & 1) == 0 ? 0x40100 : 0; }
    public int GiveFeedback(uint effect) { return 0x40102; }
}

[StructLayout(LayoutKind.Sequential)] public struct DragImage {
    public int Width, Height;
    public MimoNativeDrop.Point Offset;
    public IntPtr Bitmap;
    public uint ColorKey;
}
[ComImport, Guid("DE5BF786-477A-11D2-839D-00C04FD918D0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ShellDragSource {
    void InitializeFromBitmap(ref DragImage image, System.Runtime.InteropServices.ComTypes.IDataObject data);
    void InitializeFromWindow(IntPtr window, ref MimoNativeDrop.Point point, System.Runtime.InteropServices.ComTypes.IDataObject data);
}
[ComImport, Guid("4657278B-411B-11D2-839A-00C04FD918D0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ShellDropTarget {
    void DragEnter(IntPtr window, System.Runtime.InteropServices.ComTypes.IDataObject data, ref MimoNativeDrop.Point point, uint effect);
    void DragLeave();
    void DragOver(ref MimoNativeDrop.Point point, uint effect);
    void Drop(System.Runtime.InteropServices.ComTypes.IDataObject data, ref MimoNativeDrop.Point point, uint effect);
    void Show([MarshalAs(UnmanagedType.Bool)] bool show);
}

public static class MimoNativeDrop {
    public delegate bool WindowCallback(IntPtr window, IntPtr parameter);
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rectangle);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flag);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr handle);
    [DllImport("ole32.dll")] static extern int DoDragDrop(ComData data, NativeDropSource source, uint allowed, out uint effect);
    public static bool HeldPreview = false;

    static bool PreviewVisible(IntPtr window) {
        var root = System.Windows.Automation.AutomationElement.FromHandle(window);
        var image = root.FindFirst(System.Windows.Automation.TreeScope.Descendants,
            new System.Windows.Automation.PropertyCondition(System.Windows.Automation.AutomationElement.NameProperty, "Drop a file for Mimo"));
        return image != null && !image.Current.IsOffscreen;
    }

    public static IntPtr Find(uint process) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((window, argument) => {
            uint owner; GetWindowThreadProcessId(window, out owner);
            var title = new StringBuilder(100); GetWindowText(window, title, title.Capacity);
            if (owner == process && title.ToString() == "Mimo") found = window;
            return true;
        }, IntPtr.Zero);
        if (found == IntPtr.Zero) throw new Exception("Start the Mimo app before running this check.");
        return found;
    }

    public static string Drag(uint process, string path, bool shellImage) {
        SetThreadDpiAwarenessContext(new IntPtr(-4));
        var island = Find(process);
        Point original; GetCursorPos(out original);
        DragDropEffects result = DragDropEffects.None;
        Exception failure = null;
        System.Drawing.Point sourcePoint = new System.Drawing.Point();
        IntPtr sourceHandle = IntPtr.Zero;
        using (var ready = new System.Threading.ManualResetEvent(false)) {
            var worker = new System.Threading.Thread(() => {
                try {
                    SetThreadDpiAwarenessContext(new IntPtr(-4));
                    using (var source = new Form()) {
                        source.Text = "Mimo synthetic file drop check";
                        source.Size = new Size(300, 100);
                        source.TopMost = true;
                        source.StartPosition = FormStartPosition.Manual;
                        var area = Screen.FromHandle(island).WorkingArea;
                        source.Location = new System.Drawing.Point(area.Left + 30, area.Top + Math.Min(450, area.Height / 2));
                        source.Shown += (sender, args) => {
                            sourcePoint = source.PointToScreen(new System.Drawing.Point(40, 20));
                            sourceHandle = source.Handle;
                            source.BeginInvoke((Action)(() => ready.Set()));
                        };
                        source.MouseDown += (sender, args) => {
                            try {
                            Console.WriteLine("The synthetic source received the mouse press.");
                            object helper = null;
                            using (var data = new ShellFileData(path)) {
                            try {
                                if (shellImage) {
                                    helper = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("4657278A-411B-11D2-839A-00C04FD918D0")));
                                    using (var bitmap = new Bitmap(32, 32)) {
                                        using (var paint = Graphics.FromImage(bitmap)) paint.Clear(Color.CornflowerBlue);
                                        var image = new DragImage { Width = 32, Height = 32, Offset = new Point { X = 8, Y = 8 }, Bitmap = bitmap.GetHbitmap(), ColorKey = 0xffffffff };
                                        try { ((ShellDragSource)helper).InitializeFromBitmap(ref image, (System.Runtime.InteropServices.ComTypes.IDataObject)data); }
                                        finally { DeleteObject(image.Bitmap); }
                                    }
                                    var point = new Point { X = sourcePoint.X, Y = sourcePoint.Y };
                                    ((ShellDropTarget)helper).DragEnter(source.Handle, (System.Runtime.InteropServices.ComTypes.IDataObject)data, ref point, 1);
                                }
                                Application.OleRequired();
                                uint effect;
                                var status = DoDragDrop(data, new FileDragSource(), 1, out effect);
                                if (status < 0) Marshal.ThrowExceptionForHR(status);
                                result = (DragDropEffects)effect;
                            } finally {
                                if (helper != null) { ((ShellDropTarget)helper).DragLeave(); Marshal.ReleaseComObject(helper); }
                            }
                            }
                            Console.WriteLine("Native drag returned " + result + ".");
                            source.Close();
                            } catch (Exception error) { failure = error; source.Close(); }
                        };
                        Application.Run(source);
                    }
                } catch (Exception error) { failure = error; ready.Set(); }
            });
            worker.SetApartmentState(System.Threading.ApartmentState.STA);
            worker.IsBackground = true;
            worker.Start();
            try {
                if (!ready.WaitOne(5000)) throw new Exception("The synthetic drag source did not open.");
                if (failure != null) throw failure;
                if (!SetCursorPos(sourcePoint.X, sourcePoint.Y)) throw new Exception("This session cannot move the desktop pointer.");
                for (int wait = 0; wait < 20 && GetAncestor(WindowFromPoint(new Point { X = sourcePoint.X, Y = sourcePoint.Y }), 2) != sourceHandle; wait++)
                    System.Threading.Thread.Sleep(50);
                if (GetAncestor(WindowFromPoint(new Point { X = sourcePoint.X, Y = sourcePoint.Y }), 2) != sourceHandle)
                    throw new Exception("The test source is obscured on this desktop.");
                mouse_event(2, 0, 0, 0, UIntPtr.Zero);
                if ((GetAsyncKeyState(1) & 0x8000) == 0) throw new Exception("This session cannot press the desktop mouse button.");
                if (shellImage) {
                    for (int wait = 0; wait < 40; wait++) {
                        System.Threading.Thread.Sleep(50);
                        if (PreviewVisible(island)) { HeldPreview = true; break; }
                    }
                    Capture(process, System.IO.Path.Combine(System.IO.Path.GetDirectoryName(path), "drop-tab-while-held.png"));
                }
                for (int step = 0; step < 10; step++) {
                    System.Threading.Thread.Sleep(180);
                    Rect bounds; GetWindowRect(island, out bounds);
                    double scale = GetDpiForWindow(island) / 96.0;
                    // Enter the companion first, then move into the revealed drop tab.
                    SetCursorPos((bounds.Left + bounds.Right) / 2, bounds.Top + (int)((step < 3 ? 20 : 100) * scale));
                }
                mouse_event(4, 0, 0, 0, UIntPtr.Zero);
                if (!worker.Join(5000)) throw new Exception("The native drag source did not finish.");
                if (failure != null) throw failure;
            } finally {
                mouse_event(4, 0, 0, 0, UIntPtr.Zero);
                SetCursorPos(original.X, original.Y);
            }
        }
        return result.ToString();
    }

    public static void Capture(uint process, string path) {
        Rect bounds; GetWindowRect(Find(process), out bounds);
        using (var image = new Bitmap(bounds.Right - bounds.Left, bounds.Bottom - bounds.Top))
        using (var graphics = Graphics.FromImage(image)) {
            graphics.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, image.Size);
            image.Save(path);
        }
    }
}
'@

if (!$AppProcessId) { $AppProcessId = (Get-Process mimo | Select-Object -First 1).Id }
$artifactDir = Join-Path $PSScriptRoot '../target/native-file-drop'
New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
$fixtureName = 'mimo-native-drop-' + [DateTimeOffset]::Now.ToUnixTimeMilliseconds() + '.txt'
$fixture = Join-Path $artifactDir $fixtureName
$contents = 'Synthetic Mimo drag-and-drop check. Keep the original and show this attachment in chat.'
Set-Content -LiteralPath $fixture -Value $contents -Encoding UTF8
$effect = [MimoNativeDrop]::Drag([uint32]$AppProcessId, $fixture, [bool]$ShellDragImage)
if ($effect -ne 'Copy') { throw "Native drop returned $effect instead of Copy." }
if ($ShellDragImage -and ![MimoNativeDrop]::HeldPreview) { throw 'Holding a Shell file drag did not reveal the drop tab before entering Mimo.' }

$copied = Join-Path (Join-Path $env:LOCALAPPDATA 'Mimo/inbox') $fixtureName
$deadline = [DateTime]::UtcNow.AddSeconds(15)
$visible = $false
while ([DateTime]::UtcNow -lt $deadline) {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle([MimoNativeDrop]::Find([uint32]$AppProcessId))
    $condition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, $fixtureName)
    $attachment = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if ($attachment -and !$attachment.Current.IsOffscreen -and (Test-Path -LiteralPath $copied)) {
        $visible = $true
        break
    }
    Start-Sleep -Milliseconds 150
}
$capture = Join-Path $artifactDir 'chat-after-native-drop.png'
if ($visible) { Start-Sleep -Milliseconds 900 } # Capture after the retained view transition settles.
[MimoNativeDrop]::Capture([uint32]$AppProcessId, $capture)
if (!$visible) { throw "The drop did not return to chat with a visible attachment. Screenshot: $capture" }
if ((Get-Content -LiteralPath $fixture -Raw) -ne (Get-Content -LiteralPath $copied -Raw)) {
    throw 'The inbox copy differs from the original.'
}
[pscustomobject]@{ Passed = $true; NativeEffect = $effect; OriginalPreserved = $true;
    AttachmentVisible = $visible; HeldPreview = [MimoNativeDrop]::HeldPreview; Screenshot = $capture } | ConvertTo-Json
