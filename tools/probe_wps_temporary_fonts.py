"""Opt-in live probe: missing font upload, session visibility, then removal.

Generates private, temporary copies of a supplied PPTX and a font already in
the local standard-font library. Does not install fonts or change DB records.
"""
import argparse
import sys
import tempfile
import threading
import uuid
from pathlib import Path

from fontTools.ttLib import TTFont

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.core.ppt import detect_ppt_fonts, split_pptx_to_single_pages
from app.core.fonts import read_font_names
from app.core.resource_import_fonts import replace_ppt_fonts
from app.services.resource_import.remote_fonts import sha256_file
from app.services.resource_import.remote_renderer import RemoteRenderer


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("font", type=Path, help="Existing licensed TTF/OTF test font")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="slideflow-font-probe-") as temp:
        directory = Path(temp)
        name = "SlideFlowProbe" + uuid.uuid4().hex[:8]
        candidate = directory / (name + args.font.suffix)
        font = TTFont(args.font)
        try:
            for record in font["name"].names:
                if record.nameID in {1, 4, 6, 16}:
                    record.string = name.encode(record.getEncoding())
            font.save(candidate)
        finally:
            font.close()
        source = directory / "probe.pptx"
        replace_ppt_fonts(args.source, {n:name for n in detect_ppt_fonts(args.source)}, source)
        singles = split_pptx_to_single_pages(source, directory / "singles")
        # One slide is sufficient for font lifecycle validation on a small VM.
        remote = RemoteRenderer(threading.Event(), print)
        try:
            before = remote.request("POST", "/v1/fonts/check", json={"names":[name]}).json()
            assert name in before["missing"], "Probe font unexpectedly installed"
            remote.render([(0,singles[0])], [{"path":candidate,"sha256":sha256_file(candidate),"names":sorted(read_font_names(candidate))}], [name], directory, lambda index,path:print("Uploaded missing font and rendered:",path.stat().st_size,"bytes"))
            after = remote.request("POST", "/v1/fonts/check", json={"names":[name]}).json()
            assert name in after["missing"], "Probe font leaked into installed-font inventory"
            print("PASS: missing font upload/render/cleanup")
        finally:
            remote.close()


if __name__ == "__main__": main()
