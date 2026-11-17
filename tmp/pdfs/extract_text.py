import sys
from pypdf import PdfReader
reader = PdfReader(sys.argv[1])
with open(sys.argv[2], 'w', encoding='utf-8') as out:
    for i, page in enumerate(reader.pages, start=1):
        out.write(f'\n\n===== PAGE {i} =====\n')
        out.write(page.extract_text() or '')
