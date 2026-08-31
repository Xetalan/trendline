# Building the Android APK

The toolchain is already installed, outside this repo and needing no admin
rights:

- JDK 21 — `C:\Users\randk\android-tools\jdk-21.0.12.1+1`
- Android SDK — `C:\Users\randk\android-tools\sdk` (platform 35, build-tools 35)

Capacitor 8 requires **JDK 21**. JDK 17 is also present but fails with
`invalid source release: 21`.

## Build

```bash
npm run android:sync      # rebuild web assets and copy them into android/

cd android
JAVA_HOME=/c/Users/randk/android-tools/jdk-21.0.12.1+1 \
ANDROID_HOME=/c/Users/randk/android-tools/sdk \
./gradlew assembleDebug --no-daemon
```

The APK lands at `android/app/build/outputs/apk/debug/app-debug.apk`.

## Known blocker: system commit memory

The build needs roughly 2 GB of commit headroom for the dex merge. If Gradle
dies with *"daemon disappeared unexpectedly"*, check commit charge:

```powershell
$os = Get-CimInstance Win32_OperatingSystem
"{0:N1} GB used of {1:N1} GB" -f (($os.TotalVirtualMemorySize-$os.FreeVirtualMemory)/1MB), ($os.TotalVirtualMemorySize/1MB)
Get-Process | Sort-Object PrivateMemorySize64 -Descending | Select-Object -First 5 Name, @{n='PrivateGB';e={[math]::Round($_.PrivateMemorySize64/1GB,1)}}
```

`DellSupportAssistRemedationService` has been observed leaking ~90 GB of
committed memory, which exhausts the commit limit even with 10 GB of physical
RAM free. Restart it from an **admin** prompt, or reboot:

```powershell
Restart-Service -Name 'Alienware SupportAssist Remediation'
```

## Installing on the phone

Copy `app-debug.apk` to the phone and open it. Android asks once for
permission to install from that source. The build is debug-signed, which is
fine for personal sideloading.

The APK has its own storage, separate from the PWA. Move data across with
Settings → **Save backup (JSON)** on the desktop, then **Restore from backup…**
in the app.

## Updating

Rebuild and reinstall — a sideloaded APK does not auto-update. Reinstalling
over the top keeps the app's data as long as the signing key is unchanged.
