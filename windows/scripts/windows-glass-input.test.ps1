# SPDX-License-Identifier: MIT
param([int]$AppProcessId=0)
$ErrorActionPreference='Stop'
Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;
public static class GlassInputRegion {
 public delegate bool Callback(IntPtr window,IntPtr parameter);
 [StructLayout(LayoutKind.Sequential)]public struct Rect{public int L,T,R,B;}
 [DllImport("user32.dll")]static extern bool EnumWindows(Callback callback,IntPtr parameter);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
 [DllImport("user32.dll")]static extern int GetWindowText(IntPtr window,StringBuilder text,int length);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr window);
 [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr window,out Rect rectangle);
 [DllImport("user32.dll")]static extern int GetWindowRgn(IntPtr window,IntPtr region);
 [DllImport("gdi32.dll")]static extern IntPtr CreateRectRgn(int l,int t,int r,int b);
 [DllImport("gdi32.dll")]static extern int GetRgnBox(IntPtr region,out Rect bounds);
 [DllImport("gdi32.dll")]static extern bool PtInRegion(IntPtr region,int x,int y);
 [DllImport("gdi32.dll")]static extern bool DeleteObject(IntPtr region);
 public static object Check(uint process){
  IntPtr backdrop=IntPtr.Zero;Callback find=(window,arg)=>{uint owner;GetWindowThreadProcessId(window,out owner);var text=new StringBuilder(100);GetWindowText(window,text,100);if(owner==process&&text.ToString()=="Mimo glass"&&IsWindowVisible(window))backdrop=window;return true;};EnumWindows(find,IntPtr.Zero);
  if(backdrop==IntPtr.Zero)throw new Exception("Run this check with the Glass island visible.");
  var region=CreateRectRgn(0,0,0,0);
  try{
   if(GetWindowRgn(backdrop,region)==0)throw new Exception("Glass has an unbounded native hit area and can block Settings.");
   Rect window,bounds;GetWindowRect(backdrop,out window);GetRgnBox(region,out bounds);
   int width=window.R-window.L,height=window.B-window.T;
   if(PtInRegion(region,0,height/2)||PtInRegion(region,width-1,height/2)||PtInRegion(region,width/2,height-1))throw new Exception("Invisible glass gutters must pass input to windows underneath.");
   if(bounds.R-bounds.L>=width&&bounds.B-bounds.T>=height)throw new Exception("Glass must be clipped to the visible island.");
   return new{Passed=true,Backdrop=backdrop.ToInt64(),NativeClip=bounds};
  }finally{DeleteObject(region);}
 }
}
'@
if(!$AppProcessId){$AppProcessId=(Get-Process mimo | Select-Object -First 1).Id}
[GlassInputRegion]::Check([uint32]$AppProcessId) | ConvertTo-Json
