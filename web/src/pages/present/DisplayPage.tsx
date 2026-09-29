import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { PresentChannel, usePlaybackSessionId, type PresentMessage } from '@/lib/present-channel';
import { useShowPlayback } from '@/lib/use-show-playback';
import { DrawingCanvas, type DrawingCanvasRef } from '@/components/present/DrawingCanvas';

type SyncedState = Extract<PresentMessage, { type: 'sync-state' }>;

export function DisplayPage() {
  const { id } = useParams<{ id: string }>();
  const showId = Number(id);
  const playbackSession = usePlaybackSessionId(true);
  const [route] = useState(() => new URLSearchParams(window.location.search));
  const fixedPackageId = route.get('package_id') ?? undefined;
  const [sync, setSync] = useState<SyncedState | null>(null);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [resourceId, setResourceId] = useState(0);
  const [imageFit, setImageFit] = useState<'contain' | 'fill'>('contain');
  const [ended, setEnded] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [cursorHidden, setCursorHidden] = useState(false);
  const [loadedUrl, setLoadedUrl] = useState('');
  const playback = useShowPlayback(showId, currentSlide, {
    enabled: !!sync && !ended,
    packageId: fixedPackageId,
    preferCache: sync?.source === 'cache',
    expectedSnapshot: sync?.snapshot,
  });
  const canvasRef = useRef<DrawingCanvasRef>(null);
  const slideImageRef = useRef<HTMLImageElement>(null);
  const cursorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!playbackSession || !Number.isInteger(showId) || showId <= 0) {
      setSyncError('此播放窗口没有有效会话，请从主控重新打开用户视图');
      return;
    }
    if (!playback.ownerKey) return;
    const channel = new PresentChannel(showId, { ownerKey: playback.ownerKey, sessionId: playbackSession, packageId: fixedPackageId });
    let received = false;
    let lastSyncAt = Date.now();
    let snapshot: string | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = channel.onMessage(message => {
      switch (message.type) {
        case 'sync-state':
          if (message.packageId !== fixedPackageId || (snapshot && message.snapshot !== snapshot)) {
            setSyncError('主控播放版本已变化，请重新打开用户视图');
            return;
          }
          snapshot = message.snapshot;
          received = true;
          lastSyncAt = Date.now();
          setSyncError(null);
          setSync(message);
          setResourceId(message.resourceId);
          setCurrentSlide(message.index);
          if (message.imageFit) setImageFit(message.imageFit);
          break;
        case 'slide-change':
          if (!received) return;
          setResourceId(message.resourceId); setCurrentSlide(message.index);
          break;
        case 'pen-draw': canvasRef.current?.drawRemotePen(message.points, message.color, message.width); break;
        case 'pen-clear': canvasRef.current?.clearAll(); break;
        case 'pen-erase': canvasRef.current?.eraseStroke(message.index); break;
        case 'laser-move': canvasRef.current?.moveRemoteLaser(message.x, message.y, message.visible); break;
        case 'image-fit-change': setImageFit(message.imageFit); break;
        case 'session-end':
          setEnded(true);
          closeTimer = setTimeout(() => window.close(), 3000);
          break;
      }
    });
    // Subscribe before requesting state; retry also covers popup startup races.
    channel.send({ type: 'request-sync' });
    const retry = setInterval(() => {
      channel.send({ type: 'request-sync' });
      if (received && Date.now() - lastSyncAt > 15_000) setSyncError('与主控的连接已中断，请从主控重新打开用户视图');
    }, 3000);
    const deadline = setTimeout(() => { if (!received) setSyncError('未连接到主控，请回到主控后重新打开用户视图'); }, 15_000);
    void document.documentElement.requestFullscreen().catch(() => undefined);
    return () => {
      clearInterval(retry); clearTimeout(deadline); clearTimeout(closeTimer);
      unsubscribe(); channel.close();
    };
  }, [showId, playbackSession, playback.ownerKey, fixedPackageId]);

  const resetCursorTimer = useCallback(() => {
    setCursorHidden(false);
    if (cursorTimerRef.current) clearTimeout(cursorTimerRef.current);
    cursorTimerRef.current = setTimeout(() => setCursorHidden(true), 3000);
  }, []);
  useEffect(() => {
    resetCursorTimer();
    return () => { if (cursorTimerRef.current) clearTimeout(cursorTimerRef.current); };
  }, [resetCursorTimer]);

  const mismatch = playback.show && resourceId > 0 && playback.resources[currentSlide]?.id !== resourceId;
  const unavailable = playback.show && (!playback.resources.length || !playback.resources[currentSlide]?.accessible || resourceId <= 0);
  const error = syncError || playback.error || (mismatch ? '主控幻灯片与当前播放版本不一致' : unavailable ? '此放映没有可显示的幻灯片，请回到主控选择可访问的页面' : null);
  const imageUrl = error || ended ? null : playback.imageUrl;
  return (
    <div className="fixed inset-0 bg-black flex items-center justify-center overflow-hidden"
      style={{ cursor: cursorHidden ? 'none' : 'default' }} onMouseMove={resetCursorTimer}>
      <div className="relative w-full h-full max-w-full max-h-full" style={{ aspectRatio: '16/9' }}>
        {imageUrl && <img ref={slideImageRef} src={imageUrl} alt={'幻灯片 ' + (currentSlide + 1)}
          className={'absolute inset-0 w-full h-full ' + (imageFit === 'contain' ? 'object-contain' : 'object-fill')}
          draggable={false} onLoad={() => setLoadedUrl(imageUrl)} onError={playback.reportImageError} />}
        <DrawingCanvas ref={canvasRef} mode="none" mirror={true} className="absolute inset-0"
          imageElement={imageFit === 'contain' ? slideImageRef.current : undefined} />
      </div>
      {!ended && error && <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black z-50 text-white">
        <p role="alert">{error}</p>
        <button onClick={() => window.close()} className="rounded bg-white/20 px-4 py-2 text-sm">关闭</button>
      </div>}
      {!ended && !error && (!imageUrl || loadedUrl !== imageUrl) && <div className="absolute inset-0 flex items-center justify-center z-40 pointer-events-none">
        <p className="text-white/50 text-lg animate-pulse">{sync ? '正在加载幻灯片…' : '等待主控连接…'}</p>
      </div>}
      {ended && <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-50">
        <p className="text-white text-2xl">放映已结束</p>
      </div>}
    </div>
  );
}
