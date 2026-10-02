// #1135: original-binary preparation contract; no browser or native-send proof.
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { strToU8, unzipSync, zipSync } from "fflate"
import { prepareAttachmentFiles } from "./attachment-files"

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const spreadsheet = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
const officeRelations = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const packageRelations = "http://schemas.openxmlformats.org/package/2006/relationships"
const drawing = "http://schemas.openxmlformats.org/drawingml/2006/main"
const chart = "http://schemas.openxmlformats.org/drawingml/2006/chart"
const spreadsheetDrawing = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
const xmlPart = (body: string) => strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`)
const relationPart = (items: Array<{ id: string; kind: string; target: string }>) => xmlPart(
  `<Relationships xmlns="${packageRelations}">${items.map(({ id, kind, target }) =>
    `<Relationship Id="${id}" Type="${officeRelations}/${kind}" Target="${target}"/>`).join("")}</Relationships>`,
)

// A connected OOXML package, not a renamed text file: two worksheets, cached
// formulas, styled cells, defined range, and a worksheet drawing linked to a chart.
const workbookParts = {
  "[Content_Types].xml": xmlPart(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`),
  "_rels/.rels": relationPart([{ id: "workbook", kind: "officeDocument", target: "xl/workbook.xml" }]),
  "xl/workbook.xml": xmlPart(`<workbook xmlns="${spreadsheet}" xmlns:r="${officeRelations}"><sheets><sheet name="Revenue" sheetId="1" r:id="sheet1"/><sheet name="Summary" sheetId="2" r:id="sheet2"/></sheets><definedNames><definedName name="MonthlyRevenue">Revenue!$B$2:$B$3</definedName></definedNames><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`),
  "xl/_rels/workbook.xml.rels": relationPart([
    { id: "sheet1", kind: "worksheet", target: "worksheets/sheet1.xml" },
    { id: "sheet2", kind: "worksheet", target: "worksheets/sheet2.xml" },
    { id: "styles", kind: "styles", target: "styles.xml" },
  ]),
  "xl/styles.xml": xmlPart(`<styleSheet xmlns="${spreadsheet}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`),
  "xl/worksheets/sheet1.xml": xmlPart(`<worksheet xmlns="${spreadsheet}" xmlns:r="${officeRelations}"><dimension ref="A1:B4"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Month</t></is></c><c r="B1" t="inlineStr"><is><t>Revenue</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>August</t></is></c><c r="B2" s="1"><v>100</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>September</t></is></c><c r="B3" s="1"><v>125</v></c></row><row r="4"><c r="A4" t="inlineStr"><is><t>Total</t></is></c><c r="B4" s="1"><f>SUM(B2:B3)</f><v>225</v></c></row></sheetData><drawing r:id="drawing1"/></worksheet>`),
  "xl/worksheets/sheet2.xml": xmlPart(`<worksheet xmlns="${spreadsheet}"><dimension ref="A1:B1"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Total revenue</t></is></c><c r="B1" s="1"><f>Revenue!B4</f><v>225</v></c></row></sheetData></worksheet>`),
  "xl/worksheets/_rels/sheet1.xml.rels": relationPart([{ id: "drawing1", kind: "drawing", target: "../drawings/drawing1.xml" }]),
  "xl/drawings/drawing1.xml": xmlPart(`<xdr:wsDr xmlns:xdr="${spreadsheetDrawing}" xmlns:a="${drawing}"><xdr:twoCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>10</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>15</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Revenue chart"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${chart}"><c:chart xmlns:c="${chart}" xmlns:r="${officeRelations}" r:id="chart1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`),
  "xl/drawings/_rels/drawing1.xml.rels": relationPart([{ id: "chart1", kind: "chart", target: "../charts/chart1.xml" }]),
  "xl/charts/chart1.xml": xmlPart(`<c:chartSpace xmlns:c="${chart}" xmlns:a="${drawing}"><c:chart><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>Revenue</c:v></c:tx><c:cat><c:strRef><c:f>Revenue!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>August</c:v></c:pt><c:pt idx="1"><c:v>September</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Revenue!$B$2:$B$3</c:f><c:numCache><c:formatCode>#,##0.00</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>100</c:v></c:pt><c:pt idx="1"><c:v>125</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:crossAx val="2"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:numFmt formatCode="General" sourceLinked="1"/><c:crossAx val="1"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx></c:plotArea><c:plotVisOnly val="1"/></c:chart></c:chartSpace>`),
}
const originalBytes = zipSync(workbookParts, { mtime: new Date("2020-01-01T00:00:00Z") })
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const variants: Array<{ label: string; name: string; type: string }> = [
  { label: "declared MIME", name: "revenue.xlsx", type: XLSX_MIME },
  { label: "empty browser MIME", name: "revenue.xlsx", type: "" },
  { label: "octet-stream browser MIME", name: "revenue.xlsx", type: "application/octet-stream" },
  { label: "uppercase extension", name: "REVENUE.XLSX", type: "" },
]

describe("#1135 original XLSX attachment through prepareAttachmentFiles", () => {
  test("fixture round-trips all OOXML parts including formulas, styles and chart", () => {
    expect(unzipSync(originalBytes)).toEqual(workbookParts)
    expect(new TextDecoder().decode(workbookParts["xl/workbook.xml"])).toContain('sheetId="2"')
    expect(new TextDecoder().decode(workbookParts["xl/worksheets/sheet1.xml"])).toContain("<f>SUM(B2:B3)</f>")
    expect(new TextDecoder().decode(workbookParts["xl/worksheets/sheet2.xml"])).toContain("<f>Revenue!B4</f>")
    expect(new TextDecoder().decode(workbookParts["xl/styles.xml"])).toContain('applyNumberFormat="1"')
    expect(new TextDecoder().decode(workbookParts["xl/charts/chart1.xml"])).toContain("Revenue!$B$2:$B$3")
  })

  for (const variant of variants) {
    const prepare = () => prepareAttachmentFiles(new File([originalBytes], variant.name, { type: variant.type }))
    test(`${variant.label}: retains one original named workbook with exact XLSX MIME, not text`, async () => {
      const result = await prepare()
      expect(result).toHaveLength(1)
      expect(result?.[0]?.file.name).toBe(variant.name)
      expect(result?.[0]?.mimeType).toBe(XLSX_MIME)
      expect(result?.[0]?.file.type).toBe(XLSX_MIME)
      expect(result?.some(({ mimeType }) => mimeType === "text/plain")).toBe(false)
    })
    test(`${variant.label}: preserves every original binary byte`, async () => {
      const result = await prepare()
      if (!result?.[0]) throw new Error("Workbook preparation returned no attachment")
      expect(new Uint8Array(await result[0].file.arrayBuffer())).toEqual(originalBytes)
    })
    test(`${variant.label}: preserves the original SHA-256`, async () => {
      const result = await prepare()
      if (!result?.[0]) throw new Error("Workbook preparation returned no attachment")
      expect(hash(new Uint8Array(await result[0].file.arrayBuffer()))).toBe(hash(originalBytes))
    })
  }

  test("DOCX still extracts readable text instead of becoming an Office-wide binary passthrough", async () => {
    const bytes = zipSync({ "word/document.xml": xmlPart('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Healthy DOCX control</w:t></w:r></w:p></w:body></w:document>') })
    const result = await prepareAttachmentFiles(new File([bytes], "notes.docx"))
    expect(result).toHaveLength(1)
    expect(result?.[0]?.mimeType).toBe("text/plain")
    expect(result?.[0]?.file.name).toBe("notes.docx")
    expect(await result?.[0]?.file.text()).toContain("Healthy DOCX control")
  })

  const controls: Array<{ name: string; type: string; bytes: Uint8Array }> = [
    { name: "pixel.png", type: "image/png", bytes: Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1cAAAAASUVORK5CYII=", "base64")) },
    { name: "report.pdf", type: "application/pdf", bytes: strToU8("%PDF-1.4\n% binary control\n%%EOF\n") },
    { name: "notes.txt", type: "text/plain", bytes: strToU8("Healthy plaintext control\n") },
  ]
  for (const control of controls) {
    test(`${control.type} control: filename, MIME and bytes stay unchanged`, async () => {
      const result = await prepareAttachmentFiles(new File([Uint8Array.from(control.bytes)], control.name, { type: control.type }))
      expect(result).toHaveLength(1)
      expect(result?.[0]?.file.name).toBe(control.name)
      expect(result?.[0]?.mimeType).toBe(control.type)
      if (!result?.[0]) throw new Error("Control preparation returned no attachment")
      expect(new Uint8Array(await result[0].file.arrayBuffer())).toEqual(control.bytes)
    })
  }

  test("MIME normalization preserves lastModified and lets the XLSX filename own document dispatch", async () => {
    const source = new File([originalBytes], "budget.xlsx", { type: "application/pdf", lastModified: 123456789 })
    const result = await prepareAttachmentFiles(source)
    expect(result?.[0]?.file.lastModified).toBe(source.lastModified)
    expect(result?.[0]?.file.type).toBe(XLSX_MIME)
    if (!result?.[0]) throw new Error("Workbook preparation returned no attachment")
    expect(new Uint8Array(await result[0].file.arrayBuffer())).toEqual(originalBytes)
  })

  test("malformed XLSX still fails existing archive preflight", async () => {
    await expect(prepareAttachmentFiles(new File(["not a workbook"], "broken.xlsx"))).rejects.toThrow()
  })

  test("unsafe archive paths still refuse the whole XLSX instead of bypassing extraction preflight", async () => {
    const bytes = zipSync({ ...workbookParts, "../escape.xml": xmlPart("<unsafe/>") })
    await expect(prepareAttachmentFiles(new File([bytes], "unsafe.xlsx"))).rejects.toThrow("unsafe file path")
  })

  test("macro-workbook extensions do not gain a generic Office binary passthrough", async () => {
    expect(await prepareAttachmentFiles(new File([originalBytes], "unsupported.xlsm", {
      type: "application/vnd.ms-excel.sheet.macroenabled.12",
    }))).toBeUndefined()
  })
})
