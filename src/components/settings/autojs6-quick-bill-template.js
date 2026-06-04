// biome-ignore-all lint: AutoJS6 compatibility script
/**
 * ============================================================
 * Cent 快捷记账 - AutoJs6 版（OCR + AI 文本分析）
 * ============================================================
 * 功能：截图 → Paddle OCR 本地识别 → AI 文本分析 → XML → Relayr → Cent
 * 本地 OCR 提取文字（~1秒），AI 只处理纯文本（~2-3秒），总耗时 3-5 秒
 *
 * 前置要求：
 * 1. AutoJs6 已开启无障碍服务、悬浮窗权限
 * 2. Cent 中已开启 Relayr 功能（设置 → 快捷记账 → 开启并复制配置）
 * 3. AI API Key（推荐 DeepSeek）
 *    - DeepSeek: https://platform.deepseek.com/
 *
 * 触发方式：
 * - 直接运行（桌面快捷方式）
 * - 或取消底部注释使用音量键 / 悬浮窗
 * ============================================================
 */

// ==================== 一、用户配置区 ====================

var CONFIG = {
    /**
     * 由 Cent 设置 → 快捷记账 → Android → 复制 AutoJS6 脚本 自动写入
     * 如果填写了此项，下方的 relayr 和 prompt 将被忽略
     */
    centConfigText: "",

    /**
     * AI 配置（文本分析，无需图片输入能力）
     * 由 Cent 当前默认 AI 配置自动写入
     */
    ai: {
        apiKey: "",
        apiUrl: "",
        model: "",
        timeout: 60000,
    },

    /**
     * Cent Android App 包名
     * 对应 capacitor.config.ts 中的 appId
     */
    cent: {
        packageName: "work.linkai.cent",
        launchWait: 2000,
    },

    /**
     * 以下为手动配置项，仅当 centConfigText 为空时生效
     * 建议使用 centConfigText 方式，可自动同步 Cent 端的分类变更
     */
    relayr: {
        url: "",
        passcode: "",
        encryptKey: "",
    },
    prompt: "",

    /**
     * 截图服务释放延迟（秒）
     * 0 = 记账完成后立即释放（每次记账需重新授权）
     * 60 = 记账完成后保留 60 秒，期间再次记账无需授权
     */
    screenCaptureReleaseDelay: 60,

    billKeywords: [
        "支付",
        "付款",
        "收款",
        "转账",
        "消费",
        "订单",
        "账单",
        "退款",
        "金额",
        "余额",
        "交易",
        "商户",
        "￥",
        "¥",
        "元",
        "支出",
        "收入",
        "买单",
        "付款成功",
        "支付成功",
        "收款方",
        "付款方",
        "商品",
        "合计",
        "总计",
        "小计",
    ],
};

/**
 * 解析 centConfigText，提取 prompt、relayr 配置等
 * centConfigText 格式由 Cent 快捷记账设置页导出，包含：
 * { passcode, prompt, relayrURL, encryptKey, version, tags, currencies }
 */
function parseCentConfig() {
    if (!CONFIG.centConfigText) return;

    try {
        var sanitized = CONFIG.centConfigText
            .replace(/\n/g, "\\n")
            .replace(/\r/g, "\\r")
            .replace(/\t/g, "\\t");
        var cfg = JSON.parse(sanitized);
        if (cfg.prompt) {
            CONFIG.prompt = cfg.prompt;
        }
        if (cfg.relayrURL) {
            CONFIG.relayr.url = cfg.relayrURL;
        }
        if (cfg.passcode) {
            CONFIG.relayr.passcode = cfg.passcode;
        }
        if (cfg.encryptKey) {
            CONFIG.relayr.encryptKey = cfg.encryptKey;
        }
    } catch (e) {
        toast("Cent 配置解析失败，请检查格式");
        throw new Error("Cent 配置解析失败: " + e.message);
    }
}

// ==================== 二、截图模块 ====================

var _screenCaptureReady = false;
var _releaseThread = null;

function _cancelReleaseTimer() {
    if (_releaseThread) {
        _releaseThread.interrupt();
        _releaseThread = null;
    }
}

function _releaseScreenCapture() {
    try {
        images.stopScreenCapture();
    } catch (e) {}
    _screenCaptureReady = false;
    try {
        var nm = context.getSystemService(
            android.content.Context.NOTIFICATION_SERVICE,
        );
        nm.cancelAll();
    } catch (e) {}
}

/**
 * 截取当前屏幕，返回 ImageWrapper 对象（供 OCR 使用）
 * 调用方负责 recycle()
 */
function captureScreenImage(retryCount) {
    _cancelReleaseTimer();

    if (!_screenCaptureReady) {
        var granted = requestScreenCapture();
        if (!granted) {
            throw new Error("截图权限被拒绝");
        }
        _screenCaptureReady = true;
        sleep(800);
    }

    try {
        var img = captureScreen();
    } catch (e) {
        if (
            String(e).indexOf("MediaProjection") >= 0 &&
            (retryCount || 0) < 3
        ) {
            _screenCaptureReady = false;
            return captureScreenImage((retryCount || 0) + 1);
        }
        throw e;
    }

    if (!img || img.getWidth() <= 0) {
        throw new Error("截图失败");
    }

    if (isImageBlank(img)) {
        img.recycle();
        throw new Error("页面被安全保护，无法截图");
    }

    return img;
}

// ==================== 三、截图有效性检测 ====================

function isImageBlank(img) {
    var w = img.getWidth();
    var h = img.getHeight();
    var step = Math.max(1, Math.floor(Math.min(w, h) / 20));
    var total = 0;
    var bright = 0;
    for (var y = 0; y < h; y += step) {
        for (var x = 0; x < w; x += step) {
            var pixel = img.pixel(x, y);
            var r = (pixel >> 16) & 0xff;
            var g = (pixel >> 8) & 0xff;
            var b = pixel & 0xff;
            total++;
            if ((r + g + b) / 3 > 15) bright++;
        }
    }
    return total > 0 && bright / total < 0.05;
}

// ==================== 四、OCR 模块 ====================

/**
 * 对截图进行 OCR 识别，返回拼接的纯文本
 * 使用 ML Kit 引擎（内置，无需安装插件）
 */
function recognizeTextFromImage(img) {
    toast("OCR 识别中...");
    var startTime = Date.now();

    var results = ocr.detect(img);

    var lines = [];
    for (var i = 0; i < results.length; i++) {
        if (results[i].label) {
            lines.push(results[i].label);
        }
    }

    var text = lines.join("\n");
    var duration = Date.now() - startTime;
    toast("OCR 完成（" + duration + "ms，" + lines.length + " 行）");

    return text;
}

// ==================== 四、AI 文本分析模块 ====================

/**
 * 将 OCR 文本发给 AI，分析账单信息
 * 使用 OpenAI 兼容的 chat API 格式（纯文本，不含图片）
 */
function analyzeWithAI(ocrText) {
    toast("AI 分析文本中...");
    var startTime = Date.now();

    var payload = {
        model: CONFIG.ai.model,
        messages: [
            {
                role: "user",
                content:
                    CONFIG.prompt +
                    "\n\n以下是 OCR 识别到的屏幕文本内容：\n" +
                    ocrText +
                    '\n\n重要：如果以上文本不包含任何消费、支付、转账等账单相关信息（例如只是桌面图标、应用列表等无关内容），请不要生成任何<Bill>标签，直接回复"未识别到有效账单信息"即可。绝对不要从无关文本中推测或编造账单。',
            },
        ],
        stream: false,
    };

    var response = http.postJson(CONFIG.ai.apiUrl, payload, {
        headers: { Authorization: "Bearer " + CONFIG.ai.apiKey },
        timeout: CONFIG.ai.timeout || 60000,
    });

    var json = response.body.json();
    var duration = ((Date.now() - startTime) / 1000).toFixed(1);

    if (json.choices && json.choices[0] && json.choices[0].message) {
        toast("AI 分析完成（" + duration + " 秒）");
        return json.choices[0].message.content;
    }

    console.error("AI 原始响应: " + JSON.stringify(json));
    throw new Error("无法解析 AI 响应");
}

// ==================== 五、XML 提取模块 ====================

/**
 * 从 AI 输出中提取 <Bill>...</Bill> 块
 * Cent 端 parseBillsFromResponse 使用的正则: /<Bill>([\s\S]*?)(?:<\/Bill>|$)/gi
 */
function extractBillXml(rawText) {
    var matches = rawText.match(/<Bill>([\s\S]*?)(?:<\/Bill>|$)/gi);

    if (matches && matches.length > 0) {
        return matches.join("\n");
    }

    console.warn("AI 输出缺少 <Bill> 标签");
    console.warn("原始输出:\n" + rawText);
    return null;
}

/**
 * 校验 Bill XML 中每笔账单的必要字段
 * 必须包含 type（支出/收入）、category（非空）、amount（有效数字且 > 0）
 */
function validateBillXml(xmlContent) {
    var billRegex = /<Bill>([\s\S]*?)(?:<\/Bill>|$)/gi;
    var bill;
    var index = 0;
    while ((bill = billRegex.exec(xmlContent)) !== null) {
        index++;
        var content = bill[1] || bill[0];
        var typeMatch = content.match(/type\s*=\s*(.+)/i);
        var categoryMatch = content.match(/category\s*=\s*(.+)/i);
        var amountMatch = content.match(/amount\s*=\s*(.+)/i);

        if (!typeMatch) {
            return {
                valid: false,
                reason: "第 " + index + " 笔缺少 type 字段",
            };
        }
        var type = typeMatch[1].trim();
        if (type !== "支出" && type !== "收入") {
            return {
                valid: false,
                reason: "第 " + index + " 笔 type 无效: " + type,
            };
        }

        if (!categoryMatch || !categoryMatch[1].trim()) {
            return {
                valid: false,
                reason: "第 " + index + " 笔缺少 category 字段",
            };
        }

        if (!amountMatch) {
            return {
                valid: false,
                reason: "第 " + index + " 笔缺少 amount 字段",
            };
        }
        var amount = parseFloat(amountMatch[1].trim());
        if (isNaN(amount) || amount <= 0) {
            return {
                valid: false,
                reason:
                    "第 " + index + " 笔 amount 无效: " + amountMatch[1].trim(),
            };
        }
    }
    return { valid: true };
}

// ==================== 六、Relayr 写入模块 ====================

/**
 * 将 XML 账单写入 Relayr 临时信箱（阅后即焚）
 * Cent 端 _checkRelayrData 通过 GET ?key=<passcode> 读取
 */
function pushToRelayr(xmlContent) {
    var payload = {
        content: xmlContent,
        key: CONFIG.relayr.passcode,
    };

    if (CONFIG.relayr.encryptKey) {
        payload.encryptionKey = CONFIG.relayr.encryptKey;
    }

    var response = http.postJson(CONFIG.relayr.url, payload, {
        timeout: 15000,
    });
    var result = response.body.json();

    if (
        (result.message || "").toLowerCase().indexOf("success") >= 0 ||
        (result.message || "").toLowerCase().indexOf("stored") >= 0
    ) {
        toast("已写入 Relayr");
        return true;
    }

    throw new Error("Relayr 写入异常: " + JSON.stringify(result));
}

// ==================== 七、唤起 Cent ====================

/**
 * 打开本机安装的 Cent Android App
 * App 回到前台后 useQuickEntryByRelayr 会自动拉取 Relayr 数据并解析入账
 */
function launchCent() {
    toast("唤起 Cent App...");
    var packageName = CONFIG.cent.packageName;
    try {
        var Intent = android.content.Intent;
        var pm = context.getPackageManager();
        var intent = pm.getLaunchIntentForPackage(packageName);
        if (!intent) {
            throw new Error("未安装 Cent App: " + packageName);
        }

        intent.addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP,
        );
        context.startActivity(intent);
    } catch (e) {
        throw new Error("无法唤起 Cent App，请确认已安装 release APK");
    }
    sleep(CONFIG.cent.launchWait);
}

// ==================== 八、主流程 ====================

function main() {
    try {
        var img = captureScreenImage();

        var ocrText = recognizeTextFromImage(img);
        img.recycle();

        console.log("OCR 识别文本:\n" + ocrText);

        if (!ocrText || !ocrText.trim()) {
            throw new Error("OCR 未识别到文字");
        }
        if (
            ocrText.trim().split("\n").length < 2 ||
            ocrText.trim().length < 5
        ) {
            console.warn("OCR 内容不足，可能受屏幕保护影响:\n" + ocrText);
            throw new Error(
                "OCR 识别内容不足，请确认当前页面是否有可识别的文字",
            );
        }

        var lowerOcr = ocrText.toLowerCase();
        var keywords = CONFIG.billKeywords;
        var hasBillKeyword = false;
        for (var k = 0; k < keywords.length; k++) {
            if (lowerOcr.indexOf(keywords[k]) >= 0) {
                hasBillKeyword = true;
                break;
            }
        }
        if (!hasBillKeyword) {
            console.warn("OCR 未包含账单关键词，可能不是账单页面:\n" + ocrText);
            throw new Error(
                "当前页面未识别到账单相关信息，请确认是否停留在支付/账单页面",
            );
        }

        var aiOutput = analyzeWithAI(ocrText);

        console.log("AI 原始输出:\n" + aiOutput);

        var billXml = extractBillXml(aiOutput);
        if (!billXml) {
            throw new Error("AI 未能解析出账单信息");
        }

        var validation = validateBillXml(billXml);
        if (!validation.valid) {
            console.warn("Bill XML 校验失败: " + validation.reason);
            console.warn("Bill XML 内容:\n" + billXml);
            throw new Error("AI 解析结果无效: " + validation.reason);
        }

        console.log("Bill XML:\n" + billXml);

        pushToRelayr(billXml);

        launchCent();

        toast("记账流程完成");
    } catch (err) {
        console.error("记账异常:", err);
        toast(err.message || "记账失败");
    } finally {
        var delay = CONFIG.screenCaptureReleaseDelay || 0;
        if (delay <= 0) {
            _releaseScreenCapture();
        } else {
            _cancelReleaseTimer();
            _releaseThread = threads.start(() => {
                try {
                    sleep(delay * 1000);
                    _releaseScreenCapture();
                } catch (e) {}
            });
        }
    }
}

// ==================== 九、配置检查 ====================

var _configReady = false;

function checkConfig() {
    try {
        parseCentConfig();
    } catch (e) {
        toast("配置解析失败");
        console.error("配置解析失败:", e);
        return false;
    }
    if (!CONFIG.ai.apiKey) {
        toast("缺少 AI API Key");
        console.error("请填写 CONFIG.ai.apiKey");
        return false;
    }
    if (!CONFIG.relayr.url || !CONFIG.relayr.passcode) {
        toast("缺少 Relayr 配置");
        console.error(
            "请填写 CONFIG.centConfigText（推荐）或手动填写 relayr.url 和 relayr.passcode",
        );
        return false;
    }
    if (!CONFIG.prompt) {
        toast("缺少 Prompt 配置");
        console.error("请填写 CONFIG.centConfigText（推荐）或手动填写 prompt");
        return false;
    }
    return true;
}

// ==================== 十、触发方式 ====================

var _busy = false;

events.observeKey();
events.onKeyDown("volume_down", () => {
    if (_busy || !_configReady) return;
    _busy = true;
    threads.start(() => {
        try {
            main();
        } finally {
            _busy = false;
        }
    });
});
if (checkConfig()) {
    _configReady = true;
    toast("音量下键记账已就绪");
} else {
    toast("配置不完整，请检查日志");
}

// 【调试用】直接运行（取消注释后按一次立即执行）
// threads.start(function () { main(); });
