export interface RouteStateFields {
  readonly pathname: string
  readonly fields: readonly { readonly name: string; readonly type: string }[]
}

export function renderStateTypes(routeStates: readonly RouteStateFields[]): string {
  const routeStateType = "  export type RouteState<P extends B4RoutePath> = B4RouteState[P];"

  if (routeStates.length === 0) {
    return ["  export interface B4RouteState {}", "", routeStateType, ""].join("\n")
  }

  const routeLines: string[] = []
  for (const route of routeStates) {
    routeLines.push(`    ${JSON.stringify(route.pathname)}: {`)
    for (const field of route.fields) {
      routeLines.push(`      readonly ${field.name}: ${field.type};`)
    }
    routeLines.push("    };")
  }

  return ["  export interface B4RouteState {", ...routeLines, "  }", "", routeStateType, ""].join(
    "\n",
  )
}
