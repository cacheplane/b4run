import { script } from "../../../packages/testing/dist/index.js";

export const DEMO_PROMPT =
	"Plan a VFR flight from KSTP to KRST at 4500 feet, departing 1400Z, and save the navlog.";

// The same inline navlog input the harness journeys use: FAA airport records
// (field elevation in feet), the POH cruise RPM, and one wind per leg.
export const DEMO_NAVLOG_INPUT = {
	aircraft: { tailNumber: "N738ZU", cruiseRpm: 2400, usableFuelGal: 50 },
	altitudeFt: 4500,
	departureTimeUtc: "2026-10-06T14:00:00Z",
	waypoints: [
		{
			id: "KSTP",
			lat: 44.9346,
			lon: -93.0603,
			elevationFt: 705,
			magneticVariationDeg: 0,
			kind: "airport",
		},
		{
			id: "KRST",
			lat: 43.9083,
			lon: -92.49,
			elevationFt: 1317,
			magneticVariationDeg: 0,
			kind: "airport",
		},
	],
	winds: [{ dirDegTrue: 320, speedKt: 20, tempC: 5 }],
};

export const DEMO_FIXTURES = script()
	.user(DEMO_PROMPT)
	.callsTool("computeNavlog", DEMO_NAVLOG_INPUT)
	.replies(
		"KSTP and KRST are VFR. 66 nm, 33 minutes, 5.5 gal burned, reserve about 6 hours. [poh/cruise-performance.md, Figure 5-7]",
	)
	.build();
