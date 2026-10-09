"""页码后处理（toc.md 要求，WPS 兼容）：
1. document.xml 去掉空 <w:pgNumType/>
2. 按节区分页脚：目录节 PAGE -> PAGE \\* ROMAN，正文节 PAGE -> PAGE \\* arabic
"""
import re
import shutil
import sys
import zipfile
from pathlib import Path

src = Path(sys.argv[1])
tmp = src.with_suffix(".tmp.docx")

with zipfile.ZipFile(src, "r") as zin:
    names = zin.namelist()
    data = {n: zin.read(n) for n in names}

doc_xml = data["word/document.xml"].decode("utf-8")

# 1. 去掉空 pgNumType
before = doc_xml.count("<w:pgNumType/>")
doc_xml = doc_xml.replace("<w:pgNumType/>", "")
print(f"移除空 pgNumType: {before} 处")

# 2. 解析各节 footerReference 顺序（default 类型）
# 节顺序 = sectPr 出现顺序：封面(无 footer)、目录(Roman)、正文(Arabic)
sect_footers = re.findall(r'<w:footerReference w:type="default" r:id="(rId\d+)"/>', doc_xml)
print("footerReference 顺序:", sect_footers)

rels = data["word/_rels/document.xml.rels"].decode("utf-8")
rid_to_file = dict(re.findall(r'Id="(rId\d+)"[^>]*Target="(footer\d+\.xml)"', rels))
print("rId->file:", rid_to_file)

# 目录节 = 第 1 个带 footer 的节，正文节 = 第 2 个
plan = {}
if len(sect_footers) >= 1:
    plan[rid_to_file.get(sect_footers[0], "")] = "ROMAN"
if len(sect_footers) >= 2:
    plan[rid_to_file.get(sect_footers[1], "")] = "arabic"
print("修补计划:", plan)

for fname, fmt in plan.items():
    key = f"word/{fname}"
    if key not in data:
        print(f"警告: {key} 不存在")
        continue
    xml = data[key].decode("utf-8")
    xml2, n = re.subn(
        r"(<w:instrText[^>]*>)\s*PAGE\s*(</w:instrText>)",
        rf"\1 PAGE \\* {fmt} \\* MERGEFORMAT \2",
        xml,
    )
    data[key] = xml2.encode("utf-8")
    print(f"{key}: 修补 {n} 处 -> {fmt}")

data["word/document.xml"] = doc_xml.encode("utf-8")

with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
    for n in names:
        zout.writestr(n, data[n])
shutil.move(tmp, src)
print("页码后处理完成:", src)
