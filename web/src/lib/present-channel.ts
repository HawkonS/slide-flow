import { useEffect, useRef } from 'react';

export type PresentMessage =
  | { type: 'slide-change'; resourceId: number; index: number }
  | { type: 'pen-draw'; points: { x: number; y: number }[]; color: string; width: number }
  | { type: 'pen-erase'; index: number }
  | { type: 'pen-clear' }
  | { type: 'laser-move'; x: number; y: number; visible: boolean }
  | { type: 'session-end' }
  | { type: 'request-sync' }  // display窗口请求当前状态
  | { type: 'sync-state'; resourceId: number; index: number; sessionToken: string; imageFit?: 'contain' | 'fill' }  // 主控回复当前状态
  | { type: 'image-fit-change'; imageFit: 'contain' | 'fill' }  // 图片显示模式切换
  | { type: 'frame-update'; dataUrl: string };

export class PresentChannel {
  private channel: BroadcastChannel;
  private listeners: ((msg: PresentMessage) => void)[] = [];

  constructor(showId: number) {
    this.channel = new BroadcastChannel(`slideflow-present-${showId}`);
    this.channel.onmessage = (event) => {
      const msg = event.data as PresentMessage;
      this.listeners.forEach(fn => fn(msg));
    };
  }

  send(msg: PresentMessage): void {
    this.channel.postMessage(msg);
  }

  onMessage(listener: (msg: PresentMessage) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(fn => fn !== listener);
    };
  }

  close(): void {
    this.channel.close();
    this.listeners = [];
  }
}

// React hook for easy usage
export function usePresentChannel(showId: number | undefined) {
  const channelRef = useRef<PresentChannel | null>(null);

  useEffect(() => {
    if (!showId) return;
    const ch = new PresentChannel(showId);
    channelRef.current = ch;
    return () => {
      ch.close();
      channelRef.current = null;
    };
  }, [showId]);

  return channelRef;
}
