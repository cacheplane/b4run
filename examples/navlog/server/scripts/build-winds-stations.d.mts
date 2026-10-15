export function stationIds(text: string): string[]
export function resolveStations(
  ids: readonly string[],
  navaidRows: readonly (readonly [string, string, string, number, number, ...unknown[]])[],
  lookupAirport: (id: string) => Promise<{ lat: number; lon: number } | null>,
): Promise<{ stations: [string, number, number][]; unresolved: string[] }>
