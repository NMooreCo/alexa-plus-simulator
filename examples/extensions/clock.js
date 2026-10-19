// An extension for the Alexa+ simulator: pretend it's another time of day, for an add-on whose answers depend on it.
// It changes the time the assistant hears and the device's idle clock, not your server's clock.
//
//   alexa-plus-simulator <mcp-url> --extension examples/extensions/clock.js

/** @param {import("alexa-plus-simulator/ui").Simulator} sim */
export default function clock(sim) {
  let offsetMs = 0;

  const label = document.createElement("label");
  label.append("Pretend it's ");
  const input = document.createElement("input");
  input.type = "time";
  input.addEventListener("change", () => {
    if (!input.value) {
      offsetMs = 0;
      sim.log("page", "The assistant hears the real time again.");
      return;
    }
    const [hours, minutes] = input.value.split(":").map(Number);
    const then = new Date();
    then.setHours(hours, minutes, 0, 0);
    offsetMs = then.getTime() - Date.now();
    sim.log("page", `The assistant now hears it's ${input.value}.`);
  });
  label.append(input);
  sim.ui.footer.append(label);

  // The hooks: here only the clock. See docs/extensions.md for the rest.
  return { now: () => new Date(Date.now() + offsetMs) };
}
