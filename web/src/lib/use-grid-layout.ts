import * as React from "react";

export interface GridStyle {
  gridTemplateColumns: string;
  columnGap: number;
  rowGap: number;
}

export interface ResponsiveGrid {
  /** 当前列数，范围 2-5 */
  cols: number;
  /** 当前行数（按容器高度估算），范围 2-4 */
  rows: number;
  /** 推荐每页卡片数 = cols × rows，最少 6 */
  pageSize: number;
  /** 直接挂到 grid 容器上的 inline style */
  gridStyle: GridStyle;
}

/** 列宽阈值：每 240px 一列，2 ≤ cols ≤ 5。 */
const COL_STEP = 240;
const MIN_COLS = 2;
const MAX_COLS = 5;
const MIN_ROWS = 2;
const MAX_ROWS = 4;
/** 卡片标题区默认高度估算（px-3 py-2.5 + 单行 13px 文本 ≈ 44px） */
const DEFAULT_TITLE_H = 44;

export interface UseResponsiveGridOptions {
  /** 卡片标题区高度（px），用于估算行数。默认 44 。 */
  titleHeight?: number;
  /** 从测量到的容器宽度中减去的偏移量（px），用于补偿 ref 与 grid 之间的祖先 padding，避免临界宽度下列数抖动。默认 0。 */
  widthOffset?: number;
}

function computeGapX(W: number) {
  if (W >= 1280) return 24;
  if (W >= 768) return 20;
  return 16;
}

function computeGapY(W: number) {
  if (W >= 1280) return 28;
  if (W >= 768) return 24;
  return 20;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function computeGrid(W: number, H: number, titleH: number) {
  // 列数只由宽度决定，避免 ResizeObserver 监听到内容高度变化时反复切列。
  const cols = clamp(Math.floor(W / COL_STEP), MIN_COLS, MAX_COLS);
  const gapX = computeGapX(W);
  const gapY = computeGapY(W);
  const cardW = (W - gapX * (cols - 1)) / cols;
  const cardH = (cardW * 9) / 16 + titleH;
  const rows = clamp(Math.floor((H + gapY) / (cardH + gapY)), MIN_ROWS, MAX_ROWS);
  return { cols, rows, gapX, gapY };
}

/**
 * 监听容器尺寸，按 240px 步进稳定计算 2-5 列网格布局。
 * 同时按高度估算行数，输出 pageSize = cols × rows，保证分页与渲染列数同源。
 */
export function useResponsiveGrid(
  ref: React.RefObject<HTMLElement | null>,
  options: UseResponsiveGridOptions = {},
): ResponsiveGrid {
  const titleH = options.titleHeight ?? DEFAULT_TITLE_H;
  const widthOffset = options.widthOffset ?? 0;
  const [state, setState] = React.useState(() => computeGrid(1024, 720, titleH));

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const compute = () => {
      const W = Math.max(0, el.clientWidth - widthOffset);
      const H = el.clientHeight;
      if (!W || !H) return;
      const next = computeGrid(W, H, titleH);
      setState((prev) =>
        prev.cols === next.cols &&
        prev.rows === next.rows &&
        prev.gapX === next.gapX &&
        prev.gapY === next.gapY
          ? prev
          : next,
      );
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, titleH, widthOffset]);

  const { cols, rows, gapX, gapY } = state;
  return React.useMemo<ResponsiveGrid>(
    () => ({
      cols,
      rows,
      pageSize: Math.max(6, cols * rows),
      gridStyle: {
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        columnGap: gapX,
        rowGap: gapY,
      },
    }),
    [cols, rows, gapX, gapY],
  );
}
