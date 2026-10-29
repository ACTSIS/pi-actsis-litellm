import { Box, Image, Text, getCapabilities } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

/** Structural theme surface used by this renderer (matches pi's theme). */
interface RendererTheme {
  bg(key: string, s: string): string;
  fg(key: string, s: string): string;
}

/**
 * Renderer for the displayed "actsis-litellm:image" custom message
 * (issue #47 S2). Renders the generated png inline when the terminal
 * supports image protocols (kitty/iterm2); otherwise shows the saved file
 * path from `details`, which the /image handler always writes.
 */
export function imageMessageRenderer(
  message: {
    customType: string;
    content:
      | string
      | Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    details?: { filePath?: string };
  },
  options: { expanded?: boolean; outputPad: number },
  theme: RendererTheme,
): Component {
  const parts: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }> =
    typeof message.content === "string"
      ? ([{ type: "text", text: message.content }] as Array<{
          type: string;
          text?: string;
        }>)
      : (message.content ?? []);

  const caption = parts
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");

  const box = new Box(options.outputPad, 1, (t) => theme.bg("customMessageBg", t));
  box.addChild(new Text(theme.fg("customMessageLabel", `[image] ${caption}`), 0, 0));

  const caps = getCapabilities();
  for (const part of parts) {
    if (part.type !== "image" || !part.data || !part.mimeType) continue;
    if (caps.images) {
      box.addChild(
        new Image(
          part.data,
          part.mimeType,
          { fallbackColor: (s) => theme.fg("toolOutput", s) },
          { filename: "pixel-art" },
        ),
      );
    } else if (message.details?.filePath) {
      box.addChild(
        new Text(
          theme.fg(
            "customMessageText",
            `Inline images are not supported by this terminal. File copy: ${message.details.filePath}`,
          ),
          0,
          0,
        ),
      );
    }
  }
  return box;
}