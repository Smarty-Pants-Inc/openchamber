import { describe, expect, test } from "bun:test"
import { strToU8, zipSync } from "fflate"
import { extractDocumentAttachments } from "./document-attachments"
import { PRODUCT_NAME } from '@/lib/brand.generated'

const zippedFile = (name: string, entries: Record<string, string | Uint8Array>) => new File([
  zipSync(Object.fromEntries(Object.entries(entries).map(([path, value]) => [
    path,
    typeof value === "string" ? strToU8(value) : value,
  ]))),
], name)

const relationships = (items: Array<{ id: string; target: string; type?: string }>) => `
  <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    ${items.map((item) => `<Relationship Id="${item.id}" Target="${item.target}" Type="${item.type ?? "image"}"/>`).join("")}
  </Relationships>
`

const spreadsheetNamespace = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
const officeRelationshipsNamespace = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const packageRelationshipsNamespace = "http://schemas.openxmlformats.org/package/2006/relationships"

// Minimal OPC packages with the namespace and target shapes emitted by real XLSX writers.
const workbookFile = ({
  target = "worksheets/sheet1.xml",
  workbookPrefix = "",
  worksheetPrefix = "",
  relationshipPrefix = "r",
  packagePrefix = "",
  inline = false,
} = {}) => {
  const w = workbookPrefix ? `${workbookPrefix}:` : ""
  const x = worksheetPrefix ? `${worksheetPrefix}:` : ""
  const p = packagePrefix ? `${packagePrefix}:` : ""
  return zippedFile("writer-shape.xlsx", {
    "[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
    "_rels/.rels": `<Relationships xmlns="${packageRelationshipsNamespace}"><Relationship Id="rId1" Target="xl/workbook.xml" Type="${officeRelationshipsNamespace}/officeDocument"/></Relationships>`,
    "xl/workbook.xml": `<${w}workbook xmlns="${spreadsheetNamespace}" ${w ? `xmlns:${workbookPrefix}="${spreadsheetNamespace}"` : ""} xmlns:${relationshipPrefix}="${officeRelationshipsNamespace}"><${w}sheets><${w}sheet name="Summary" sheetId="1" ${relationshipPrefix}:id="rIdSheet"/></${w}sheets></${w}workbook>`,
    "xl/_rels/workbook.xml.rels": `<${p}Relationships xmlns="${packageRelationshipsNamespace}" ${p ? `xmlns:${packagePrefix}="${packageRelationshipsNamespace}"` : ""}><${p}Relationship Id="rIdSheet" Target="${target}" Type="${officeRelationshipsNamespace}/worksheet"/></${p}Relationships>`,
    "xl/sharedStrings.xml": `<${x}sst xmlns="${spreadsheetNamespace}" ${x ? `xmlns:${worksheetPrefix}="${spreadsheetNamespace}"` : ""} count="1" uniqueCount="1"><${x}si><${x}r><${x}t>Reve</${x}t></${x}r><${x}r><${x}t>nue &amp; costs</${x}t></${x}r></${x}si></${x}sst>`,
    "xl/worksheets/sheet1.xml": `<${x}worksheet xmlns="${spreadsheetNamespace}" ${x ? `xmlns:${worksheetPrefix}="${spreadsheetNamespace}"` : ""}><${x}dimension ref="A1:C1"/><${x}sheetData><${x}row r="1"><${x}c r="A1" t="${inline ? "inlineStr" : "s"}">${inline ? `<${x}is><${x}r><${x}t>Reve</${x}t></${x}r><${x}r><${x}t>nue &amp; costs</${x}t></${x}r></${x}is>` : `<${x}v>0</${x}v>`}</${x}c><${x}c r="B1"><${x}v>42</${x}v></${x}c><${x}c r="C1"><${x}f>B1*2</${x}f><${x}v>84</${x}v></${x}c></${x}row></${x}sheetData></${x}worksheet>`,
  })
}

const pngBytes = (suffix = 0) => new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, suffix])
const jpegBytes = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0])
const webpBytes = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
])

describe("document attachment extraction", () => {
  test("extracts DOCX text and preserves inline image citations", async () => {
    const file = zippedFile("report.docx", {
      "word/document.xml": `
        <w:document xmlns:w="w" xmlns:a="a" xmlns:r="r">
          <w:body>
            <w:p><w:r><w:t>Before image</w:t></w:r></w:p>
            <w:p><w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r></w:p>
            <w:p><w:r><w:t>After image</w:t></w:r></w:p>
          </w:body>
        </w:document>`,
      "word/_rels/document.xml.rels": relationships([{ id: "rId1", target: "media/image1.png" }]),
      "word/media/image1.png": pngBytes(),
    })

    const result = await extractDocumentAttachments(file)
    const text = await result?.textFile.text() ?? ""

    expect(text.includes("Before image\n\n[report-image-1.png]\n\nAfter image")).toBe(true)
    expect(result?.textFile.name).toBe("report.docx")
    expect(result?.textFile.type.startsWith("text/plain")).toBe(true)
    expect(result?.images).toHaveLength(1)
    expect(result?.images[0]?.name).toBe("report-image-1.png")
    expect(result?.images[0]?.type).toBe("image/png")

    const deduplicated = await extractDocumentAttachments(file, ["report-image-1.png"])
    expect((await deduplicated?.textFile.text())?.includes("[report-image-2.png]")).toBe(true)
    expect(deduplicated?.images[0]?.name).toBe("report-image-2.png")
  })

  test("extracts PPTX slide text, notes, and pictures", async () => {
    const file = zippedFile("deck.pptx", {
      "ppt/slides/slide1.xml": `
        <p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r">
          <a:p><a:r><a:t>Slide title</a:t></a:r></a:p>
          <p:pic><p:blipFill><a:blip r:embed="rIdImage"/></p:blipFill></p:pic>
        </p:sld>`,
      "ppt/slides/_rels/slide1.xml.rels": relationships([
        { id: "rIdImage", target: "../media/image1.jpeg" },
        { id: "rIdNotes", target: "../notesSlides/notesSlide1.xml", type: "http://example/notesSlide" },
      ]),
      "ppt/notesSlides/notesSlide1.xml": `<p:notes xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Speaker note</a:t></a:r></a:p></p:notes>`,
      "ppt/media/image1.jpeg": jpegBytes,
    })

    const result = await extractDocumentAttachments(file)
    const text = await result?.textFile.text() ?? ""

    expect(text.includes("## Slide 1")).toBe(true)
    expect(text.includes("Slide title")).toBe(true)
    expect(text.includes("[deck-image-1.jpg]")).toBe(true)
    expect(text.includes("### Slide 1 notes\n\nSpeaker note")).toBe(true)
    expect(result?.images[0]?.name).toBe("deck-image-1.jpg")
  })

  test("extracts XLSX cell values and anchors pictures to cells", async () => {
    const file = zippedFile("budget.xlsx", {
      "xl/workbook.xml": `<workbook xmlns:r="r"><sheets><sheet name="Summary" r:id="rIdSheet"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": relationships([{ id: "rIdSheet", target: "worksheets/sheet1.xml" }]),
      "xl/sharedStrings.xml": `<sst><si><t>Revenue</t></si></sst>`,
      "xl/worksheets/sheet1.xml": `
        <worksheet xmlns:r="r"><sheetData>
          <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row>
          <row r="2"><c r="A2" t="inlineStr"><is><t>North</t></is></c><c r="B2"><v>17</v></c></row>
        </sheetData><drawing r:id="rIdDrawing"/></worksheet>`,
      "xl/worksheets/_rels/sheet1.xml.rels": relationships([{ id: "rIdDrawing", target: "../drawings/drawing1.xml" }]),
      "xl/drawings/drawing1.xml": `
        <xdr:wsDr xmlns:xdr="xdr" xmlns:a="a" xmlns:r="r"><xdr:oneCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:row>2</xdr:row></xdr:from><a:blip r:embed="rIdImage"/></xdr:oneCellAnchor></xdr:wsDr>`,
      "xl/drawings/_rels/drawing1.xml.rels": relationships([{ id: "rIdImage", target: "../media/image1.webp" }]),
      "xl/media/image1.webp": webpBytes,
    })

    const result = await extractDocumentAttachments(file)
    const text = await result?.textFile.text() ?? ""

    expect(text.includes("## Sheet: Summary")).toBe(true)
    expect(text.includes("Range: A1:B2\nRevenue\t42\nNorth\t17")).toBe(true)
    expect(text.includes("Image at B3: [budget-image-1.webp]")).toBe(true)
    expect(result?.images[0]?.name).toBe("budget-image-1.webp")
  })

  for (const [name, options] of [
    ["extracts Excel-default XLSX relative worksheet targets", {}],
    ["extracts XLSX absolute worksheet targets", { target: "/xl/worksheets/sheet1.xml" }],
    ["extracts XLSX namespace-prefixed workbook sheets", { workbookPrefix: "x" }],
    ["extracts XLSX non-r relationship ID prefixes", { relationshipPrefix: "rel" }],
    ["extracts XLSX namespace-prefixed shared strings, rows, cells, and cached values", { worksheetPrefix: "x" }],
    ["extracts XLSX namespace-prefixed package relationships", { packagePrefix: "pkg" }],
    ["extracts XLSX rich inline strings", { inline: true }],
    ["extracts XLSX prefixed inline strings with absolute targets and non-r IDs", { target: "/xl/worksheets/sheet1.xml", workbookPrefix: "x", worksheetPrefix: "x", relationshipPrefix: "rel", packagePrefix: "pkg", inline: true }],
  ] satisfies Array<[string, Parameters<typeof workbookFile>[0]]>) {
    test(name, async () => {
      const result = await extractDocumentAttachments(workbookFile(options))
      expect(await result?.textFile.text()).toBe("# Workbook\n\n## Sheet: Summary\n\nRange: A1:C1\nRevenue & costs\t42\t84\n")
    })
  }

  for (const [name, entries] of [
    ["rejects XLSX with no sheet elements instead of sending a workbook stub", { "xl/workbook.xml": `<workbook xmlns="${spreadsheetNamespace}"><sheets/></workbook>` }],
    ["rejects XLSX with unresolved sheet relationships", { "xl/workbook.xml": `<workbook xmlns:r="${officeRelationshipsNamespace}"><sheets><sheet name="Summary" r:id="missing"/></sheets></workbook>` }],
    ["rejects XLSX with a missing worksheet part", { "xl/workbook.xml": `<workbook xmlns:r="${officeRelationshipsNamespace}"><sheets><sheet name="Summary" r:id="sheet"/></sheets></workbook>`, "xl/_rels/workbook.xml.rels": relationships([{ id: "sheet", target: "/xl/worksheets/missing.xml" }]) }],
    ["rejects XLSX with sheets but no readable cells", { "xl/workbook.xml": `<workbook xmlns:r="${officeRelationshipsNamespace}"><sheets><sheet name="Summary" r:id="sheet"/></sheets></workbook>`, "xl/_rels/workbook.xml.rels": relationships([{ id: "sheet", target: "worksheets/sheet1.xml" }]), "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" s="1"/><c r="B1"><f>1+1</f></c></row></sheetData></worksheet>` }],
    ["rejects XLSX with no workbook part", { "metadata.xml": "<metadata/>" }],
  ] satisfies Array<[string, Record<string, string>]>) {
    test(name, async () => {
      await expect(extractDocumentAttachments(zippedFile("empty.xlsx", entries)))
        .rejects.toThrow("Couldn't read this workbook: no sheets or cells found")
    })
  }

  test("rejects XLSX shared-string and boolean cells with no stored value", async () => {
    const file = zippedFile("no-values.xlsx", {
      "xl/workbook.xml": `<workbook xmlns:r="${officeRelationshipsNamespace}"><sheets><sheet name="Data" r:id="sheet"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": relationships([{ id: "sheet", target: "worksheets/sheet1.xml" }]),
      "xl/sharedStrings.xml": "<sst><si><t>Unused shared string</t></si></sst>",
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"></c><c r="B1" t="b"><v/></c></row></sheetData></worksheet>`,
    })
    await expect(extractDocumentAttachments(file)).rejects.toThrow("Couldn't read this workbook: no sheets or cells found")
  })

  test("extracts prefixed XLSX drawings and non-r image relationship attributes", async () => {
    const file = zippedFile("prefixed-image.xlsx", {
      "xl/workbook.xml": `<workbook xmlns:r="${officeRelationshipsNamespace}"><sheets><sheet name="Data" r:id="sheet"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": relationships([{ id: "sheet", target: "/xl/worksheets/sheet1.xml" }]),
      "xl/worksheets/sheet1.xml": `<x:worksheet xmlns:x="${spreadsheetNamespace}" xmlns:rel="${officeRelationshipsNamespace}"><x:sheetData><x:row r="1"><x:c r="A1"><x:v>42</x:v></x:c></x:row></x:sheetData><x:drawing rel:id="drawing"/></x:worksheet>`,
      "xl/worksheets/_rels/sheet1.xml.rels": relationships([{ id: "drawing", target: "/xl/drawings/drawing1.xml" }]),
      "xl/drawings/drawing1.xml": `<d:wsDr xmlns:d="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:rel="${officeRelationshipsNamespace}"><d:twoCellAnchor><d:from><d:col>1</d:col><d:row>2</d:row></d:from><d:pic><pic:blip rel:embed="image"/></d:pic></d:twoCellAnchor></d:wsDr>`,
      "xl/drawings/_rels/drawing1.xml.rels": relationships([{ id: "image", target: "/xl/media/image1.png" }]),
      "xl/media/image1.png": pngBytes(),
    })
    const result = await extractDocumentAttachments(file)
    expect(await result?.textFile.text()).toContain("Image at B3: [prefixed-image-image-1.png]")
    expect(result?.images[0]?.name).toBe("prefixed-image-image-1.png")
  })

  test("preserves readable XLSX sheets when another sheet is empty or unresolved", async () => {
    const file = zippedFile("mixed.xlsx", {
      "xl/workbook.xml": `<workbook xmlns:r="${officeRelationshipsNamespace}"><sheets><sheet name="Missing" r:id="missing"/><sheet name="Blank" r:id="blank"/><sheet name="Readable" r:id="data"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": relationships([{ id: "blank", target: "worksheets/sheet1.xml" }, { id: "data", target: "worksheets/sheet2.xml" }]),
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData/></worksheet>`,
      "xl/worksheets/sheet2.xml": `<x:worksheet xmlns:x="${spreadsheetNamespace}"><x:sheetData><x:row r="1"><x:c r="A1" s="1"/><x:c r="B1"><x:v>0</x:v></x:c><x:c r="C1" t="b"><x:v>0</x:v></x:c><x:c r="D1" t="inlineStr"><x:is><x:t>&lt;tag&gt; &amp; text</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>`,
    })
    const result = await extractDocumentAttachments(file)
    expect(await result?.textFile.text()).toBe("# Workbook\n\n## Sheet: Blank\n\n[Empty sheet]\n\n## Sheet: Readable\n\nRange: B1:D1\n0\tFALSE\t<tag> & text\n")
  })

  test("quotes TSV values and keeps sparse XLSX rows coordinate-based", async () => {
    const file = zippedFile("sparse.xlsx", {
      "xl/workbook.xml": `<workbook xmlns:r="r"><sheets><sheet name="Data" r:id="sheet"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": relationships([{ id: "sheet", target: "worksheets/sheet1.xml" }]),
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData>
        <row r="1"><c r="A1" t="inlineStr"><is><t>line 1&#10;line 2</t></is></c><c r="B1" t="inlineStr"><is><t>say &quot;hi&quot;</t></is></c></row>
        <row r="2"><c r="A2" t="inlineStr"><is><t>first</t></is></c><c r="XFD2" t="inlineStr"><is><t>last</t></is></c></row>
      </sheetData></worksheet>`,
    })

    const text = await (await extractDocumentAttachments(file))?.textFile.text() ?? ""

    expect(text.includes('Range: A1:B1\n"line 1\nline 2"\t"say ""hi"""')).toBe(true)
    expect(text.includes("Cells: A2\tfirst | XFD2\tlast")).toBe(true)
  })

  test("extracts OpenDocument text, presentations, spreadsheets, and image positions", async () => {
    const image = pngBytes()
    const odt = zippedFile("notes.odt", {
      "content.xml": `<office:document xmlns:office="office" xmlns:text="text" xmlns:draw="draw" xmlns:xlink="xlink"><text:h>Heading</text:h><text:p>Hello <text:span>world</text:span></text:p><draw:frame><draw:image xlink:href="Pictures/photo.png"/></draw:frame><text:p>After image</text:p></office:document>`,
      "Pictures/photo.png": image,
    })
    const odp = zippedFile("slides.odp", {
      "content.xml": `<office:document xmlns:office="office" xmlns:text="text" xmlns:draw="draw"><draw:page draw:name="Intro"><text:p>Welcome</text:p></draw:page></office:document>`,
    })
    const ods = zippedFile("table.ods", {
      "content.xml": `<office:document xmlns:office="office" xmlns:text="text" xmlns:table="table" xmlns:draw="draw" xmlns:xlink="xlink"><table:table table:name="Data"><table:shapes><draw:frame><draw:image xlink:href="Pictures/chart.png"/></draw:frame></table:shapes><table:table-row><table:table-cell><text:p>Name</text:p></table:table-cell><table:table-cell><text:p>Value</text:p></table:table-cell></table:table-row></table:table></office:document>`,
      "Pictures/chart.png": image,
    })

    const odtResult = await extractDocumentAttachments(odt)
    const odpResult = await extractDocumentAttachments(odp)
    const odsResult = await extractDocumentAttachments(ods)

    expect((await odtResult?.textFile.text())?.includes("Heading\n\nHello world\n\n[notes-image-1.png]\n\nAfter image")).toBe(true)
    expect(odtResult?.images).toHaveLength(1)
    expect((await odpResult?.textFile.text())?.includes("## Slide: Intro\n\nWelcome")).toBe(true)
    expect((await odsResult?.textFile.text())?.includes("## Sheet: Data\n\n[table-image-1.png]\n\nName | Value")).toBe(true)
    expect(odsResult?.images).toHaveLength(1)
  })

  test("rejects unsafe archive paths", async () => {
    const file = zippedFile("unsafe.docx", {
      "../word/document.xml": `<w:document xmlns:w="w"><w:p><w:t>Unsafe</w:t></w:p></w:document>`,
    })
    await expect(extractDocumentAttachments(file)).rejects.toThrow("unsafe file path")
  })

  test("rejects archives over the entry-count limit", async () => {
    const entries = Object.fromEntries(Array.from({ length: 5_001 }, (_, index) => [
      `metadata/entry-${index}.xml`,
      "<metadata/>",
    ]))

    await expect(extractDocumentAttachments(zippedFile("too-many.docx", entries))).rejects.toThrow("too many files")
  })

  test("bounds embedded image count and marks omitted images in document text", async () => {
    const imageTags = Array.from({ length: 51 }, (_, index) => `<w:p><a:blip r:embed="rId${index}"/></w:p>`).join("")
    const relationshipItems = Array.from({ length: 51 }, (_, index) => ({
      id: `rId${index}`,
      target: `media/image${index}.png`,
    }))
    const entries: Record<string, string | Uint8Array> = {
      "word/document.xml": `<w:document xmlns:w="w" xmlns:a="a" xmlns:r="r"><w:body>${imageTags}</w:body></w:document>`,
      "word/_rels/document.xml.rels": relationships(relationshipItems),
    }
    for (let index = 0; index < 51; index += 1) entries[`word/media/image${index}.png`] = pngBytes(index)

    const result = await extractDocumentAttachments(zippedFile("gallery.docx", entries))
    const text = await result?.textFile.text() ?? ""

    expect(result?.images).toHaveLength(50)
    expect(text.includes("[Embedded image omitted by attachment limits: image50.png]")).toBe(true)
  })

  test("omits unsupported and spoofed embedded image content", async () => {
    const file = zippedFile("unsafe-images.docx", {
      "word/document.xml": `
        <w:document xmlns:w="w" xmlns:a="a" xmlns:r="r"><w:body>
          <w:p><a:blip r:embed="svg"/></w:p>
          <w:p><a:blip r:embed="fakePng"/></w:p>
        </w:body></w:document>`,
      "word/_rels/document.xml.rels": relationships([
        { id: "svg", target: "media/image.svg" },
        { id: "fakePng", target: "media/fake.png" },
      ]),
      "word/media/image.svg": `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`,
      "word/media/fake.png": new Uint8Array([1, 2, 3]),
    })

    const result = await extractDocumentAttachments(file)
    const text = await result?.textFile.text() ?? ""

    expect(result?.images).toEqual([])
    expect(text.includes("[Unsupported embedded image omitted: image.svg]")).toBe(true)
    expect(text.includes("[Invalid embedded image omitted: fake.png]")).toBe(true)
  })

  test("bounds expanded ODF spaces", async () => {
    const file = zippedFile("spaces.odt", {
      "content.xml": `<office:document xmlns:office="office" xmlns:text="text"><text:p>Before<text:s text:c="999999999999999999999"/>After</text:p></office:document>`,
    })

    const result = await extractDocumentAttachments(file)
    const text = await result?.textFile.text() ?? ""

    expect(text.includes("[Additional spaces omitted]After")).toBe(true)
    expect(text.length).toBeLessThan(1_000)
  })

  test("does not retain images whose citations fall beyond the text limit", async () => {
    const file = zippedFile("long.docx", {
      "word/document.xml": `<w:document xmlns:w="w" xmlns:a="a" xmlns:r="r"><w:body><w:p><w:t>${"x".repeat(500_100)}</w:t></w:p><w:p><a:blip r:embed="image"/></w:p></w:body></w:document>`,
      "word/_rels/document.xml.rels": relationships([{ id: "image", target: "media/image.png" }]),
      "word/media/image.png": pngBytes(),
    })

    const result = await extractDocumentAttachments(file)
    const text = await result?.textFile.text() ?? ""

    expect(text.length <= 500_000).toBe(true)
    expect(text.endsWith(`[Document text truncated by ${PRODUCT_NAME}]\n`)).toBe(true)
    expect(text.includes("[long-image-1.png]")).toBe(false)
    expect(result?.images).toEqual([])
  })
})
