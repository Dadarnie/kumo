# SPDX-License-Identifier: MIT
param([int]$AppProcessId=0)
$ErrorActionPreference='Stop'
Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;
public static class IslandFrameCheck {
 public delegate bool Callback(IntPtr window,IntPtr parameter);
 [DllImport("user32.dll")]static extern bool EnumWindows(Callback callback,IntPtr parameter);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
 [DllImport("user32.dll")]static extern int GetWindowText(IntPtr window,StringBuilder text,int length);
 [DllImport("user32.dll")]static extern int GetWindowLong(IntPtr window,int index);
 [DllImport("user32.dll")]static extern int SetWindowLong(IntPtr window,int index,int value);
 public static object Check(uint process){
  IntPtr island=IntPtr.Zero;EnumWindows((window,arg)=>{uint owner;GetWindowThreadProcessId(window,out owner);var title=new StringBuilder(100);GetWindowText(window,title,100);if(owner==process&&title.ToString()=="Mimo")island=window;return true;},IntPtr.Zero);
  if(island==IntPtr.Zero)throw new Exception("Run this check with Mimo open.");
  int style=GetWindowLong(island,-16),extended=GetWindowLong(island,-20);
  try{
   // Simulate a framework style refresh. The frame must be rejected before
   // Windows can paint it, rather than removed by a later animation tick.
   SetWindowLong(island,-16,style|0x00cf0000);
   if((GetWindowLong(island,-16)&0x00cf0000)!=0)throw new Exception("A style refresh can restore the island's rectangular native frame.");
   SetWindowLong(island,-20,extended|0x00000300);
   if((GetWindowLong(island,-20)&0x00000300)!=0)throw new Exception("A style refresh can restore native window edges.");
   return new{Passed=true,CaptionAndEdgesRejected=true};
  }finally{SetWindowLong(island,-16,style);SetWindowLong(island,-20,extended);}
 }
}
'@
if(!$AppProcessId){$AppProcessId=(Get-Process mimo | Select-Object -First 1).Id}
[IslandFrameCheck]::Check([uint32]$AppProcessId) | ConvertTo-Json
