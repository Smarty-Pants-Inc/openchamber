import { describe, expect, test } from "bun:test"
import { addRange, gapHeight, gapsOf, windowFor } from "./position-windows"

describe("position windows (smarty-code#583)", () => {
  test("loaded ranges merge when they touch or overlap, and stay sorted", () => {
    let ranges = addRange([], { start: 900, end: 1000 }) // the tail
    ranges = addRange(ranges, { start: 0, end: 200 }) // a jump to the start
    ranges = addRange(ranges, { start: 700, end: 900 }) // scrolling up from the tail: touches it
    expect(ranges).toEqual([{ start: 0, end: 200 }, { start: 700, end: 1000 }])
    ranges = addRange(ranges, { start: 150, end: 720 })
    expect(ranges).toEqual([{ start: 0, end: 1000 }])
  })

  test("gaps cover exactly the unloaded positions, keyed by where they start", () => {
    expect(gapsOf([{ start: 900, end: 1000 }], 1000)).toEqual([{ start: 0, end: 900, key: "gap:0" }])
    expect(gapsOf([{ start: 0, end: 200 }, { start: 700, end: 1000 }], 1000)).toEqual([{ start: 200, end: 700, key: "gap:200" }])
    expect(gapsOf([{ start: 0, end: 1000 }], 1000)).toEqual([])
    expect(gapsOf([{ start: 0, end: 100 }], 150)).toEqual([{ start: 100, end: 150, key: "gap:100" }]) // appended records
  })

  test("the window for a gap: its end when scrolling up, its start when scrolling down, centred when landed inside", () => {
    const gap = { start: 200, end: 700 }
    expect(windowFor(gap, 100, { edge: "end" })).toEqual({ start: 600, end: 700 })
    expect(windowFor(gap, 100, { edge: "start" })).toEqual({ start: 200, end: 300 })
    expect(windowFor(gap, 100, { fraction: 0.5 })).toEqual({ start: 400, end: 500 })
    expect(windowFor(gap, 100, { fraction: 0 })).toEqual({ start: 200, end: 300 })
    expect(windowFor(gap, 100, { fraction: 1 })).toEqual({ start: 600, end: 700 })
    expect(windowFor({ start: 0, end: 30 }, 100, { fraction: 0.5 })).toEqual({ start: 0, end: 30 }) // smaller than a window
  })

  test("a gap's placeholder is as tall as its records would be", () => {
    expect(gapHeight({ start: 0, end: 1000 }, 120)).toBe(120_000)
    expect(gapHeight({ start: 0, end: 10 }, 0)).toBe(80) // never below a minimum per record
  })
})
