import React, { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

export default function LinkSharePage() {
  const [searchParams] = useSearchParams();
  const url = searchParams.get("url") || "";
  const name = searchParams.get("name") || "";
  const [status, setStatus] = useState<"starting" | "sharing" | "failed">("starting");
  const [errorMsg, setErrorMsg] = useState("");
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;

    const startCapture = async () => {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { displaySurface: "browser" } as any,
          audio: false,
          selfBrowserSurface: "exclude",
          surfaceSwitching: "exclude",
        } as any);

        if (cancelled) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }

        streamRef.current = stream;
        setStatus("sharing");

        // 传递流给 opener（PresenterPage）
        if (window.opener && (window.opener as any).__onMirrorStream) {
          (window.opener as any).__onMirrorStream(stream);
        }

        // 监听流结束
        stream.getVideoTracks()[0].onended = () => {
          streamRef.current = null;
          setStatus("failed");
          setErrorMsg("共享已停止");
          if (window.opener && (window.opener as any).__onMirrorEnd) {
            (window.opener as any).__onMirrorEnd();
          }
        };

        // 缩小窗口（共享开始后不需要大窗口）
        try {
          window.resizeTo(360, 160);
        } catch {}
      } catch (err: any) {
        if (cancelled) return;
        console.warn("getDisplayMedia failed:", err);
        setStatus("failed");
        setErrorMsg(err?.message || "无法启动屏幕共享");
        // 通知 opener 走 fallback
        if (window.opener && (window.opener as any).__onMirrorFallback) {
          (window.opener as any).__onMirrorFallback();
        }
      }
    };

    const timer = setTimeout(startCapture, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [url]);

  // 页面关闭时停止流并通知 opener
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }
      if (window.opener && (window.opener as any).__onMirrorEnd) {
        (window.opener as any).__onMirrorEnd();
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  const handleStop = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    window.close();
  };

  return (
    <div className="w-screen h-screen bg-gray-900 flex flex-col items-center justify-center p-4">
      {status === "starting" && (
        <div className="text-center space-y-3">
          <div className="animate-spin h-8 w-8 border-4 border-blue-400 border-t-transparent rounded-full mx-auto" />
          <p className="text-white text-base">正在启动共享...</p>
          <p className="text-gray-400 text-xs">请在弹出的对话框中选择要共享的标签页</p>
        </div>
      )}
      {status === "sharing" && (
        <div className="text-center space-y-3">
          <div className="h-3 w-3 bg-red-500 rounded-full animate-pulse mx-auto" />
          <p className="text-white text-sm font-medium">正在共享</p>
          <p className="text-gray-400 text-xs truncate max-w-full">{name || url}</p>
          <button
            onClick={handleStop}
            className="mt-2 px-3 py-1.5 bg-red-600 hover:bg-red-700 rounded text-white text-xs"
          >
            停止共享
          </button>
        </div>
      )}
      {status === "failed" && (
        <div className="text-center space-y-3">
          <p className="text-white text-sm">{errorMsg || "共享失败"}</p>
          <p className="text-gray-400 text-xs">可关闭此窗口</p>
          <button
            onClick={() => window.close()}
            className="mt-2 px-3 py-1.5 bg-gray-600 hover:bg-gray-700 rounded text-white text-xs"
          >
            关闭
          </button>
        </div>
      )}
    </div>
  );
}
