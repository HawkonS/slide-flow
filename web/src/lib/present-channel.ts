import { useEffect, useRef, useState } from 'react';

function createPlaybackSessionId(): string {
  const cryptoApi = globalThis.crypto;
  try {
    if (typeof cryptoApi?.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      cryptoApi.getRandomValues(bytes);
      return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    // Some embedded app shells expose Web Crypto but reject calls from their context.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export type PresentMessage =
  | { type: 'slide-change'; resourceId: number; index: number }
  | { type: 'pen-draw'; points: { x: number; y: number }[]; color: string; width: number }
  | { type: 'pen-erase'; index: number }
  | { type: 'pen-clear' }
  | { type: 'laser-move'; x: number; y: number; visible: boolean }
  | { type: 'session-end' }
  | { type: 'request-sync' }
  | { type: 'sync-state'; resourceId: number; index: number; source: 'online' | 'cache'; packageId?: string; snapshot: string; imageFit?: 'contain' | 'fill' }
  | { type: 'image-fit-change'; imageFit: 'contain' | 'fill' };

export interface PresentScope { ownerKey: string; sessionId: string; packageId?: string }
export function presentChannelName(showId: number, scope: PresentScope): string {
  if (!Number.isInteger(showId) || showId <= 0 || !scope.ownerKey || !/^[a-zA-Z0-9_-]{16,80}$/.test(scope.sessionId)) throw new Error('无效的播放会话');
  return 'slideflow-present-v3:' + [scope.ownerKey, showId, scope.sessionId, scope.packageId ?? 'online'].map(value => encodeURIComponent(String(value))).join(':');
}

export function isPresentMessage(value: unknown): value is PresentMessage {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const index = () => Number.isInteger(item.index) && Number(item.index) >= 0 && Number(item.index) < 100_000;
  const finite = (number: unknown) => typeof number === 'number' && Number.isFinite(number) && Math.abs(number) < 1_000_000;
  switch (item.type) {
    case 'slide-change': return index() && Number.isInteger(item.resourceId) && Number(item.resourceId) > 0;
    case 'sync-state': return index() && Number.isInteger(item.resourceId) && Number(item.resourceId) >= 0
      && (item.source === 'online' || item.source === 'cache') && (item.packageId === undefined || typeof item.packageId === 'string')
      && typeof item.snapshot === 'string' && item.snapshot.length <= 200_000
      && (item.imageFit === undefined || item.imageFit === 'contain' || item.imageFit === 'fill');
    case 'pen-draw': return Array.isArray(item.points) && item.points.length <= 20_000 && item.points.every(point => point && finite(point.x) && finite(point.y))
      && typeof item.color === 'string' && /^#[a-fA-F0-9]{3,8}$/.test(item.color) && finite(item.width) && Number(item.width) > 0;
    case 'pen-erase': return index();
    case 'laser-move': return finite(item.x) && finite(item.y) && typeof item.visible === 'boolean';
    case 'image-fit-change': return item.imageFit === 'contain' || item.imageFit === 'fill';
    case 'pen-clear': case 'session-end': case 'request-sync': return true;
    default: return false;
  }
}

export class PresentChannel {
  private channel: BroadcastChannel;
  private listeners = new Set<(message: PresentMessage) => void>();
  private name: string;
  constructor(showId: number, scope: PresentScope) {
    this.name = presentChannelName(showId, scope);
    this.channel = new BroadcastChannel(this.name);
    this.channel.onmessage = event => {
      const envelope = event.data;
      if (envelope?.version !== 3 || envelope?.scope !== this.name || !isPresentMessage(envelope.message)) return;
      this.listeners.forEach(listener => listener(envelope.message));
    };
  }
  send(message: PresentMessage) { if (isPresentMessage(message)) this.channel.postMessage({ version: 3, scope: this.name, message }); }
  onMessage(listener: (message: PresentMessage) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  close() { this.channel.close(); this.listeners.clear(); }
}

export function usePlaybackSessionId(required = false): string {
  return useState(() => {
    const value = new URLSearchParams(window.location.search).get('playback_session');
    if (value && /^[a-zA-Z0-9_-]{16,80}$/.test(value)) return value;
    return required ? '' : createPlaybackSessionId();
  })[0];
}

export function usePresentChannel(showId: number, scope?: PresentScope) {
  const ref = useRef<PresentChannel | null>(null);
  useEffect(() => {
    if (!showId || !scope?.ownerKey || !scope.sessionId) return;
    const channel = new PresentChannel(showId, scope);
    ref.current = channel;
    return () => { channel.close(); ref.current = null; };
  }, [showId, scope?.ownerKey, scope?.sessionId, scope?.packageId]);
  return ref;
}
