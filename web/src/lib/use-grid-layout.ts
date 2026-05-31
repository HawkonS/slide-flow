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

/** 列宽阈值：每 240px 一列，2 ≤ cols ≤ 5。
 *  高度加分：容器高度超过 650px 时，每多 1px 加 0.5，最多 +120。
 *  这样矮屏（13" Mac ~600px 高）保持 4 列，高屏（14" Win ~840px）升至 5 列。
 */
const COL_STEP = 240;
const HEIGHT_REF = 650;   // 高度加分基准线
const HEIGHT_FACTOR = 0.5; // 每超出 1px 的加分系数
const HEIGHT_BONUS_MAX = 120;
const MIN_COLS = 2;
const MAX_COLS = 5;
const MIN_ROWS = 2;
const MAX_ROWS = 4;
/** 卡片标题区默认高度估算（px-3 py-2.5 + 单行 13px 文本 ≈ 44px） */
const DEFAULT_TITLE_H = 44;

export interface UseResponsiveGridOptions {
  /** 卡片标题区高度（px），用于估算行数。默认 44 。 */
  titleHeight?: number;
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
  // 高度加分：高屏容器获得更多列数
  const hBonus = H > HEIGHT_REF
    ? Math.min((H - HEIGHT_REF) * HEIGHT_FACTOR, HEIGHT_BONUS_MAX)
    : 0;
  const cols = clamp(Math.floor((W + hBonus) / COL_STEP), MIN_COLS, MAX_COLS);
  const gapX = computeGapX(W);
  const gapY = computeGapY(W);
  const cardW = (W - gapX * (cols - 1)) / cols;
  const cardH = (cardW * 9) / 16 + titleH;
  const rows = clamp(Math.floor((H + gapY) / (cardH + gapY)), MIN_ROWS, MAX_ROWS);
  return { cols, rows, gapX, gapY };
}

/**
 * 监听容器尺寸，按 240px 步进 + 高度加分连续计算 2-5 列网格布局。
 * 同时按高度估算行数，输出 pageSize = cols × rows，保证分页与渲染列数同源。
 */
export function useResponsiveGrid(
  ref: React.RefObject<HTMLElement | null>,
  options: UseResponsiveGridOptions = {},
): ResponsiveGrid {
  const titleH = options.titleHeight ?? DEFAULT_TITLE_H;
  const [state, setState] = React.useState(() => computeGrid(1024, 720, titleH));

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const compute = () => {
      const W = el.clientWidth;
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
  }, [ref, titleH]);

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
