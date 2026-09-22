"""Live WPS smoke using the same split/font/stream path as resource import.

No resource DB writes. Token is read through normal config/environment, never
printed. Example: python tools/smoke_resource_import_render.py source.pptx
"""
import argparse
import json
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.core.ppt import detect_ppt_fonts, split_pptx_to_single_pages
from app.services.resource_import.remote_fonts import snapshot_fonts
from app.services.resource_import.remote_renderer import RemoteRenderer
from app.services.resource_import.validation import _validate_import_ppt_package


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path, help="Optional empty directory to retain PNGs; otherwise temporary")
    args = parser.parse_args()
    _validate_import_ppt_package(args.source)
    if args.output:
        args.output.mkdir(parents=True, exist_ok=True)
        if any(args.output.iterdir()):
            parser.error("--output must be empty (no files are overwritten)")
    with tempfile.TemporaryDirectory(prefix="slideflow-wps-smoke-") as temp:
        directory = Path(temp)
        pages = split_pptx_to_single_pages(args.source, directory / "split")
        names = detect_ppt_fonts(args.source)
        fonts = snapshot_fonts(names, directory / "fonts")
        renderer = RemoteRenderer(threading.Event(), lambda text: print(text, flush=True))
        received = []
        try:
            def page(index, path):
                received.append(index)
                if args.output:
                    import shutil
                    shutil.copyfile(path, args.output / path.name)
                print(json.dumps({"type":"page", "index":index, "bytes":path.stat().st_size}), flush=True)
            renderer.render(list(enumerate(pages)), fonts, names, directory, page)
        finally:
            renderer.close()
        if received != list(range(len(pages))):
            raise RuntimeError("Incomplete/out-of-order render result")
        print(json.dumps({"ok":True,"pages":len(received)}))


if __name__ == "__main__": main()
