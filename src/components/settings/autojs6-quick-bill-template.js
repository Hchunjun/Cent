// biome-ignore-all lint: AutoJS6 compatibility script
/**
 * ============================================================
 * Cent 快捷记账 - AutoJs6 版（无障碍/OCR + AI 文本分析）
 * ============================================================
 * 功能：无障碍读取文本（优先）/截图 OCR（兜底）→ AI 文本分析 → XML → Cent Android App
 * AI 只处理纯文本（~2-3秒），总耗时通常 3-5 秒
 *
 * 前置要求：
 * 1. AutoJs6 已开启无障碍服务、悬浮窗权限
 * 2. 已安装 Cent Android App
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
     * 如果填写了此项，下方的 prompt 将被忽略
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
        deepLinkScheme: "cent-accounting",
        launchWait: 2000,
    },

    /**
     * 以下为手动配置项，仅当 centConfigText 为空时生效
     * 建议使用 centConfigText 方式，可自动同步 Cent 端的分类变更
     */
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
 * 解析 centConfigText，提取 prompt、Cent 配置等
 * centConfigText 格式由 Cent 快捷记账设置页导出，包含：
 * { prompt, version, tags, currencies, packageName, deepLinkScheme }
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
        if (cfg.packageName) {
            CONFIG.cent.packageName = cfg.packageName;
        }
        if (cfg.deepLinkScheme) {
            CONFIG.cent.deepLinkScheme = cfg.deepLinkScheme;
        }
    } catch (e) {
        toast("Cent 配置解析失败，请检查格式");
        throw new Error("Cent 配置解析失败: " + e.message);
    }
}

// ==================== 二、文本采集模块 ====================

function normalizeCollectedText(value) {
    if (value === null || value === undefined) return "";
    return String(value).replace(/\s+/g, " ").trim();
}

function appendUniqueLine(lines, seen, value) {
    var text = normalizeCollectedText(value);
    if (!text || seen[text]) return;
    seen[text] = true;
    lines.push(text);
}

function getCollectionSize(collection) {
    if (!collection) return 0;
    if (typeof collection.size === "function") {
        return collection.size();
    }
    return collection.length || 0;
}

function getCollectionItem(collection, index) {
    if (collection && typeof collection.get === "function") {
        return collection.get(index);
    }
    return collection[index];
}

function collectNodeText(collection, getterName, lines, seen) {
    var size = getCollectionSize(collection);
    for (var i = 0; i < size; i++) {
        var node = getCollectionItem(collection, i);
        if (!node || typeof node[getterName] !== "function") continue;
        appendUniqueLine(lines, seen, node[getterName]());
    }
}

/**
 * 支付宝等安全页面可能禁止截图，但无障碍树仍可能暴露金额、商户、时间等文本。
 */
function collectTextFromAccessibility() {
    toast("读取页面文本中...");
    var lines = [];
    var seen = {};

    try {
        collectNodeText(textMatches(/\S+/).find(), "text", lines, seen);
    } catch (e) {
        console.warn("读取无障碍 text 失败: " + e.message);
    }

    try {
        collectNodeText(descMatches(/\S+/).find(), "desc", lines, seen);
    } catch (e) {
        console.warn("读取无障碍 desc 失败: " + e.message);
    }

    var text = lines.join("\n");
    if (text) {
        console.log("无障碍读取文本:\n" + text);
    }
    return text;
}

function hasBillKeyword(text) {
    var lowerText = text.toLowerCase();
    var keywords = CONFIG.billKeywords;
    for (var k = 0; k < keywords.length; k++) {
        if (lowerText.indexOf(keywords[k]) >= 0) {
            return true;
        }
    }
    return false;
}

function validateCollectedText(text, sourceName) {
    var trimmed = text ? text.trim() : "";
    if (!trimmed) {
        return sourceName + "未识别到文字";
    }
    if (trimmed.length < 5) {
        return sourceName + "内容不足，请确认当前页面是否有可识别的文字";
    }
    if (!hasBillKeyword(text)) {
        return sourceName + "未包含账单关键词，请确认是否停留在支付/账单页面";
    }
    return null;
}

function collectTextFromScreenOcr() {
    var img = captureScreenImage();

    try {
        var text = recognizeTextFromImage(img);
        console.log("OCR 识别文本:\n" + text);
        return text;
    } finally {
        img.recycle();
    }
}

function collectBillText() {
    var accessibilityText = collectTextFromAccessibility();
    var accessibilityError = validateCollectedText(
        accessibilityText,
        "无障碍",
    );
    if (!accessibilityError) {
        toast("无障碍读取页面...");
        return accessibilityText;
    }

    console.warn(accessibilityError + "，尝试截图 OCR");

    var ocrText;
    try {
        ocrText = collectTextFromScreenOcr();
    } catch (e) {
        throw new Error(e.message + "；无障碍结果：" + accessibilityError);
    }
    var ocrError = validateCollectedText(ocrText, "OCR");
    if (!ocrError) {
        return ocrText;
    }

    throw new Error(ocrError + "；无障碍结果：" + accessibilityError);
}

// ==================== 三、截图模块 ====================

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

// ==================== 四、截图有效性检测 ====================

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

// ==================== 五、OCR 模块 ====================

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

// ==================== 六、AI 文本分析模块 ====================

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
                    "\n\n以下是从当前页面识别到的文本内容：\n" +
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

// ==================== 七、XML 提取模块 ====================

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

// ==================== 八、唤起 Cent ====================

/**
 * 通过 Android deep link 打开本机安装的 Cent Android App，并直接传入 Bill XML。
 */
function openCentWithDeepLink(xmlContent) {
    toast("唤起 Cent App...");
    try {
        var Intent = android.content.Intent;
        var Uri = android.net.Uri;
        var url =
            CONFIG.cent.deepLinkScheme +
            "://add-bills?text=" +
            encodeURIComponent(xmlContent);
        var intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));

        intent.setPackage(CONFIG.cent.packageName);
        intent.addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP,
        );
        context.startActivity(intent);
    } catch (e) {
        throw new Error(
            "无法通过 deep link 唤起 Cent App，请确认已安装新版 release APK",
        );
    }
    sleep(CONFIG.cent.launchWait);
}

// ==================== 九、主流程 ====================

function main() {
    try {
        var pageText = collectBillText();

        var aiOutput = analyzeWithAI(pageText);

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

        openCentWithDeepLink(billXml);

        toast("记账流程完成");
    } catch (err) {
        console.error("记账异常:", err);
        toast(err.message || "记账失败");
    } finally {
        if (!_screenCaptureReady) {
            return;
        }
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

// ==================== 十、配置检查 ====================

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
    if (!CONFIG.prompt) {
        toast("缺少 Prompt 配置");
        console.error("请填写 CONFIG.centConfigText（推荐）或手动填写 prompt");
        return false;
    }
    return true;
}

// ==================== 十一、触发方式 ====================

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
