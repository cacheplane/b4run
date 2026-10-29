import {
  isToolDisplayIcon,
  type TOOL_DISPLAY_ICONS,
  type ToolDisplay,
  type ToolDisplayIcon,
} from "../src/tool-display.js"

const display: ToolDisplay = { icon: "weather-radar" }
const icon: ToolDisplayIcon = "weather-radar"

function narrowKnownIcon(value: string): string {
  if (isToolDisplayIcon(value)) {
    const known: (typeof TOOL_DISPLAY_ICONS)[number] = value
    return known
  }
  const opaque: typeof value = "weather-radar"
  return opaque
}

void display
void icon
void narrowKnownIcon
