#!/usr/bin/env python3
"""Builds the blank document the Work tab opens in paper mode.

    python3 scripts/build-paper-template.py

Like scripts/build-holmes-minion.py this is a ONE-SHOT generator writing a
committed artifact — src/office-shell/templates/paper.docx — not a build step.

Why a template at all. Setting a document's default font needs an editing API,
and this ONLYOFFICE build has none that works from the shell: the plugin
connector's first `connect` is lost if it lands before the editor's plugin
runtime is listening, after which every `callCommand` times out for the life of
the document; and `put_TextPrFontName` on the editor api updates the toolbar
without reaching the runs (checked against Liberation Serif as a control, which
also failed to change a single glyph).

A document that arrives already in Holmes Minion needs neither. The Work tab
opens this file instead of asking the editor for a blank one, which is a path
that already exists and is already exercised — `openFile`, the same one used for
a document off disk.

Kept as a generator rather than a hand-checked binary so the XML is reviewable;
a .docx nobody can read in a diff is a .docx nobody can correct.
"""
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src/office-shell/templates/paper.docx"

FONT = "Holmes Minion"

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>"""

RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""

DOCUMENT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"""

# One empty paragraph and a US Letter section with one-inch margins — what a
# blank ONLYOFFICE document is, so opening this is not visibly different from
# asking for a new one.
DOCUMENT = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p/>
<w:sectPr>
<w:pgSz w:w="12240" w:h="15840"/>
<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
</w:sectPr>
</w:body>
</w:document>"""

# The font is named in BOTH docDefaults and the Normal style. docDefaults alone
# only reaches text that inherits the whole way up, and Word and ONLYOFFICE both
# resolve Normal ahead of it — a template that set only one of the two showed
# the right name in the toolbar and the wrong glyphs on the page.
#
# Every w:rFonts slot is filled with the same family. Leaving w:eastAsia to the
# theme is what put a new document in DengXian rather than in its own font.
STYLES = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults>
<w:rPrDefault><w:rPr>
<w:rFonts w:ascii="{FONT}" w:hAnsi="{FONT}" w:eastAsia="{FONT}" w:cs="{FONT}"/>
<w:sz w:val="22"/><w:szCs w:val="22"/>
<w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/>
</w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal">
<w:name w:val="Normal"/><w:qFormat/>
<w:rPr><w:rFonts w:ascii="{FONT}" w:hAnsi="{FONT}" w:eastAsia="{FONT}" w:cs="{FONT}"/></w:rPr>
</w:style>
</w:styles>"""

PARTS = {
    "[Content_Types].xml": CONTENT_TYPES,
    "_rels/.rels": RELS,
    "word/_rels/document.xml.rels": DOCUMENT_RELS,
    "word/document.xml": DOCUMENT,
    "word/styles.xml": STYLES,
}


def main() -> int:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, text in PARTS.items():
            # A fixed timestamp so the committed bytes do not change on every run.
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, text)
    print(f"{OUT.relative_to(ROOT)}  {OUT.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
