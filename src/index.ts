import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export default function toolVisuals(pi: ExtensionAPI): void {
  pi.registerToolRenderer((_toolName, next) => next())
}
