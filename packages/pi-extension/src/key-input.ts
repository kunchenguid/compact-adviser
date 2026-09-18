import {
  DynamicBorder,
  type ExtensionCommandContext,
  keyHint,
} from "@earendil-works/pi-coding-agent";
import { Container, Input, Text } from "@earendil-works/pi-tui";

export function maskSecret(value: string): string {
  return "*".repeat(value.length);
}

/** Empty prompt; typed characters are masked. Escape cancels. Never prefills a saved key. */
export function promptSecret(ctx: ExtensionCommandContext): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    const input = new Input();
    const box = new Container();
    const heading = new Text("", 1, 0);
    const help = new Text("", 1, 0);
    box.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    box.addChild(heading);
    box.addChild(input);
    box.addChild(help);
    box.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    return {
      get focused() {
        return input.focused;
      },
      set focused(value: boolean) {
        input.focused = value;
      },
      render(width: number) {
        heading.setText(
          theme.fg("accent", "TypeSafe API key (saved for all sessions; never shown again)"),
        );
        help.setText(
          theme.fg(
            "dim",
            `${keyHint("tui.select.confirm", "save")}  ${keyHint("tui.select.cancel", "cancel")}`,
          ),
        );
        const real = input.getValue();
        input.setValue(maskSecret(real));
        box.invalidate();
        try {
          return box.render(width);
        } finally {
          input.setValue(real);
        }
      },
      invalidate() {
        box.invalidate();
      },
      handleInput(data: string) {
        if (keybindings.matches(data, "tui.select.confirm") || data === "\n")
          done(input.getValue());
        else if (keybindings.matches(data, "tui.select.cancel")) done(undefined);
        else {
          input.handleInput(data);
          tui.requestRender();
        }
      },
    };
  });
}
