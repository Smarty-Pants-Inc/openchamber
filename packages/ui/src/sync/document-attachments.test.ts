import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
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

// SEC551: hostile workbooks must finish within a fixed bound. Extraction runs in a child
// process so a non-terminating loop or super-linear regex fails the test instead of hanging it.
const EXTRACTION_DEADLINE_MS = 5_000
const SLOW_TEST_TIMEOUT_MS = 30_000
const MAX_INTERMEDIATE_TEXT_CHARS = 1_000_000

type BoundedExtraction = {
  error?: string
  head?: string
  length?: number
  truncated?: boolean
  longestJoin: number
}

const extractionScript = (modulePath: string, name: string) => `
const { extractDocumentAttachments } = await import(${JSON.stringify(modulePath)})
let longestJoin = 0
const join = Array.prototype.join
Array.prototype.join = function (...args) {
  const output = join.apply(this, args)
  if (output.length > longestJoin) longestJoin = output.length
  return output
}
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
try {
  const result = await extractDocumentAttachments(new File([Buffer.concat(chunks)], ${JSON.stringify(name)}))
  const text = result ? await result.textFile.text() : ""
  console.log(JSON.stringify({ head: text.slice(0, 4000), length: text.length, truncated: text.includes("[Document text truncated by"), longestJoin }))
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error), longestJoin }))
}
`

const boundedExtraction = async (file: File): Promise<BoundedExtraction> => {
  const modulePath = fileURLToPath(new URL("./document-attachments.ts", import.meta.url))
  const child = spawn(process.execPath, ["-e", extractionScript(modulePath, file.name)], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    stdio: ["pipe", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk })
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk })
  const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)))
  let timedOut = false
  const deadline = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, EXTRACTION_DEADLINE_MS)
  child.stdin.end(new Uint8Array(await file.arrayBuffer()))
  const code = await exited
  clearTimeout(deadline)
  if (timedOut) throw new Error(`extraction exceeded the ${EXTRACTION_DEADLINE_MS} ms completion bound`)
  if (code !== 0) throw new Error(`extraction process failed (${code}): ${stderr.slice(0, 2000)}`)
  const result: BoundedExtraction = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}")
  return result
}

const readableWorksheet = `<worksheet xmlns:r="${officeRelationshipsNamespace}"><sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData><drawing r:id="drawing"/></worksheet>`

const hostileWorkbook = (
  worksheet: string,
  extra: Record<string, string> = {},
  sheets = '<sheet name="Data" r:id="sheet"/>',
) => zippedFile("hostile.xlsx", {
  "xl/workbook.xml": `<workbook xmlns:r="${officeRelationshipsNamespace}"><sheets>${sheets}</sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": relationships([{ id: "sheet", target: "worksheets/sheet1.xml" }]),
  "xl/worksheets/sheet1.xml": worksheet,
  ...extra,
})

describe("SEC551 bounded extraction", () => {
  for (const [column, row] of [["9".repeat(400), "0"], ["16384", "0"], ["0", "1048576"], ["-1", "0"]]) {
    test(`SEC551 P2.1 rejects drawing coordinate ${column.slice(0, 12)} / ${row} within deadline`, async () => {
      const result = await boundedExtraction(hostileWorkbook(readableWorksheet, {
        "xl/worksheets/_rels/sheet1.xml.rels": relationships([{ id: "drawing", target: "../drawings/drawing1.xml" }]),
        "xl/drawings/drawing1.xml": `<d:wsDr><d:oneCellAnchor><d:from><d:col>${column}</d:col><d:row>${row}</d:row></d:from></d:oneCellAnchor></d:wsDr>`,
      }))
      expect(result.error).toContain("coordinate")
    }, SLOW_TEST_TIMEOUT_MS)
  }

  for (const reference of ["XFE1", "A1048577", `${"Z".repeat(400)}1`, `A${"9".repeat(400)}`, "A0"]) {
    test(`SEC551 P2.1 rejects cell coordinate ${reference.slice(0, 12)} within deadline`, async () => {
      const result = await boundedExtraction(hostileWorkbook(`<worksheet><sheetData><row><c r="${reference}"><v>1</v></c></row></sheetData></worksheet>`))
      expect(result.error).toContain("coordinate")
    }, SLOW_TEST_TIMEOUT_MS)
  }

  test("SEC551 P2.1 keeps the last valid XLSX cell and drawing coordinates", async () => {
    const result = await boundedExtraction(hostileWorkbook(
      `<worksheet xmlns:r="${officeRelationshipsNamespace}"><sheetData><row><c r="XFD1048576"><v>7</v></c></row></sheetData><drawing r:id="drawing"/></worksheet>`,
      {
        "xl/worksheets/_rels/sheet1.xml.rels": relationships([{ id: "drawing", target: "../drawings/drawing1.xml" }]),
        "xl/drawings/drawing1.xml": "<d:wsDr><d:oneCellAnchor><d:from><d:col>16383</d:col><d:row>1048575</d:row></d:from></d:oneCellAnchor></d:wsDr>",
      },
    ))
    expect(result.error).toBeUndefined()
    expect(result.head).toContain("Range: XFD1048576:XFD1048576\n7")
    expect(result.head).toContain("Image at XFD1048576: [Embedded image reference could not be resolved]")
  }, SLOW_TEST_TIMEOUT_MS)

  const whitespace = " ".repeat(1_000_000)
  for (const [name, file] of [
    ["missing row closers", hostileWorkbook(`<worksheet><sheetData><row r="1"><c r="A1"><v>42</v></c></row>${"<row><c>".repeat(200_000)}</sheetData></worksheet>`)],
    ["incomplete relationship whitespace", hostileWorkbook(readableWorksheet, {
      "xl/_rels/workbook.xml.rels": `${relationships([{ id: "sheet", target: "worksheets/sheet1.xml" }])}<Relationship${whitespace}`,
    })],
    ["incomplete sheet whitespace", hostileWorkbook(readableWorksheet, {
      "xl/workbook.xml": `<workbook xmlns:r="${officeRelationshipsNamespace}"><sheets><sheet name="Data" r:id="sheet"/></sheets></workbook><sheet${whitespace}`,
    })],
    ["incomplete drawing whitespace", hostileWorkbook(`${readableWorksheet}<drawing${whitespace}`)],
  ] satisfies Array<[string, File]>) {
    test(`SEC551 P2.2 completes XLSX with ${name} within deadline`, async () => {
      const result = await boundedExtraction(file)
      expect(result.error).toBeUndefined()
      expect(result.head).toContain("Range: A1:A1\n42")
    }, SLOW_TEST_TIMEOUT_MS)
  }

  for (const [name, file, expected] of [
    ["DOCX missing text closers", zippedFile("open.docx", {
      "word/document.xml": `<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>ok</w:t>${"<w:t>".repeat(200_000)}</w:r></w:p></w:body></w:document>`,
    }), "ok"],
    ["DOCX escaped angle brackets without closers", zippedFile("angles.docx", {
      "word/document.xml": `<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>ok${"&lt;".repeat(300_000)}</w:t></w:r></w:p></w:body></w:document>`,
    }), "ok<<<"],
    ["ODT missing paragraph closers", zippedFile("open.odt", {
      "content.xml": `<office:document xmlns:office="office" xmlns:text="text"><text:p>ok</text:p>${"<text:p>".repeat(200_000)}</office:document>`,
    }), "ok"],
  ] satisfies Array<[string, File, string]>) {
    test(`SEC551 P2.2 completes ${name} within deadline`, async () => {
      const result = await boundedExtraction(file)
      expect(result.error).toBeUndefined()
      expect(result.head).toContain(expected)
    }, SLOW_TEST_TIMEOUT_MS)
  }

  test("SEC551 P2.3 bounds intermediate output for shared-string reuse", async () => {
    const rows = Array.from({ length: 4_000 }, (_, index) => `<row r="${index + 1}"><c r="A${index + 1}" t="s"><v>0</v></c></row>`).join("")
    const result = await boundedExtraction(hostileWorkbook(`<worksheet><sheetData>${rows}</sheetData></worksheet>`, {
      "xl/sharedStrings.xml": `<sst><si><t>${"&quot;".repeat(8_192)}</t></si></sst>`,
    }))
    expect(result.error).toBeUndefined()
    expect(result.truncated).toBe(true)
    expect(result.length).toBeLessThanOrEqual(500_000)
    expect(result.longestJoin).toBeLessThanOrEqual(MAX_INTERMEDIATE_TEXT_CHARS)
  }, SLOW_TEST_TIMEOUT_MS)

  test("SEC551 P2.3 parses a worksheet repeated by many sheet entries once", async () => {
    const emptyRows = Array.from({ length: 50_000 }, (_, index) => `<row r="${index + 2}"><c r="A${index + 2}"/></row>`).join("")
    const result = await boundedExtraction(hostileWorkbook(
      `<worksheet><sheetData><row r="1"><c r="A1"><v>42</v></c></row>${emptyRows}</sheetData></worksheet>`,
      {},
      '<sheet name="Data" r:id="sheet"/>'.repeat(5_000),
    ))
    expect(result.error).toBeUndefined()
    expect(result.head?.split("## Sheet: Data").length).toBe(2)
    expect(result.longestJoin).toBeLessThanOrEqual(MAX_INTERMEDIATE_TEXT_CHARS)
  }, SLOW_TEST_TIMEOUT_MS)

  const oversizedXml = (body: string) => `${" ".repeat(9 * 1024 * 1024)}${body}`
  for (const [name, file] of [
    ["worksheet", hostileWorkbook(readableWorksheet, {
      "xl/_rels/workbook.xml.rels": relationships([{ id: "sheet", target: "worksheets/sheet1.png" }]),
      "xl/worksheets/sheet1.png": oversizedXml(readableWorksheet),
    })],
    ["drawing", hostileWorkbook(readableWorksheet, {
      "xl/worksheets/_rels/sheet1.xml.rels": relationships([{ id: "drawing", target: "../drawings/drawing1.png" }]),
      "xl/drawings/drawing1.png": oversizedXml("<d:wsDr/>"),
    })],
  ] satisfies Array<[string, File]>) {
    test(`SEC551 P2.4 guards ${name} XML with an image suffix`, async () => {
      const result = await boundedExtraction(file)
      expect(result.error).toContain("XML that is too large")
    }, SLOW_TEST_TIMEOUT_MS)
  }
})
