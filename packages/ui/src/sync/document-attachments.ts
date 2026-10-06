import { unzip, unzipSync, type UnzipFileInfo, type Unzipped } from "fflate"
import { PRODUCT_NAME } from "@/lib/brand.generated"

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
const MAX_ENTRY_BYTES = 25 * 1024 * 1024
const MAX_XML_ENTRY_BYTES = 8 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 5_000
const MAX_EMBEDDED_IMAGES = 50
const MAX_EMBEDDED_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_EMBEDDED_IMAGES_BYTES = 40 * 1024 * 1024
const MAX_EXTRACTED_TEXT_CHARS = 500_000
const MAX_ODF_SPACES_PER_ELEMENT = 100
const MAX_SPREADSHEET_COLUMNS = 16_384
const MAX_SPREADSHEET_ROWS = 1_048_576
const TEXT_TRUNCATION_NOTICE = `\n\n[Document text truncated by ${PRODUCT_NAME}]\n`

const OFFICE_EXTENSIONS = new Set(["docx", "pptx", "xlsx", "odt", "odp", "ods"])
const IMAGE_MIMES = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
])

type Relationship = { target: string; type: string }
type Relationships = Map<string, Relationship>

type ExtractedDocumentAttachments = {
  textFile: File
  images: File[]
}

const extensionOf = (name: string): string => {
  const index = name.lastIndexOf(".")
  return index === -1 ? "" : name.slice(index + 1).toLowerCase()
}

const basenameWithoutExtension = (name: string): string => {
  const basename = name.replace(/\\/g, "/").split("/").pop() || "document"
  const index = basename.lastIndexOf(".")
  return (index > 0 ? basename.slice(0, index) : basename).replace(/[^a-zA-Z0-9._-]+/g, "-") || "document"
}

const normalizeArchivePath = (path: string): string | undefined => {
  const segments: string[] = []
  for (const segment of path.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue
    if (segment === "..") {
      if (segments.length === 0) return
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.join("/")
}

const resolveArchivePath = (sourcePath: string, target: string): string | undefined => {
  if (target.startsWith("/")) return normalizeArchivePath(target.slice(1))
  const sourceDirectory = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/") + 1) : ""
  return normalizeArchivePath(`${sourceDirectory}${target}`)
}

const relationshipsPath = (sourcePath: string): string => {
  const index = sourcePath.lastIndexOf("/")
  const directory = index === -1 ? "" : sourcePath.slice(0, index + 1)
  const filename = sourcePath.slice(index + 1)
  return `${directory}_rels/${filename}.rels`
}

const decodeXmlCodePoint = (code: string, radix: number): string => {
  const value = Number.parseInt(code, radix)
  if (value < 0 || value > 0x10FFFF || (value >= 0xD800 && value <= 0xDFFF)) return "�"
  return String.fromCodePoint(value)
}

const decodeXml = (value: string): string => value
  .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => decodeXmlCodePoint(code, 16))
  .replace(/&#([0-9]+);/g, (_, code: string) => decodeXmlCodePoint(code, 10))
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&amp;/g, "&")

const attribute = (tag: string, name: string): string | undefined => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = tag.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"))
  return decodeXml(match?.[1] ?? match?.[2] ?? "") || undefined
}

const attributeByLocalName = (tag: string, name: string): string | undefined => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = tag.match(new RegExp(`(?:^|\\s)(?:[A-Za-z_][\\w.-]*:)?${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"))
  return decodeXml(match?.[1] ?? match?.[2] ?? "") || undefined
}

type XmlTag = {
  /** Lowercase qualified name, such as `w:t` or `row`. */
  name: string
  start: number
  end: number
  closing: boolean
  selfClosing: boolean
  source: string
}

const isTagNameEnd = (code: number): boolean => code === 32 || code === 9 || code === 10 || code === 13 || code === 47 || code === 62

// Linear tag scan for hostile XML (SEC551). Each character is visited a bounded number of
// times; an unterminated tag ends the scan instead of causing a rescan from every later "<".
function* xmlTags(source: string): Generator<XmlTag> {
  let index = 0
  while (index < source.length) {
    const first = source.indexOf("<", index)
    if (first === -1) return
    const close = source.indexOf(">", first + 1)
    if (close === -1) return
    index = close + 1
    const start = source.lastIndexOf("<", close)
    const closing = source.charCodeAt(start + 1) === 47
    const nameStart = closing ? start + 2 : start + 1
    let nameEnd = nameStart
    while (nameEnd < close && !isTagNameEnd(source.charCodeAt(nameEnd))) nameEnd += 1
    yield {
      name: source.slice(nameStart, nameEnd).toLowerCase(),
      start,
      end: close + 1,
      closing,
      selfClosing: !closing && source.charCodeAt(close - 1) === 47,
      source: source.slice(start, close + 1),
    }
  }
}

/** A qualified wanted name must match exactly; an unqualified one matches any namespace prefix. */
const matchesTagName = (name: string, wanted: string): boolean => wanted.includes(":")
  ? name === wanted
  : name.slice(name.lastIndexOf(":") + 1) === wanted

const openTags = (source: string, wanted: string): XmlTag[] => {
  const tags: XmlTag[] = []
  for (const tag of xmlTags(source)) {
    if (!tag.closing && matchesTagName(tag.name, wanted)) tags.push(tag)
  }
  return tags
}

/** Non-self-closing elements, each ending at the first closer with the opener's name. */
const tagBlocks = (source: string, ...tags: string[]): string[] => {
  const wanted = tags.map((tag) => tag.toLowerCase())
  const blocks: string[] = []
  let open: { start: number; tag: string } | undefined
  for (const tag of xmlTags(source)) {
    if (open) {
      if (tag.closing && matchesTagName(tag.name, open.tag)) {
        blocks.push(source.slice(open.start, tag.end))
        open = undefined
      }
      continue
    }
    if (tag.closing || tag.selfClosing) continue
    const match = wanted.find((name) => matchesTagName(tag.name, name))
    if (match) open = { start: tag.start, tag: match }
  }
  return blocks
}

const innerXml = (block: string): string => block.slice(block.indexOf(">") + 1, block.lastIndexOf("<"))

const stripTags = (value: string): string => {
  let output = ""
  let index = 0
  for (const tag of xmlTags(value)) {
    output += value.slice(index, tag.start)
    if (tag.end === tag.start + 2) output += "<>"
    index = tag.end
  }
  return output + value.slice(index)
}

const trimLineEnds = (value: string): string => value.split("\n").map((line) => {
  let end = line.length
  while (end > 0 && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end -= 1
  return line.slice(0, end)
}).join("\n")

const textDecoder = new TextDecoder()
const xml = (archive: Unzipped, path: string): string => {
  const bytes = archive[path]
  if (!bytes) return ""
  // Relationship targets choose which entry is parsed, so the XML limit follows use, not filename.
  if (bytes.byteLength > MAX_XML_ENTRY_BYTES) throw new Error("Document contains XML that is too large to process safely")
  return textDecoder.decode(bytes)
}

const parseRelationships = (archive: Unzipped, sourcePath: string): Relationships => {
  const result: Relationships = new Map()
  const source = xml(archive, relationshipsPath(sourcePath))
  for (const tag of openTags(source, "relationship")) {
    const id = attribute(tag.source, "Id")
    const target = attribute(tag.source, "Target")
    if (!id || !target) continue
    result.set(id, { target, type: attribute(tag.source, "Type") ?? "" })
  }
  return result
}

const isControlCharacter = (character: string): boolean => {
  const code = character.charCodeAt(0)
  return code <= 0x1F || code === 0x7F
}

const hasControlCharacters = (value: string): boolean => Array.from(value).some(isControlCharacter)

const embeddedImageLabel = (path: string): string => {
  const basename = path.replace(/\\/g, "/").split("/").pop() || "embedded image"
  return Array.from(basename.slice(0, 200), (character) => {
    if (character === "[" || character === "]") return "_"
    return isControlCharacter(character) ? "_" : character
  }).join("")
}

const hasBytes = (bytes: Uint8Array, expected: number[]): boolean => expected.every((value, index) => bytes[index] === value)

const hasAscii = (bytes: Uint8Array, offset: number, expected: string): boolean => {
  if (bytes.byteLength < offset + expected.length) return false
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected.charCodeAt(index)) return false
  }
  return true
}

const hasValidImageSignature = (bytes: Uint8Array, extension: string): boolean => {
  switch (extension) {
    case "png":
      return hasBytes(bytes, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    case "jpg":
    case "jpeg":
      return hasBytes(bytes, [0xFF, 0xD8, 0xFF])
    case "gif":
      return hasAscii(bytes, 0, "GIF87a") || hasAscii(bytes, 0, "GIF89a")
    case "webp":
      return hasAscii(bytes, 0, "RIFF") && hasAscii(bytes, 8, "WEBP")
    default:
      return false
  }
}

class EmbeddedImages {
  private readonly files: File[] = []
  private readonly filenames = new Map<string, string>()
  private count = 0
  private imageBytes = 0
  private readonly reservedFilenames: Set<string>

  constructor(
    private readonly archive: Unzipped,
    private readonly documentName: string,
    reservedFilenames: Iterable<string>,
  ) {
    this.reservedFilenames = new Set(Array.from(reservedFilenames, (filename) => filename.toLowerCase()))
  }

  citation(path: string | undefined): string {
    if (!path) return "[Embedded image reference could not be resolved]"
    const normalized = normalizeArchivePath(path)
    if (!normalized) return "[Unsafe embedded image path omitted]"
    const existing = this.filenames.get(normalized)
    if (existing) return `[${existing}]`

    const bytes = this.archive[normalized]
    const extension = extensionOf(normalized)
    const mime = IMAGE_MIMES.get(extension)
    const label = embeddedImageLabel(normalized)
    if (!bytes || !mime) return `[Unsupported embedded image omitted: ${label}]`
    if (!hasValidImageSignature(bytes, extension)) return `[Invalid embedded image omitted: ${label}]`
    if (
      this.files.length >= MAX_EMBEDDED_IMAGES
      || bytes.byteLength > MAX_EMBEDDED_IMAGE_BYTES
      || this.imageBytes + bytes.byteLength > MAX_EMBEDDED_IMAGES_BYTES
    ) {
      return `[Embedded image omitted by attachment limits: ${label}]`
    }

    const outputExtension = extension === "jpeg" ? "jpg" : extension
    let filename: string
    do {
      this.count += 1
      filename = `${basenameWithoutExtension(this.documentName)}-image-${this.count}.${outputExtension}`
    } while (this.reservedFilenames.has(filename.toLowerCase()))
    this.reservedFilenames.add(filename.toLowerCase())
    this.filenames.set(normalized, filename)
    this.files.push(new File([bytes], filename, { type: mime }))
    this.imageBytes += bytes.byteLength
    return `[${filename}]`
  }

  all(): File[] {
    return this.files
  }
}

const relationshipTarget = (sourcePath: string, relationships: Relationships, id: string | undefined): string | undefined => {
  if (!id) return
  const relationship = relationships.get(id)
  return relationship ? resolveArchivePath(sourcePath, relationship.target) : undefined
}

const INLINE_TEXT_TAGS = new Set(["w:t", "a:t", "text:span"])
const INLINE_TAB_TAGS = new Set(["w:tab", "text:tab"])
const INLINE_BREAK_TAGS = new Set(["w:br", "a:br", "text:line-break"])
const INLINE_IMAGE_TAGS = new Set(["a:blip", "v:imagedata", "draw:image"])

const inlineText = (
  block: string,
  sourcePath: string,
  relationships: Relationships,
  images: EmbeddedImages,
): string => {
  const pieces: string[] = []
  let textStart: number | undefined
  for (const tag of xmlTags(block)) {
    if (textStart !== undefined) {
      if (tag.closing && INLINE_TEXT_TAGS.has(tag.name)) {
        pieces.push(stripTags(decodeXml(block.slice(textStart, tag.start))))
        textStart = undefined
      }
      continue
    }
    if (tag.closing) continue
    if (INLINE_TEXT_TAGS.has(tag.name)) {
      if (!tag.selfClosing) textStart = tag.end
      continue
    }
    if (INLINE_TAB_TAGS.has(tag.name)) {
      pieces.push("\t")
      continue
    }
    if (INLINE_BREAK_TAGS.has(tag.name)) {
      pieces.push("\n")
      continue
    }
    if (!INLINE_IMAGE_TAGS.has(tag.name)) continue
    const relationshipId = attribute(tag.source, "r:embed") ?? attribute(tag.source, "r:id")
    const directPath = attribute(tag.source, "xlink:href")
    const target = directPath
      ? resolveArchivePath(sourcePath, directPath)
      : relationshipTarget(sourcePath, relationships, relationshipId)
    pieces.push(`\n${images.citation(target)}\n`)
  }
  return trimLineEnds(pieces.join("")).trim()
}

const paragraphs = (
  source: string,
  paragraphTag: string,
  sourcePath: string,
  relationships: Relationships,
  images: EmbeddedImages,
): string[] => tagBlocks(source, paragraphTag)
  .map((block) => inlineText(block, sourcePath, relationships, images))
  .filter(Boolean)

const extractDocx = (archive: Unzipped, images: EmbeddedImages): string | undefined => {
  const documentPath = "word/document.xml"
  const documentXml = xml(archive, documentPath)
  if (!documentXml) return
  const sections = ["# Document", ...paragraphs(documentXml, "w:p", documentPath, parseRelationships(archive, documentPath), images)]

  const extras = Object.keys(archive)
    .filter((path) => /^word\/(?:header|footer)\d+\.xml$/i.test(path))
    .sort()
  for (const path of extras) {
    const content = paragraphs(xml(archive, path), "w:p", path, parseRelationships(archive, path), images)
    if (content.length > 0) sections.push(`## ${path.includes("header") ? "Header" : "Footer"}`, ...content)
  }
  return `${sections.join("\n\n")}\n`
}

const numberedPaths = (archive: Unzipped, pattern: RegExp): string[] => Object.keys(archive)
  .filter((path) => pattern.test(path))
  .sort((left, right) => {
    const leftNumber = Number(left.match(/(\d+)(?=\.xml$)/)?.[1] ?? 0)
    const rightNumber = Number(right.match(/(\d+)(?=\.xml$)/)?.[1] ?? 0)
    return leftNumber - rightNumber
  })

const extractPptx = (archive: Unzipped, images: EmbeddedImages): string | undefined => {
  const slidePaths = numberedPaths(archive, /^ppt\/slides\/slide\d+\.xml$/i)
  if (slidePaths.length === 0) return
  const sections: string[] = ["# Presentation"]

  slidePaths.forEach((slidePath, index) => {
    const relationships = parseRelationships(archive, slidePath)
    const content = tagBlocks(xml(archive, slidePath), "a:p", "p:pic")
      .map((block) => inlineText(block, slidePath, relationships, images))
      .filter(Boolean)
    sections.push(`## Slide ${index + 1}`, ...(content.length > 0 ? content : ["[Empty slide]"]))

    const notesRelationship = Array.from(relationships.values()).find((relationship) => relationship.type.endsWith("/notesSlide"))
    const notesPath = notesRelationship ? resolveArchivePath(slidePath, notesRelationship.target) : undefined
    if (!notesPath) return
    const notes = paragraphs(xml(archive, notesPath), "a:p", notesPath, parseRelationships(archive, notesPath), images)
    if (notes.length > 0) sections.push(`### Slide ${index + 1} notes`, ...notes)
  })
  return `${sections.join("\n\n")}\n`
}

const invalidCoordinateError = (): Error => {
  const error = new Error("Couldn't read this workbook: invalid cell coordinate")
  error.name = "WorkbookReadError"
  return error
}

const columnName = (index: number): string => {
  if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_SPREADSHEET_COLUMNS) throw invalidCoordinateError()
  let value = index + 1
  let result = ""
  while (value > 0) {
    value -= 1
    result = String.fromCharCode(65 + (value % 26)) + result
    value = Math.floor(value / 26)
  }
  return result
}

const columnIndex = (name: string): number => {
  let result = 0
  for (const character of name.toUpperCase()) result = result * 26 + character.charCodeAt(0) - 64
  return result - 1
}

const tsvValue = (value: string): string => {
  if (!/[\t\r\n"]/.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}

const cellCoordinates = (reference: string) => {
  const coordinates = /^([a-z]{1,3})([1-9]\d{0,6})$/i.exec(reference)
  const column = coordinates ? columnIndex(coordinates[1]) : -1
  const row = coordinates ? Number(coordinates[2]) : 0
  if (column < 0 || column >= MAX_SPREADSHEET_COLUMNS || row > MAX_SPREADSHEET_ROWS) throw invalidCoordinateError()
  return { column, row }
}

const spreadsheetText = (source: string): string => tagBlocks(source, "t")
  .map((text) => decodeXml(stripTags(text)))
  .join("")

const cellValue = (cell: string, sharedStrings: string[]): string => {
  const type = attribute(cell.match(/^<(?:[A-Za-z_][\w.-]*:)?c\b[^>]*>/i)?.[0] ?? "", "t")
  if (type === "inlineStr") return spreadsheetText(cell)
  const valueBlock = tagBlocks(cell, "v")[0]
  const value = valueBlock === undefined ? "" : innerXml(valueBlock)
  if (!value) return ""
  if (type === "s") return sharedStrings[Number(value)] ?? ""
  if (type === "b") return value === "1" ? "TRUE" : "FALSE"
  return decodeXml(value)
}

type SpreadsheetCell = {
  reference: string
  column: number
  row: number
  /** TSV-quoted value. */
  text: string
}

/** Charges spreadsheet output as it is built, so oversized results stop before they are joined. */
class TextBudget {
  private used = 0

  charge(characters: number): void {
    this.used += characters
  }

  get exhausted(): boolean {
    return this.used > MAX_EXTRACTED_TEXT_CHARS
  }
}

type SpreadsheetRow = {
  cells: SpreadsheetCell[]
  firstColumn: number
  lastColumn: number
  row: number
}

const isDenseSpreadsheetRow = (row: SpreadsheetRow): boolean => {
  const width = row.lastColumn - row.firstColumn + 1
  return width <= Math.max(32, row.cells.length * 4)
}

const serializeDenseSpreadsheetRow = (row: SpreadsheetRow): string => {
  const valuesByColumn = new Map(row.cells.map((cell) => [cell.column, cell.text]))
  return Array.from(
    { length: row.lastColumn - row.firstColumn + 1 },
    (_, offset) => valuesByColumn.get(row.firstColumn + offset) ?? "",
  ).join("\t")
}

const spreadsheetRows = (worksheet: string, sharedStrings: string[], budget: TextBudget): SpreadsheetRow[] => {
  const rows: SpreadsheetRow[] = []
  for (const rowXml of tagBlocks(worksheet, "row")) {
    if (budget.exhausted) break
    const cells: SpreadsheetCell[] = []
    for (const cell of tagBlocks(rowXml, "c")) {
      if (budget.exhausted) break
      const tag = cell.match(/^<(?:[A-Za-z_][\w.-]*:)?c\b[^>]*>/i)?.[0] ?? ""
      const reference = attribute(tag, "r")
      if (!reference) continue
      const { column, row } = cellCoordinates(reference)
      const value = cellValue(cell, sharedStrings)
      if (!value) continue
      const text = tsvValue(value)
      cells.push({ reference, column, row, text })
      budget.charge(reference.length + text.length + 4)
    }
    cells.sort((left, right) => left.column - right.column)
    const first = cells[0]
    const last = cells.at(-1)
    if (!first || !last) continue
    rows.push({ cells, firstColumn: first.column, lastColumn: last.column, row: first.row })
  }
  return rows
}

const serializeSpreadsheetRows = (rows: SpreadsheetRow[]): string[] => {
  const sections: string[] = []
  let denseBlock: SpreadsheetRow[] = []

  const flushDenseBlock = () => {
    const first = denseBlock[0]
    const last = denseBlock.at(-1)
    if (!first || !last) return
    sections.push([
      `Range: ${columnName(first.firstColumn)}${first.row}:${columnName(first.lastColumn)}${last.row}`,
      ...denseBlock.map(serializeDenseSpreadsheetRow),
    ].join("\n"))
    denseBlock = []
  }

  for (const row of rows) {
    const previous = denseBlock.at(-1)
    if (!isDenseSpreadsheetRow(row)) {
      flushDenseBlock()
      sections.push(`Cells: ${row.cells.map((cell) => `${cell.reference}\t${cell.text}`).join(" | ")}`)
      continue
    }
    if (
      previous
      && (row.row !== previous.row + 1
        || row.firstColumn !== previous.firstColumn
        || row.lastColumn !== previous.lastColumn)
    ) {
      flushDenseBlock()
    }
    denseBlock.push(row)
  }
  flushDenseBlock()
  return sections
}

/** Zero-based drawing anchor coordinate; a missing element keeps the historical default of 0. */
const drawingCoordinate = (anchor: string, tag: string, limit: number): number => {
  const block = tagBlocks(anchor, tag)[0]
  if (block === undefined) return 0
  const text = innerXml(block).trim()
  const value = /^\d{1,7}$/.test(text) ? Number(text) : -1
  if (value < 0 || value >= limit) throw invalidCoordinateError()
  return value
}

const drawingCitations = (
  archive: Unzipped,
  worksheetPath: string,
  images: EmbeddedImages,
  budget: TextBudget,
  seenDrawings: Set<string>,
): string[] => {
  const worksheetXml = xml(archive, worksheetPath)
  const worksheetRelationships = parseRelationships(archive, worksheetPath)
  const output: string[] = []
  for (const drawing of openTags(worksheetXml, "drawing")) {
    const drawingId = attributeByLocalName(drawing.source, "id")
    const drawingPath = relationshipTarget(worksheetPath, worksheetRelationships, drawingId)
    // Each drawing part is read once, however many worksheet references repeat it.
    if (!drawingPath || seenDrawings.has(drawingPath)) continue
    seenDrawings.add(drawingPath)
    const drawingXml = xml(archive, drawingPath)
    const drawingRelationships = parseRelationships(archive, drawingPath)
    for (const anchor of tagBlocks(drawingXml, "oneCellAnchor", "twoCellAnchor")) {
      if (budget.exhausted) return output
      const column = drawingCoordinate(anchor, "col", MAX_SPREADSHEET_COLUMNS)
      const row = drawingCoordinate(anchor, "row", MAX_SPREADSHEET_ROWS)
      const imageTag = openTags(anchor, "blip")[0]
      const imageId = imageTag ? attributeByLocalName(imageTag.source, "embed") : undefined
      const target = relationshipTarget(drawingPath, drawingRelationships, imageId)
      const line = `Image at ${columnName(column)}${row + 1}: ${images.citation(target)}`
      output.push(line)
      budget.charge(line.length + 2)
    }
  }
  return output
}

const extractXlsx = (archive: Unzipped, images: EmbeddedImages, budget: TextBudget): string | undefined => {
  const workbookPath = "xl/workbook.xml"
  const workbookXml = xml(archive, workbookPath)
  const workbookRelationships = parseRelationships(archive, workbookPath)
  const sharedStrings = tagBlocks(xml(archive, "xl/sharedStrings.xml"), "si").map(spreadsheetText)
  const sections: string[] = ["# Workbook"]
  const seenWorksheets = new Set<string>()
  const seenDrawings = new Set<string>()
  let hasReadableCells = false

  for (const sheet of openTags(workbookXml, "sheet")) {
    if (budget.exhausted) break
    const name = attribute(sheet.source, "name") ?? "Sheet"
    const relationshipId = attributeByLocalName(sheet.source, "id")
    const worksheetPath = relationshipTarget(workbookPath, workbookRelationships, relationshipId)
    // Each worksheet part is read once, however many sheet entries repeat its target.
    if (!worksheetPath || seenWorksheets.has(worksheetPath)) continue
    seenWorksheets.add(worksheetPath)
    sections.push(`## Sheet: ${name}`)
    budget.charge(name.length + 12)

    const rows = serializeSpreadsheetRows(spreadsheetRows(xml(archive, worksheetPath), sharedStrings, budget))
    if (rows.length > 0) hasReadableCells = true
    sections.push(...(rows.length > 0 ? rows : ["[Empty sheet]"]))
    if (!budget.exhausted) sections.push(...drawingCitations(archive, worksheetPath, images, budget, seenDrawings))
  }
  if (!hasReadableCells) {
    const error = new Error("Couldn't read this workbook: no sheets or cells found")
    error.name = "WorkbookReadError"
    throw error
  }
  return `${sections.join("\n\n")}\n`
}

const expandOdfSpaces = (tag: string): string => {
  const rawCount = attribute(tag, "text:c")
  if (!rawCount) return " "

  const count = Number(rawCount)
  if (Number.isSafeInteger(count) && count > 0 && count <= MAX_ODF_SPACES_PER_ELEMENT) return " ".repeat(count)

  const omitted = Number.isSafeInteger(count) && count > MAX_ODF_SPACES_PER_ELEMENT
    ? `${count - MAX_ODF_SPACES_PER_ELEMENT} additional spaces omitted`
    : "Additional spaces omitted"
  return `${" ".repeat(MAX_ODF_SPACES_PER_ELEMENT)}[${omitted}]`
}

const odfImageCitation = (tag: string, sourcePath: string, images: EmbeddedImages): string =>
  images.citation(resolveArchivePath(sourcePath, attribute(tag, "xlink:href") ?? ""))

const odfInlineText = (source: string, sourcePath: string, images: EmbeddedImages): string => {
  let output = ""
  let index = 0
  for (const tag of xmlTags(source)) {
    output += source.slice(index, tag.start)
    index = tag.end
    if (tag.closing) continue
    if (tag.name === "draw:image") output += `\n${odfImageCitation(tag.source, sourcePath, images)}\n`
    else if (tag.name === "text:tab") output += "\t"
    else if (tag.name === "text:line-break") output += "\n"
    else if (tag.name === "text:s") output += expandOdfSpaces(tag.source)
  }
  return output + source.slice(index)
}

const odfContent = (source: string, sourcePath: string, images: EmbeddedImages): string[] => {
  const output: string[] = []
  let open: { start: number; name: string } | undefined
  for (const tag of xmlTags(source)) {
    if (open) {
      if (tag.closing && tag.name === open.name) {
        const content = trimLineEnds(decodeXml(odfInlineText(source.slice(open.start, tag.end), sourcePath, images))).trim()
        if (content) output.push(content)
        open = undefined
      }
      continue
    }
    if (tag.closing) continue
    if ((tag.name === "text:p" || tag.name === "text:h") && !tag.selfClosing) open = { start: tag.start, name: tag.name }
    else if (tag.name === "draw:image") output.push(odfImageCitation(tag.source, sourcePath, images))
  }
  return output
}

const extractOdt = (archive: Unzipped, images: EmbeddedImages): string | undefined => {
  const contentPath = "content.xml"
  const content = xml(archive, contentPath)
  if (!content) return
  return `${["# Document", ...odfContent(content, contentPath, images)].join("\n\n")}\n`
}

const extractOdp = (archive: Unzipped, images: EmbeddedImages): string | undefined => {
  const contentPath = "content.xml"
  const content = xml(archive, contentPath)
  if (!content) return
  const sections = ["# Presentation"]
  const pages = tagBlocks(content, "draw:page")
  pages.forEach((page, index) => {
    const openTag = page.match(/^<draw:page\b[^>]*>/i)?.[0] ?? ""
    const name = attribute(openTag, "draw:name") ?? String(index + 1)
    sections.push(`## Slide: ${name}`, ...odfContent(page, contentPath, images))
  })
  return `${sections.join("\n\n")}\n`
}

const extractOds = (archive: Unzipped, images: EmbeddedImages): string | undefined => {
  const contentPath = "content.xml"
  const content = xml(archive, contentPath)
  if (!content) return
  const sections = ["# Workbook"]
  for (const table of tagBlocks(content, "table:table")) {
    const openTag = table.match(/^<table:table\b[^>]*>/i)?.[0] ?? ""
    sections.push(`## Sheet: ${attribute(openTag, "table:name") ?? "Sheet"}`)
    for (const shapes of tagBlocks(table, "table:shapes")) {
      sections.push(...odfContent(shapes, contentPath, images))
    }
    for (const row of tagBlocks(table, "table:table-row")) {
      const cells = tagBlocks(row, "table:table-cell")
        .map((cell) => odfContent(cell, contentPath, images).join(" "))
      if (cells.some(Boolean)) sections.push(cells.join(" | "))
    }
  }
  return `${sections.join("\n\n")}\n`
}

const createArchiveEntryValidator = () => {
  let entries = 0
  let uncompressedBytes = 0

  return (info: UnzipFileInfo): void => {
    entries += 1
    uncompressedBytes += info.originalSize
    if (entries > MAX_ARCHIVE_ENTRIES) throw new Error("Document contains too many files")
    if (info.originalSize > MAX_ENTRY_BYTES) throw new Error("Document contains an oversized file")
    if (/\.(?:xml|rels)$/i.test(info.name) && info.originalSize > MAX_XML_ENTRY_BYTES) {
      throw new Error("Document contains XML that is too large to process safely")
    }
    if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) throw new Error("Document expands beyond the 100 MB safety limit")
    const normalized = normalizeArchivePath(info.name)
    const canonicalName = info.name.endsWith("/") ? info.name.slice(0, -1) : info.name
    if (
      !normalized
      || normalized !== canonicalName
      || info.name.includes("\\")
      || /^[a-z]:/i.test(info.name)
      || hasControlCharacters(info.name)
    ) {
      throw new Error("Document contains an unsafe file path")
    }
  }
}

const shouldExtractArchiveEntry = (info: UnzipFileInfo): boolean => {
  const extension = extensionOf(info.name)
  return extension === "xml" || extension === "rels" || IMAGE_MIMES.has(extension)
}

const validateArchiveMetadata = async (data: Uint8Array): Promise<void> => {
  const validateArchiveEntry = createArchiveEntryValidator()
  if ("Bun" in globalThis) {
    unzipSync(data, { filter: (info) => {
      validateArchiveEntry(info)
      return false
    } })
    return
  }

  await new Promise<void>((resolve, reject) => {
    unzip(data, { filter: (info) => {
      validateArchiveEntry(info)
      return false
    } }, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

const validateExtractedArchive = (archive: Unzipped): void => {
  let uncompressedBytes = 0
  for (const [path, bytes] of Object.entries(archive)) {
    uncompressedBytes += bytes.byteLength
    if (bytes.byteLength > MAX_ENTRY_BYTES) throw new Error("Document contains an oversized file")
    if (/\.(?:xml|rels)$/i.test(path) && bytes.byteLength > MAX_XML_ENTRY_BYTES) {
      throw new Error("Document contains XML that is too large to process safely")
    }
    if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) throw new Error("Document expands beyond the 100 MB safety limit")
  }
}

const unzipDocument = async (file: File): Promise<Unzipped> => {
  if (file.size > MAX_ARCHIVE_BYTES) throw new Error("Document exceeds the 20 MB attachment limit")
  const data = new Uint8Array(await file.arrayBuffer())
  await validateArchiveMetadata(data)

  // Bun's browser-style Blob workers do not reliably execute fflate's async decoder.
  // Production browser runtimes use the worker-backed path below.
  const archive = "Bun" in globalThis
    ? unzipSync(data, { filter: shouldExtractArchiveEntry })
    : await new Promise<Unzipped>((resolve, reject) => {
      unzip(data, { filter: shouldExtractArchiveEntry }, (error, result) => {
        if (error) reject(error)
        else resolve(result)
      })
    })
  validateExtractedArchive(archive)
  return archive
}

const extractDocumentText = (
  extension: string,
  archive: Unzipped,
  images: EmbeddedImages,
  budget: TextBudget,
): string | undefined => {
  switch (extension) {
    case "docx":
      return extractDocx(archive, images)
    case "pptx":
      return extractPptx(archive, images)
    case "xlsx":
      return extractXlsx(archive, images, budget)
    case "odt":
      return extractOdt(archive, images)
    case "odp":
      return extractOdp(archive, images)
    case "ods":
      return extractOds(archive, images)
    default:
      return undefined
  }
}

const boundExtractedText = (text: string, imageFilenames: Set<string>, truncated: boolean): string => {
  if (!truncated && text.length <= MAX_EXTRACTED_TEXT_CHARS) return text

  let end = Math.min(text.length, MAX_EXTRACTED_TEXT_CHARS - TEXT_TRUNCATION_NOTICE.length)
  const lastOpenBracket = text.lastIndexOf("[", end - 1)
  const lastCloseBracket = text.lastIndexOf("]", end - 1)
  if (lastOpenBracket > lastCloseBracket) {
    const nextCloseBracket = text.indexOf("]", lastOpenBracket)
    const candidate = nextCloseBracket === -1 ? "" : text.slice(lastOpenBracket + 1, nextCloseBracket)
    if (imageFilenames.has(candidate)) end = lastOpenBracket
  }
  return `${text.slice(0, end)}${TEXT_TRUNCATION_NOTICE}`
}

export const extractDocumentAttachments = async (
  file: File,
  reservedFilenames: Iterable<string> = [],
): Promise<ExtractedDocumentAttachments | undefined> => {
  const extension = extensionOf(file.name)
  if (!OFFICE_EXTENSIONS.has(extension)) return
  const archive = await unzipDocument(file)
  const images = new EmbeddedImages(archive, file.name, reservedFilenames)
  const budget = new TextBudget()
  const text = extractDocumentText(extension, archive, images, budget)
  if (!text) return
  const extractedImages = images.all()
  const imageFilenames = new Set(extractedImages.map((image) => image.name))
  const boundedText = boundExtractedText(text, imageFilenames, budget.exhausted)
  return {
    textFile: new File([boundedText], file.name, { type: "text/plain" }),
    images: extractedImages.filter((image) => boundedText.includes(`[${image.name}]`)),
  }
}
