/* 素材库跨通道迁移工作台 · 用户手册 docx 生成脚本
 * 架构：3 节（封面 R1/DS-1 → 目录 Roman → 正文 Arabic）
 * 规范：docx skill create 路由 + design-system R1 + common-rules Profile A
 */
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  ImageRun, PageBreak, Header, Footer, PageNumber, NumberFormat,
  AlignmentType, HeadingLevel, WidthType, BorderStyle, ShadingType,
  TableOfContents, SectionType, TableLayoutType, LevelFormat,
} = require("docx");
const fs = require("fs");
const path = require("path");

const IMG_DIR = "D:/trae_projects/lihua/asset-migration-tool/docs/manual-images";
const OUT = "D:/trae_projects/lihua/asset-migration-tool/用户手册.docx";

// ── 调色板 DS-1 Deep Sea（design-system.md）──
const PAL = {
  bg: "0B1C2C", accent: "529286",
  cover: { titleColor: "FFFFFF", subtitleColor: "B0B8C0", metaColor: "90989F", footerColor: "687078" },
  table: { headerBg: "529286", headerText: "FFFFFF", accentLine: "529286", innerLine: "BECFCC", surface: "E8ECEB" },
};
const NB = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const noBorders = { top: NB, bottom: NB, left: NB, right: NB };
const allNoBorders = { top: NB, bottom: NB, left: NB, right: NB, insideHorizontal: NB, insideVertical: NB };

// ── design-system.md 标题布局函数 ──
function splitTitleLines(title, charsPerLine) {
  if (title.length <= charsPerLine) return [title];
  const breakAfter = new Set([..."，。、；：！？", ..."的与和及之在于为", ..."-_—–·/", ..." \t"]);
  const lines = [];
  let remaining = title;
  while (remaining.length > charsPerLine) {
    let breakAt = -1;
    for (let i = charsPerLine; i >= Math.floor(charsPerLine * 0.6); i--) {
      if (i < remaining.length && breakAfter.has(remaining[i - 1])) { breakAt = i; break; }
    }
    if (breakAt === -1) {
      const limit = Math.min(remaining.length, Math.ceil(charsPerLine * 1.3));
      for (let i = charsPerLine + 1; i < limit; i++) {
        if (breakAfter.has(remaining[i - 1])) { breakAt = i; break; }
      }
    }
    if (breakAt === -1) {
      breakAt = charsPerLine;
      const prevChar = remaining[breakAt - 1], nextChar = remaining[breakAt];
      if (prevChar && nextChar && !breakAfter.has(prevChar) && !breakAfter.has(nextChar) &&
          /[\u4e00-\u9fff]/.test(prevChar) && /[\u4e00-\u9fff]/.test(nextChar)) breakAt -= 1;
    }
    lines.push(remaining.slice(0, breakAt).trim());
    remaining = remaining.slice(breakAt).trim();
  }
  if (remaining) lines.push(remaining);
  if (lines.length > 1 && lines[lines.length - 1].length <= 2) {
    const last = lines.pop();
    lines[lines.length - 1] += last;
  }
  return lines;
}
function calcTitleLayout(title, maxWidthTwips, preferredPt = 40, minPt = 24) {
  const charsPerLine = pt => Math.floor(maxWidthTwips / (pt * 20));
  let titlePt = preferredPt, lines;
  while (titlePt >= minPt) {
    const cpl = charsPerLine(titlePt);
    if (cpl < 2) { titlePt -= 2; continue; }
    lines = splitTitleLines(title, cpl);
    if (lines.length <= 3) break;
    titlePt -= 2;
  }
  if (!lines || lines.length > 3) { lines = splitTitleLines(title, charsPerLine(minPt)); titlePt = minPt; }
  return { titlePt, titleLines: lines };
}
function calcCoverSpacing(params) {
  const { titleLineCount = 1, titlePt = 36, hasSubtitle = false, hasEnglishLabel = false,
    metaLineCount = 0, fixedHeight = 800, pageHeight = 16838, marginTop = 0, marginBottom = 0 } = params;
  const SAFETY = 1200;
  const usableHeight = pageHeight - marginTop - marginBottom - SAFETY;
  const titleHeight = titleLineCount * (titlePt * 23 + 200);
  const subtitleHeight = hasSubtitle ? (12 * 23 + 600) : 0;
  const englishLabelHeight = hasEnglishLabel ? (9 * 23 + 600) : 0;
  const metaHeight = metaLineCount * (10 * 23 + 100);
  const implicitParaHeight = 3 * 300;
  const contentHeight = titleHeight + subtitleHeight + englishLabelHeight + metaHeight + fixedHeight + implicitParaHeight;
  const remainingSpace = usableHeight - contentHeight;
  const safeRemaining = Math.max(remainingSpace, 400);
  const FOOTER_MIN = 400;
  const rawTop = Math.floor(safeRemaining * 0.55);
  const rawBottom = Math.floor(safeRemaining * 0.45);
  // 钳制 ≤5000（postcheck 上限），剩余空间留白在 exact 高度单元格底部
  const bottomSpacing = Math.min(Math.max(rawBottom, FOOTER_MIN), 5000);
  const topSpacing = Math.min(Math.max(rawTop - Math.max(0, FOOTER_MIN - rawBottom), 400), 5000);
  return { topSpacing, midSpacing: Math.max(safeRemaining - topSpacing - bottomSpacing, 0), bottomSpacing };
}

// ── R1 封面（design-system.md Recipe R1）──
function buildCoverR1(config) {
  const P = config.palette;
  const padL = 1200, padR = 800;
  const availableWidth = 11906 - padL - padR - 300;
  const { titlePt, titleLines } = calcTitleLayout(config.title, availableWidth, 40, 24);
  const titleSize = titlePt * 2;
  const spacing = calcCoverSpacing({
    titleLineCount: titleLines.length, titlePt,
    hasSubtitle: !!config.subtitle, hasEnglishLabel: !!config.englishLabel,
    metaLineCount: (config.metaLines || []).length, fixedHeight: 400,
  });
  const accentLeft = { style: BorderStyle.SINGLE, size: 8, color: P.accent, space: 12 };
  const children = [];
  children.push(new Paragraph({ spacing: { before: spacing.topSpacing } }));
  if (config.englishLabel) {
    children.push(new Paragraph({
      indent: { left: padL, right: padR }, spacing: { after: 500 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: P.accent, space: 8 } },
      children: [new TextRun({ text: config.englishLabel.split("").join("  "), size: 18, color: P.accent, font: { ascii: "Calibri", eastAsia: "SimHei" }, characterSpacing: 40 })],
    }));
  }
  for (let i = 0; i < titleLines.length; i++) {
    children.push(new Paragraph({
      indent: { left: padL },
      spacing: { after: i < titleLines.length - 1 ? 100 : 300, line: Math.ceil(titlePt * 23), lineRule: "atLeast" },
      children: [new TextRun({ text: titleLines[i], size: titleSize, bold: true, color: P.cover.titleColor, font: { eastAsia: "SimHei", ascii: "Arial" } })],
    }));
  }
  if (config.subtitle) {
    children.push(new Paragraph({
      indent: { left: padL }, spacing: { after: 800 },
      children: [new TextRun({ text: config.subtitle, size: 24, color: P.cover.subtitleColor, font: { eastAsia: "Microsoft YaHei", ascii: "Arial" } })],
    }));
  }
  for (const line of (config.metaLines || [])) {
    children.push(new Paragraph({
      indent: { left: padL + 200 }, spacing: { after: 80 },
      border: { left: accentLeft },
      children: [new TextRun({ text: line, size: 24, color: P.cover.metaColor, font: { eastAsia: "Microsoft YaHei", ascii: "Arial" } })],
    }));
  }
  children.push(new Paragraph({ spacing: { before: spacing.bottomSpacing } }));
  children.push(new Paragraph({
    indent: { left: padL, right: padR },
    border: { top: { style: BorderStyle.SINGLE, size: 2, color: P.accent, space: 8 } },
    spacing: { before: 200 },
    children: [
      new TextRun({ text: config.footerLeft || "", size: 16, color: P.cover.footerColor, font: { ascii: "Arial", eastAsia: "Microsoft YaHei" } }),
      new TextRun({ text: "                                        " }),
      new TextRun({ text: config.footerRight || "", size: 16, color: P.cover.footerColor, font: { ascii: "Arial", eastAsia: "Microsoft YaHei" } }),
    ],
  }));
  return [new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: allNoBorders,
    rows: [new TableRow({
      height: { value: 16838, rule: "exact" },
      children: [new TableCell({ shading: { type: ShadingType.CLEAR, fill: P.bg }, borders: noBorders, children })],
    })],
  })];
}

// ── 正文构件（Profile A：黑体标题 + 宋体正文，1.3 倍行距，2 字符缩进）──
function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 160, line: 312 },
    children: [new TextRun({ text, bold: true, size: 32, color: "0B1220", font: { eastAsia: "SimHei", ascii: "Arial" } })],
  });
}
function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 120, line: 312 },
    children: [new TextRun({ text, bold: true, size: 28, color: "0B1220", font: { eastAsia: "SimHei", ascii: "Arial" } })],
  });
}
function body(text, opts = {}) {
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    indent: { firstLine: 480 },
    spacing: { line: 312, after: opts.after || 60 },
    children: [new TextRun({ text, size: 24, color: "000000", font: { eastAsia: "SimSun", ascii: "Times New Roman" } })],
  });
}
function bodyRuns(runs, opts = {}) {
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    indent: { firstLine: 480 },
    spacing: { line: 312, after: opts.after || 60 },
    children: runs.map(r => new TextRun({ size: 24, color: "000000", font: { eastAsia: "SimSun", ascii: "Times New Roman" }, ...r })),
  });
}
function numbered(reference, text) {
  return new Paragraph({
    numbering: { reference, level: 0 },
    alignment: AlignmentType.JUSTIFIED,
    spacing: { line: 312, after: 40 },
    children: [new TextRun({ text, size: 24, color: "000000", font: { eastAsia: "SimSun", ascii: "Times New Roman" } })],
  });
}
function caption(text) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 80, after: 240, line: 312 },
    children: [new TextRun({ text, size: 21, color: "666666", font: { eastAsia: "SimSun", ascii: "Times New Roman" } })],
  });
}
// PNG 尺寸读取（IHDR）+ 等比缩放插图
function figure(fileName, capText, displayWidth = 560) {
  const buf = fs.readFileSync(path.join(IMG_DIR, fileName));
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const displayHeight = Math.round(displayWidth * h / w);
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 120 },
      keepNext: true,
      children: [new ImageRun({ data: buf, transformation: { width: displayWidth, height: displayHeight }, type: "png" })],
    }),
    caption(capText),
  ];
}
// 表格（DS-1 表格色，跨页控制齐全）
function dataTable(title, headers, rows, widths) {
  const mkCell = (text, isHeader, i) => new TableCell({
    children: [new Paragraph({
      spacing: { line: 312 },
      children: [new TextRun({
        text, size: 21, bold: isHeader,
        color: isHeader ? PAL.table.headerText : "000000",
        font: { eastAsia: isHeader ? "SimHei" : "SimSun", ascii: "Times New Roman" },
      })],
    })],
    shading: isHeader ? { type: ShadingType.CLEAR, fill: PAL.table.headerBg } : undefined,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    width: { size: widths[i], type: WidthType.PERCENTAGE },
  });
  return [
    new Paragraph({
      keepNext: true, spacing: { before: 160, after: 80 },
      children: [new TextRun({ text: title, bold: true, size: 21, color: "444444", font: { eastAsia: "SimHei", ascii: "Arial" } })],
    }),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top: { style: BorderStyle.SINGLE, size: 4, color: PAL.table.accentLine },
        bottom: { style: BorderStyle.SINGLE, size: 4, color: PAL.table.accentLine },
        left: NB, right: NB,
        insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: PAL.table.innerLine },
        insideVertical: NB,
      },
      rows: [
        new TableRow({ tableHeader: true, cantSplit: true, children: headers.map((t, i) => mkCell(t, true, i)) }),
        ...rows.map(r => new TableRow({ cantSplit: true, children: r.map((t, i) => mkCell(t, false, i)) })),
      ],
    }),
  ];
}
function pageFooter() {
  return new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: "888888" })],
    })],
  });
}
function bodyHeader() {
  return new Header({
    children: [new Paragraph({
      alignment: AlignmentType.RIGHT,
      border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: "CCCCCC", space: 4 } },
      children: [new TextRun({ text: "素材库跨通道迁移工作台 · 用户手册", size: 16, color: "999999", font: { eastAsia: "SimSun", ascii: "Times New Roman" } })],
    })],
  });
}

// ── 正文内容 ──
const bodyChildren = [];

bodyChildren.push(h1("一、项目背景"));
bodyChildren.push(body("素材库平台对外提供统一的「服务商标识」通道（如火山引擎、移动云等），同一模型业务可能同时接入多个通道。同一素材在不同通道中对应不同的素材 ID，互相不通用：当业务需要切换通道、双通道并行或灾备时，原有素材无法直接使用，成为核心障碍。"));
bodyChildren.push(body("本工具为解决这一问题而生：把一个通道里的素材组与素材，批量、可校验、可追溯地迁移到另一个通道，让「切换 Provider」从数据风险操作变成常规操作。工具采用网页版工作台形态，在任何一台能访问素材库平台的机器上启动服务，用浏览器打开页面即可操作，无需安装客户端。"));
bodyChildren.push(body("迁移采用 URL 直传方式：源素材的下载地址直接交给目标通道拉取，素材字节不经过工具，速度快、磁盘占用小。逐素材校验「目标存在、状态可用、类型一致」，未通过即标记失败；目标已存在的同名素材自动跳过，任务可以放心重复执行。"));

bodyChildren.push(h1("二、功能总览"));
bodyChildren.push(body("工作台页面顶部有三个标签页，对应三个功能模块：通道配置（使用前的准备）、素材浏览（迁移前的核对）、迁移任务（核心功能）。以下分节说明各模块的界面与操作。"));

bodyChildren.push(h2("2.1 通道配置"));
bodyChildren.push(body("通道是使用本工具的前提。每个通道对应素材库平台的一个「服务商标识」，需要配置五项信息：名称（自定义便于识别）、服务地址（平台地址）、服务商标识（平台分配的通道标识，如 volcano、ecloud）、ProjectName（数据隔离的项目名）、访问令牌（sk- 开头，等同账号权限）。"));
bodyChildren.push(...figure("01-通道配置.png", "图 1 通道配置页：通道列表与新增入口"));
bodyChildren.push(body("录入信息后，建议先点击「测试连通」再保存：成功时显示延迟与该项目下的素材组数量；失败时展示完整请求链路（实际请求的 URL、HTTP 状态、响应体原文）与针对性的排查建议，可直接比对是服务地址还是服务商标识填写有误。", { after: 120 }));
bodyChildren.push(...figure("02-通道编辑与连通测试.png", "图 2 通道编辑弹窗与连通测试结果"));
bodyChildren.push(body("访问令牌在页面中只显示掩码（sk-•••• 加末四位），编辑通道时令牌留空表示保持原值不变，需要更换时直接填入新令牌即可。每个通道行的「素材」按钮可打开该通道的素材浏览弹窗：左侧为素材组列表（含「全部素材」入口），右侧为媒体卡片，支持状态与名称筛选、分页浏览，点击图片可全尺寸放大查看。", { after: 120 }));
bodyChildren.push(...figure("03-通道素材弹窗.png", "图 3 通道素材弹窗：组列表与媒体卡片"));

bodyChildren.push(h2("2.2 素材浏览"));
bodyChildren.push(body("素材浏览页按「通道、素材组、素材」三级组织。仅列出 AIGC 素材组；真人素材组须经 H5 活体认证产生，无法通过接口创建，因此不在列表中、也不可迁移。", { after: 120 }));
bodyChildren.push(...figure("05-素材浏览-组列表.png", "图 4 素材浏览：通道与素材组列表"));
bodyChildren.push(body("组内素材以媒体卡片展示：图片直接渲染缩略图并支持点击放大为全尺寸查看，视频与音频可在卡片内直接播放；每张卡片显示素材名称、ID 与状态徽章（可用、处理中、失败）。支持按状态与名称筛选，分页浏览。", { after: 120 }));
bodyChildren.push(...figure("06-素材媒体卡片.png", "图 5 组内素材的媒体卡片展示"));
bodyChildren.push(...figure("04-图片全尺寸查看.png", "图 6 图片全尺寸查看（在卡片之上层叠展示）"));

bodyChildren.push(h2("2.3 迁移任务"));
bodyChildren.push(body("迁移任务页上半部分是创建表单：选择源通道（迁出）与目标通道（迁入，二者不能相同），设定迁移范围（全部 AIGC 组或手动勾选）、状态过滤（默认只迁「可用」素材）、是否跳过目标已存在素材（默认开启），以及执行参数（并发数默认 3、轮询间隔默认 3 秒、单素材轮询上限默认 5 分钟、请求重试默认 3 次，一般无需修改）。下半部分是任务列表，展示每个任务的方向、状态、进度与操作按钮。", { after: 120 }));
bodyChildren.push(...figure("07-迁移任务页.png", "图 7 迁移任务页：创建表单与任务列表"));
bodyChildren.push(body("任务创建后自动扫描源通道并生成迁移计划（可勾选创建后立即启动）；运行中可随时暂停或取消；失败素材可一键「失败重试」。「详情」页展示组映射、逐素材状态（待迁移、上传中、轮询中、成功、失败、跳过）与运行日志，日志按最新在前排列，任务停止后画面保持稳定，便于截屏与排查。迁移完成后可导出 MD 或 CSV 报告留档，CSV 包含目标组 ID、目标素材 ID 等完整对照信息。", { after: 120 }));
bodyChildren.push(...figure("08-任务详情与日志.png", "图 8 任务详情：逐素材状态与运行日志（最新在前）"));

bodyChildren.push(h1("三、启动服务"));
bodyChildren.push(h2("3.1 启动方式"));
bodyChildren.push(body("方式一（推荐）：启动脚本。Windows 双击 start.bat，Linux/macOS 执行 ./start.sh（首次需 chmod +x start.sh）。脚本会自动完成：优先使用项目内置运行时 runtime/（若有），否则使用系统 Node.js（18 以上，缺失时给出安装指引）；检测到依赖缺失时自动执行 npm install；服务就绪后自动用默认浏览器打开页面。"));
bodyChildren.push(body("方式二：免安装部署（目标机器无需安装 Node.js）。先在装有 Node.js 的机器上双击 install-runtime.bat（或执行 node install-runtime.cjs），把 node.exe 安装到项目的 runtime/ 目录；然后将整个项目目录（含 runtime/ 与 node_modules/）拷贝到目标 Windows 机器，双击 start.bat 即可直接运行。"));
bodyChildren.push(body("方式三：手动命令。依次执行 npm install 与 npm start。"));
bodyChildren.push(h2("3.2 端口与浏览器"));
bodyChildren.push(body("默认端口 8787。更换端口：Windows 先执行 set PORT=9000 再运行 start.bat；Linux/macOS 用 PORT=9000 ./start.sh。服务就绪后自动打开浏览器（由启动脚本设置 OPEN_BROWSER=1 触发）；不想自动打开时，直接运行 node src/server.js 即可。启动成功后终端会输出访问地址，随时可用 Ctrl+C 停止服务。"));
bodyChildren.push(h2("3.3 数据目录"));
bodyChildren.push(body("所有数据保存在服务端的 data/ 目录：config.json 为通道配置与全局参数，jobs/ 子目录为迁移任务与逐素材进度。升级版本时，替换程序文件并保留 data/ 目录，通道配置与历史任务全部保留。"));
bodyChildren.push(h2("3.4 启动常见问题"));
bodyChildren.push(...dataTable("表 1 启动问题速查", ["现象", "处理"], [
  ["端口被占用 / 页面打不开", "换端口启动（见 3.2），或结束占用 8787 端口的进程"],
  ["提示未检测到 Node.js", "双击 install-runtime.bat 生成内置运行时（需先在装有 Node 的机器上执行），或安装 Node.js 18+"],
  ["提示缺少依赖 express", "脚本会自动 npm install；失败时检查网络后手动执行"],
  ["便携目录提示缺 node_modules", "重新获取完整项目目录（应包含 node_modules/）"],
], [40, 60]));

bodyChildren.push(h1("四、快速上手"));
bodyChildren.push(body("按以下五步，即可在几分钟内完成第一次迁移："));
bodyChildren.push(numbered("list-quickstart", "启动服务：Windows 双击 start.bat（首次运行自动安装依赖）；Linux 或 macOS 执行 ./start.sh；或手动执行 npm install 与 npm start。"));
bodyChildren.push(numbered("list-quickstart", "打开页面：浏览器访问 http://localhost:8787（端口可在启动时通过 PORT 环境变量修改）。"));
bodyChildren.push(numbered("list-quickstart", "配置通道：在「通道配置」新增源通道与目标通道，逐个「测试连通」确认后保存。"));
bodyChildren.push(numbered("list-quickstart", "创建迁移：进入「迁移任务」，选择源与目标通道，范围选「全部 AIGC 素材组」，状态过滤勾选「可用」，点击「创建并启动」。"));
bodyChildren.push(numbered("list-quickstart", "查看结果：任务完成后核对计数（成功加跳过应等于总数且失败为零），需要留档则导出报告。"));

bodyChildren.push(h1("五、典型场景"));
bodyChildren.push(h2("5.1 首次全量迁移"));
bodyChildren.push(body("按「快速上手」执行即可。组映射按名称自动匹配：目标通道存在同名组则复用，不存在则自动创建（组描述会注明迁移来源）。完成后导出报告留档。"));
bodyChildren.push(h2("5.2 增量补迁"));
bodyChildren.push(body("全量迁移完成后，若源通道仍在使用，过一段时间重跑同样的任务即可：已迁移的素材全部自动「跳过」，只有新增或变更的素材会真正迁移。这是日常增量的推荐做法，无需任何额外配置。"));
bodyChildren.push(h2("5.3 失败素材处理"));
bodyChildren.push(body("在任务详情中查看每条失败记录的原因（常见：源素材状态不可用、目标通道处理失败、轮询超时）。点击「失败重试」后再「启动」：已有目标素材 ID 的记录会先复查该素材是否实际已成功，不会产生重复上传。"));
bodyChildren.push(h2("5.4 应急切换与先切后补"));
bodyChildren.push(body("若目标通道素材不全而业务急需切换，可以直接切换，之后用本工具按需补迁：迁移按组进行、可反复执行，「跳过已存在」机制保证不会产生重复素材。"));

bodyChildren.push(h1("六、常见问题"));
const faqs = [
  ["测试连通报 404 或 Not Found？", "入口形如「服务地址/服务商标识/asset/v1/ark」。重点核对服务商标识是否为平台分配的原文（不含斜杠、不多加前缀），服务地址是否以 https:// 开头。失败提示中会显示实际请求的完整 URL，可直接比对。"],
  ["提示 401 或令牌错误？", "访问令牌以 sk- 开头、等同账号权限，只保存在服务端。编辑通道时令牌留空表示保持原值；更换令牌直接填入新值保存即可。"],
  ["素材一直显示「处理中」？", "目标平台对素材做异步处理（内容审核与转码），通常几秒到几分钟。工具默认轮询 5 分钟，超时按失败记录（目标素材 ID 保留在报告中）。若普遍超时，可在创建任务时调大「单素材轮询上限」。"],
  ["成功加跳过小于源素材总数？", "检查创建任务时的状态过滤：默认只迁移「可用」素材，处理中与失败的源素材不在范围内。如需全部迁移，把三个状态都勾选。"],
  ["页面提示「检测到服务重启」或「连接中断」？", "服务重启或网络瞬断时，页面会提示并自动刷新数据；样式或脚本加载失败也会自动重试恢复，无需手动处理。任务进度实时落盘，不受影响。"],
  ["可以迁移真人素材吗？", "不可以。真人素材组必须经 H5 活体认证产生，接口无法创建，因此不在迁移范围，页面组列表也只显示 AIGC 组。"],
  ["迁移会删除素材吗？", "不会。工具只做新增与校验，不删除、不修改任何一侧的已有素材，对回滚友好。"],
  ["两个通道的项目名必须一样吗？", "不需要。每个通道独立配置各自的 ProjectName，工具按通道配置自动携带。"],
];
for (const [q, a] of faqs) {
  bodyChildren.push(bodyRuns([{ text: "问：" + q, bold: true }], { after: 20 }));
  bodyChildren.push(bodyRuns([{ text: "答：" + a }], { after: 160 }));
}

bodyChildren.push(h1("七、数据与安全"));
bodyChildren.push(body("所有配置与任务记录保存在服务端 data 目录（config.json 与 jobs 子目录），可直接复制备份。升级版本时，替换程序目录并保留 data 目录，通道配置与历史任务全部保留。"));
bodyChildren.push(body("访问令牌等同账号权限：请仅在内网部署使用，并做好服务器的访问控制。页面未内置登录鉴权，如需向更大范围暴露，请在前面加一层带认证的反向代理。迁移过程中，源与目标素材都不会被删除或修改（只在目标新增），可放心试跑。"));

bodyChildren.push(h1("八、术语表"));
bodyChildren.push(...dataTable("表 2 术语说明", ["术语", "含义"], [
  ["通道 / 服务商标识", "平台为接入方分配的接口路径标识，一个通道背后对应一个上游厂商"],
  ["ProjectName", "素材数据的隔离边界，跨项目数据互不可见"],
  ["AIGC 组", "通过接口创建的普通素材组，区别于须经活体认证的真人组"],
  ["URL 直传", "源素材的下载地址直接交给目标通道拉取，工具不经手文件内容"],
  ["幂等", "同一任务重复执行结果一致：已迁移的自动跳过，不产生重复素材"],
  ["断点续跑", "服务中断后从已保存的逐素材进度继续，不重复已完成部分"],
], [25, 75]));

// ── 组装（3 节：封面 / 目录 / 正文）──
const doc = new Document({
  styles: {
    default: {
      document: {
        run: { font: { ascii: "Times New Roman", eastAsia: "SimSun" }, size: 24, color: "000000" },
        paragraph: { spacing: { line: 312 } },
      },
      heading1: {
        run: { font: { ascii: "Arial", eastAsia: "SimHei" }, size: 32, bold: true, color: "0B1220" },
        paragraph: { spacing: { before: 360, after: 160, line: 312 }, outlineLevel: 0 },
      },
      heading2: {
        run: { font: { ascii: "Arial", eastAsia: "SimHei" }, size: 28, bold: true, color: "0B1220" },
        paragraph: { spacing: { before: 240, after: 120, line: 312 }, outlineLevel: 1 },
      },
    },
  },
  numbering: {
    config: [{
      reference: "list-quickstart",
      levels: [{
        level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 720, hanging: 360 } } },
      }],
    }],
  },
  sections: [
    { // 第 1 节：封面（边距 0，无页眉页脚页码）
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 0, bottom: 0, left: 0, right: 0 } } },
      children: buildCoverR1({
        title: "素材库跨通道迁移工作台",
        subtitle: "用 户 手 册",
        englishLabel: "USER MANUAL",
        metaLines: ["版本：1.0", "适用对象：运维与实施人员", "发布日期：2026 年 10 月"],
        footerLeft: "内部资料",
        footerRight: "Asset Migration Workbench",
        palette: PAL,
      }),
    },
    { // 第 2 节：目录（罗马页码）
      properties: {
        type: SectionType.NEXT_PAGE,
        page: {
          size: { width: 11906, height: 16838 },
          margin: { top: 1440, bottom: 1440, left: 1701, right: 1417 },
          pageNumbers: { start: 1, formatType: NumberFormat.UPPER_ROMAN },
        },
      },
      footers: { default: pageFooter() },
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 480, after: 360 },
          children: [new TextRun({ text: "目  录", bold: true, size: 32, font: { eastAsia: "SimHei", ascii: "Times New Roman" } })],
        }),
        new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-2" }),
        new Paragraph({
          spacing: { before: 200 },
          children: [new TextRun({
            text: "注：本目录由域代码生成。文档编辑后如需刷新页码，请在目录上点击右键并选择「更新域」。",
            italics: true, size: 18, color: "888888", font: { eastAsia: "SimSun", ascii: "Times New Roman" },
          })],
        }),
      ],
    },
    { // 第 3 节：正文（阿拉伯页码从 1 起）
      properties: {
        type: SectionType.NEXT_PAGE,
        page: {
          size: { width: 11906, height: 16838 },
          margin: { top: 1440, bottom: 1440, left: 1701, right: 1417 },
          pageNumbers: { start: 1, formatType: NumberFormat.DECIMAL },
        },
      },
      headers: { default: bodyHeader() },
      footers: { default: pageFooter() },
      children: bodyChildren,
    },
  ],
});

Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync(OUT, buf);
  console.log("生成完成:", OUT, Math.round(buf.length / 1024) + "KB");
});
