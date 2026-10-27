"""Optional XML relink helper for editors requiring absolute file URLs.
Run AFTER moving/unzipping: python3 relocate.py
Writes new *-local.xml; original portable XML/manifest are unchanged.
"""
from pathlib import Path
import xml.etree.ElementTree as ET
from urllib.parse import unquote
import re
root=Path(__file__).resolve().parent
for source in sorted(root.glob('timeline-*.xml')):
    if source.stem.endswith('-local'):continue
    tree=ET.parse(source)
    for node in tree.findall('.//pathurl'):
        prefix='file:///__KEEL_PACKAGE__/'
        if not node.text.startswith(prefix):raise ValueError('Not a portable KEEL XML template')
        rel=unquote(node.text[len(prefix):])
        if not re.fullmatch(r'[A-Za-z0-9_./-]+',rel) or any(x in ('','.','..') for x in rel.split('/')):raise ValueError('Unsafe media path')
        p=root
        for component in rel.split('/'):
            p=p/component
            if p.is_symlink():raise ValueError('Symlink forbidden')
        p.resolve().relative_to(root)
        if not p.is_file():raise ValueError('Missing media: '+rel)
        node.text=p.as_uri()
    tree.write(source.with_name(source.stem+'-local.xml'),encoding='utf-8',xml_declaration=True)
