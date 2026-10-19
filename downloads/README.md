# Download Mimo for Windows

[**Download Mimo-Windows-setup.exe**](https://github.com/Jiocode1/mimo/raw/refs/heads/main/downloads/Mimo-Windows-setup.exe)

Version **1.0.1**, Windows 10 / 11, 64-bit, with WebView2.

**This installer is not code-signed yet.** Windows may show an unknown-publisher
or SmartScreen notice.

Check the downloaded file against [SHA256SUMS.txt](SHA256SUMS.txt):

```powershell
Get-FileHash .\Mimo-Windows-setup.exe -Algorithm SHA256
```

The checksum identifies the published file. [Build it yourself](../docs/distribution.md).

Maintainers: run `npm run pack` in `windows/`, copy
`windows/release/Mimo-Windows-setup.exe` here, and refresh the checksum and
[build record](build.json) together.
