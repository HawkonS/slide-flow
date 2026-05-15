/**
 * 生成离线HTML播放器 - 仅HTML结构（引用外部 style.css 和 app.js）
 */
export function generateOfflineHtml(): string {
  return '<!DOCTYPE html>\n' +
    '<html lang="zh-CN">\n' +
    '<head>\n' +
    '  <meta charset="UTF-8">\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    '  <title>SlideFlow \u79BB\u7EBF\u64AD\u653E</title>\n' +
    '  <link rel="stylesheet" href="style.css">\n' +
    '</head>\n' +
    '<body>\n' +
    '  <div id="app"></div>\n' +
    '  <script src="manifest.js"></script>\n' +
    '  <script src="app.js"></script>\n' +
    '</body>\n' +
    '</html>';
}

/**
 * 生成离线播放器的 CSS 文件内容
 */
export function generateOfflineCss(): string {
  return ':root {\n' +
    '  --bg-primary: #0f0f0f;\n' +
    '  --bg-secondary: #1a1a1a;\n' +
    '  --bg-card: #242424;\n' +
    '  --bg-card-hover: #2e2e2e;\n' +
    '  --bg-toolbar: rgba(15, 15, 15, 0.85);\n' +
    '  --text-primary: #f0f0f0;\n' +
    '  --text-secondary: #a0a0a0;\n' +
    '  --text-muted: #666;\n' +
    '  --accent: #6366f1;\n' +
    '  --accent-hover: #818cf8;\n' +
    '  --border: #333;\n' +
    '  --success: #22c55e;\n' +
    '  --warning: #f59e0b;\n' +
    '  --danger: #ef4444;\n' +
    '  --radius: 8px;\n' +
    '  --transition: 0.2s ease;\n' +
    '}\n' +
    '\n' +
    '* { margin: 0; padding: 0; box-sizing: border-box; }\n' +
    '\n' +
    'body {\n' +
    '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n' +
    '  background: var(--bg-primary);\n' +
    '  color: var(--text-primary);\n' +
    '  min-height: 100vh;\n' +
    '  overflow-x: hidden;\n' +
    '}\n' +
    '\n' +
    '#app { min-height: 100vh; }\n' +
    '\n' +
    '.view { display: none; min-height: 100vh; }\n' +
    '.view.active { display: block; }\n' +
    '\n' +
    '/* Header */\n' +
    '.header {\n' +
    '  padding: 24px 32px;\n' +
    '  border-bottom: 1px solid var(--border);\n' +
    '  background: var(--bg-secondary);\n' +
    '}\n' +
    '.header h1 { font-size: 1.5rem; font-weight: 600; }\n' +
    '.header p { color: var(--text-secondary); margin-top: 4px; font-size: 0.875rem; }\n' +
    '\n' +
    '/* Filter Bar */\n' +
    '.filter-bar {\n' +
    '  padding: 16px 32px;\n' +
    '  background: var(--bg-secondary);\n' +
    '  border-bottom: 1px solid var(--border);\n' +
    '  display: flex;\n' +
    '  flex-wrap: wrap;\n' +
    '  gap: 12px;\n' +
    '  align-items: center;\n' +
    '}\n' +
    '.filter-bar input, .filter-bar select {\n' +
    '  padding: 7px 12px;\n' +
    '  background: var(--bg-primary);\n' +
    '  border: 1px solid var(--border);\n' +
    '  border-radius: var(--radius);\n' +
    '  color: var(--text-primary);\n' +
    '  font-size: 0.82rem;\n' +
    '  outline: none;\n' +
    '  transition: border-color var(--transition);\n' +
    '}\n' +
    '.filter-bar input:focus, .filter-bar select:focus { border-color: var(--accent); }\n' +
    '.filter-bar input { min-width: 180px; flex: 1; max-width: 280px; }\n' +
    '.filter-bar select { min-width: 120px; }\n' +
    '.filter-tags-wrap {\n' +
    '  display: flex;\n' +
    '  flex-wrap: wrap;\n' +
    '  gap: 6px;\n' +
    '  align-items: center;\n' +
    '}\n' +
    '.filter-tag {\n' +
    '  padding: 4px 10px;\n' +
    '  border-radius: 12px;\n' +
    '  font-size: 0.72rem;\n' +
    '  background: rgba(255,255,255,0.06);\n' +
    '  border: 1px solid var(--border);\n' +
    '  color: var(--text-secondary);\n' +
    '  cursor: pointer;\n' +
    '  transition: all var(--transition);\n' +
    '  user-select: none;\n' +
    '}\n' +
    '.filter-tag:hover { border-color: var(--accent); color: var(--text-primary); }\n' +
    '.filter-tag.active {\n' +
    '  background: rgba(99, 102, 241, 0.2);\n' +
    '  border-color: var(--accent);\n' +
    '  color: var(--accent-hover);\n' +
    '}\n' +
    '.filter-label {\n' +
    '  font-size: 0.75rem;\n' +
    '  color: var(--text-muted);\n' +
    '  white-space: nowrap;\n' +
    '}\n' +
    '\n' +
    '/* Card Grid */\n' +
    '.card-grid {\n' +
    '  display: grid;\n' +
    '  grid-template-columns: repeat(5, 1fr);\n' +
    '  gap: 16px;\n' +
    '  padding: 24px 32px;\n' +
    '}\n' +
    '@media (max-width: 1600px) { .card-grid { grid-template-columns: repeat(4, 1fr); } }\n' +
    '@media (max-width: 1200px) { .card-grid { grid-template-columns: repeat(3, 1fr); } }\n' +
    '@media (max-width: 900px) { .card-grid { grid-template-columns: repeat(2, 1fr); } }\n' +
    '\n' +
    '.card {\n' +
    '  background: var(--bg-card);\n' +
    '  border: 1px solid var(--border);\n' +
    '  border-radius: var(--radius);\n' +
    '  overflow: hidden;\n' +
    '  transition: background var(--transition), border-color var(--transition), transform var(--transition);\n' +
    '  position: relative;\n' +
    '}\n' +
    '.card:hover {\n' +
    '  background: var(--bg-card-hover);\n' +
    '  border-color: var(--accent);\n' +
    '  transform: translateY(-2px);\n' +
    '}\n' +
    '.card-thumb {\n' +
    '  width: 100%;\n' +
    '  padding-top: 56.25%;\n' +
    '  position: relative;\n' +
    '  background: var(--bg-primary);\n' +
    '  overflow: hidden;\n' +
    '}\n' +
    '.card-thumb img {\n' +
    '  position: absolute;\n' +
    '  top: 0; left: 0;\n' +
    '  width: 100%; height: 100%;\n' +
    '  object-fit: cover;\n' +
    '}\n' +
    '.card-thumb-placeholder {\n' +
    '  position: absolute;\n' +
    '  top: 0; left: 0;\n' +
    '  width: 100%; height: 100%;\n' +
    '  display: flex;\n' +
    '  align-items: center;\n' +
    '  justify-content: center;\n' +
    '  color: var(--text-muted);\n' +
    '  font-size: 2rem;\n' +
    '}\n' +
    '.card-actions {\n' +
    '  position: absolute;\n' +
    '  top: 0; left: 0; right: 0; bottom: 0;\n' +
    '  background: rgba(0,0,0,0.7);\n' +
    '  display: flex;\n' +
    '  flex-direction: column;\n' +
    '  align-items: center;\n' +
    '  justify-content: center;\n' +
    '  gap: 8px;\n' +
    '  opacity: 0;\n' +
    '  transition: opacity 0.2s ease;\n' +
    '}\n' +
    '.card:hover .card-actions { opacity: 1; }\n' +
    '.card-action-btn {\n' +
    '  padding: 6px 16px;\n' +
    '  border-radius: var(--radius);\n' +
    '  border: none;\n' +
    '  font-size: 0.78rem;\n' +
    '  font-weight: 500;\n' +
    '  cursor: pointer;\n' +
    '  transition: background var(--transition), transform var(--transition);\n' +
    '  min-width: 110px;\n' +
    '  text-align: center;\n' +
    '}\n' +
    '.card-action-btn:hover { transform: scale(1.05); }\n' +
    '.card-action-btn.primary { background: var(--accent); color: #fff; }\n' +
    '.card-action-btn.primary:hover { background: var(--accent-hover); }\n' +
    '.card-action-btn.secondary { background: rgba(255,255,255,0.15); color: var(--text-primary); }\n' +
    '.card-action-btn.secondary:hover { background: rgba(255,255,255,0.25); }\n' +
    '.card-body { padding: 12px 14px; }\n' +
    '.card-title { font-size: 0.95rem; font-weight: 600; margin-bottom: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n' +
    '.card-meta { font-size: 0.75rem; color: var(--text-secondary); line-height: 1.6; }\n' +
    '.card-meta span { display: inline-block; margin-right: 10px; }\n' +
    '.card-version-badge {\n' +
    '  position: absolute;\n' +
    '  top: 8px; right: 8px;\n' +
    '  background: rgba(0,0,0,0.65);\n' +
    '  color: var(--text-primary);\n' +
    '  padding: 2px 7px;\n' +
    '  border-radius: 4px;\n' +
    '  font-size: 0.68rem;\n' +
    '  font-weight: 500;\n' +
    '  z-index: 2;\n' +
    '  pointer-events: none;\n' +
    '}\n' +
    '.card-badge {\n' +
    '  display: inline-block;\n' +
    '  padding: 2px 8px;\n' +
    '  border-radius: 4px;\n' +
    '  font-size: 0.7rem;\n' +
    '  font-weight: 500;\n' +
    '  margin-top: 4px;\n' +
    '  margin-right: 4px;\n' +
    '}\n' +
    '.badge-auth { background: rgba(245, 158, 11, 0.15); color: var(--warning); }\n' +
    '.badge-subject { background: rgba(34, 197, 94, 0.12); color: var(--success); }\n' +
    '.badge-secrecy { background: rgba(239, 68, 68, 0.12); color: var(--danger); }\n' +
    '.card.hidden { display: none; }\n' +
    '\n' +
    '/* Auth Page */\n' +
    '.auth-container {\n' +
    '  display: flex;\n' +
    '  align-items: center;\n' +
    '  justify-content: center;\n' +
    '  min-height: 100vh;\n' +
    '  padding: 24px;\n' +
    '}\n' +
    '.auth-box {\n' +
    '  background: var(--bg-card);\n' +
    '  border: 1px solid var(--border);\n' +
    '  border-radius: var(--radius);\n' +
    '  padding: 32px;\n' +
    '  width: 100%;\n' +
    '  max-width: 400px;\n' +
    '}\n' +
    '.auth-box h2 { margin-bottom: 8px; font-size: 1.25rem; }\n' +
    '.auth-box p { color: var(--text-secondary); font-size: 0.875rem; margin-bottom: 20px; }\n' +
    '.auth-input {\n' +
    '  width: 100%;\n' +
    '  padding: 10px 14px;\n' +
    '  background: var(--bg-primary);\n' +
    '  border: 1px solid var(--border);\n' +
    '  border-radius: var(--radius);\n' +
    '  color: var(--text-primary);\n' +
    '  font-size: 0.9rem;\n' +
    '  outline: none;\n' +
    '  transition: border-color var(--transition);\n' +
    '  margin-bottom: 12px;\n' +
    '}\n' +
    '.auth-input:focus { border-color: var(--accent); }\n' +
    '.auth-btn {\n' +
    '  width: 100%;\n' +
    '  padding: 10px;\n' +
    '  background: var(--accent);\n' +
    '  color: #fff;\n' +
    '  border: none;\n' +
    '  border-radius: var(--radius);\n' +
    '  font-size: 0.9rem;\n' +
    '  font-weight: 500;\n' +
    '  cursor: pointer;\n' +
    '  transition: background var(--transition);\n' +
    '}\n' +
    '.auth-btn:hover { background: var(--accent-hover); }\n' +
    '.auth-error {\n' +
    '  color: var(--danger);\n' +
    '  font-size: 0.8rem;\n' +
    '  margin-top: 8px;\n' +
    '  display: none;\n' +
    '}\n' +
    '.auth-back {\n' +
    '  display: block;\n' +
    '  margin-top: 16px;\n' +
    '  text-align: center;\n' +
    '  color: var(--text-secondary);\n' +
    '  font-size: 0.8rem;\n' +
    '  cursor: pointer;\n' +
    '  text-decoration: underline;\n' +
    '}\n' +
    '\n' +
    '/* Player */\n' +
    '.player-container {\n' +
    '  position: relative;\n' +
    '  width: 100%;\n' +
    '  height: 100vh;\n' +
    '  background: #000;\n' +
    '  display: flex;\n' +
    '  flex-direction: column;\n' +
    '  overflow: hidden;\n' +
    '}\n' +
    '.player-toolbar {\n' +
    '  padding: 12px 20px;\n' +
    '  background: var(--bg-toolbar);\n' +
    '  backdrop-filter: blur(8px);\n' +
    '  display: flex;\n' +
    '  align-items: center;\n' +
    '  gap: 12px;\n' +
    '  z-index: 10;\n' +
    '  flex-shrink: 0;\n' +
    '}\n' +
    '.player-container.fullscreen-active .player-toolbar {\n' +
    '  position: absolute;\n' +
    '  top: 0; left: 0; right: 0;\n' +
    '  opacity: 0;\n' +
    '  transition: opacity 0.3s ease;\n' +
    '}\n' +
    '.player-container.fullscreen-active:hover .player-toolbar,\n' +
    '.player-container.fullscreen-active .player-toolbar:focus-within {\n' +
    '  opacity: 1;\n' +
    '}\n' +
    '.player-container.fullscreen-active .player-content {\n' +
    '  height: 100%;\n' +
    '}\n' +
    '.toolbar-btn {\n' +
    '  background: rgba(255,255,255,0.1);\n' +
    '  border: none;\n' +
    '  color: var(--text-primary);\n' +
    '  padding: 6px 12px;\n' +
    '  border-radius: var(--radius);\n' +
    '  cursor: pointer;\n' +
    '  font-size: 0.85rem;\n' +
    '  transition: background var(--transition);\n' +
    '}\n' +
    '.toolbar-btn:hover { background: rgba(255,255,255,0.2); }\n' +
    '.toolbar-title { flex: 1; font-size: 0.9rem; font-weight: 500; }\n' +
    '.slide-counter {\n' +
    '  font-size: 0.85rem;\n' +
    '  color: var(--text-secondary);\n' +
    '  margin-left: auto;\n' +
    '}\n' +
    '\n' +
    '.slide-img {\n' +
    '  max-width: 100%;\n' +
    '  max-height: 100%;\n' +
    '  object-fit: contain;\n' +
    '  user-select: none;\n' +
    '  -webkit-user-drag: none;\n' +
    '}\n' +
    '\n' +
    '/* Navigation Arrows */\n' +
    '.nav-arrow {\n' +
    '  position: absolute;\n' +
    '  top: 50%;\n' +
    '  transform: translateY(-50%);\n' +
    '  background: rgba(255,255,255,0.08);\n' +
    '  border: none;\n' +
    '  color: var(--text-primary);\n' +
    '  width: 48px;\n' +
    '  height: 48px;\n' +
    '  border-radius: 50%;\n' +
    '  font-size: 1.5rem;\n' +
    '  cursor: pointer;\n' +
    '  z-index: 5;\n' +
    '  transition: background var(--transition), opacity var(--transition);\n' +
    '  opacity: 0;\n' +
    '}\n' +
    '.player-container:hover .nav-arrow,\n' +
    '.slide-area:hover .nav-arrow { opacity: 1; }\n' +
    '.nav-arrow:hover { background: rgba(255,255,255,0.15); }\n' +
    '.nav-arrow.left { left: 16px; }\n' +
    '.nav-arrow.right { right: 16px; }\n' +
    '.nav-arrow:disabled { opacity: 0.2; cursor: default; }\n' +
    '\n' +
    '/* Thumbnail Bar */\n' +
    '.thumb-bar {\n' +
    '  background: var(--bg-toolbar);\n' +
    '  backdrop-filter: blur(8px);\n' +
    '  padding: 8px 16px;\n' +
    '  display: flex;\n' +
    '  gap: 6px;\n' +
    '  overflow-x: auto;\n' +
    '  z-index: 10;\n' +
    '  flex-shrink: 0;\n' +
    '}\n' +
    '.player-container.fullscreen-active .thumb-bar {\n' +
    '  position: absolute;\n' +
    '  bottom: 0; left: 0; right: 0;\n' +
    '  opacity: 0;\n' +
    '  transition: opacity 0.3s ease;\n' +
    '}\n' +
    '.player-container.fullscreen-active:hover .thumb-bar { opacity: 1; }\n' +
    '.thumb-bar::-webkit-scrollbar { height: 4px; }\n' +
    '.thumb-bar::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }\n' +
    '.thumb-item {\n' +
    '  flex-shrink: 0;\n' +
    '  width: 64px;\n' +
    '  height: 40px;\n' +
    '  border-radius: 4px;\n' +
    '  overflow: hidden;\n' +
    '  border: 2px solid transparent;\n' +
    '  cursor: pointer;\n' +
    '  transition: border-color var(--transition);\n' +
    '  opacity: 0.6;\n' +
    '}\n' +
    '.thumb-item.active { border-color: var(--accent); opacity: 1; }\n' +
    '.thumb-item:hover { opacity: 1; }\n' +
    '.thumb-item img { width: 100%; height: 100%; object-fit: cover; }\n' +
    '\n' +
    '/* Player Content Layout */\n' +
    '.player-content {\n' +
    '  width: 100%;\n' +
    '  flex: 1;\n' +
    '  display: flex;\n' +
    '  min-height: 0;\n' +
    '}\n' +
    '.slide-area {\n' +
    '  flex: 1;\n' +
    '  position: relative;\n' +
    '  display: flex;\n' +
    '  align-items: center;\n' +
    '  justify-content: center;\n' +
    '  min-width: 0;\n' +
    '}\n' +
    '\n' +
    '/* Remark Panel */\n' +
    '.remark-panel {\n' +
    '  width: 300px;\n' +
    '  background: var(--bg-secondary);\n' +
    '  border-left: 1px solid var(--border);\n' +
    '  display: flex;\n' +
    '  flex-direction: column;\n' +
    '  overflow: hidden;\n' +
    '  transition: width 0.3s ease, opacity 0.3s ease;\n' +
    '  z-index: 6;\n' +
    '  flex-shrink: 0;\n' +
    '}\n' +
    '.remark-panel.hidden {\n' +
    '  width: 0;\n' +
    '  border-left: none;\n' +
    '  opacity: 0;\n' +
    '  pointer-events: none;\n' +
    '}\n' +
    '.remark-panel-inner {\n' +
    '  width: 300px;\n' +
    '  height: 100%;\n' +
    '  overflow-y: auto;\n' +
    '}\n' +
    '.remark-panel-inner::-webkit-scrollbar { width: 5px; }\n' +
    '.remark-panel-inner::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }\n' +
    '\n' +
    '.remark-section {\n' +
    '  border-bottom: 1px solid var(--border);\n' +
    '}\n' +
    '.remark-header {\n' +
    '  display: flex;\n' +
    '  align-items: center;\n' +
    '  padding: 10px 14px;\n' +
    '  cursor: pointer;\n' +
    '  user-select: none;\n' +
    '  font-size: 0.8rem;\n' +
    '  font-weight: 600;\n' +
    '  color: var(--text-secondary);\n' +
    '  transition: background var(--transition), color var(--transition);\n' +
    '}\n' +
    '.remark-header:hover {\n' +
    '  background: rgba(255,255,255,0.04);\n' +
    '  color: var(--text-primary);\n' +
    '}\n' +
    '.remark-header .arrow {\n' +
    '  margin-right: 8px;\n' +
    '  font-size: 0.7rem;\n' +
    '  transition: transform 0.2s ease;\n' +
    '  display: inline-block;\n' +
    '}\n' +
    '.remark-header.collapsed .arrow {\n' +
    '  transform: rotate(-90deg);\n' +
    '}\n' +
    '.remark-body {\n' +
    '  padding: 8px 14px 14px;\n' +
    '  font-size: 0.82rem;\n' +
    '  line-height: 1.6;\n' +
    '  color: var(--text-primary);\n' +
    '  overflow: hidden;\n' +
    '  transition: max-height 0.3s ease, padding 0.3s ease, opacity 0.2s ease;\n' +
    '  max-height: 800px;\n' +
    '  opacity: 1;\n' +
    '}\n' +
    '.remark-body.collapsed {\n' +
    '  max-height: 0;\n' +
    '  padding-top: 0;\n' +
    '  padding-bottom: 0;\n' +
    '  opacity: 0;\n' +
    '}\n' +
    '.remark-body p { margin-bottom: 8px; }\n' +
    '.remark-body ul, .remark-body ol { padding-left: 18px; margin-bottom: 8px; }\n' +
    '.remark-body li { margin-bottom: 4px; }\n' +
    '.remark-body h1, .remark-body h2, .remark-body h3,\n' +
    '.remark-body h4, .remark-body h5, .remark-body h6 {\n' +
    '  margin-bottom: 8px;\n' +
    '  font-weight: 600;\n' +
    '}\n' +
    '.remark-body h1 { font-size: 1.1rem; }\n' +
    '.remark-body h2 { font-size: 1rem; }\n' +
    '.remark-body h3 { font-size: 0.95rem; }\n' +
    '.remark-body a { color: var(--accent-hover); text-decoration: underline; }\n' +
    '.remark-body code {\n' +
    '  background: rgba(255,255,255,0.08);\n' +
    '  padding: 1px 5px;\n' +
    '  border-radius: 3px;\n' +
    '  font-size: 0.78rem;\n' +
    '}\n' +
    '.remark-body pre {\n' +
    '  background: rgba(0,0,0,0.3);\n' +
    '  padding: 10px;\n' +
    '  border-radius: 4px;\n' +
    '  overflow-x: auto;\n' +
    '  margin-bottom: 8px;\n' +
    '}\n' +
    '.remark-body blockquote {\n' +
    '  border-left: 3px solid var(--accent);\n' +
    '  padding-left: 12px;\n' +
    '  color: var(--text-secondary);\n' +
    '  margin-bottom: 8px;\n' +
    '}\n' +
    '.remark-body img { max-width: 100%; border-radius: 4px; }\n' +
    '.remark-body table { width: 100%; border-collapse: collapse; margin-bottom: 8px; font-size: 0.78rem; }\n' +
    '.remark-body th, .remark-body td { border: 1px solid var(--border); padding: 4px 8px; }\n' +
    '.remark-body th { background: rgba(255,255,255,0.04); }\n' +
    '.no-remark { color: var(--text-muted); font-style: italic; }\n' +
    '\n' +
    '.toolbar-btn.active {\n' +
    '  background: rgba(99, 102, 241, 0.3);\n' +
    '  color: var(--accent-hover);\n' +
    '}\n' +
    '\n' +
    '/* Offline notice */\n' +
    '.offline-notice {\n' +
    '  padding: 12px 32px;\n' +
    '  background: rgba(245, 158, 11, 0.1);\n' +
    '  color: var(--warning);\n' +
    '  font-size: 0.8rem;\n' +
    '  text-align: center;\n' +
    '}\n' +
    '\n' +
    '/* Empty state */\n' +
    '.empty-state {\n' +
    '  text-align: center;\n' +
    '  padding: 80px 24px;\n' +
    '  color: var(--text-secondary);\n' +
    '}\n' +
    '.empty-state h2 { font-size: 1.2rem; margin-bottom: 8px; }\n' +
    '\n' +
    '/* Mode Selection */\n' +
    '.mode-select-container {\n' +
    '  display: flex;\n' +
    '  align-items: center;\n' +
    '  justify-content: center;\n' +
    '  min-height: 100vh;\n' +
    '  padding: 24px;\n' +
    '}\n' +
    '.mode-select-box {\n' +
    '  background: var(--bg-card);\n' +
    '  border: 1px solid var(--border);\n' +
    '  border-radius: var(--radius);\n' +
    '  padding: 40px;\n' +
    '  width: 100%;\n' +
    '  max-width: 520px;\n' +
    '  text-align: center;\n' +
    '}\n' +
    '.mode-select-box h2 { margin-bottom: 24px; font-size: 1.3rem; font-weight: 600; }\n' +
    '.mode-cards {\n' +
    '  display: grid;\n' +
    '  grid-template-columns: 1fr 1fr;\n' +
    '  gap: 16px;\n' +
    '  margin-bottom: 24px;\n' +
    '}\n' +
    '.mode-card {\n' +
    '  background: var(--bg-primary);\n' +
    '  border: 2px solid var(--border);\n' +
    '  border-radius: var(--radius);\n' +
    '  padding: 24px 16px;\n' +
    '  cursor: pointer;\n' +
    '  transition: border-color var(--transition), background var(--transition), transform var(--transition);\n' +
    '}\n' +
    '.mode-card:hover {\n' +
    '  border-color: var(--accent);\n' +
    '  background: var(--bg-secondary);\n' +
    '  transform: translateY(-2px);\n' +
    '}\n' +
    '.mode-card-icon { font-size: 2.2rem; margin-bottom: 12px; }\n' +
    '.mode-card-title { font-size: 1rem; font-weight: 600; margin-bottom: 6px; }\n' +
    '.mode-card-sub { font-size: 0.78rem; color: var(--text-secondary); line-height: 1.4; }\n' +
    '.mode-back {\n' +
    '  color: var(--text-secondary);\n' +
    '  font-size: 0.85rem;\n' +
    '  cursor: pointer;\n' +
    '  text-decoration: underline;\n' +
    '}\n' +
    '\n' +
    '/* Presenter View */\n' +
    '.presenter-container {\n' +
    '  width: 100%;\n' +
    '  height: 100vh;\n' +
    '  display: flex;\n' +
    '  flex-direction: column;\n' +
    '  background: var(--bg-primary);\n' +
    '  overflow: hidden;\n' +
    '}\n' +
    '.presenter-toolbar {\n' +
    '  padding: 10px 20px;\n' +
    '  background: var(--bg-secondary);\n' +
    '  border-bottom: 1px solid var(--border);\n' +
    '  display: flex;\n' +
    '  align-items: center;\n' +
    '  gap: 12px;\n' +
    '  flex-shrink: 0;\n' +
    '}\n' +
    '.presenter-body {\n' +
    '  flex: 1;\n' +
    '  display: flex;\n' +
    '  min-height: 0;\n' +
    '  overflow: hidden;\n' +
    '}\n' +
    '.presenter-left {\n' +
    '  flex: 1;\n' +
    '  display: flex;\n' +
    '  flex-direction: column;\n' +
    '  min-width: 0;\n' +
    '  border-right: 1px solid var(--border);\n' +
    '}\n' +
    '.presenter-current {\n' +
    '  flex: 3;\n' +
    '  display: flex;\n' +
    '  align-items: center;\n' +
    '  justify-content: center;\n' +
    '  padding: 16px;\n' +
    '  background: #000;\n' +
    '  min-height: 0;\n' +
    '  position: relative;\n' +
    '}\n' +
    '.presenter-current .slide-img { max-width: 100%; max-height: 100%; object-fit: contain; }\n' +
    '.presenter-next {\n' +
    '  flex: 0 0 40%;\n' +
    '  display: flex;\n' +
    '  align-items: center;\n' +
    '  justify-content: center;\n' +
    '  padding: 12px;\n' +
    '  background: var(--bg-secondary);\n' +
    '  border-bottom: 1px solid var(--border);\n' +
    '  min-height: 0;\n' +
    '}\n' +
    '.presenter-next-label {\n' +
    '  position: absolute;\n' +
    '  top: 8px;\n' +
    '  left: 12px;\n' +
    '  font-size: 0.7rem;\n' +
    '  color: var(--text-muted);\n' +
    '  text-transform: uppercase;\n' +
    '  letter-spacing: 0.5px;\n' +
    '}\n' +
    '.presenter-next-wrapper {\n' +
    '  position: relative;\n' +
    '  width: 100%;\n' +
    '  height: 100%;\n' +
    '  display: flex;\n' +
    '  align-items: center;\n' +
    '  justify-content: center;\n' +
    '}\n' +
    '.presenter-next .slide-img { max-width: 100%; max-height: 100%; object-fit: contain; opacity: 0.8; }\n' +
    '.presenter-right {\n' +
    '  width: 360px;\n' +
    '  flex-shrink: 0;\n' +
    '  display: flex;\n' +
    '  flex-direction: column;\n' +
    '  background: var(--bg-secondary);\n' +
    '  min-height: 0;\n' +
    '}\n' +
    '.presenter-thumbs {\n' +
    '  flex: 1;\n' +
    '  display: flex;\n' +
    '  flex-direction: column;\n' +
    '  border-top: 1px solid var(--border);\n' +
    '  background: var(--bg-secondary);\n' +
    '  min-height: 0;\n' +
    '}\n' +
    '.presenter-thumbs-header {\n' +
    '  padding: 8px 14px;\n' +
    '  font-size: 0.78rem;\n' +
    '  font-weight: 600;\n' +
    '  color: var(--text-secondary);\n' +
    '  border-bottom: 1px solid var(--border);\n' +
    '  display: flex;\n' +
    '  align-items: center;\n' +
    '  justify-content: space-between;\n' +
    '  flex-shrink: 0;\n' +
    '}\n' +
    '.presenter-thumbs-header .view-toggle {\n' +
    '  display: flex;\n' +
    '  gap: 2px;\n' +
    '  background: rgba(255,255,255,0.06);\n' +
    '  border-radius: 4px;\n' +
    '  padding: 2px;\n' +
    '}\n' +
    '.presenter-thumbs-header .view-toggle button {\n' +
    '  background: transparent;\n' +
    '  border: none;\n' +
    '  color: var(--text-muted);\n' +
    '  font-size: 0.7rem;\n' +
    '  padding: 2px 8px;\n' +
    '  cursor: pointer;\n' +
    '  border-radius: 3px;\n' +
    '  transition: background var(--transition), color var(--transition);\n' +
    '}\n' +
    '.presenter-thumbs-header .view-toggle button.active {\n' +
    '  background: var(--accent);\n' +
    '  color: #fff;\n' +
    '}\n' +
    '.presenter-thumbs-list {\n' +
    '  flex: 1;\n' +
    '  overflow-y: auto;\n' +
    '  padding: 8px;\n' +
    '  min-height: 0;\n' +
    '}\n' +
    '.presenter-thumbs-list::-webkit-scrollbar { width: 5px; }\n' +
    '.presenter-thumbs-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }\n' +
    '.presenter-thumbs-grid {\n' +
    '  display: grid;\n' +
    '  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));\n' +
    '  gap: 6px;\n' +
    '}\n' +
    '.presenter-thumb-card {\n' +
    '  position: relative;\n' +
    '  aspect-ratio: 16 / 9;\n' +
    '  border-radius: 4px;\n' +
    '  border: 2px solid transparent;\n' +
    '  background: #000;\n' +
    '  overflow: hidden;\n' +
    '  cursor: pointer;\n' +
    '  transition: border-color var(--transition), transform var(--transition);\n' +
    '}\n' +
    '.presenter-thumb-card:hover { border-color: rgba(99,102,241,0.4); }\n' +
    '.presenter-thumb-card.active { border-color: var(--accent); }\n' +
    '.presenter-thumb-card img {\n' +
    '  width: 100%;\n' +
    '  height: 100%;\n' +
    '  object-fit: cover;\n' +
    '  display: block;\n' +
    '}\n' +
    '.presenter-thumb-card .index-badge {\n' +
    '  position: absolute;\n' +
    '  bottom: 2px;\n' +
    '  left: 4px;\n' +
    '  background: rgba(0,0,0,0.65);\n' +
    '  color: #fff;\n' +
    '  font-size: 0.65rem;\n' +
    '  padding: 1px 5px;\n' +
    '  border-radius: 2px;\n' +
    '  pointer-events: none;\n' +
    '}\n' +
    '.presenter-thumbs-rows {\n' +
    '  display: flex;\n' +
    '  flex-direction: column;\n' +
    '  gap: 2px;\n' +
    '}\n' +
    '.presenter-thumb-row {\n' +
    '  display: flex;\n' +
    '  align-items: center;\n' +
    '  gap: 8px;\n' +
    '  padding: 4px 6px;\n' +
    '  border-radius: 4px;\n' +
    '  cursor: pointer;\n' +
    '  transition: background var(--transition);\n' +
    '  border: 1px solid transparent;\n' +
    '}\n' +
    '.presenter-thumb-row:hover { background: rgba(255,255,255,0.04); }\n' +
    '.presenter-thumb-row.active { background: rgba(99,102,241,0.18); border-color: var(--accent); }\n' +
    '.presenter-thumb-row .row-index {\n' +
    '  width: 22px;\n' +
    '  text-align: right;\n' +
    '  font-size: 0.7rem;\n' +
    '  color: var(--text-muted);\n' +
    '  flex-shrink: 0;\n' +
    '  font-variant-numeric: tabular-nums;\n' +
    '}\n' +
    '.presenter-thumb-row .row-thumb {\n' +
    '  width: 64px;\n' +
    '  height: 36px;\n' +
    '  background: #000;\n' +
    '  border-radius: 3px;\n' +
    '  overflow: hidden;\n' +
    '  flex-shrink: 0;\n' +
    '}\n' +
    '.presenter-thumb-row .row-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }\n' +
    '.presenter-thumb-row .row-name {\n' +
    '  flex: 1;\n' +
    '  font-size: 0.75rem;\n' +
    '  color: var(--text-secondary);\n' +
    '  overflow: hidden;\n' +
    '  text-overflow: ellipsis;\n' +
    '  white-space: nowrap;\n' +
    '}\n' +
    '.presenter-thumb-row.active .row-name { color: var(--text-primary); }\n' +
    '.presenter-remarks {\n' +
    '  flex: 1 1 60%;\n' +
    '  overflow-y: auto;\n' +
    '  min-height: 0;\n' +
    '}\n' +
    '.presenter-remarks::-webkit-scrollbar { width: 5px; }\n' +
    '.presenter-remarks::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }\n' +
    '.presenter-controls {\n' +
    '  padding: 12px 20px;\n' +
    '  background: var(--bg-secondary);\n' +
    '  border-top: 1px solid var(--border);\n' +
    '  display: flex;\n' +
    '  align-items: center;\n' +
    '  justify-content: center;\n' +
    '  gap: 16px;\n' +
    '  flex-shrink: 0;\n' +
    '}\n' +
    '.presenter-controls .nav-btn {\n' +
    '  background: rgba(255,255,255,0.1);\n' +
    '  border: none;\n' +
    '  color: var(--text-primary);\n' +
    '  padding: 8px 16px;\n' +
    '  border-radius: var(--radius);\n' +
    '  cursor: pointer;\n' +
    '  font-size: 0.9rem;\n' +
    '  transition: background var(--transition);\n' +
    '}\n' +
    '.presenter-controls .nav-btn:hover { background: rgba(255,255,255,0.2); }\n' +
    '.presenter-controls .nav-btn:disabled { opacity: 0.3; cursor: default; }\n' +
    '.presenter-controls .page-info {\n' +
    '  font-size: 1rem;\n' +
    '  font-weight: 500;\n' +
    '  min-width: 80px;\n' +
    '  text-align: center;\n' +
    '}\n' +
    '\n' +
    '/* Display Window */\n' +
    '.display-container {\n' +
    '  width: 100vw;\n' +
    '  height: 100vh;\n' +
    '  background: #000;\n' +
    '  display: flex;\n' +
    '  align-items: center;\n' +
    '  justify-content: center;\n' +
    '  overflow: hidden;\n' +
    '}\n' +
    '.display-container .slide-img {\n' +
    '  max-width: 100%;\n' +
    '  max-height: 100%;\n' +
    '  object-fit: contain;\n' +
    '}\n' +
    '\n' +
    '/* Loading */\n' +
    '.loading-container {\n' +
    '  display: flex;\n' +
    '  align-items: center;\n' +
    '  justify-content: center;\n' +
    '  height: 100vh;\n' +
    '  color: var(--text-secondary);\n' +
    '  font-size: 1.1rem;\n' +
    '}\n' +
    '\n' +
    '@media (max-width: 768px) {\n' +
    '  .remark-panel {\n' +
    '    position: absolute;\n' +
    '    right: 0;\n' +
    '    top: 0;\n' +
    '    bottom: 0;\n' +
    '    width: 280px;\n' +
    '    box-shadow: -4px 0 20px rgba(0,0,0,0.5);\n' +
    '  }\n' +
    '  .remark-panel.hidden {\n' +
    '    width: 0;\n' +
    '    box-shadow: none;\n' +
    '  }\n' +
    '  .presenter-right { width: 300px; }\n' +
    '  .mode-cards { grid-template-columns: 1fr; }\n' +
    '}\n' +
    '\n' +
    '@media (max-width: 640px) {\n' +
    '  .card-grid { grid-template-columns: 1fr; padding: 16px; gap: 12px; }\n' +
    '  .header { padding: 16px; }\n' +
    '  .filter-bar { padding: 12px 16px; gap: 8px; }\n' +
    '  .filter-bar input { min-width: 140px; }\n' +
    '  .player-toolbar { padding: 8px 12px; }\n' +
    '  .presenter-toolbar { padding: 8px 12px; }\n' +
    '}\n';
}

/**
 * 生成离线播放器的 JS 文件内容
 */
export function generateOfflineJs(): string {
  return '(function() {\n' +
    '"use strict";\n' +
    '\n' +
    '// === State ===\n' +
    'var state = {\n' +
    '  currentView: "list",\n' +
    '  currentShowId: null,\n' +
    '  currentSlide: 0,\n' +
    '  isFullscreen: false,\n' +
    '  remarkVisible: window.innerWidth >= 768,\n' +
    '  presenterMode: false,\n' +
    '  displayWindow: null\n' +
    '};\n' +
    '\n' +
    'var manifest = window.__OFFLINE_MANIFEST || { shows: {} };\n' +
    'var slideCache = {};\n' +
    'var thumbCache = {};\n' +
    '\n' +
    '// === Utility ===\n' +
    'function $(sel, ctx) { return (ctx || document).querySelector(sel); }\n' +
    'function $$(sel, ctx) { return Array.from((ctx || document).querySelectorAll(sel)); }\n' +
    'function el(tag, attrs, children) {\n' +
    '  var e = document.createElement(tag);\n' +
    '  if (attrs) Object.keys(attrs).forEach(function(k) {\n' +
    '    if (k === "className") e.className = attrs[k];\n' +
    '    else if (k === "textContent") e.textContent = attrs[k];\n' +
    '    else if (k === "innerHTML") e.innerHTML = attrs[k];\n' +
    '    else if (k.startsWith("on")) e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);\n' +
    '    else e.setAttribute(k, attrs[k]);\n' +
    '  });\n' +
    '  if (children) children.forEach(function(c) { if (c) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });\n' +
    '  return e;\n' +
    '}\n' +
    '\n' +
    '// === XOR Image Loading ===\n' +
    'var showInfoCache = {};\n' +
    'function loadShowInfo(showId) {\n' +
    '  if (showInfoCache[showId]) return Promise.resolve(showInfoCache[showId]);\n' +
    '  return new Promise(function(resolve) {\n' +
    '    var script = document.createElement("script");\n' +
    '    script.src = "shows/" + showId + "/info.js";\n' +
    '    script.onload = function() {\n' +
    '      showInfoCache[showId] = window.__SHOW_INFO;\n' +
    '      resolve(window.__SHOW_INFO || null);\n' +
    '      document.head.removeChild(script);\n' +
    '    };\n' +
    '    script.onerror = function() {\n' +
    '      resolve(null);\n' +
    '      document.head.removeChild(script);\n' +
    '    };\n' +
    '    document.head.appendChild(script);\n' +
    '  });\n' +
    '}\n' +
    '\n' +
    'function loadSlideImage(showId, resource, xorKey) {\n' +
    '  if (!xorKey) {\n' +
    '    // 明文PNG，直接返回相对路径\n' +
    '    return Promise.resolve("shows/" + showId + "/slides/" + resource.file);\n' +
    '  }\n' +
    '  // 向后兼容：旧数据使用XHR + XOR解密\n' +
    '  return new Promise(function(resolve) {\n' +
    '    var xhr = new XMLHttpRequest();\n' +
    '    xhr.open("GET", "shows/" + showId + "/slides/" + resource.file, true);\n' +
    '    xhr.responseType = "arraybuffer";\n' +
    '    xhr.onload = function() {\n' +
    '      if (xhr.status === 200 || xhr.status === 0) {\n' +
    '        try {\n' +
    '          var encrypted = new Uint8Array(xhr.response);\n' +
    '          var decrypted = new Uint8Array(encrypted.length);\n' +
    '          for (var i = 0; i < encrypted.length; i++) {\n' +
    '            decrypted[i] = encrypted[i] ^ xorKey;\n' +
    '          }\n' +
    '          var blob = new Blob([decrypted], { type: "image/png" });\n' +
    '          resolve(URL.createObjectURL(blob));\n' +
    '        } catch(e) {\n' +
    '          resolve(null);\n' +
    '        }\n' +
    '      } else {\n' +
    '        resolve(null);\n' +
    '      }\n' +
    '    };\n' +
    '    xhr.onerror = function() { resolve(null); };\n' +
    '    xhr.send();\n' +
    '  });\n' +
    '}\n' +
    '\n' +
    'function loadThumbImage(showId, resource, xorKey) {\n' +
    '  if (!resource.thumb_file) return Promise.resolve(null);\n' +
    '  if (!xorKey) {\n' +
    '    return Promise.resolve("shows/" + showId + "/slides/" + resource.thumb_file);\n' +
    '  }\n' +
    '  return new Promise(function(resolve) {\n' +
    '    var xhr = new XMLHttpRequest();\n' +
    '    xhr.open("GET", "shows/" + showId + "/slides/" + resource.thumb_file, true);\n' +
    '    xhr.responseType = "arraybuffer";\n' +
    '    xhr.onload = function() {\n' +
    '      if (xhr.status === 200 || xhr.status === 0) {\n' +
    '        try {\n' +
    '          var encrypted = new Uint8Array(xhr.response);\n' +
    '          var decrypted = new Uint8Array(encrypted.length);\n' +
    '          for (var i = 0; i < encrypted.length; i++) {\n' +
    '            decrypted[i] = encrypted[i] ^ xorKey;\n' +
    '          }\n' +
    '          var blob = new Blob([decrypted], { type: "image/jpeg" });\n' +
    '          resolve(URL.createObjectURL(blob));\n' +
    '        } catch(e) {\n' +
    '          resolve(null);\n' +
    '        }\n' +
    '      } else {\n' +
    '        resolve(null);\n' +
    '      }\n' +
    '    };\n' +
    '    xhr.onerror = function() { resolve(null); };\n' +
    '    xhr.send();\n' +
    '  });\n' +
    '}\n' +
    '\n' +
    'async function preloadAllSlides(showId, resources, xorKey) {\n' +
    '  if (slideCache[showId]) return slideCache[showId];\n' +
    '  var urls = [];\n' +
    '  for (var i = 0; i < resources.length; i++) {\n' +
    '    var url = await loadSlideImage(showId, resources[i], xorKey);\n' +
    '    urls.push(url);\n' +
    '  }\n' +
    '  slideCache[showId] = urls;\n' +
    '  return urls;\n' +
    '}\n' +
    '\n' +
    'async function preloadAllThumbs(showId, resources, xorKey) {\n' +
    '  if (thumbCache[showId]) return thumbCache[showId];\n' +
    '  var urls = [];\n' +
    '  for (var i = 0; i < resources.length; i++) {\n' +
    '    var url = await loadThumbImage(showId, resources[i], xorKey);\n' +
    '    urls.push(url);\n' +
    '  }\n' +
    '  thumbCache[showId] = urls;\n' +
    '  return urls;\n' +
    '}\n' +
    '\n' +
    '// === Cover Image Loading ===\n' +
    'function getCoverImageUrl(showId) {\n' +
    '  return "shows/" + showId + "/cover_thumb.jpg";\n' +
    '}\n' +
    '\n' +
    'function loadCoverImage(showId) {\n' +
    '  return new Promise(function(resolve) {\n' +
    '    var img = new Image();\n' +
    '    img.onload = function() { resolve(getCoverImageUrl(showId)); };\n' +
    '    img.onerror = function() {\n' +
    '      // Fallback: use first slide image directly\n' +
    '      loadShowInfo(showId).then(function(info) {\n' +
    '        if (info && info.resources && info.resources.length > 0) {\n' +
    '          var firstFile = info.resources[0].file;\n' +
    '          var xorKey = info.xor_key || 0;\n' +
    '          if (!xorKey) {\n' +
    '            // 明文PNG，直接用路径\n' +
    '            resolve("shows/" + showId + "/slides/" + firstFile);\n' +
    '          } else {\n' +
    '            // 向后兼容：旧数据需要XOR解密\n' +
    '            loadSlideImage(showId, info.resources[0], xorKey).then(resolve);\n' +
    '          }\n' +
    '        } else {\n' +
    '          resolve(null);\n' +
    '        }\n' +
    '      }).catch(function() { resolve(null); });\n' +
    '    };\n' +
    '    img.src = getCoverImageUrl(showId);\n' +
    '  });\n' +
    '}\n' +
    '\n' +
    '// === Views ===\n' +
    'function showView(name) {\n' +
    '  $$(".view").forEach(function(v) { v.classList.remove("active"); });\n' +
    '  var target = $("#view-" + name);\n' +
    '  if (target) target.classList.add("active");\n' +
    '  state.currentView = name;\n' +
    '}\n' +
    '\n' +
    '// === BroadcastChannel / localStorage sync ===\n' +
    'function broadcastSlideChange(showId, slideIndex) {\n' +
    '  try {\n' +
    '    var channel = new BroadcastChannel("slideflow-offline-" + showId);\n' +
    '    channel.postMessage({ type: "slide-change", index: slideIndex });\n' +
    '    channel.close();\n' +
    '  } catch(e) {\n' +
    '    localStorage.setItem("slideflow-offline-sync", JSON.stringify({\n' +
    '      showId: showId,\n' +
    '      index: slideIndex,\n' +
    '      timestamp: Date.now()\n' +
    '    }));\n' +
    '  }\n' +
    '}\n' +
    '\n' +
    'function listenForSlideChanges(showId, callback) {\n' +
    '  try {\n' +
    '    var channel = new BroadcastChannel("slideflow-offline-" + showId);\n' +
    '    channel.onmessage = function(e) {\n' +
    '      if (e.data && e.data.type === "slide-change") callback(e.data.index);\n' +
    '    };\n' +
    '    return function() { channel.close(); };\n' +
    '  } catch(e) {\n' +
    '    var handler = function(ev) {\n' +
    '      if (ev.key === "slideflow-offline-sync") {\n' +
    '        try {\n' +
    '          var data = JSON.parse(ev.newValue);\n' +
    '          if (data && data.showId == showId) callback(data.index);\n' +
    '        } catch(ex) {}\n' +
    '      }\n' +
    '    };\n' +
    '    window.addEventListener("storage", handler);\n' +
    '    return function() { window.removeEventListener("storage", handler); };\n' +
    '  }\n' +
    '}\n' +
    '\n' +
    '// === Hash Routing ===\n' +
    'function parseHash() {\n' +
    '  var hash = location.hash.replace(/^#/, "");\n' +
    '  if (!hash || hash === "list") return { mode: "list", id: null };\n' +
    '  var parts = hash.split("/");\n' +
    '  var mode = parts[0];\n' +
    '  var id = parts.slice(1).join("/");\n' +
    '  return { mode: mode, id: id };\n' +
    '}\n' +
    '\n' +
    'function navigateHash(mode, id) {\n' +
    '  if (mode === "list") { location.hash = "#list"; }\n' +
    '  else { location.hash = "#" + mode + "/" + id; }\n' +
    '}\n' +
    '\n' +
    '// === List View ===\n' +
    'var filterState = { search: "", subject: "", tags: [], status: "", secrecy: "" };\n' +
    '\n' +
    'function getUniqueValues(field) {\n' +
    '  var shows = manifest.shows || {};\n' +
    '  var vals = {};\n' +
    '  Object.keys(shows).forEach(function(id) {\n' +
    '    var v = shows[id][field];\n' +
    '    if (field === "tags" && Array.isArray(v)) {\n' +
    '      v.forEach(function(t) { if (t) vals[t] = 1; });\n' +
    '    } else if (v) { vals[v] = 1; }\n' +
    '  });\n' +
    '  return Object.keys(vals).sort();\n' +
    '}\n' +
    '\n' +
    'function applyFilters() {\n' +
    '  var shows = manifest.shows || {};\n' +
    '  var cards = $$(".card[data-id]");\n' +
    '  cards.forEach(function(card) {\n' +
    '    var id = card.getAttribute("data-id");\n' +
    '    var show = shows[id];\n' +
    '    if (!show) { card.classList.add("hidden"); return; }\n' +
    '    var visible = true;\n' +
    '    // search\n' +
    '    if (filterState.search) {\n' +
    '      var q = filterState.search.toLowerCase();\n' +
    '      var name = (show.name || "").toLowerCase();\n' +
    '      var owner = (show.owner_name || "").toLowerCase();\n' +
    '      if (name.indexOf(q) === -1 && owner.indexOf(q) === -1) visible = false;\n' +
    '    }\n' +
    '    // subject\n' +
    '    if (visible && filterState.subject) {\n' +
    '      if ((show.subject || "") !== filterState.subject) visible = false;\n' +
    '    }\n' +
    '    // tags\n' +
    '    if (visible && filterState.tags.length > 0) {\n' +
    '      var showTags = show.tags || [];\n' +
    '      var hasAll = filterState.tags.every(function(t) { return showTags.indexOf(t) !== -1; });\n' +
    '      if (!hasAll) visible = false;\n' +
    '    }\n' +
    '    // status\n' +
    '    if (visible && filterState.status) {\n' +
    '      if ((show.status || "active") !== filterState.status) visible = false;\n' +
    '    }\n' +
    '    // secrecy\n' +
    '    if (visible && filterState.secrecy) {\n' +
    '      if ((show.secrecy_level || "public") !== filterState.secrecy) visible = false;\n' +
    '    }\n' +
    '    card.classList.toggle("hidden", !visible);\n' +
    '  });\n' +
    '}\n' +
    '\n' +
    'function renderListView() {\n' +
    '  var app = $("#app");\n' +
    '  app.innerHTML = "";\n' +
    '  var listView = el("div", { id: "view-list", className: "view active" });\n' +
    '  var header = el("div", { className: "header" });\n' +
    '  header.appendChild(el("h1", { textContent: "SlideFlow \\u79BB\\u7EBF\\u64AD\\u653E" }));\n' +
    '  header.appendChild(el("p", { textContent: "\\u5DF2\\u7F13\\u5B58\\u7684\\u653E\\u6620\\u4ED3\\u5E93" }));\n' +
    '  listView.appendChild(header);\n' +
    '  var shows = manifest.shows || {};\n' +
    '  var keys = Object.keys(shows);\n' +
    '  if (keys.length === 0) {\n' +
    '    var empty = el("div", { className: "empty-state" });\n' +
    '    empty.appendChild(el("h2", { textContent: "\\u6682\\u65E0\\u7F13\\u5B58\\u4ED3\\u5E93" }));\n' +
    '    empty.appendChild(el("p", { textContent: "\\u8BF7\\u5728 SlideFlow \\u5728\\u7EBF\\u7AD9\\u70B9\\u4E2D\\u7F13\\u5B58\\u653E\\u6620\\u4ED3\\u5E93" }));\n' +
    '    listView.appendChild(empty);\n' +
    '  } else {\n' +
    '    // Filter bar\n' +
    '    var filterBar = el("div", { className: "filter-bar" });\n' +
    '    var searchInput = el("input", { type: "text", placeholder: "\\u641C\\u7D22\\u4ED3\\u5E93\\u540D\\u79F0..." });\n' +
    '    searchInput.addEventListener("input", function() {\n' +
    '      filterState.search = searchInput.value;\n' +
    '      applyFilters();\n' +
    '    });\n' +
    '    filterBar.appendChild(searchInput);\n' +
    '    // Subject filter\n' +
    '    var subjects = getUniqueValues("subject");\n' +
    '    if (subjects.length > 0) {\n' +
    '      var subjectSel = el("select");\n' +
    '      subjectSel.appendChild(el("option", { value: "", textContent: "\\u5168\\u90E8\\u4E3B\\u4F53" }));\n' +
    '      subjects.forEach(function(s) { subjectSel.appendChild(el("option", { value: s, textContent: s })); });\n' +
    '      subjectSel.addEventListener("change", function() {\n' +
    '        filterState.subject = subjectSel.value;\n' +
    '        applyFilters();\n' +
    '      });\n' +
    '      filterBar.appendChild(subjectSel);\n' +
    '    }\n' +
    '    // Status filter\n' +
    '    var statusSel = el("select");\n' +
    '    statusSel.appendChild(el("option", { value: "", textContent: "\\u5168\\u90E8\\u72B6\\u6001" }));\n' +
    '    statusSel.appendChild(el("option", { value: "active", textContent: "\\u6D3B\\u8DC3" }));\n' +
    '    statusSel.appendChild(el("option", { value: "inactive", textContent: "\\u975E\\u6D3B\\u8DC3" }));\n' +
    '    statusSel.addEventListener("change", function() {\n' +
    '      filterState.status = statusSel.value;\n' +
    '      applyFilters();\n' +
    '    });\n' +
    '    filterBar.appendChild(statusSel);\n' +
    '    // Secrecy filter\n' +
    '    var secrecySel = el("select");\n' +
    '    secrecySel.appendChild(el("option", { value: "", textContent: "\\u5168\\u90E8\\u5BC6\\u7EA7" }));\n' +
    '    secrecySel.appendChild(el("option", { value: "public", textContent: "\\u516C\\u5F00" }));\n' +
    '    secrecySel.appendChild(el("option", { value: "internal", textContent: "\\u5185\\u90E8" }));\n' +
    '    secrecySel.appendChild(el("option", { value: "secret", textContent: "\\u673A\\u5BC6" }));\n' +
    '    secrecySel.addEventListener("change", function() {\n' +
    '      filterState.secrecy = secrecySel.value;\n' +
    '      applyFilters();\n' +
    '    });\n' +
    '    filterBar.appendChild(secrecySel);\n' +
    '    // Tags filter\n' +
    '    var allTags = getUniqueValues("tags");\n' +
    '    if (allTags.length > 0) {\n' +
    '      var tagsWrap = el("div", { className: "filter-tags-wrap" });\n' +
    '      tagsWrap.appendChild(el("span", { className: "filter-label", textContent: "\\u6807\\u7B7E:" }));\n' +
    '      allTags.forEach(function(tag) {\n' +
    '        var tagEl = el("span", { className: "filter-tag", textContent: tag });\n' +
    '        tagEl.addEventListener("click", function() {\n' +
    '          var idx = filterState.tags.indexOf(tag);\n' +
    '          if (idx === -1) { filterState.tags.push(tag); tagEl.classList.add("active"); }\n' +
    '          else { filterState.tags.splice(idx, 1); tagEl.classList.remove("active"); }\n' +
    '          applyFilters();\n' +
    '        });\n' +
    '        tagsWrap.appendChild(tagEl);\n' +
    '      });\n' +
    '      filterBar.appendChild(tagsWrap);\n' +
    '    }\n' +
    '    listView.appendChild(filterBar);\n' +
    '    // Card grid\n' +
    '    var grid = el("div", { className: "card-grid" });\n' +
    '    keys.forEach(function(id) {\n' +
    '      var show = shows[id];\n' +
    '      var card = el("div", { className: "card", "data-id": id });\n' +
    '      // Thumbnail area\n' +
    '      var thumbArea = el("div", { className: "card-thumb" });\n' +
    '      var thumbPlaceholder = el("div", { className: "card-thumb-placeholder", textContent: "\\uD83C\\uDFA8" });\n' +
    '      thumbArea.appendChild(thumbPlaceholder);\n' +
    '      // Version badge\n' +
    '      thumbArea.appendChild(el("div", { className: "card-version-badge", textContent: "v" + (show.version_no || 1) }));\n' +
    '      // Action buttons overlay\n' +
    '      var actions = el("div", { className: "card-actions" });\n' +
    '      var playBtn = el("button", { className: "card-action-btn primary", textContent: "\\u5168\\u5C4F\\u653E\\u6620" });\n' +
    '      playBtn.addEventListener("click", function(e) { e.stopPropagation(); startPlay(id); });\n' +
    '      var presBtn = el("button", { className: "card-action-btn secondary", textContent: "\\u6F14\\u8BB2\\u89C6\\u56FE" });\n' +
    '      presBtn.addEventListener("click", function(e) { e.stopPropagation(); startPresenter(id); });\n' +
    '      actions.appendChild(playBtn);\n' +
    '      actions.appendChild(presBtn);\n' +
    '      thumbArea.appendChild(actions);\n' +
    '      card.appendChild(thumbArea);\n' +
    '      // Card body\n' +
    '      var body = el("div", { className: "card-body" });\n' +
    '      body.appendChild(el("div", { className: "card-title", textContent: show.name || "\\u672A\\u547D\\u540D\\u4ED3\\u5E93" }));\n' +
    '      var meta = el("div", { className: "card-meta" });\n' +
    '      meta.appendChild(el("span", { textContent: show.slide_count + " \\u9875" }));\n' +
    '      if (show.owner_name) meta.appendChild(el("span", { textContent: show.owner_name }));\n' +
    '      if (show.cached_at) {\n' +
    '        var d = new Date(show.cached_at);\n' +
    '        meta.appendChild(el("span", { textContent: d.toLocaleDateString("zh-CN") }));\n' +
    '      }\n' +
    '      body.appendChild(meta);\n' +
    '      // Badges\n' +
    '      if (show.subject) body.appendChild(el("span", { className: "card-badge badge-subject", textContent: show.subject }));\n' +
    '      if (show.secrecy_level && show.secrecy_level !== "public") body.appendChild(el("span", { className: "card-badge badge-secrecy", textContent: show.secrecy_level }));\n' +
    '      if (show.auth_mode === "required") body.appendChild(el("span", { className: "card-badge badge-auth", textContent: "\\u9700\\u8981\\u9A8C\\u8BC1" }));\n' +
    '      card.appendChild(body);\n' +
    '      grid.appendChild(card);\n' +
    '      // Async load cover\n' +
    '      (function(cardEl, showId) {\n' +
    '        loadCoverImage(showId).then(function(url) {\n' +
    '          if (url) {\n' +
    '            var img = el("img", { alt: "cover", src: url });\n' +
    '            var ph = cardEl.querySelector(".card-thumb-placeholder");\n' +
    '            if (ph) ph.style.display = "none";\n' +
    '            cardEl.querySelector(".card-thumb").insertBefore(img, cardEl.querySelector(".card-thumb").firstChild);\n' +
    '          }\n' +
    '        });\n' +
    '      })(card, id);\n' +
    '    });\n' +
    '    listView.appendChild(grid);\n' +
    '  }\n' +
    '  app.appendChild(listView);\n' +
    '  app.appendChild(el("div", { id: "view-auth", className: "view" }));\n' +
    '  app.appendChild(el("div", { id: "view-mode", className: "view" }));\n' +
    '  app.appendChild(el("div", { id: "view-player", className: "view" }));\n' +
    '  app.appendChild(el("div", { id: "view-presenter", className: "view" }));\n' +
    '  app.appendChild(el("div", { id: "view-display", className: "view" }));\n' +
    '}\n' +
    '\n' +
    '// === Card action helpers ===\n' +
    'function startPlay(id) {\n' +
    '  var show = manifest.shows[id];\n' +
    '  if (!show) return;\n' +
    '  if (show.auth_mode === "required") {\n' +
    '    var sessionKey = "sf_auth_" + id;\n' +
    '    if (!sessionStorage.getItem(sessionKey)) { renderAuthView(id, "play"); return; }\n' +
    '  }\n' +
    '  navigateHash("play", id);\n' +
    '}\n' +
    '\n' +
    'function startPresenter(id) {\n' +
    '  var show = manifest.shows[id];\n' +
    '  if (!show) return;\n' +
    '  if (show.auth_mode === "required") {\n' +
    '    var sessionKey = "sf_auth_" + id;\n' +
    '    if (!sessionStorage.getItem(sessionKey)) { renderAuthView(id, "presenter"); return; }\n' +
    '  }\n' +
    '  navigateHash("presenter", id);\n' +
    '}\n' +
    '\n' +
    '// === Open Show ===\n' +
    'function openShow(id, targetMode) {\n' +
    '  state.currentShowId = id;\n' +
    '  var show = manifest.shows[id];\n' +
    '  if (!show) return;\n' +
    '  if (show.auth_mode === "required") {\n' +
    '    var sessionKey = "sf_auth_" + id;\n' +
    '    if (sessionStorage.getItem(sessionKey)) { renderModeSelect(id); }\n' +
    '    else { renderAuthView(id, targetMode); }\n' +
    '  } else { renderModeSelect(id); }\n' +
    '}\n' +
    '\n' +
    '// === Mode Selection ===\n' +
    'function renderModeSelect(id) {\n' +
    '  var show = manifest.shows[id];\n' +
    '  var view = $("#view-mode");\n' +
    '  view.innerHTML = "";\n' +
    '  var container = el("div", { className: "mode-select-container" });\n' +
    '  var box = el("div", { className: "mode-select-box" });\n' +
    '  box.appendChild(el("h2", { textContent: "\\u9009\\u62E9\\u64AD\\u653E\\u6A21\\u5F0F" }));\n' +
    '  var cards = el("div", { className: "mode-cards" });\n' +
    '  var fullCard = el("div", { className: "mode-card" });\n' +
    '  fullCard.appendChild(el("div", { className: "mode-card-icon", textContent: "\\uD83D\\uDCFA" }));\n' +
    '  fullCard.appendChild(el("div", { className: "mode-card-title", textContent: "\\u5168\\u5C4F\\u653E\\u6620" }));\n' +
    '  fullCard.appendChild(el("div", { className: "mode-card-sub", innerHTML: "\\u5355\\u7A97\\u53E3 \\u00B7 \\u7EAF\\u653E\\u6620" }));\n' +
    '  fullCard.addEventListener("click", function() { navigateHash("play", id); });\n' +
    '  cards.appendChild(fullCard);\n' +
    '  var presCard = el("div", { className: "mode-card" });\n' +
    '  presCard.appendChild(el("div", { className: "mode-card-icon", textContent: "\\uD83C\\uDFA4" }));\n' +
    '  presCard.appendChild(el("div", { className: "mode-card-title", textContent: "\\u8BB2\\u6F14\\u6A21\\u5F0F" }));\n' +
    '  presCard.appendChild(el("div", { className: "mode-card-sub", innerHTML: "\\u53CC\\u7A97\\u53E3 \\u00B7 \\u63A7\\u5236+\\u5907\\u6CE8" }));\n' +
    '  presCard.addEventListener("click", function() { navigateHash("presenter", id); });\n' +
    '  cards.appendChild(presCard);\n' +
    '  box.appendChild(cards);\n' +
    '  var backLink = el("span", { className: "mode-back", textContent: "\\u2190 \\u8FD4\\u56DE\\u5217\\u8868" });\n' +
    '  backLink.addEventListener("click", function() { navigateHash("list"); });\n' +
    '  box.appendChild(backLink);\n' +
    '  container.appendChild(box);\n' +
    '  view.appendChild(container);\n' +
    '  showView("mode");\n' +
    '}\n' +
    '\n' +
    '// === Auth View ===\n' +
    'function renderAuthView(id, targetMode) {\n' +
    '  var show = manifest.shows[id];\n' +
    '  var view = $("#view-auth");\n' +
    '  view.innerHTML = "";\n' +
    '  var container = el("div", { className: "auth-container" });\n' +
    '  var box = el("div", { className: "auth-box" });\n' +
    '  box.appendChild(el("h2", { textContent: "\\u8EAB\\u4EFD\\u9A8C\\u8BC1" }));\n' +
    '  box.appendChild(el("p", { textContent: "\\u300C" + (show.name || "") + "\\u300D\\u9700\\u8981\\u9A8C\\u8BC1\\u8EAB\\u4EFD\\u540E\\u624D\\u80FD\\u67E5\\u770B" }));\n' +
    '  var usernameInput = el("input", { className: "auth-input", type: "text", placeholder: "\\u7528\\u6237\\u540D" });\n' +
    '  var passwordInput = el("input", { className: "auth-input", type: "password", placeholder: "\\u5BC6\\u7801" });\n' +
    '  var btn = el("button", { className: "auth-btn", textContent: "\\u9A8C\\u8BC1" });\n' +
    '  var errorEl = el("div", { className: "auth-error", textContent: "\\u9A8C\\u8BC1\\u5931\\u8D25\\uFF0C\\u8BF7\\u91CD\\u8BD5" });\n' +
    '  var backLink = el("span", { className: "auth-back", textContent: "\\u8FD4\\u56DE\\u5217\\u8868" });\n' +
    '  box.appendChild(usernameInput);\n' +
    '  box.appendChild(passwordInput);\n' +
    '  box.appendChild(btn);\n' +
    '  box.appendChild(errorEl);\n' +
    '  box.appendChild(backLink);\n' +
    '  container.appendChild(box);\n' +
    '  view.appendChild(container);\n' +
    '  showView("auth");\n' +
    '  backLink.addEventListener("click", function() { navigateHash("list"); });\n' +
    '  btn.addEventListener("click", function() {\n' +
    '    var username = usernameInput.value.trim();\n' +
    '    var password = passwordInput.value;\n' +
    '    if (!password) { errorEl.style.display = "block"; errorEl.textContent = "\\u8BF7\\u8F93\\u5165\\u5BC6\\u7801"; return; }\n' +
    '    errorEl.style.display = "none";\n' +
    '    btn.disabled = true;\n' +
    '    btn.textContent = "\\u9A8C\\u8BC1\\u4E2D...";\n' +
    '    verifyAuth(id, username, password).then(function(ok) {\n' +
    '      btn.disabled = false;\n' +
    '      btn.textContent = "\\u9A8C\\u8BC1";\n' +
    '      if (ok) {\n' +
    '        sessionStorage.setItem("sf_auth_" + id, "1");\n' +
    '        if (targetMode === "play") { navigateHash("play", id); }\n' +
    '        else if (targetMode === "presenter") { navigateHash("presenter", id); }\n' +
    '        else { renderModeSelect(id); }\n' +
    '      } else {\n' +
    '        errorEl.style.display = "block";\n' +
    '        errorEl.textContent = "\\u9A8C\\u8BC1\\u5931\\u8D25\\uFF0C\\u7528\\u6237\\u540D\\u6216\\u5BC6\\u7801\\u9519\\u8BEF";\n' +
    '      }\n' +
    '    });\n' +
    '  });\n' +
    '  passwordInput.addEventListener("keydown", function(e) {\n' +
    '    if (e.key === "Enter") btn.click();\n' +
    '  });\n' +
    '}\n' +
    '\n' +
    '// === Auth Verification ===\n' +
    'function verifyAuth(id, username, password) {\n' +
    '  return loadShowScript(id, "auth.js").then(function() {\n' +
    '    var auth = window.__SHOW_AUTH;\n' +
    '    if (navigator.onLine && auth && auth.verify_url) {\n' +
    '      return fetch(auth.verify_url, {\n' +
    '        method: "POST",\n' +
    '        headers: { "Content-Type": "application/json" },\n' +
    '        body: JSON.stringify({ username: username, password: password, show_id: id })\n' +
    '      }).then(function(r) { return r.json(); }).then(function(data) {\n' +
    '        return !!data.success;\n' +
    '      }).catch(function() { return offlineVerify(password, auth); });\n' +
    '    }\n' +
    '    return offlineVerify(password, auth);\n' +
    '  }).catch(function() {\n' +
    '    if (navigator.onLine && manifest.server_url) {\n' +
    '      var url = manifest.server_url.replace(/\\/$/, "") + "/api/auth/verify-offline";\n' +
    '      return fetch(url, {\n' +
    '        method: "POST",\n' +
    '        headers: { "Content-Type": "application/json" },\n' +
    '        body: JSON.stringify({ username: username, password: password, show_id: id })\n' +
    '      }).then(function(r) { return r.json(); }).then(function(data) {\n' +
    '        return !!data.success;\n' +
    '      }).catch(function() { return false; });\n' +
    '    }\n' +
    '    return Promise.resolve(false);\n' +
    '  });\n' +
    '}\n' +
    '\n' +
    'function offlineVerify(password, auth) {\n' +
    '  if (!auth || !auth.password_hash) return Promise.resolve(false);\n' +
    '  try {\n' +
    '    var result = bcryptCheckpw(password, auth.password_hash);\n' +
    '    return Promise.resolve(result);\n' +
    '  } catch(e) { return Promise.resolve(false); }\n' +
    '}\n' +
    '\n' +
    '// === Minimal bcrypt verify ===\n' +
    'var BCRYPT_CHARS = "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";\n' +
    'function bcryptCheckpw(password, hash) {\n' +
    '  if (!hash || hash.length < 59) return false;\n' +
    '  var parts = hash.split("$");\n' +
    '  if (parts.length < 4) return false;\n' +
    '  var cost = parseInt(parts[2], 10);\n' +
    '  if (isNaN(cost) || cost < 4 || cost > 31) return false;\n' +
    '  var saltAndHash = parts[3];\n' +
    '  var salt = bcryptDecode64(saltAndHash.substring(0, 22), 16);\n' +
    '  var expectedHash = bcryptDecode64(saltAndHash.substring(22), 23);\n' +
    '  var computed = bcryptHashpw(password, salt, cost);\n' +
    '  if (computed.length !== expectedHash.length) return false;\n' +
    '  var diff = 0;\n' +
    '  for (var i = 0; i < computed.length; i++) diff |= computed[i] ^ expectedHash[i];\n' +
    '  return diff === 0;\n' +
    '}\n' +
    'function bcryptDecode64(str, maxLen) {\n' +
    '  var bytes = [];\n' +
    '  var i = 0, c1, c2, c3, c4;\n' +
    '  while (i < str.length && bytes.length < maxLen) {\n' +
    '    c1 = BCRYPT_CHARS.indexOf(str.charAt(i++));\n' +
    '    c2 = i < str.length ? BCRYPT_CHARS.indexOf(str.charAt(i++)) : 0;\n' +
    '    c3 = i < str.length ? BCRYPT_CHARS.indexOf(str.charAt(i++)) : 0;\n' +
    '    c4 = i < str.length ? BCRYPT_CHARS.indexOf(str.charAt(i++)) : 0;\n' +
    '    if (c1 < 0 || c2 < 0 || c3 < 0 || c4 < 0) break;\n' +
    '    bytes.push(((c1 << 2) | (c2 >> 4)) & 0xff);\n' +
    '    if (bytes.length >= maxLen) break;\n' +
    '    bytes.push(((c2 << 4) | (c3 >> 2)) & 0xff);\n' +
    '    if (bytes.length >= maxLen) break;\n' +
    '    bytes.push(((c3 << 6) | c4) & 0xff);\n' +
    '  }\n' +
    '  return bytes;\n' +
    '}\n' +
    'function bcryptHashpw(password, salt, cost) {\n' +
    '  throw new Error("offline-bcrypt-unavailable");\n' +
    '}\n' +
    '\n' +
    '// === Load Show Script (for auth.js only) ===\n' +
    'function loadShowScript(id, filename) {\n' +
    '  return new Promise(function(resolve, reject) {\n' +
    '    var script = document.createElement("script");\n' +
    '    script.src = "shows/" + id + "/" + filename;\n' +
    '    script.onload = resolve;\n' +
    '    script.onerror = reject;\n' +
    '    document.head.appendChild(script);\n' +
    '  });\n' +
    '}\n' +
    '\n' +
    '// === Player (Fullscreen Mode) ===\n' +
    'async function loadPlayer(id) {\n' +
    '  var view = $("#view-player");\n' +
    '  view.innerHTML = "<div class=\\"loading-container\\">\\u52A0\\u8F7D\\u4E2D...</div>";\n' +
    '  showView("player");\n' +
    '  var info = await loadShowInfo(id);\n' +
    '  var show = manifest.shows[id];\n' +
    '  if (!info) info = show || {};\n' +
    '  var resources = info.resources || [];\n' +
    '  var xorKey = info.xor_key || 0;\n' +
    '  var slideUrls = await preloadAllSlides(id, resources, xorKey);\n' +
    '  var thumbUrls = await preloadAllThumbs(id, resources, xorKey);\n' +
    '  renderPlayer(id, info, slideUrls, thumbUrls);\n' +
    '}\n' +
    '\n' +
    'function renderPlayer(id, info, slideUrls, thumbUrls) {\n' +
    '  var show = manifest.shows[id];\n' +
    '  var slideCount = slideUrls.length || info.slide_count || 0;\n' +
    '  state.currentSlide = 0;\n' +
    '  var view = $("#view-player");\n' +
    '  view.innerHTML = "";\n' +
    '  var container = el("div", { className: "player-container" });\n' +
    '  // Toolbar\n' +
    '  var toolbar = el("div", { className: "player-toolbar" });\n' +
    '  var backBtn = el("button", { className: "toolbar-btn", textContent: "\\u2190 \\u8FD4\\u56DE" });\n' +
    '  var title = el("span", { className: "toolbar-title", textContent: info.name || (show && show.name) || "" });\n' +
    '  var counter = el("span", { className: "slide-counter", textContent: "1 / " + slideCount });\n' +
    '  var remarkBtn = el("button", { className: "toolbar-btn" + (state.remarkVisible ? " active" : ""), textContent: "\\u5907\\u6CE8" });\n' +
    '  var fsBtn = el("button", { className: "toolbar-btn", textContent: "\\u5168\\u5C4F" });\n' +
    '  toolbar.appendChild(backBtn);\n' +
    '  toolbar.appendChild(title);\n' +
    '  toolbar.appendChild(counter);\n' +
    '  toolbar.appendChild(remarkBtn);\n' +
    '  toolbar.appendChild(fsBtn);\n' +
    '  container.appendChild(toolbar);\n' +
    '  // Player content\n' +
    '  var playerContent = el("div", { className: "player-content" });\n' +
    '  var slideArea = el("div", { className: "slide-area" });\n' +
    '  var img = el("img", { className: "slide-img", alt: "slide", draggable: "false" });\n' +
    '  slideArea.appendChild(img);\n' +
    '  var leftArrow = el("button", { className: "nav-arrow left", innerHTML: "&#9664;" });\n' +
    '  var rightArrow = el("button", { className: "nav-arrow right", innerHTML: "&#9654;" });\n' +
    '  slideArea.appendChild(leftArrow);\n' +
    '  slideArea.appendChild(rightArrow);\n' +
    '  playerContent.appendChild(slideArea);\n' +
    '  // Remark panel\n' +
    '  var remarkPanel = el("div", { className: "remark-panel" + (state.remarkVisible ? "" : " hidden") });\n' +
    '  var remarkInner = el("div", { className: "remark-panel-inner" });\n' +
    '  var sections = [\n' +
    '    { id: "common-remark", title: "\\u901A\\u7528\\u5907\\u6CE8" },\n' +
    '    { id: "personal-remark", title: "\\u4E2A\\u4EBA\\u5907\\u6CE8" },\n' +
    '    { id: "show-remark", title: "\\u653E\\u6620\\u5907\\u6CE8" }\n' +
    '  ];\n' +
    '  sections.forEach(function(sec) {\n' +
    '    var section = el("div", { className: "remark-section" });\n' +
    '    var header = el("div", { className: "remark-header" });\n' +
    '    var arrow = el("span", { className: "arrow", textContent: "\\u25BC" });\n' +
    '    var titleSpan = el("span", { textContent: sec.title });\n' +
    '    header.appendChild(arrow);\n' +
    '    header.appendChild(titleSpan);\n' +
    '    var body = el("div", { className: "remark-body", id: sec.id + "-content" });\n' +
    '    body.innerHTML = "<span class=\\"no-remark\\">\\u6682\\u65E0\\u5907\\u6CE8</span>";\n' +
    '    header.addEventListener("click", function() {\n' +
    '      header.classList.toggle("collapsed");\n' +
    '      body.classList.toggle("collapsed");\n' +
    '    });\n' +
    '    section.appendChild(header);\n' +
    '    section.appendChild(body);\n' +
    '    remarkInner.appendChild(section);\n' +
    '  });\n' +
    '  remarkPanel.appendChild(remarkInner);\n' +
    '  playerContent.appendChild(remarkPanel);\n' +
    '  container.appendChild(playerContent);\n' +
    '  // Thumbnail bar\n' +
    '  var thumbBar = el("div", { className: "thumb-bar" });\n' +
    '  for (var i = 0; i < slideCount; i++) {\n' +
    '    (function(idx) {\n' +
    '      var thumb = el("div", { className: "thumb-item" + (idx === 0 ? " active" : "") });\n' +
    '      var timg = el("img", { alt: "slide " + (idx + 1) });\n' +
    '      if (slideUrls[idx]) timg.src = thumbUrls[idx] || slideUrls[idx];\n' +
    '      thumb.appendChild(timg);\n' +
    '      thumb.addEventListener("click", function() { goToSlide(idx); });\n' +
    '      thumbBar.appendChild(thumb);\n' +
    '    })(i);\n' +
    '  }\n' +
    '  container.appendChild(thumbBar);\n' +
    '  view.appendChild(container);\n' +
    '  showView("player");\n' +
    '\n' +
    '  function updateRemarks(slideIndex) {\n' +
    '    var resources = info.resources;\n' +
    '    if (!resources || !resources[slideIndex]) return;\n' +
    '    var resource = resources[slideIndex];\n' +
    '    var commonEl = document.getElementById("common-remark-content");\n' +
    '    var personalEl = document.getElementById("personal-remark-content");\n' +
    '    var showEl = document.getElementById("show-remark-content");\n' +
    '    if (commonEl) commonEl.innerHTML = resource.common_remark_html || "<span class=\\"no-remark\\">\\u6682\\u65E0\\u5907\\u6CE8</span>";\n' +
    '    if (personalEl) personalEl.innerHTML = resource.personal_remark_html || "<span class=\\"no-remark\\">\\u6682\\u65E0\\u5907\\u6CE8</span>";\n' +
    '    if (showEl) showEl.innerHTML = resource.show_remark_html || "<span class=\\"no-remark\\">\\u6682\\u65E0\\u5907\\u6CE8</span>";\n' +
    '  }\n' +
    '\n' +
    '  if (slideUrls[0]) img.src = slideUrls[0];\n' +
    '  updateRemarks(0);\n' +
    '\n' +
    '  function goToSlide(idx) {\n' +
    '    if (idx < 0 || idx >= slideCount) return;\n' +
    '    state.currentSlide = idx;\n' +
    '    if (slideUrls[idx]) img.src = slideUrls[idx];\n' +
    '    counter.textContent = (idx + 1) + " / " + slideCount;\n' +
    '    leftArrow.disabled = idx === 0;\n' +
    '    rightArrow.disabled = idx === slideCount - 1;\n' +
    '    $$(".thumb-item", thumbBar).forEach(function(t, i) { t.classList.toggle("active", i === idx); });\n' +
    '    var activeThumb = thumbBar.children[idx];\n' +
    '    if (activeThumb) activeThumb.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });\n' +
    '    updateRemarks(idx);\n' +
    '  }\n' +
    '\n' +
    '  leftArrow.disabled = true;\n' +
    '  rightArrow.disabled = slideCount <= 1;\n' +
    '  leftArrow.addEventListener("click", function() { goToSlide(state.currentSlide - 1); });\n' +
    '  rightArrow.addEventListener("click", function() { goToSlide(state.currentSlide + 1); });\n' +
    '  remarkBtn.addEventListener("click", function() {\n' +
    '    state.remarkVisible = !state.remarkVisible;\n' +
    '    remarkPanel.classList.toggle("hidden", !state.remarkVisible);\n' +
    '    remarkBtn.classList.toggle("active", state.remarkVisible);\n' +
    '  });\n' +
    '  backBtn.addEventListener("click", function() {\n' +
    '    if (state.isFullscreen) exitFullscreen();\n' +
    '    navigateHash("list");\n' +
    '  });\n' +
    '  fsBtn.addEventListener("click", function() {\n' +
    '    if (!state.isFullscreen) enterFullscreen(container);\n' +
    '    else exitFullscreen();\n' +
    '  });\n' +
    '  function onKey(e) {\n' +
    '    if (state.currentView !== "player") return;\n' +
    '    switch(e.key) {\n' +
    '      case "ArrowLeft": goToSlide(state.currentSlide - 1); break;\n' +
    '      case "ArrowRight": case " ": e.preventDefault(); goToSlide(state.currentSlide + 1); break;\n' +
    '      case "Escape":\n' +
    '        if (state.isFullscreen) exitFullscreen();\n' +
    '        else backBtn.click();\n' +
    '        break;\n' +
    '      case "f": case "F": fsBtn.click(); break;\n' +
    '    }\n' +
    '  }\n' +
    '  document.addEventListener("keydown", onKey);\n' +
    '  function enterFullscreen(elem) {\n' +
    '    var rfs = elem.requestFullscreen || elem.webkitRequestFullscreen || elem.msRequestFullscreen;\n' +
    '    if (rfs) rfs.call(elem);\n' +
    '    container.classList.add("fullscreen-active");\n' +
    '    state.isFullscreen = true;\n' +
    '    fsBtn.textContent = "\\u9000\\u51FA\\u5168\\u5C4F";\n' +
    '  }\n' +
    '  function exitFullscreen() {\n' +
    '    var efs = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;\n' +
    '    if (efs) efs.call(document);\n' +
    '    container.classList.remove("fullscreen-active");\n' +
    '    state.isFullscreen = false;\n' +
    '    fsBtn.textContent = "\\u5168\\u5C4F";\n' +
    '  }\n' +
    '  document.addEventListener("fullscreenchange", function() {\n' +
    '    if (!document.fullscreenElement) {\n' +
    '      container.classList.remove("fullscreen-active");\n' +
    '      state.isFullscreen = false;\n' +
    '      fsBtn.textContent = "\\u5168\\u5C4F";\n' +
    '    }\n' +
    '  });\n' +
    '}\n' +
    '\n' +
    '// === Presenter Mode ===\n' +
    'async function loadPresenter(id) {\n' +
    '  var view = $("#view-presenter");\n' +
    '  view.innerHTML = "<div class=\\"loading-container\\">\\u52A0\\u8F7D\\u4E2D...</div>";\n' +
    '  showView("presenter");\n' +
    '  var info = await loadShowInfo(id);\n' +
    '  var show = manifest.shows[id];\n' +
    '  if (!info) info = show || {};\n' +
    '  var resources = info.resources || [];\n' +
    '  var xorKey = info.xor_key || 0;\n' +
    '  var slideUrls = await preloadAllSlides(id, resources, xorKey);\n' +
    '  var thumbUrls = await preloadAllThumbs(id, resources, xorKey);\n' +
    '  renderPresenterView(id, info, slideUrls, thumbUrls);\n' +
    '}\n' +
    '\n' +
    'function renderPresenterView(id, info, slideUrls, thumbUrls) {\n' +
    '  var show = manifest.shows[id];\n' +
    '  var slideCount = slideUrls.length || info.slide_count || 0;\n' +
    '  state.currentSlide = 0;\n' +
    '  state.presenterMode = true;\n' +
    '  var view = $("#view-presenter");\n' +
    '  view.innerHTML = "";\n' +
    '  var container = el("div", { className: "presenter-container" });\n' +
    '  // Toolbar\n' +
    '  var toolbar = el("div", { className: "presenter-toolbar" });\n' +
    '  var backBtn = el("button", { className: "toolbar-btn", textContent: "\\u2190 \\u8FD4\\u56DE" });\n' +
    '  var titleEl = el("span", { className: "toolbar-title", textContent: (info.name || (show && show.name) || "") + " - \\u8BB2\\u6F14\\u8005\\u89C6\\u56FE" });\n' +
    '  var openDispBtn = el("button", { className: "toolbar-btn", textContent: "\\u6253\\u5F00\\u663E\\u793A\\u7A97\\u53E3" });\n' +
    '  var fsBtn = el("button", { className: "toolbar-btn", textContent: "\\u5168\\u5C4F" });\n' +
    '  toolbar.appendChild(backBtn);\n' +
    '  toolbar.appendChild(titleEl);\n' +
    '  toolbar.appendChild(openDispBtn);\n' +
    '  toolbar.appendChild(fsBtn);\n' +
    '  container.appendChild(toolbar);\n' +
    '  // Body\n' +
    '  var body = el("div", { className: "presenter-body" });\n' +
    '  var leftPanel = el("div", { className: "presenter-left" });\n' +
    '  var currentArea = el("div", { className: "presenter-current" });\n' +
    '  var currentImg = el("img", { className: "slide-img", alt: "current slide", draggable: "false" });\n' +
    '  currentArea.appendChild(currentImg);\n' +
    '  leftPanel.appendChild(currentArea);\n' +
    '  // Thumbnails section (left-bottom)\n' +
    '  var thumbsSection = el("div", { className: "presenter-thumbs" });\n' +
    '  var thumbsHeader = el("div", { className: "presenter-thumbs-header" });\n' +
    '  thumbsHeader.appendChild(el("span", { textContent: "\\u5E7B\\u706F\\u7247\\u9884\\u89C8" }));\n' +
    '  var viewToggle = el("div", { className: "view-toggle" });\n' +
    '  var gridBtn = el("button", { className: "active", textContent: "\\u7F51\\u683C", title: "\\u7F51\\u683C\\u89C6\\u56FE" });\n' +
    '  var listBtn = el("button", { textContent: "\\u5217\\u8868", title: "\\u5217\\u8868\\u89C6\\u56FE" });\n' +
    '  viewToggle.appendChild(gridBtn);\n' +
    '  viewToggle.appendChild(listBtn);\n' +
    '  thumbsHeader.appendChild(viewToggle);\n' +
    '  thumbsSection.appendChild(thumbsHeader);\n' +
    '  var thumbsList = el("div", { className: "presenter-thumbs-list" });\n' +
    '  thumbsSection.appendChild(thumbsList);\n' +
    '  leftPanel.appendChild(thumbsSection);\n' +
    '  body.appendChild(leftPanel);\n' +
    '  // Right panel: NEXT (top) + remarks (bottom)\n' +
    '  var rightPanel = el("div", { className: "presenter-right" });\n' +
    '  var nextArea = el("div", { className: "presenter-next" });\n' +
    '  var nextWrapper = el("div", { className: "presenter-next-wrapper" });\n' +
    '  var nextLabel = el("span", { className: "presenter-next-label", textContent: "NEXT" });\n' +
    '  var nextImg = el("img", { className: "slide-img", alt: "next slide", draggable: "false" });\n' +
    '  nextWrapper.appendChild(nextLabel);\n' +
    '  nextWrapper.appendChild(nextImg);\n' +
    '  nextArea.appendChild(nextWrapper);\n' +
    '  rightPanel.appendChild(nextArea);\n' +
    '  var thumbItemEls = [];\n' +
    '  var currentThumbView = "grid";\n' +
    '  function renderThumbs(mode) {\n' +
    '    currentThumbView = mode;\n' +
    '    thumbsList.innerHTML = "";\n' +
    '    thumbItemEls = [];\n' +
    '    var resources = info.resources || [];\n' +
    '    if (mode === "grid") {\n' +
    '      var grid = el("div", { className: "presenter-thumbs-grid" });\n' +
    '      for (var i = 0; i < slideCount; i++) {\n' +
    '        (function(idx) {\n' +
    '          var card = el("div", { className: "presenter-thumb-card" + (idx === state.currentSlide ? " active" : "") });\n' +
    '          var src = (thumbUrls && thumbUrls[idx]) || slideUrls[idx];\n' +
    '          if (src) {\n' +
    '            var imgEl = el("img", { alt: "slide " + (idx + 1) });\n' +
    '            imgEl.src = src;\n' +
    '            card.appendChild(imgEl);\n' +
    '          }\n' +
    '          card.appendChild(el("span", { className: "index-badge", textContent: String(idx + 1) }));\n' +
    '          card.addEventListener("click", function() { goToSlide(idx); });\n' +
    '          grid.appendChild(card);\n' +
    '          thumbItemEls.push(card);\n' +
    '        })(i);\n' +
    '      }\n' +
    '      thumbsList.appendChild(grid);\n' +
    '    } else {\n' +
    '      var rows = el("div", { className: "presenter-thumbs-rows" });\n' +
    '      for (var j = 0; j < slideCount; j++) {\n' +
    '        (function(idx) {\n' +
    '          var resource = resources[idx] || {};\n' +
    '          var row = el("div", { className: "presenter-thumb-row" + (idx === state.currentSlide ? " active" : "") });\n' +
    '          row.appendChild(el("span", { className: "row-index", textContent: String(idx + 1) }));\n' +
    '          var thumb = el("div", { className: "row-thumb" });\n' +
    '          var src = (thumbUrls && thumbUrls[idx]) || slideUrls[idx];\n' +
    '          if (src) {\n' +
    '            var imgEl = el("img", { alt: "slide " + (idx + 1) });\n' +
    '            imgEl.src = src;\n' +
    '            thumb.appendChild(imgEl);\n' +
    '          }\n' +
    '          row.appendChild(thumb);\n' +
    '          var nameText = resource.name || ("Slide " + (idx + 1));\n' +
    '          row.appendChild(el("span", { className: "row-name", textContent: nameText }));\n' +
    '          row.addEventListener("click", function() { goToSlide(idx); });\n' +
    '          rows.appendChild(row);\n' +
    '          thumbItemEls.push(row);\n' +
    '        })(j);\n' +
    '      }\n' +
    '      thumbsList.appendChild(rows);\n' +
    '    }\n' +
    '  }\n' +
    '  gridBtn.addEventListener("click", function() {\n' +
    '    if (currentThumbView === "grid") return;\n' +
    '    gridBtn.classList.add("active");\n' +
    '    listBtn.classList.remove("active");\n' +
    '    renderThumbs("grid");\n' +
    '  });\n' +
    '  listBtn.addEventListener("click", function() {\n' +
    '    if (currentThumbView === "list") return;\n' +
    '    listBtn.classList.add("active");\n' +
    '    gridBtn.classList.remove("active");\n' +
    '    renderThumbs("list");\n' +
    '  });\n' +
    '  // Remarks section\n' +
    '  var remarksSection = el("div", { className: "presenter-remarks" });\n' +
    '  var remarkSections = [\n' +
    '    { id: "pres-common-remark", title: "\\u901A\\u7528\\u5907\\u6CE8" },\n' +
    '    { id: "pres-personal-remark", title: "\\u4E2A\\u4EBA\\u5907\\u6CE8" },\n' +
    '    { id: "pres-show-remark", title: "\\u653E\\u6620\\u5907\\u6CE8" }\n' +
    '  ];\n' +
    '  remarkSections.forEach(function(sec) {\n' +
    '    var section = el("div", { className: "remark-section" });\n' +
    '    var header = el("div", { className: "remark-header" });\n' +
    '    var arrow = el("span", { className: "arrow", textContent: "\\u25BC" });\n' +
    '    var titleSpan = el("span", { textContent: sec.title });\n' +
    '    header.appendChild(arrow);\n' +
    '    header.appendChild(titleSpan);\n' +
    '    var bodyEl = el("div", { className: "remark-body", id: sec.id + "-content" });\n' +
    '    bodyEl.innerHTML = "<span class=\\"no-remark\\">\\u6682\\u65E0\\u5907\\u6CE8</span>";\n' +
    '    header.addEventListener("click", function() {\n' +
    '      header.classList.toggle("collapsed");\n' +
    '      bodyEl.classList.toggle("collapsed");\n' +
    '    });\n' +
    '    section.appendChild(header);\n' +
    '    section.appendChild(bodyEl);\n' +
    '    remarksSection.appendChild(section);\n' +
    '  });\n' +
    '  rightPanel.appendChild(remarksSection);\n' +
    '  body.appendChild(rightPanel);\n' +
    '  container.appendChild(body);\n' +
    '  // Controls\n' +
    '  var controls = el("div", { className: "presenter-controls" });\n' +
    '  var prevBtn = el("button", { className: "nav-btn", textContent: "\\u25C0 \\u4E0A\\u4E00\\u9875" });\n' +
    '  var pageInfo = el("span", { className: "page-info", textContent: "1 / " + slideCount });\n' +
    '  var nextBtn = el("button", { className: "nav-btn", textContent: "\\u4E0B\\u4E00\\u9875 \\u25B6" });\n' +
    '  controls.appendChild(prevBtn);\n' +
    '  controls.appendChild(pageInfo);\n' +
    '  controls.appendChild(nextBtn);\n' +
    '  container.appendChild(controls);\n' +
    '  view.appendChild(container);\n' +
    '  showView("presenter");\n' +
    '\n' +
    '  function setSlideSrc(idx) {\n' +
    '    if (slideUrls[idx]) currentImg.src = slideUrls[idx];\n' +
    '    if (idx + 1 < slideCount && slideUrls[idx + 1]) {\n' +
    '      nextImg.src = slideUrls[idx + 1];\n' +
    '      nextImg.style.display = "";\n' +
    '      nextLabel.textContent = "NEXT";\n' +
    '    } else {\n' +
    '      nextImg.src = "";\n' +
    '      nextImg.style.display = "none";\n' +
    '      nextLabel.textContent = "END";\n' +
    '    }\n' +
    '  }\n' +
    '\n' +
    '  function updatePresenterRemarks(slideIndex) {\n' +
    '    var resources = info.resources;\n' +
    '    if (!resources || !resources[slideIndex]) {\n' +
    '      var ids = ["pres-common-remark-content", "pres-personal-remark-content", "pres-show-remark-content"];\n' +
    '      ids.forEach(function(rid) {\n' +
    '        var e = document.getElementById(rid);\n' +
    '        if (e) e.innerHTML = "<span class=\\"no-remark\\">\\u6682\\u65E0\\u5907\\u6CE8</span>";\n' +
    '      });\n' +
    '      return;\n' +
    '    }\n' +
    '    var resource = resources[slideIndex];\n' +
    '    var commonEl = document.getElementById("pres-common-remark-content");\n' +
    '    var personalEl = document.getElementById("pres-personal-remark-content");\n' +
    '    var showEl = document.getElementById("pres-show-remark-content");\n' +
    '    if (commonEl) commonEl.innerHTML = resource.common_remark_html || "<span class=\\"no-remark\\">\\u6682\\u65E0\\u5907\\u6CE8</span>";\n' +
    '    if (personalEl) personalEl.innerHTML = resource.personal_remark_html || "<span class=\\"no-remark\\">\\u6682\\u65E0\\u5907\\u6CE8</span>";\n' +
    '    if (showEl) showEl.innerHTML = resource.show_remark_html || "<span class=\\"no-remark\\">\\u6682\\u65E0\\u5907\\u6CE8</span>";\n' +
    '  }\n' +
    '\n' +
    '  function updateActiveThumb(idx) {\n' +
    '    for (var k = 0; k < thumbItemEls.length; k++) {\n' +
    '      thumbItemEls[k].classList.toggle("active", k === idx);\n' +
    '    }\n' +
    '    var activeEl = thumbItemEls[idx];\n' +
    '    if (activeEl && activeEl.scrollIntoView) {\n' +
    '      try { activeEl.scrollIntoView({ behavior: "smooth", block: "nearest" }); } catch(e) {}\n' +
    '    }\n' +
    '  }\n' +
    '\n' +
    '  function goToSlide(idx) {\n' +
    '    if (idx < 0 || idx >= slideCount) return;\n' +
    '    state.currentSlide = idx;\n' +
    '    setSlideSrc(idx);\n' +
    '    pageInfo.textContent = (idx + 1) + " / " + slideCount;\n' +
    '    prevBtn.disabled = idx === 0;\n' +
    '    nextBtn.disabled = idx === slideCount - 1;\n' +
    '    updatePresenterRemarks(idx);\n' +
    '    updateActiveThumb(idx);\n' +
    '    broadcastSlideChange(id, idx);\n' +
    '  }\n' +
    '\n' +
    '  renderThumbs("grid");\n' +
    '  setSlideSrc(0);\n' +
    '  updatePresenterRemarks(0);\n' +
    '  updateActiveThumb(0);\n' +
    '  prevBtn.disabled = true;\n' +
    '  nextBtn.disabled = slideCount <= 1;\n' +
    '  prevBtn.addEventListener("click", function() { goToSlide(state.currentSlide - 1); });\n' +
    '  nextBtn.addEventListener("click", function() { goToSlide(state.currentSlide + 1); });\n' +
    '  openDispBtn.addEventListener("click", function() {\n' +
    '    var url = location.pathname + "#display/" + id;\n' +
    '    state.displayWindow = window.open(url, "slideflow-display-" + id, "width=1024,height=768");\n' +
    '    if (state.displayWindow) {\n' +
    '      openDispBtn.textContent = "\\u663E\\u793A\\u7A97\\u53E3\\u5DF2\\u6253\\u5F00";\n' +
    '      openDispBtn.style.opacity = "0.6";\n' +
    '    }\n' +
    '  });\n' +
    '  backBtn.addEventListener("click", function() {\n' +
    '    state.presenterMode = false;\n' +
    '    if (state.isFullscreen) {\n' +
    '      var efs = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;\n' +
    '      if (efs) efs.call(document);\n' +
    '      state.isFullscreen = false;\n' +
    '    }\n' +
    '    navigateHash("list");\n' +
    '  });\n' +
    '  fsBtn.addEventListener("click", function() {\n' +
    '    if (!state.isFullscreen) {\n' +
    '      var rfs = container.requestFullscreen || container.webkitRequestFullscreen || container.msRequestFullscreen;\n' +
    '      if (rfs) rfs.call(container);\n' +
    '      state.isFullscreen = true;\n' +
    '      fsBtn.textContent = "\\u9000\\u51FA\\u5168\\u5C4F";\n' +
    '    } else {\n' +
    '      var efs = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;\n' +
    '      if (efs) efs.call(document);\n' +
    '      state.isFullscreen = false;\n' +
    '      fsBtn.textContent = "\\u5168\\u5C4F";\n' +
    '    }\n' +
    '  });\n' +
    '  document.addEventListener("fullscreenchange", function() {\n' +
    '    if (!document.fullscreenElement && state.presenterMode) {\n' +
    '      state.isFullscreen = false;\n' +
    '      fsBtn.textContent = "\\u5168\\u5C4F";\n' +
    '    }\n' +
    '  });\n' +
    '  function onPresenterKey(e) {\n' +
    '    if (state.currentView !== "presenter") return;\n' +
    '    switch(e.key) {\n' +
    '      case "ArrowLeft": goToSlide(state.currentSlide - 1); break;\n' +
    '      case "ArrowRight": case " ": e.preventDefault(); goToSlide(state.currentSlide + 1); break;\n' +
    '      case "Escape":\n' +
    '        if (state.isFullscreen) fsBtn.click();\n' +
    '        else backBtn.click();\n' +
    '        break;\n' +
    '    }\n' +
    '  }\n' +
    '  document.addEventListener("keydown", onPresenterKey);\n' +
    '}\n' +
    '\n' +
    '// === Display View (audience window) ===\n' +
    'async function renderDisplayView(id) {\n' +
    '  var show = manifest.shows[id];\n' +
    '  if (!show) return;\n' +
    '  var app = $("#app");\n' +
    '  app.innerHTML = "<div class=\\"loading-container\\">\\u52A0\\u8F7D\\u4E2D...</div>";\n' +
    '  var info = await loadShowInfo(id);\n' +
    '  if (!info) info = show || {};\n' +
    '  var resources = info.resources || [];\n' +
    '  var xorKey = info.xor_key || 0;\n' +
    '  var slideUrls = await preloadAllSlides(id, resources, xorKey);\n' +
    '  setupDisplay(id, info, slideUrls);\n' +
    '}\n' +
    '\n' +
    'function setupDisplay(id, info, slideUrls) {\n' +
    '  var slideCount = slideUrls.length || info.slide_count || 0;\n' +
    '  var app = $("#app");\n' +
    '  app.innerHTML = "";\n' +
    '  var displayView = el("div", { id: "view-display", className: "view active" });\n' +
    '  var container = el("div", { className: "display-container" });\n' +
    '  var img = el("img", { className: "slide-img", alt: "display slide", draggable: "false" });\n' +
    '  if (slideUrls[0]) img.src = slideUrls[0];\n' +
    '  img.setAttribute("data-index", "0");\n' +
    '  container.appendChild(img);\n' +
    '  displayView.appendChild(container);\n' +
    '  app.appendChild(displayView);\n' +
    '  // Request fullscreen\n' +
    '  setTimeout(function() {\n' +
    '    var rfs = container.requestFullscreen || container.webkitRequestFullscreen || container.msRequestFullscreen;\n' +
    '    if (rfs) { try { rfs.call(container); } catch(e) {} }\n' +
    '  }, 500);\n' +
    '  // Listen for slide changes from presenter\n' +
    '  listenForSlideChanges(id, function(index) {\n' +
    '    if (index >= 0 && index < slideCount && slideUrls[index]) {\n' +
    '      img.src = slideUrls[index];\n' +
    '      img.setAttribute("data-index", String(index));\n' +
    '    }\n' +
    '  });\n' +
    '  // Keyboard navigation fallback\n' +
    '  document.addEventListener("keydown", function(e) {\n' +
    '    var current = parseInt(img.getAttribute("data-index") || "0", 10);\n' +
    '    if (e.key === "ArrowRight" || e.key === " ") {\n' +
    '      e.preventDefault();\n' +
    '      if (current + 1 < slideCount && slideUrls[current + 1]) {\n' +
    '        current++;\n' +
    '        img.src = slideUrls[current];\n' +
    '        img.setAttribute("data-index", String(current));\n' +
    '      }\n' +
    '    } else if (e.key === "ArrowLeft") {\n' +
    '      if (current - 1 >= 0 && slideUrls[current - 1]) {\n' +
    '        current--;\n' +
    '        img.src = slideUrls[current];\n' +
    '        img.setAttribute("data-index", String(current));\n' +
    '      }\n' +
    '    }\n' +
    '  });\n' +
    '}\n' +
    '\n' +
    '// === Init ===\n' +
    'function initApp() {\n' +
    '  renderListView();\n' +
    '  handleRoute();\n' +
    '  window.addEventListener("hashchange", handleRoute);\n' +
    '}\n' +
    '\n' +
    'function handleRoute() {\n' +
    '  var route = parseHash();\n' +
    '  if (route.mode === "display" && route.id) { renderDisplayView(route.id); return; }\n' +
    '  if (route.mode === "play" && route.id) { loadPlayer(route.id); return; }\n' +
    '  if (route.mode === "presenter" && route.id) { loadPresenter(route.id); return; }\n' +
    '  showView("list");\n' +
    '}\n' +
    '\n' +
    'initApp();\n' +
    '})();\n';
}
