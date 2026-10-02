/* Minimal dependency-free DOCX generator for Browser Test Evidence Recorder.
 * Creates an uncompressed ZIP container (valid DOCX) with embedded PNG evidence.
 * Output format: User Manual (step-by-step guide with plain-English descriptions).
 */

const DocxReport = (() => {
  const encoder = new TextEncoder();

  function xmlEscape(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function base64ToBytes(dataUrl) {
    const comma = String(dataUrl).indexOf(",");
    if (comma < 0) throw new Error("Invalid screenshot data.");
    const base64 = String(dataUrl).slice(comma + 1);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function readPngDimensions(bytes) {
    if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
      return { width: 1280, height: 720 };
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function u16(value) {
    const a = new Uint8Array(2);
    const v = value & 0xffff;
    a[0] = v & 0xff;
    a[1] = (v >>> 8) & 0xff;
    return a;
  }

  function u32(value) {
    const a = new Uint8Array(4);
    const v = value >>> 0;
    a[0] = v & 0xff;
    a[1] = (v >>> 8) & 0xff;
    a[2] = (v >>> 16) & 0xff;
    a[3] = (v >>> 24) & 0xff;
    return a;
  }

  function concat(parts) {
    let total = 0;
    for (const part of parts) total += part.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  function zipStore(files) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    for (const file of files) {
      const name = encoder.encode(file.name);
      const data = file.data instanceof Uint8Array ? file.data : encoder.encode(String(file.data));
      const crc = crc32(data);

      const local = concat([
        u32(0x04034b50), u16(20), u16(0), u16(0), u16(dosTime), u16(dosDate),
        u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data
      ]);
      localParts.push(local);

      const central = concat([
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(dosTime), u16(dosDate),
        u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0),
        u32(0), u32(offset), name
      ]);
      centralParts.push(central);
      offset += local.length;
    }

    const central = concat(centralParts);
    const local = concat(localParts);
    const end = concat([
      u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
      u32(central.length), u32(local.length), u16(0)
    ]);
    return concat([local, central, end]);
  }

  function paragraph(text, opts = {}) {
    const bold = opts.bold ? "<w:b/>" : "";
    const italic = opts.italic ? "<w:i/>" : "";
    const size = opts.size ? `<w:sz w:val="${opts.size}"/><w:szCs w:val="${opts.size}"/>` : "";
    const color = opts.color ? `<w:color w:val="${opts.color}"/>` : "";
    const align = opts.align ? `<w:jc w:val="${opts.align}"/>` : "";
    const pageBreakBefore = opts.pageBreakBefore ? "<w:pageBreakBefore/>" : "";
    return `<w:p><w:pPr>${align}${pageBreakBefore}</w:pPr><w:r><w:rPr>${bold}${italic}${size}${color}</w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
  }

  function table(rows, widths = []) {
    const widthXml = widths.length
      ? `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>`
      : "";
    const borders = `<w:tblBorders><w:top w:val="single" w:sz="4" w:color="D9E1E8"/><w:left w:val="single" w:sz="4" w:color="D9E1E8"/><w:bottom w:val="single" w:sz="4" w:color="D9E1E8"/><w:right w:val="single" w:sz="4" w:color="D9E1E8"/><w:insideH w:val="single" w:sz="4" w:color="D9E1E8"/><w:insideV w:val="single" w:sz="4" w:color="D9E1E8"/></w:tblBorders>`;
    const body = rows.map((row, rowIndex) => `<w:tr>${row.map((cell) => `<w:tc><w:tcPr><w:tcW w:w="${widths[0] || 2500}" w:type="dxa"/></w:tcPr><w:p><w:r><w:rPr>${rowIndex === 0 ? "<w:b/>" : ""}</w:rPr><w:t xml:space="preserve">${xmlEscape(cell)}</w:t></w:r></w:p></w:tc>`).join("")}</w:tr>`).join("");
    return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${borders}</w:tblPr>${widthXml}${body}</w:tbl>`;
  }

  function imageParagraph(relId, widthPx, heightPx, docPrId) {
    const maxWidthEmu = 5715000;
    const maxHeightEmu = 6500000;
    const ratio = heightPx > 0 ? widthPx / heightPx : 16 / 9;
    let cx = maxWidthEmu;
    let cy = Math.round(cx / ratio);
    if (cy > maxHeightEmu) {
      cy = maxHeightEmu;
      cx = Math.round(cy * ratio);
    }
    return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${docPrId}" name="Step Screenshot ${docPrId}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${docPrId}" name="screenshot.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  }

  function documentXml(body) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="900" w:right="900" w:bottom="900" w:left="900"/></w:sectPr></w:body></w:document>`;
  }

  function relationshipsXml(relationships) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${xmlEscape(r.target)}"${r.external ? ` TargetMode="External"` : ""}/>`).join("")}</Relationships>`;
  }

  function contentTypesXml(imageCount) {
    const images = Array.from({ length: imageCount }, (_, i) => `<Override PartName="/word/media/image${i + 1}.png" ContentType="image/png"/>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${images}<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
  }

  function rootRelsXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  }

  function stylesXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160"/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>`;
  }

  function coreProps(title) {
    const now = new Date().toISOString();
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEscape(title)}</dc:title><dc:creator>Browser Test Evidence Recorder</dc:creator><cp:lastModifiedBy>Browser Test Evidence Recorder</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
  }

  function appProps() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Browser Test Evidence Recorder</Application></Properties>`;
  }

  function formatTimestamp(iso) {
    try {
      return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(iso));
    } catch (_) { return String(iso || ""); }
  }

  function reasonLabel(reason) {
    const labels = { click: "CLICK", navigation: "NAVIGATION", new_tab: "NEW TAB", tab_updated: "TAB UPDATED", manual: "MANUAL" };
    return labels[reason] || String(reason || "CAPTURE").toUpperCase();
  }

  /**
   * Generates a plain-English sentence describing what happened at this step.
   * Examples:
   *   "Navigate to the Login page (https://example.com/login)."
   *   "Click the Sign In button on the Login page."
   *   "Manual screenshot captured on the Dashboard page."
   */
  function stepDescription(entry) {
    const reason = entry.reason;
    const info = entry.elementInfo;
    const url = entry.url || "";
    const pageName = entry.pageName || entry.title || "";

    if (reason === "navigation" || reason === "new_tab" || reason === "tab_updated") {
      const dest = pageName ? `the "${pageName}" page` : (url || "a new page");
      return `Navigate to ${dest}${url ? ` (${url})` : ""}.`;
    }

    if (reason === "click" && info) {
      const tagNames = {
        button: "button", a: "link", input: "field",
        select: "dropdown", textarea: "text area",
        img: "image", li: "menu item", label: "label"
      };
      const friendlyTag = tagNames[info.tag] || info.tag || "element";

      let elementDesc = "";
      if (info.text && info.text.trim().length > 0 && info.text.trim().length <= 60) {
        elementDesc = `the "${info.text.trim()}" ${friendlyTag}`;
      } else if (info.id) {
        elementDesc = `the ${friendlyTag} with ID "${info.id}"`;
      } else if (info.className) {
        const cls = String(info.className).split(/\s+/)[0];
        elementDesc = `the "${cls}" ${friendlyTag}`;
      } else {
        elementDesc = `a ${friendlyTag}`;
      }

      return `Click ${elementDesc}${pageName ? ` on the "${pageName}" page` : ""}.`;
    }

    if (reason === "manual") {
      return `Manual screenshot captured${pageName ? ` on the "${pageName}" page` : ""}${url ? ` � ${url}` : ""}.`;
    }

    return `${reasonLabel(reason)}${pageName ? ` on "${pageName}"` : ""}${url ? ` � ${url}` : ""}.`;
  }

  function filenameForReport(session) {
    const tc = String(session?.testCaseId || "Session").replace(/[^a-zA-Z0-9_-]+/g, "-");
    const sid = String(session?.id || "BTE-SESSION").replace(/[^a-zA-Z0-9_-]+/g, "-");
    return `Browser Test Evidence Recorder/${tc}_${sid}_Screenshots.docx`;
  }

  async function build(history, session) {
    const entries = history
      .filter((e) => e?.sessionId === session?.id)
      .sort((a, b) => (a.sequence || 0) - (b.sequence || 0));

    if (!entries.length) throw new Error("No evidence exists in the current session.");

    const files = [];
    const relationships = [{ id: "rId1", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles", target: "styles.xml" }];
    const body = [];
    let relCounter = 1;
    let imageCounter = 0;
    let docPrId = 1;

    const docTitle = session.testCaseId || "Page Screenshots";
    for (const [index, entry] of entries.entries()) {
      const screenshot = await EvidenceDB.get(entry.id);
      let pageDescription = entry.pageName || entry.title;
      if (!pageDescription) {
        try { const url = new URL(entry.url); pageDescription = url.hostname + url.pathname; }
        catch (_) { pageDescription = "Browser page"; }
      }
      body.push(paragraph(pageDescription, {
        bold: true, size: 26, pageBreakBefore: index > 0
      }));

      // Screenshot
      if (screenshot) {
        const bytes = base64ToBytes(screenshot);
        const dims = readPngDimensions(bytes);
        imageCounter += 1;
        const imageName = `word/media/image${imageCounter}.png`;
        const imageRelId = `rId${++relCounter}`;
        files.push({ name: imageName, data: bytes });
        relationships.push({
          id: imageRelId,
          type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
          target: `media/image${imageCounter}.png`
        });
        body.push(imageParagraph(imageRelId, dims.width, dims.height, docPrId++));
      } else {
        body.push(paragraph("[ Screenshot unavailable ]", { color: "CC0000", size: 18 }));
      }

      body.push(paragraph(" "));
    }

    // -- ZIP assembly ---------------------------------------------------------
    files.push({ name: "[Content_Types].xml", data: encoder.encode(contentTypesXml(imageCounter)) });
    files.push({ name: "_rels/.rels", data: encoder.encode(rootRelsXml()) });
    files.push({ name: "word/document.xml", data: encoder.encode(documentXml(body.join(""))) });
    files.push({ name: "word/_rels/document.xml.rels", data: encoder.encode(relationshipsXml(relationships)) });
    files.push({ name: "word/styles.xml", data: encoder.encode(stylesXml()) });
    files.push({ name: "docProps/core.xml", data: encoder.encode(coreProps(docTitle)) });
    files.push({ name: "docProps/app.xml", data: encoder.encode(appProps()) });

    return zipStore(files);
  }

  return { build, filenameForReport };
})();
