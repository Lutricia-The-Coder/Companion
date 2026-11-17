import sys
from pypdf import PdfReader
reader = PdfReader(sys.argv[1])
sys.stdout.reconfigure(encoding="utf-8")
for i, page in enumerate(reader.pages, start=1):
    text = page.extract_text() or ""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    print(f"{i}: {len(text)} chars | {' / '.join(lines[:2])}")
