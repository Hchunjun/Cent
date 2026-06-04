# Cent Android App Release 打包手册

本文档记录如何把当前 Cent 项目打包成 Android 原生安装包 APK。目标是下次可以从 clone 仓库开始，按步骤独立完成 release APK 构建、签名、验证和安装。

## 1. 打包目的

当前 Cent 可以通过服务端部署后在手机浏览器访问，也可以添加为 PWA 使用。但这种方式会依赖某个线上站点，例如 `https://cent.linkai.work`。

本打包方案的目标是：

- 把 Cent 前端资源直接打进 Android APK。
- 手机安装后通过本地 App 打开，而不是通过浏览器访问 `https://cent.linkai.work`。
- 不需要自己部署 Cent 服务端，也不需要在自己的 PC 上长期运行服务。
- 账单数据仍然按 Cent 原有同步能力保存到个人存储端，例如自己的 Gitee token 方案。
- 尽量保留 Cent 原有完整功能，不改业务逻辑。

## 2. 这种方式的好处

- 不依赖 `cent.linkai.work`：App 启动界面来自 APK 内置资源，不是远程网页。
- 不需要自建服务器：只需要本地打包一次 APK，然后安装到手机。
- 更可控：APK 是自己从源码打包出来的，可以确认没有配置远程 `server.url`。
- 数据仍归自己：账单同步端点由 App 内的 Cent 功能选择，例如 Gitee/GitHub/WebDAV/S3 等。
- 更新方式明确：以后源码更新后重新打包 APK，再覆盖安装即可。

注意：这种方式并不等于完全离线。Cent 的数据同步、地图、分词库 CDN 等功能如果本身需要联网，App 运行时仍会按原业务逻辑访问对应服务。这里解决的是“不通过 `https://cent.linkai.work` 加载主应用”。

## 3. 环境准备

以下命令以 Windows PowerShell 为例。

需要准备：

- Git
- Node.js
- pnpm
- JDK
- Android SDK / Android command line tools
- Android build-tools 中的 `apksigner.bat` 和 `aapt2.exe`
- 可选：`adb`，用于安装到手机

可以先确认基础命令是否可用：

```powershell
git --version
node -v
pnpm -v
java -version
adb version
```

如果 `adb` 不可用，不影响打包，只影响后续命令行安装到手机。

## 4. 从仓库 clone 项目

如果你维护的是自己的 fork 或 Gitee 仓库，建议 clone 自己的仓库地址：

```powershell
git clone <你的 Cent 仓库地址>
cd Cent
```

例如当前项目来源是：

```powershell
git clone https://github.com/Hchunjun/Cent.git
cd Cent
```

进入项目后，确认在项目根目录：

```powershell
Get-Location
Get-ChildItem
```

应该能看到 `package.json`、`src`、`public`、`vite.config.ts` 等文件。

## 5. 安装前端依赖

执行：

```powershell
pnpm.cmd install --trust-lockfile
```

如果 pnpm 提示类似：

```text
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: xxx
Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
```

执行：

```powershell
pnpm.cmd approve-builds
```

在交互界面里用空格选中被拦截的依赖，然后回车确认。当前项目常见需要允许的依赖包括：

- `@parcel/watcher`
- `@tailwindcss/oxide`
- `esbuild`

当前仓库也可以通过 `pnpm-workspace.yaml` 固定允许列表，例如：

```yaml
allowBuilds:
  '@parcel/watcher': true
  '@tailwindcss/oxide': true
  esbuild: true
```

批准后重新执行：

```powershell
pnpm.cmd install --trust-lockfile
```

## 6. Capacitor 配置

当前方案使用 Capacitor 把 Vite 构建产物打进 Android 工程。

项目根目录需要有 `capacitor.config.ts`：

```ts
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
    appId: "work.linkai.cent",
    appName: "Cent",
    webDir: "dist",
    server: {
        androidScheme: "https",
    },
};

export default config;
```

关键点：

- `webDir: "dist"` 表示使用本地构建产物。
- 不要配置 `server.url`。
- 只要没有 `server.url`，Capacitor 就不会把 App 做成访问远程站点的壳浏览器。

可以用下面命令确认没有远程入口：

```powershell
rg -n "cent\.linkai\.work|server\.url|serverUrl" capacitor.config.ts android\app\src\main\assets android\app\src\main -S
```

如果没有输出，说明这些位置没有配置 `cent.linkai.work` 作为启动地址。

## 7. Android 工程

项目根目录需要有 `android` 目录。这个目录是 Capacitor Android 工程。

如果仓库已经包含 `android` 目录，可以直接使用。

如果是从原始 Web 项目第一次生成 Android 工程，先安装 Capacitor 依赖：

```powershell
pnpm.cmd add @capacitor/core @capacitor/android
pnpm.cmd add -D @capacitor/cli
```

然后生成 Android 工程：

```powershell
pnpm.cmd exec cap add android
```

当前项目已经有 Android 工程时，不需要重复执行 `cap add android`。

## 8. Release 签名配置

release APK 必须签名后才能正常分发安装。

当前 Android 工程会从 `android/local.properties` 读取签名信息。示例：

```properties
sdk.dir=C:\你的\Android\SDK\路径
storeFile=../../cent-release.keystore
storePassword=<你的 keystore 密码>
keyAlias=<你的 key alias>
keyPassword=<你的 key 密码>
```

说明：

- `sdk.dir` 指向本机 Android SDK。
- `storeFile` 是 keystore 文件路径，相对 `android` 目录计算。
- `storePassword`、`keyAlias`、`keyPassword` 必须与你的 keystore 匹配。
- 不要把真实密码提交到公开仓库。
- 不要把 `cent-release.keystore` 泄露给别人，否则别人可以伪装成你的 App 更新包。

### 换电脑后如何处理签名文件

release APK 不能凭空生成，它必须使用 keystore 签名。为了以后能覆盖安装升级同一个 App，需要一直使用同一个 `cent-release.keystore`。

推荐做法：

- 不把 `cent-release.keystore` 提交到 Git。
- 不把 `android/local.properties` 提交到 Git。
- 把 `cent-release.keystore` 单独安全备份，例如放在私人加密备份、U 盘或密码管理工具附件里。
- 换电脑 clone 仓库后，把同一个 `cent-release.keystore` 放回项目根目录。
- 在新电脑重新创建 `android/local.properties`，写入新电脑自己的 Android SDK 路径和签名密码。

也就是说，新电脑第一次打包前需要补齐这两个本地文件：

```text
cent-release.keystore
android/local.properties
```

其中 `cent-release.keystore` 要复用旧文件；`android/local.properties` 通常每台电脑单独维护，因为 `sdk.dir` 路径不同。

如果把 keystore 和密码也提交进仓库，确实可以做到 clone 后更接近直接打包，但不推荐。私钥泄露后，别人可以签出同包名、同签名的 APK；一旦泄露，通常只能换新 keystore，而换签名后旧 App 不能无缝覆盖升级。

如果要自己生成新的 keystore，可以使用：

```powershell
keytool -genkeypair -v -keystore cent-release.keystore -alias cent -keyalg RSA -keysize 2048 -validity 10000
```

生成后，把对应密码和 alias 写入 `android/local.properties`。

## 9. 构建前端 dist

推荐用于 App 打包的前端构建命令：

```powershell
pnpm.cmd exec vite build
```

成功后，项目根目录会生成 `dist` 目录。

为什么不用 `pnpm.cmd run build`？

当前 `package.json` 中：

```json
"build": "pnpm run lint && vite build"
```

它会先跑 lint。因为 `biome.json` 当前会扫描 `**`，当 Android 工程已经产生 Gradle 中间文件后，Biome 可能扫到：

```text
android\capacitor-cordova-android-plugins\build\intermediates\...
```

然后报格式化错误。这不是业务代码问题，也不是 APK 构建问题，只是格式化工具扫到了 Android 生成产物。

所以为了最小改动先产出 APK，推荐直接执行：

```powershell
pnpm.cmd exec vite build
```

如果以后想从根上修复，可以在 `biome.json` 的 includes 中排除 Android 目录：

```json
"!**/android"
```

这属于工程配置优化，不是业务逻辑修改。

## 10. 同步资源到 Android 工程

前端 `dist` 构建完成后，执行：

```powershell
pnpm.cmd exec cap sync android
```

这个命令会把 `dist` 同步到：

```text
android\app\src\main\assets\public
```

可以检查：

```powershell
Get-ChildItem android\app\src\main\assets\public
```

应该能看到：

- `index.html`
- `assets`
- `manifest.webmanifest`
- `sw.js`
- `registerSW.js`

## 11. 构建 release APK

进入 Android 目录：

```powershell
cd android
```

执行 release 构建：

```powershell
.\gradlew.bat assembleRelease
```

成功后 APK 路径是：

```text
android\app\build\outputs\apk\release\app-release.apk
```

如果你当前已经在 `android` 目录内，则相对路径是：

```text
app\build\outputs\apk\release\app-release.apk
```

## 12. 验证 APK 是否是 release 包

回到项目根目录：

```powershell
cd ..
```

查看 release 输出：

```powershell
Get-ChildItem android\app\build\outputs\apk\release
```

应该看到：

```text
app-release.apk
output-metadata.json
```

读取元数据：

```powershell
Get-Content android\app\build\outputs\apk\release\output-metadata.json
```

重点确认：

```json
"variantName": "release"
```

## 13. 验证 APK 签名

找到 Android SDK build-tools 下的 `apksigner.bat`，例如：

```text
C:\Users\<你的用户名>\scoop\apps\android-clt\current\build-tools\35.0.0\apksigner.bat
```

执行：

```powershell
& '<你的 apksigner.bat 路径>' verify --verbose --print-certs android\app\build\outputs\apk\release\app-release.apk
```

成功信号：

```text
Verifies
Verified using v2 scheme (APK Signature Scheme v2): true
Number of signers: 1
```

看到 `Verifies` 就说明签名验证通过。

## 14. 查看 APK 基本信息

可以用 `aapt2.exe` 查看包名、版本、权限：

```powershell
& '<你的 aapt2.exe 路径>' dump badging android\app\build\outputs\apk\release\app-release.apk
```

重点确认：

```text
package: name='work.linkai.cent'
application-label:'Cent'
launchable-activity: name='work.linkai.cent.MainActivity'
```

当前 App 需要联网权限：

```text
uses-permission: name='android.permission.INTERNET'
```

这是正常的，因为 Gitee/GitHub/WebDAV/S3 同步、地图、CDN 资源等功能需要网络。

## 15. 安装到手机

手机打开 USB 调试后，执行：

```powershell
adb install -r android\app\build\outputs\apk\release\app-release.apk
```

成功信号：

```text
Success
```

如果提示签名不一致，说明手机上已有同包名但不同签名的旧版本。处理方式：

```powershell
adb uninstall work.linkai.cent
adb install android\app\build\outputs\apk\release\app-release.apk
```

注意：卸载会清掉该 App 本地数据。卸载前确保账单已经同步或备份。

## 16. 真机验证清单

安装后建议至少检查：

- App 可以正常打开。
- 不是跳转浏览器访问 `https://cent.linkai.work`。
- 首页、记账、统计等核心页面可以打开。
- Gitee token 存储方案可以配置。
- 新增账单后可以同步到自己的 Gitee。
- 断网后 App 主界面仍能打开。
- 联网后同步功能恢复正常。
- 分词相关功能能正常加载；如果真机网络无法访问 CDN，再考虑把分词库本地化。

## 17. 下次重新打包的最短流程

如果环境、Android 工程、签名文件都已经配置好，下次通常只需要：

```powershell
git pull
pnpm.cmd install --trust-lockfile
pnpm.cmd exec vite build
pnpm.cmd exec cap sync android
cd android
.\gradlew.bat assembleRelease
cd ..
```

产物：

```text
android\app\build\outputs\apk\release\app-release.apk
```

验证：

```powershell
& '<你的 apksigner.bat 路径>' verify --verbose --print-certs android\app\build\outputs\apk\release\app-release.apk
```

安装：

```powershell
adb install -r android\app\build\outputs\apk\release\app-release.apk
```

## 18. 常见问题

### pnpm 提示 Ignored build scripts

现象：

```text
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @parcel/watcher
```

处理：

```powershell
pnpm.cmd approve-builds
pnpm.cmd install --trust-lockfile
```

### Biome 扫到 Android 生成文件

现象：

```text
android\capacitor-cordova-android-plugins\build\intermediates\...
Formatter would have printed the following content
```

处理：

```powershell
pnpm.cmd exec vite build
```

不要去修改 Android `build\intermediates` 里的文件，它们是生成产物。

### App 是否访问 cent.linkai.work

检查：

```powershell
rg -n "cent\.linkai\.work|server\.url|serverUrl" capacitor.config.ts android\app\src\main\assets android\app\src\main -S
```

如果没有输出，并且 `capacitor.config.ts` 没有 `server.url`，说明 App 启动资源不是来自 `https://cent.linkai.work`。

### 生成的是 debug 还是 release

检查：

```powershell
Get-Content android\app\build\outputs\apk\release\output-metadata.json
```

确认：

```json
"variantName": "release"
```

### 覆盖安装失败

如果提示签名不一致：

```powershell
adb uninstall work.linkai.cent
adb install android\app\build\outputs\apk\release\app-release.apk
```

卸载会清除本地数据，操作前先确认数据已同步或备份。

## 19. 当前方案边界

当前方案只做最小打包改造：

- 不修改 Cent 业务代码。
- 不把默认同步端点强制改成 Gitee。
- 不特殊处理分词库。
- 不把 App 做成访问 `https://cent.linkai.work` 的浏览器壳。
- 通过 Capacitor WebView 加载 APK 内置的 `dist` 静态资源。

后续如果真机验证发现某个远程资源不可用，再针对那个资源做本地化处理。
