import { useEffect, useState } from "react";
import { useCopyToClipboard } from "react-use";
import { toast } from "sonner";
import { v4 } from "uuid";
import { useShallow } from "zustand/shallow";
import { getQuickCurrencies } from "@/hooks/use-currency";
import PopupLayout from "@/layouts/popup-layout";
import { useIntl } from "@/locale";
import { useLedgerStore } from "@/store/ledger";
import { usePreferenceStore } from "@/store/preference";
import { decodeApiKey } from "@/utils/api-key";
import { generateSymmetricKey } from "@/utils/encrypt";
import { getAIConfig } from "../assistant/request";
import {
    getCategoriesStr,
    textToBillSystemPrompt,
} from "../assistant/text-to-bill";
import createConfirmProvider from "../confirm";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import autojs6QuickBillScript from "./autojs6-quick-bill-template.js?raw";

/**
 * 生成随机字符串（用于 passcode）
 */
function generateRandomPasscode(): string {
    return `relayr-${v4()}`;
}

function buildOpenAIChatUrl(apiUrl: string): string {
    const normalizedUrl = apiUrl.trim().replace(/\/+$/, "");
    if (!normalizedUrl) return "";
    if (normalizedUrl.endsWith("/chat/completions")) {
        return normalizedUrl;
    }
    return `${normalizedUrl}/chat/completions`;
}

function replaceScriptStringConfig(
    script: string,
    key: string,
    value: string,
): string {
    const pattern = new RegExp(
        `(${key}:\\s*)(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`,
        "m",
    );
    const nextScript = script.replace(pattern, `$1${JSON.stringify(value)}`);
    if (nextScript === script) {
        throw new Error(`AutoJS6 template missing ${key}`);
    }
    return nextScript;
}

function Form({ onCancel }: { onCancel?: () => void }) {
    const t = useIntl();

    // 获取 relayr 配置
    const relayrConfig = usePreferenceStore(
        useShallow((state) => state.relayr),
    );

    const [enable, setEnable] = useState(relayrConfig?.enable ?? false);
    const [secret, setSecret] = useState(relayrConfig?.passcode ?? "");
    const [showSecret, setShowSecret] = useState(false);
    const [configText, setConfigText] = useState<string>("");

    // 同步 store 的值到本地状态
    useEffect(() => {
        setEnable(relayrConfig?.enable ?? false);
        setSecret(relayrConfig?.passcode ?? "");
    }, [relayrConfig]);

    const handleEnableChange = async (checked: boolean) => {
        setEnable(checked);

        if (checked) {
            // 开启服务：生成新的对称加密密钥和 passcode
            try {
                const newPasscode = generateRandomPasscode();
                const encryptKey = generateSymmetricKey();

                // 立即更新本地状态
                setSecret(newPasscode);

                usePreferenceStore.setState((prev) => ({
                    ...prev,
                    relayr: {
                        enable: true,
                        passcode: newPasscode,
                        encryptKey: encryptKey,
                    },
                }));

                toast.success(t("relayr-enabled"));
            } catch (error) {
                console.error("开启 Relayr 服务失败:", error);
                toast.error(t("relayr-enable-failed"));
                setEnable(false);
            }
        } else {
            // 关闭服务：清空所有 relayr 相关配置
            usePreferenceStore.setState((prev) => {
                return Object.fromEntries(
                    Object.entries(prev).filter(([key]) => key !== "relayr"),
                ) as typeof prev;
            });
            setSecret("");
            toast.success(t("relayr-disabled"));
        }
    };

    const [, copy] = useCopyToClipboard();
    const handleSecretChange = (value: string) => {
        setSecret(value);
        usePreferenceStore.setState((prev) => ({
            ...prev,
            relayr: {
                ...(prev.relayr ?? {}),
                passcode: value,
            },
        }));
    };
    const buildQuickEntryBaseConfig = () => {
        const prompt = textToBillSystemPrompt(getCategoriesStr(), false);
        return {
            prompt,
            version: "1.0",
            tags: useLedgerStore
                .getState()
                .infos?.meta.tags?.map((v) => v.name)
                .join(","),
            currencies: getQuickCurrencies().map((v) => v.label),
        };
    };
    const buildQuickEntryConfigText = () => {
        return JSON.stringify({
            ...buildQuickEntryBaseConfig(),
            passcode: secret,
            relayrURL: import.meta.env.VITE_RELAYR_URL,
            encryptKey: relayrConfig?.encryptKey,
        });
    };
    const buildAndroidAutojsConfigText = () => {
        return JSON.stringify({
            ...buildQuickEntryBaseConfig(),
            packageName: "work.linkai.cent",
            deepLinkScheme: "cent-accounting",
        });
    };
    const handleCopyAutojs6Script = () => {
        let aiConfig: ReturnType<typeof getAIConfig>;
        try {
            aiConfig = getAIConfig();
        } catch (error) {
            console.error("获取 AI 配置失败:", error);
            toast.error(t("autojs6-ai-config-required"));
            return;
        }

        if (aiConfig.apiType !== "open-ai-compatible") {
            toast.error(t("autojs6-ai-config-unsupported"));
            return;
        }

        const apiKey = decodeApiKey(aiConfig.apiKey).trim();
        const apiUrl = buildOpenAIChatUrl(aiConfig.apiUrl);
        const model = aiConfig.model.trim();

        if (!apiKey || !apiUrl || !model) {
            toast.error(t("autojs6-ai-config-incomplete"));
            return;
        }

        try {
            const configTextValue = buildAndroidAutojsConfigText();
            let script = autojs6QuickBillScript;
            script = replaceScriptStringConfig(
                script,
                "centConfigText",
                configTextValue,
            );
            script = replaceScriptStringConfig(script, "apiKey", apiKey);
            script = replaceScriptStringConfig(script, "apiUrl", apiUrl);
            script = replaceScriptStringConfig(script, "model", model);
            copy(script);
            toast.success(t("autojs6-script-copied"), { duration: 2000 });
        } catch (error) {
            console.error("生成 AutoJS6 脚本失败:", error);
            toast.error(t("autojs6-script-build-failed"));
        }
    };

    return (
        <PopupLayout
            title={t("quick-entry-settings")}
            onBack={onCancel}
            className="h-full overflow-hidden"
        >
            <div className="flex-1 flex flex-col overflow-y-auto py-4">
                {/* Relayr 开关 */}
                <div className="w-full min-h-10 pb-2 flex justify-between items-center px-4 gap-2">
                    <div className="text-sm">
                        <div>{t("enable-relayr")}</div>
                        <div className="text-xs opacity-60">
                            {t("enable-relayr-description")}
                        </div>
                    </div>
                    <Switch
                        checked={enable}
                        onCheckedChange={handleEnableChange}
                    />
                </div>

                {/* Secret 输入框 */}
                {enable && (
                    <div className="w-full px-4 pb-2 flex flex-col gap-2">
                        <div className="text-sm">
                            <div>{t("relayr-secret")}</div>
                            <div className="text-xs opacity-60">
                                {t("relayr-secret-description")}
                            </div>
                        </div>
                        <div className="relative">
                            <Input
                                type={showSecret ? "text" : "password"}
                                value={secret}
                                onChange={(e) =>
                                    handleSecretChange(e.target.value)
                                }
                                disabled
                                placeholder={t("relayr-secret-placeholder")}
                                className="w-full pr-10"
                            />
                            <button
                                type="button"
                                onClick={() => setShowSecret(!showSecret)}
                                className="absolute right-0 top-0 h-full px-3 flex items-center text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
                            >
                                {showSecret ? (
                                    <i className="icon-[mdi--eye-off] size-4"></i>
                                ) : (
                                    <i className="icon-[mdi--eye] size-4"></i>
                                )}
                            </button>
                        </div>
                    </div>
                )}

                {/* For：iOS 区域 */}
                {enable && secret && (
                    <div className="w-full px-4 py-4 border-t border-gray-200 dark:border-gray-700">
                        <div className="text-sm font-medium mb-3">
                            {t("ios")}
                        </div>

                        {/* 第一步：复制快捷指令配置 */}
                        <div className="mb-3">
                            <div className="text-xs opacity-60 mb-2">
                                {t("step-1")}
                            </div>
                            <Button
                                type="button"
                                variant="outline"
                                onClick={async () => {
                                    const configTextValue =
                                        buildQuickEntryConfigText();
                                    setConfigText(configTextValue);
                                    copy(configTextValue);
                                    // 显示复制成功的提示消息，持续时间为 2 秒
                                    toast.success(
                                        t("quick-entry-config-copied"),
                                        { duration: 2000 },
                                    );
                                }}
                                className="w-full"
                            >
                                <i className="icon-[mdi--content-copy] size-4 mr-2"></i>
                                {t("copy-quick-entry-config")}
                            </Button>
                            {configText && (
                                <div className="mt-2 h-[70px] overflow-y-auto !select-all text-xs text-gray-600 dark:text-gray-400 break-all font-mono bg-gray-50 dark:bg-gray-800 p-2 rounded border border-gray-200 dark:border-gray-700">
                                    {configText}
                                </div>
                            )}
                        </div>

                        {/* 第二步：安装快捷指令Relayr版 */}
                        <div>
                            <div className="text-xs opacity-60 mb-2">
                                {t("step-2")}
                            </div>
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => {
                                    window.open(
                                        "https://www.icloud.com/shortcuts/31529bde07134e5d931b51ed158ea303",
                                        "_blank",
                                        "noopener,noreferrer",
                                    );
                                }}
                                className="w-full"
                            >
                                {t("install-shortcut")}
                            </Button>
                        </div>
                    </div>
                )}

                {/* For：Android 区域 */}
                <div className="w-full px-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                    <div className="text-sm font-medium mb-3">
                        {t("android")}
                    </div>
                    <Button
                        type="button"
                        variant="outline"
                        onClick={handleCopyAutojs6Script}
                        className="w-full"
                    >
                        <i className="icon-[mdi--content-copy] size-4 mr-2"></i>
                        {t("copy-autojs6-script")}
                    </Button>
                </div>

                {/* 帮助链接 */}
                <div className="w-full px-4 pt-4 inline-flex justify-center">
                    <a
                        href={t("quick-entry-help-url")}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs opacity-60 hover:opacity-80 transition-opacity flex items-center gap-1 text-blue-500 hover:text-blue-600 underline"
                    >
                        <i className="icon-[mdi--help-circle-outline] size-4"></i>
                        {t("quick-entry-help-link")}
                    </a>
                </div>
            </div>
        </PopupLayout>
    );
}

const [QuickEntrySettingsProvider, showQuickEntrySettings] =
    createConfirmProvider(Form, {
        dialogTitle: "quick-entry-settings",
        dialogModalClose: true,
        contentClassName:
            "h-full w-full max-h-full max-w-full rounded-none sm:rounded-md sm:max-h-[min(520px,calc(100vh-32px))] sm:w-[90vw] sm:max-w-[500px]",
    });

export default function QuickEntrySettingsItem() {
    const t = useIntl();

    return (
        <div className="quick-entry-settings">
            <Button
                onClick={() => {
                    showQuickEntrySettings();
                }}
                variant="ghost"
                className="w-full py-4 rounded-none h-auto"
            >
                <div className="w-full px-4 flex justify-between items-center">
                    <div className="flex items-center gap-2">
                        <i className="icon-[mdi--lightning-bolt-outline] size-5"></i>
                        {t("quick-entry-settings")}
                    </div>
                    <i className="icon-[mdi--chevron-right] size-5"></i>
                </div>
            </Button>
            <QuickEntrySettingsProvider />
        </div>
    );
}
