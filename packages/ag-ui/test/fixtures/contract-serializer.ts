/**
 * The activity DOM contract (arc spec §5.6) as text, for comparing the React
 * and Angular kits. Keeps every element, its attributes (sorted, classes
 * sorted) and its text; drops what only one framework adds:
 *
 * - comment nodes (Angular's anchors) and whitespace-only text between elements;
 * - `style` and Angular's markers (`ng-*`, `_ng*`, `ng-reflect-*`);
 * - the attribute an Angular attribute selector leaves on its host (`b4-step`
 *   on `li[b4-step]`): every attribute whose name starts with `b4-`;
 * - Angular's element hosts (`<b4-turn-activity>`, `display: contents`): the
 *   host is unwrapped and its children kept in place.
 *
 * Adjacent text nodes are merged, so `{agent} wants to {label}` (three React
 * text nodes) and one Angular interpolation compare equal.
 */

const DROPPED_ATTRIBUTE = /^(?:style|ng-|_ng|b4-)/

const isElement = (node: Node): node is Element => node.nodeType === 1
const isText = (node: Node): boolean => node.nodeType === 3

const isHost = (element: Element): boolean => element.localName.startsWith("b4-")

/** The element's children with every Angular host replaced by its own children. */
function contractChildren(parent: Node): Node[] {
  const out: Node[] = []
  for (const child of Array.from(parent.childNodes)) {
    if (isElement(child) && isHost(child)) out.push(...contractChildren(child))
    else if (isElement(child) || isText(child)) out.push(child)
  }
  return out
}

function attributes(element: Element): string {
  return Array.from(element.attributes)
    .filter((attr) => !DROPPED_ATTRIBUTE.test(attr.name))
    .map((attr) => {
      const value =
        attr.name === "class"
          ? attr.value.split(/\s+/).filter(Boolean).sort().join(" ")
          : attr.value
      return ` ${attr.name}=${JSON.stringify(value)}`
    })
    .sort()
    .join("")
}

function serializeNodes(nodes: readonly Node[], depth: number, lines: string[]): void {
  const pad = "  ".repeat(depth)
  let text = ""
  const flush = () => {
    if (text.trim() !== "") lines.push(`${pad}${JSON.stringify(text)}`)
    text = ""
  }
  for (const node of nodes) {
    if (!isElement(node)) {
      text += node.textContent ?? ""
      continue
    }
    flush()
    lines.push(`${pad}<${node.localName}${attributes(node)}>`)
    serializeNodes(contractChildren(node), depth + 1, lines)
  }
  flush()
}

/** The contract DOM under `root` (exclusive), one node per line. */
export function serializeContract(root: Node): string {
  const lines: string[] = []
  serializeNodes(contractChildren(root), 0, lines)
  return lines.join("\n")
}

/**
 * Opens every disclosure under `root`: clicks the first collapsed
 * `button[aria-expanded="false"]` until none is left (opening one can reveal
 * more). `click` dispatches the click and lets the framework render.
 */
export async function expandAll(
  root: ParentNode,
  click: (button: HTMLElement) => void | Promise<void>,
): Promise<void> {
  for (let guard = 0; guard < 500; guard += 1) {
    const next = root.querySelector<HTMLElement>('button[aria-expanded="false"]')
    if (next === null) return
    await click(next)
  }
  throw new Error("expandAll: a disclosure never stayed open")
}

/** The snapshot's shape: per fixture, the contract as mounted and with every disclosure open. */
export interface ContractSnapshot {
  readonly turns: Readonly<Record<string, { readonly initial: string; readonly expanded: string }>>
  readonly approvals: Readonly<Record<string, string>>
}

/**
 * The committed snapshot's path. Not `new URL(…, import.meta.url)`: Vite
 * rewrites that pattern into an asset URL.
 */
export const CONTRACT_SNAPSHOT_PATH: string = `${import.meta.dirname}/activity-contract.snap.json`
