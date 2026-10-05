import { describe, expect, it } from "vitest"
import { interpolateWind, parseWindsAloft } from "../src/lib/winds-aloft.ts"

// A real FBUS31 KWNO excerpt for region "chi", 06Z forecast.
const SAMPLE = `(Extracted from FBUS31 KWNO 040200)
FD1US1
DATA BASED ON 040000Z    
VALID 040600Z   FOR USE 0200-0900Z. TEMPS NEG ABV 24000

FT  3000    6000    9000   12000   18000   24000  30000  34000  39000
MSP 3332 3229+07 3132+02 3037-03 3145-16 3255-27 337443 326952 305554
SPI 9900 2712+14 2514+09 2616+02 2736-10 2845-23 275839 266847 258854
GCK      3409+14 0411+10 0312+05 0408-08 3609-22 331738 302146 273551
BRL 2610 2918+13 2719+08 2621+01 2841-12 2960-23 276840 277648 269054
`

describe("parseWindsAloft", () => {
  it("reads the header, validity and levels", () => {
    const product = parseWindsAloft(SAMPLE)
    expect(product.basedOn).toBe("040000Z")
    expect(product.validAt).toBe("040600Z")
    expect(product.forUse).toBe("0200-0900Z")
    expect(product.levelsFt).toEqual([3000, 6000, 9000, 12000, 18000, 24000, 30000, 34000, 39000])
  })
  it("decodes direction, speed and temperature per level", () => {
    const msp = parseWindsAloft(SAMPLE).stations.MSP
    expect(msp?.[3000]).toEqual({ dirDegTrue: 330, speedKt: 32, tempC: null })
    expect(msp?.[6000]).toEqual({ dirDegTrue: 320, speedKt: 29, tempC: 7 })
    expect(msp?.[12000]).toEqual({ dirDegTrue: 300, speedKt: 37, tempC: -3 })
  })
  it("decodes light and variable as calm", () => {
    expect(parseWindsAloft(SAMPLE).stations.SPI?.[3000]).toEqual({
      dirDegTrue: 0,
      speedKt: 0,
      tempC: null,
    })
  })
  it("keeps the temperature on a light-and-variable group", () => {
    expect(parseWindsAloft("FT  3000    6000\nXYZ 2610 9900+13\n").stations.XYZ?.[6000]).toEqual({
      dirDegTrue: 0,
      speedKt: 0,
      tempC: 13,
    })
  })
  it("leaves a missing low level undefined", () => {
    expect(parseWindsAloft(SAMPLE).stations.GCK?.[3000]).toBeUndefined()
    expect(parseWindsAloft(SAMPLE).stations.GCK?.[6000]).toEqual({
      dirDegTrue: 340,
      speedKt: 9,
      tempC: 14,
    })
  })
  it("decodes winds over 100 knots and negative temps above 24000", () => {
    expect(parseWindsAloft(SAMPLE).stations.BRL?.[30000]).toEqual({
      dirDegTrue: 270,
      speedKt: 68,
      tempC: -40,
    })
    expect(parseWindsAloft("FT  3000\nXYZ 7599\n").stations.XYZ?.[3000]).toEqual({
      dirDegTrue: 250,
      speedKt: 199,
      tempC: null,
    })
  })
})

describe("interpolateWind", () => {
  it("interpolates direction and speed between bracketing levels", () => {
    const msp = parseWindsAloft(SAMPLE).stations.MSP!
    const w = interpolateWind(msp, 4500)
    expect(w.dirDegTrue).toBe(325)
    expect(w.speedKt).toBeCloseTo(30.5, 5)
    expect(w.tempC).toBeNull()
  })
  it("returns the level itself at a listed altitude", () => {
    const msp = parseWindsAloft(SAMPLE).stations.MSP!
    expect(interpolateWind(msp, 6000)).toEqual({ dirDegTrue: 320, speedKt: 29, tempC: 7 })
  })
  it("takes the other level's direction when one level is calm", () => {
    const station = {
      3000: { dirDegTrue: 0, speedKt: 0, tempC: null },
      6000: { dirDegTrue: 270, speedKt: 20, tempC: null },
    }
    const w = interpolateWind(station, 4500)
    expect(w.dirDegTrue).toBe(270)
    expect(w.speedKt).toBeCloseTo(10, 5)
  })
  it("interpolates direction across north", () => {
    const station = {
      3000: { dirDegTrue: 350, speedKt: 10, tempC: null },
      6000: { dirDegTrue: 10, speedKt: 10, tempC: null },
    }
    expect(interpolateWind(station, 4500).dirDegTrue).toBe(0)
  })
  it("rejects an altitude below the lowest or above the highest level", () => {
    const msp = parseWindsAloft(SAMPLE).stations.MSP!
    expect(() => interpolateWind(msp, 1500)).toThrow(/outside/)
  })
})
