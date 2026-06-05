import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { useEffect } from "react";
import { toast } from "sonner";
import { xmlTextToBills } from "@/components/assistant/text-to-bill";
import { useIntl } from "@/locale";
import { useLedgerStore } from "@/store/ledger";

const LAST_QUICK_ENTRY_URL_KEY = "cent.lastQuickEntryUrl";

/**
 * 处理标准 URL 链接唤起
 * 支持格式:
 * - https://myapp.com/add-bills?text=xxx
 * - cent-accounting://add-bills?text=xxx
 */
export function useUrlHandler() {
    const t = useIntl();

    useEffect(() => {
        const handleQuickEntryText = async (text: string) => {
            try {
                const bills = await xmlTextToBills(text);
                if (bills.length > 0) {
                    await useLedgerStore.getState().addBills(bills);
                    toast.success(
                        t("voice-add-success", { count: bills.length }),
                    );
                } else {
                    toast.error(t("voice-recognition-failed", { error: "" }));
                }
            } catch (error) {
                console.error("处理 URL 参数失败:", error);
                toast.error(
                    t("voice-recognition-failed", {
                        error: error instanceof Error ? error.message : "",
                    }),
                );
            }
        };

        const handleUrlLaunch = async (rawUrl: string) => {
            const url = new URL(rawUrl);
            const pathname = url.pathname;
            const searchParams = url.searchParams;
            const isWebAddBills =
                pathname === "/add-bills" || pathname === "/add-bills/";
            const isAndroidAddBills =
                url.protocol === "cent-accounting:" &&
                url.hostname === "add-bills";

            if (!isWebAddBills && !isAndroidAddBills) {
                return;
            }

            const text = searchParams.get("text") ?? "";
            if (!text) {
                return;
            }

            const quickEntryKey = `${url.protocol}//${url.host}${url.pathname}?text=${text}`;
            if (
                sessionStorage.getItem(LAST_QUICK_ENTRY_URL_KEY) ===
                quickEntryKey
            ) {
                return;
            }
            sessionStorage.setItem(LAST_QUICK_ENTRY_URL_KEY, quickEntryKey);

            if (isWebAddBills) {
                window.history.replaceState({}, "", "/");
            }

            await handleQuickEntryText(text);
        };

        handleUrlLaunch(window.location.href);

        if (!Capacitor.isNativePlatform()) {
            return;
        }

        App.getLaunchUrl().then((launchUrl) => {
            if (launchUrl?.url) {
                handleUrlLaunch(launchUrl.url);
            }
        });

        const listener = App.addListener("appUrlOpen", (event) => {
            handleUrlLaunch(event.url);
        });

        return () => {
            listener.then((handle) => handle.remove());
        };
    }, [t]);
}
