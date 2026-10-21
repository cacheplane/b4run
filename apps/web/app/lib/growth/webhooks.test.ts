import { describe, expect, it } from "vitest";
import { parseResendEvent } from "./webhooks";

const base = (type: string, data: Record<string, unknown> = {}) => ({
	type,
	created_at: "2026-10-21T10:00:00.000Z",
	data: { email_id: "em_1", to: ["ada@example.com"], ...data },
});

describe("parseResendEvent", () => {
	it("parses email.delivered with array tags", () => {
		const event = parseResendEvent(
			base("email.delivered", {
				tags: [
					{ name: "environment", value: "production" },
					{ name: "step", value: "1" },
				],
			}),
		);
		expect(event).toEqual({
			type: "email.delivered",
			occurredAt: new Date("2026-10-21T10:00:00.000Z"),
			providerEmailId: "em_1",
			to: ["ada@example.com"],
			tags: { environment: "production", step: "1" },
		});
	});

	it("parses object tags", () => {
		const event = parseResendEvent(
			base("email.delivered", { tags: { environment: "preview" } }),
		);
		expect(event?.tags).toEqual({ environment: "preview" });
	});

	it("defaults tags to empty when absent", () => {
		expect(parseResendEvent(base("email.complained"))?.tags).toEqual({});
	});

	it("normalises bounce types case-insensitively", () => {
		expect(
			parseResendEvent(base("email.bounced", { bounce: { type: "Permanent" } }))
				?.bounceType,
		).toBe("permanent");
		expect(
			parseResendEvent(base("email.bounced", { bounce: { type: "Transient" } }))
				?.bounceType,
		).toBe("transient");
		expect(
			parseResendEvent(
				base("email.bounced", { bounce: { type: "Undetermined" } }),
			)?.bounceType,
		).toBe("unknown");
		expect(parseResendEvent(base("email.bounced"))?.bounceType).toBe("unknown");
	});

	it("omits bounceType for non-bounce events", () => {
		expect(parseResendEvent(base("email.complained"))).not.toHaveProperty(
			"bounceType",
		);
	});

	it("returns undefined for unsupported types and malformed shapes", () => {
		expect(parseResendEvent(base("email.opened"))).toBeUndefined();
		expect(
			parseResendEvent(base("email.delivered", { email_id: undefined })),
		).toBeUndefined();
		expect(
			parseResendEvent(base("email.delivered", { to: "ada@example.com" })),
		).toBeUndefined();
		expect(parseResendEvent({ type: "email.delivered" })).toBeUndefined();
		expect(
			parseResendEvent({
				...base("email.delivered"),
				created_at: "not a date",
			}),
		).toBeUndefined();
		expect(parseResendEvent(null)).toBeUndefined();
		expect(parseResendEvent("x")).toBeUndefined();
	});
});
