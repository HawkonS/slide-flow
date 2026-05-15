# PPTX 工具模块

现有业务仍可从 `app.core.ppt` 导入。该文件只显式导出已有的 10 个业务入口（含下载流程使用的 `_build_watermark_tile`），不承载实现。

- `inspect.py`：字体与页数检测。
- `split.py`：单页拆分、依赖收集和输出。
- `merge.py`：合并流程与源文件部件映射。
- `masters.py`：母版去重、布局共享、备注母版主题。
- `integrity.py`：关系完整性、内容类型和元数据修复。
- `visibility.py`：合并时的隐藏页标记。
- `images.py`：图片画布与图片型 PPTX 构建。
- `watermark.py`：图片和 PPTX 水印。
- `svg.py`：合并及水印共用的 SVG 引用修复。
- `package.py`：ZIP 读取、命名空间、包内关系路径。
- `xml.py`：保留命名空间的 OOXML 序列化。

依赖只能从业务模块流向共用工具，不能反向导入 `app.core.ppt`，也不能使用 `import *`。共用辅助函数只保留一份实现；渲染、字体替换和导入事务仍由各自的服务负责，不放入本目录。

回归检查：`python -m unittest discover -s tests -p 'test_ppt_modules.py'`。真实 WPS 服务链路检查：`python tools/smoke_resource_import_render.py 实际文件.pptx`。该工具使用临时目录、只读标准字体库，不创建素材记录。
