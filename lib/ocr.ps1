# Windows 自带 OCR（WinRT Windows.Media.Ocr）的 PowerShell 包装。
#
# 为什么要有这个文件：
#   桥接的纯文本模型吃不到图片（DSH 的 MCP 客户端在 dsh-mcp-client/lib/index.js:299
#   用 inputModalities 做硬门槛），所以"看图"必须由插件在模型外面先做一遍。
#   离线兜底用系统 OCR：不花钱、不联网、只出文字（看不懂画面语义）。
#
# 为什么结果写文件而不是写 stdout：
#   实测 powershell.exe 子进程的 stdout 在中文环境下按 GBK 回传，node 侧读出来
#   就是一堆乱码。写 UTF-8 文件再读，彻底绕开编码协商。
#
# 注意：本文件必须存成带 BOM 的 UTF-8。系统 powershell.exe 是 5.1，
#   无 BOM 时会按 GBK 解码中文，直接语法解析失败。
#
# 用法：
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
#     -File ocr.ps1 -ImagePath <图片绝对路径> -OutFile <结果txt路径> [-Lang zh-Hans-CN]
#
# 输出（JSON 单行，UTF-8 无 BOM）：
#   {"ok":true,"lang":"zh-Hans-CN","lines":["..."],"text":"..."}
#   {"ok":false,"error":"..."}

param(
  [Parameter(Mandatory = $true)][string]$ImagePath,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [string]$Lang = 'zh-Hans-CN'
)

$ErrorActionPreference = 'Stop'

function Write-Result([hashtable]$Payload) {
  $json = $Payload | ConvertTo-Json -Depth 6 -Compress
  [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

try {
  if (-not (Test-Path -LiteralPath $ImagePath)) { throw "图片不存在：$ImagePath" }

  # WinRT 类型投影：不先加载，下面几个类型名在 PS 5.1 里解析不到。
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
  [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null

  # IAsyncOperation<T> -> Task<T> 的泛型桥。PS 5.1 没有 await，只能同步等。
  $asTaskCandidates = @([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })
  if ($asTaskCandidates.Count -lt 1) { throw '找不到 AsTask 泛型方法，WinRT 投影未就绪' }
  $asTaskGeneric = $asTaskCandidates[0]

  function Await($Operation, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $task = $asTask.Invoke($null, @($Operation))
    $task.Wait(-1) | Out-Null
    $task.Result
  }

  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  $engine = $null
  try {
    $language = New-Object Windows.Globalization.Language($Lang)
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
  } catch { }
  if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if (-not $engine) { throw "系统里没有可用的 OCR 语言包（试过 $Lang 与用户配置语言）" }

  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = @()
  foreach ($line in $result.Lines) { $lines += [string]$line.Text }

  # 释放句柄，否则临时文件删不掉（Windows 上开着就锁）。
  try { $stream.Dispose() } catch { }
  try { $bitmap.Dispose() } catch { }

  Write-Result @{
    ok    = $true
    lang  = [string]$engine.RecognizerLanguage.LanguageTag
    lines = $lines
    text  = ($lines -join "`n")
  }
} catch {
  Write-Result @{ ok = $false; error = [string]$_.Exception.Message }
  exit 1
}
