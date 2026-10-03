/** Echo the middleware context this tool was invoked with. */
export default async function whoAmI(
  input: { probe: string },
  ctx: { readonly middleware?: Readonly<Record<string, unknown>> },
): Promise<{ probe: string; middleware: Readonly<Record<string, unknown>> | null }> {
  return { probe: input.probe, middleware: ctx.middleware ?? null }
}
