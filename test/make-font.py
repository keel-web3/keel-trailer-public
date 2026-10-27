"""Generate the original MIT test font. Optional regeneration: pip install fonttools.
Every glyph is constructed here from 3x5 integer rectangles, without source fonts.
"""
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from pathlib import Path
patterns={'A':['010','101','111','101','101'],'C':['111','100','100','100','111'],'D':['110','101','101','101','110'],'E':['111','100','110','100','111'],'H':['101','101','111','101','101'],'I':['111','010','010','010','111'],'K':['101','101','110','101','101'],'L':['100','100','100','100','111'],'N':['101','111','111','111','101'],'R':['110','101','110','101','101'],'T':['111','010','010','010','010'],'U':['101','101','101','101','111']}
order=['.notdef','space']+list(patterns);glyphs={};metrics={}
for name in order:
 p=TTGlyphPen(None)
 for row,line in enumerate(patterns.get(name,[])):
  for col,on in enumerate(line):
   if on=='1':
    x=col*100;y=(4-row)*100;p.moveTo((x,y));p.lineTo((x+100,y));p.lineTo((x+100,y+100));p.lineTo((x,y+100));p.closePath()
 glyphs[name]=p.glyph();metrics[name]=(400,0)
f=FontBuilder(800,isTTF=True);f.setupGlyphOrder(order);f.setupCharacterMap({32:'space',**{ord(k):k for k in patterns}});f.setupGlyf(glyphs);f.setupHorizontalMetrics(metrics);f.setupHorizontalHeader(ascent=600,descent=-100);f.setupNameTable({'familyName':'KEEL Test Pixels','styleName':'Regular','uniqueFontIdentifier':'KEEL-Test-Pixels-v1','fullName':'KEEL Test Pixels','psName':'KEELTestPixels','version':'Version 1.0','copyright':'Original test fixture; MIT License'});f.setupOS2(sTypoAscender=600,sTypoDescender=-100,usWinAscent=600,usWinDescent=100);f.setupPost();f.setupMaxp();f.font['head'].created=f.font['head'].modified=2082844800;f.save(Path(__file__).parent/'fixtures/test-pixel.ttf')
