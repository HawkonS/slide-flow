"""Small, dependency-free HTML sanitizer for user-authored remarks.

Remarks are rendered with ``dangerouslySetInnerHTML`` in the web client.  Keep
the accepted format intentionally tiny: text and basic formatting only, with
no attributes or URL-bearing elements.
"""

from __future__ import annotations

import html
from html.parser import HTMLParser


_ALLOWED_TAGS = {"p", "br", "strong", "b", "em", "i", "u", "ul", "ol", "li"}
_VOID_TAGS = {"br"}
_SKIP_TAGS = {"script", "style", "iframe", "object", "embed", "svg", "math", "template", "form"}
_MAX_HTML_LENGTH = 100_000


class _RemarkSanitizer(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.open_tags: list[str] = []
        self.skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if self.skip_depth:
            if tag in _SKIP_TAGS:
                self.skip_depth += 1
            return
        if tag in _SKIP_TAGS:
            self.skip_depth = 1
            return
        if tag not in _ALLOWED_TAGS:
            return
        self.parts.append(f"<{tag}>")
        if tag not in _VOID_TAGS:
            self.open_tags.append(tag)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag.lower() in _ALLOWED_TAGS and tag.lower() not in _VOID_TAGS:
            self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if self.skip_depth:
            if tag in _SKIP_TAGS:
                self.skip_depth -= 1
            return
        if tag not in _ALLOWED_TAGS or tag in _VOID_TAGS or tag not in self.open_tags:
            return
        # Close nested allowed tags if malformed input omitted their end tags.
        while self.open_tags:
            current = self.open_tags.pop()
            self.parts.append(f"</{current}>")
            if current == tag:
                break

    def handle_data(self, data: str) -> None:
        if not self.skip_depth and data:
            self.parts.append(html.escape(data, quote=False))

    def handle_comment(self, data: str) -> None:
        return


def sanitize_html(value: str | None) -> str:
    """Return safe, attribute-free HTML suitable for remark rendering."""
    if not value:
        return ""
    source = str(value)
    if len(source) > _MAX_HTML_LENGTH:
        source = source[:_MAX_HTML_LENGTH]
    parser = _RemarkSanitizer()
    try:
        parser.feed(source)
        parser.close()
    except Exception:
        # Malformed input should degrade to escaped plain text, never fail a
        # request or leak unsanitized markup.
        return html.escape(source, quote=False)
    while parser.open_tags:
        parser.parts.append(f"</{parser.open_tags.pop()}>")
    return "".join(parser.parts)

