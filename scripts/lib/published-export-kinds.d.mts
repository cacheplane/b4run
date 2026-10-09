export declare function publishedExportKinds(
  packageDir: string,
  specifier: string,
): Record<string, string>

export declare function publishedProbeExpectation(
  packageDir: string,
  specifier: string,
  expected: Readonly<Record<string, string>>,
): {
  readonly actual: Record<string, string | undefined>
  readonly expected: Record<string, string>
}
