# SPDX-License-Identifier: MIT
param([int]$AppProcessId=0,[int]$Rounds=4,[string]$OutputPath='target/topmost-validation/current')
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing @'
using System;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Threading;
public static class IslandTopmostCheck {
 public delegate bool Callback(IntPtr window,IntPtr parameter);
 [StructLayout(LayoutKind.Sequential)]public struct Rect{public int L,T,R,B;}
 [StructLayout(LayoutKind.Sequential)]public struct Point{public int X,Y;}
 [StructLayout(LayoutKind.Sequential)]public struct Placement{public int Length,Flags,Show;public Point Min,Max;public Rect Normal;}
 [DllImport("user32.dll")]static extern bool EnumWindows(Callback callback,IntPtr parameter);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
 [DllImport("user32.dll")]static extern int GetWindowText(IntPtr window,StringBuilder text,int length);
 [DllImport("user32.dll")]static extern int GetClassName(IntPtr window,StringBuilder text,int length);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr window);
 [DllImport("user32.dll")]static extern int GetWindowLong(IntPtr window,int index);
 [DllImport("user32.dll")]static extern bool SetWindowPos(IntPtr window,IntPtr after,int x,int y,int width,int height,uint flags);
 [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr window,out Rect rectangle);
 [DllImport("user32.dll")]static extern int GetWindowRgn(IntPtr window,IntPtr region);
 [DllImport("gdi32.dll")]static extern IntPtr CreateRectRgn(int l,int t,int r,int b);
 [DllImport("gdi32.dll")]static extern int GetRgnBox(IntPtr region,out Rect bounds);
 [DllImport("gdi32.dll")]static extern bool DeleteObject(IntPtr region);
 [DllImport("user32.dll")]static extern bool GetWindowPlacement(IntPtr window,ref Placement placement);
 [DllImport("user32.dll")]static extern bool SetWindowPlacement(IntPtr window,ref Placement placement);
 [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]static extern bool SetForegroundWindow(IntPtr window);
 [DllImport("user32.dll")]static extern bool ShowWindow(IntPtr window,int command);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr window,IntPtr process);
 [DllImport("kernel32.dll")]static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")]static extern bool AttachThreadInput(uint first,uint second,bool attach);
 [DllImport("user32.dll")]static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
 static readonly IntPtr Topmost=new IntPtr(-1),NotTopmost=new IntPtr(-2);
 const uint KeepGeometryAndFocus=0x0001|0x0002|0x0010|0x0200;
 public static IntPtr FindFolderWindow(){IntPtr found=IntPtr.Zero;EnumWindows((window,arg)=>{var name=new StringBuilder(100);GetClassName(window,name,100);if(name.ToString()=="CabinetWClass"&&IsWindowVisible(window))found=window;return true;},IntPtr.Zero);return found;}
 static bool Top(IntPtr window){return (GetWindowLong(window,-20)&0x00000008)!=0;}
 static bool Above(IntPtr first,IntPtr second){var windows=new List<IntPtr>();EnumWindows((window,arg)=>{windows.Add(window);return true;},IntPtr.Zero);return windows.IndexOf(first)>=0&&windows.IndexOf(first)<windows.IndexOf(second);}
 static void Activate(IntPtr target){
  uint current=GetCurrentThreadId(),foreground=GetWindowThreadProcessId(GetForegroundWindow(),IntPtr.Zero);
  bool attached=current!=foreground&&AttachThreadInput(current,foreground,true);
  try{SetForegroundWindow(target);}finally{if(attached)AttachThreadInput(current,foreground,false);}
  if(GetForegroundWindow()!=target){keybd_event(0x12,0,0,UIntPtr.Zero);keybd_event(0x12,0,2,UIntPtr.Zero);SetForegroundWindow(target);}
  for(int i=0;i<20&&GetForegroundWindow()!=target;i++){Thread.Sleep(25);SetForegroundWindow(target);}
  if(GetForegroundWindow()!=target){uint actual,expected;GetWindowThreadProcessId(GetForegroundWindow(),out actual);GetWindowThreadProcessId(target,out expected);throw new Exception("Target activation failed; expected HWND "+target+" process "+expected+", foreground HWND "+GetForegroundWindow()+" process "+actual);}
 }
 static object Sample(string name,IntPtr island,IntPtr app){
  bool top=false,above=false,focus=false;
  for(int i=0;i<20;i++){top=Top(island);above=Above(island,app);focus=GetForegroundWindow()==app;if(top&&above&&focus)break;Thread.Sleep(25);}
  var region=CreateRectRgn(0,0,0,0);Rect clip=new Rect();
  try{GetWindowRgn(island,region);GetRgnBox(region,out clip);}finally{DeleteObject(region);}
  return new{Case=name,Passed=top&&above&&focus,Topmost=top,AboveApplication=above,ApplicationKeepsFocus=focus,ClipWidth=clip.R-clip.L,ClipHeight=clip.B-clip.T};
 }
 static void Capture(IntPtr island,string path){
  Rect rect;GetWindowRect(island,out rect);
  using(var bitmap=new Bitmap(rect.R-rect.L+240,160))using(var graphics=Graphics.FromImage(bitmap)){
   graphics.CopyFromScreen(rect.L-120,rect.T,0,0,bitmap.Size);bitmap.Save(path,ImageFormat.Png);
  }
 }
 public static object Check(uint process,IntPtr[] apps,string[] names,int rounds,string output){
  IntPtr island=IntPtr.Zero;
  EnumWindows((window,arg)=>{uint owner;GetWindowThreadProcessId(window,out owner);var title=new StringBuilder(100);GetWindowText(window,title,100);if(owner==process&&title.ToString()=="Mimo"&&IsWindowVisible(window))island=window;return true;},IntPtr.Zero);
  if(island==IntPtr.Zero)throw new Exception("Run this check with the native Mimo island visible.");
  var originalFocus=GetForegroundWindow();var placements=new Placement[apps.Length];var topmost=new bool[apps.Length];
  var samples=new List<object>();bool passed=true;
  for(int i=0;i<apps.Length;i++){placements[i].Length=Marshal.SizeOf(typeof(Placement));if(!GetWindowPlacement(apps[i],ref placements[i]))throw new Exception("Cannot save application placement.");topmost[i]=Top(apps[i]);}
  try{
   Rect rect;GetWindowRect(island,out rect);
   for(int round=0;round<rounds;round++)for(int i=0;i<apps.Length;i++){
    var app=apps[i];ShowWindow(app,9);SetWindowPos(app,IntPtr.Zero,rect.L-100,rect.T,Math.Max(900,rect.R-rect.L+200),700,0x0010|0x0004);ShowWindow(app,3);Activate(app);
    var normal=Sample(names[i]+" foreground/maximized "+round,island,app);samples.Add(normal);passed&=(bool)normal.GetType().GetProperty("Passed").GetValue(normal,null);
    SetWindowPos(island,NotTopmost,0,0,0,0,KeepGeometryAndFocus);
    var demotion=Sample(names[i]+" native demotion "+round,island,app);samples.Add(demotion);passed&=(bool)demotion.GetType().GetProperty("Passed").GetValue(demotion,null);
    SetWindowPos(island,NotTopmost,0,0,0,0,KeepGeometryAndFocus|0x0400);
    var bypass=Sample(names[i]+" bypass position guard "+round,island,app);samples.Add(bypass);passed&=(bool)bypass.GetType().GetProperty("Passed").GetValue(bypass,null);
    SetWindowPos(app,Topmost,0,0,0,0,KeepGeometryAndFocus);
    Activate(apps[(i+1)%apps.Length]);Activate(app);
    var competition=Sample(names[i]+" foreground topmost app "+round,island,app);samples.Add(competition);passed&=(bool)competition.GetType().GetProperty("Passed").GetValue(competition,null);
    SetWindowPos(app,topmost[i]?Topmost:NotTopmost,0,0,0,0,KeepGeometryAndFocus);
    if(round==rounds-1){Thread.Sleep(300);Capture(island,System.IO.Path.Combine(output,names[i]+".png"));}
   }
   return new{Passed=passed,Process=process,Cases=samples.Count,Samples=samples};
  }finally{
   for(int i=0;i<apps.Length;i++){SetWindowPos(apps[i],topmost[i]?Topmost:NotTopmost,0,0,0,0,KeepGeometryAndFocus);SetWindowPlacement(apps[i],ref placements[i]);}
   SetWindowPos(island,Topmost,0,0,0,0,KeepGeometryAndFocus);
   if(originalFocus!=IntPtr.Zero)SetForegroundWindow(originalFocus);
  }
 }
}
'@
if(!$AppProcessId){$AppProcessId=(Get-Process mimo | Select-Object -First 1).Id}
$editor=Get-Process Code -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if(!$editor){throw 'Open VS Code before running this check.'}
$output=[IO.Path]::GetFullPath($OutputPath)
[IO.Directory]::CreateDirectory($output) | Out-Null
$folderWindow=[IslandTopmostCheck]::FindFolderWindow()
if($folderWindow -eq [IntPtr]::Zero){
 Start-Process -FilePath 'explorer.exe' -ArgumentList @('/n,',$output) -WindowStyle Hidden
 for($attempt=0;$attempt -lt 60 -and $folderWindow -eq [IntPtr]::Zero;$attempt++){Start-Sleep -Milliseconds 50;$folderWindow=[IslandTopmostCheck]::FindFolderWindow()}
}
if($folderWindow -eq [IntPtr]::Zero){throw 'Could not open a File Explorer folder window for the native check.'}
$result=[IslandTopmostCheck]::Check([uint32]$AppProcessId,@($editor.MainWindowHandle,$folderWindow),@('VSCode','FileExplorer'),$Rounds,$output)
$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $output 'report.json') -Encoding UTF8
$result | Select-Object Passed,Process,Cases | ConvertTo-Json
if(!$result.Passed){exit 1}
