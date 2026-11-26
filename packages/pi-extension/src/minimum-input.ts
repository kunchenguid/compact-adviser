import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, DynamicBorder, Input, keyHint, Text } from "./tui-compat.ts";

// Pi 0.82's ui.input second argument is an ignored placeholder, not an initial
// value. Render our own Input prefilled with it so the promised prefill really exists.
export function promptMinimum(
  ctx: ExtensionCommandContext,
  initial: number,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    const input = new Input(keybindings);
    input.setValue(String(initial));
    const box = new Container();
    const heading = new Text("", 1);
    const help = new Text("", 1);
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
          theme.fg("accent", "Minimum context tokens (constant count; no calls below it)"),
        );
        help.setText(
          theme.fg(
            "dim",
            `${keyHint(theme, "tui.select.confirm", "save")}  ${keyHint(theme, "tui.select.cancel", "cancel")}`,
          ),
        );
        return box.render(width);
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
